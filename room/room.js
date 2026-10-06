// Videoroom cinema: every camera is a YouTube embed. A shared timeline clock
// follows the visible camera; a small pool of other cameras plays muted in
// the background, in sync, so switching to them is just a crossfade.
(() => {
  'use strict';

  const VR = globalThis.VR;
  const EmbedPlayer = globalThis.VREmbedPlayer;
  const S = EmbedPlayer.State;

  const TICK = 250; // ms
  const MAX_EMBEDS = 4; // active + audio source + 2 warm
  const DRIFT_ACTIVE = 0.3; // s
  const DRIFT_FORCED = 0.15; // s, right after a switch / seek
  const DRIFT_WARM = 0.2; // s, hidden seeks are invisible, so keep them ready for an exact cut
  const SEEK_COOLDOWN = 1500; // ms between corrective seeks of one embed
  const FOLLOW_GRACE = 1200; // ms after a seek before the clock trusts that embed again
  const SEEK_LEAD = 0.5; // s, initial guess of seek latency while playing; learned per embed
  const HOVER_DELAY = 150; // ms
  const SAVE_DEBOUNCE = 600; // ms
  const EMBED_DENIED = new Set([152, 153]); // embedding refused for this page, not the video

  const $ = (s) => document.querySelector(s);
  const stage = $('#stage');
  const poster = $('#poster');

  // ---------- state ----------

  let room = null;
  let canSave = false;
  let savedAt = 0;
  let saveTimer = null;
  let active = null;
  let hovered = null;
  let hoverTimer = null;
  let audioId = null;
  let started = false;
  let seeking = false; // user is dragging the seek bar
  let posterKey;
  const players = new Map(); // videoId -> EmbedPlayer
  const blocked = new Set(); // embedding disabled by the author
  const deniedCodes = new Set();
  const cards = new Map();

  const prefs = { volume: 100, muted: false };
  try {
    Object.assign(prefs, JSON.parse(localStorage.getItem('vr-prefs') || '{}'));
  } catch {
    // private mode etc.
  }
  const savePrefs = () => {
    try {
      localStorage.setItem('vr-prefs', JSON.stringify(prefs));
    } catch {
      // ignore
    }
  };

  // ---------- clock ----------

  const clock = { t: 0, at: performance.now(), playing: false, rate: 1 };

  function now() {
    return clock.playing ? clock.t + ((performance.now() - clock.at) / 1000) * clock.rate : clock.t;
  }

  function setClock(t) {
    clock.t = t;
    clock.at = performance.now();
  }

  // ---------- helpers ----------

  function h(tag, props, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children) if (c != null && c !== false) e.append(c);
    return e;
  }

  function fmtTime(s) {
    const neg = s < 0;
    s = Math.abs(Math.round(s));
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return (neg ? '−' : '') + (hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`);
  }

  function fmtOffset(s) {
    return (s >= 0 ? '+' : '−') + Math.abs(s).toFixed(2) + ' с';
  }

  const cam = (id) => room.cameras.find((c) => c.videoId === id) || null;
  const camIndex = (id) => room.cameras.findIndex((c) => c.videoId === id);
  const camLabel = (c) => c.label || `Камера ${camIndex(c.videoId) + 1}`;

  // Shared timeline span covered by all cameras.
  function span() {
    let start = Infinity;
    let end = -Infinity;
    for (const c of room.cameras) {
      start = Math.min(start, c.offset);
      end = Math.max(end, c.offset + (c.duration || 0));
    }
    return { start, end: Math.max(end, start + 1) };
  }

  // true / false, or null when unknown (duration not learned yet).
  function inRange(c, t = now()) {
    const local = t - c.offset;
    if (local < 0) return false;
    return c.duration ? local < c.duration - 0.25 : null;
  }

  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove('show'), 1600);
  }

  function banner(text) {
    const el = $('#banner');
    el.textContent = text || '';
    el.hidden = !text;
  }

  // ---------- persistence ----------

  // Room storage: chrome.storage when running as an extension page, or the
  // extension's content-script bridge when hosted (see cinema-bridge.js).
  let bridgeSeq = 0;
  function bridgeCall(op, args = {}, timeout = 3000) {
    return new Promise((resolve, reject) => {
      const id = ++bridgeSeq;
      const timer = setTimeout(() => done(() => resolve(undefined)), timeout);
      const onMsg = (e) => {
        const d = e.data;
        if (e.source !== window || !d || d.vrCinema !== 'response' || d.id !== id) return;
        done(() => (d.error ? reject(new Error(d.error)) : resolve(d.result)));
      };
      function done(fn) {
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        fn();
      }
      window.addEventListener('message', onMsg);
      window.postMessage({ vrCinema: 'request', id, op, ...args }, location.origin);
    });
  }

  async function connectStore(roomId) {
    if (VR.hasStorage()) {
      return {
        load: async () => (await VR.loadRooms())[roomId] || null,
        save: async (r) => (await VR.saveRoom(r)).updatedAt,
        watch: (cb) =>
          chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes.rooms) cb(changes.rooms.newValue?.[roomId]);
          }),
      };
    }
    if (!(await bridgeCall('hello', {}, 1500))) return null;
    return {
      load: () => bridgeCall('loadRoom', { roomId }),
      save: async (r) => (await bridgeCall('saveRoom', { room: r })).updatedAt,
      watch: (cb) =>
        window.addEventListener('message', (e) => {
          if (e.source === window && e.data?.vrCinema === 'roomChanged') cb(e.data.room);
        }),
    };
  }

  let store = null;

  function scheduleSave() {
    if (!canSave) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      try {
        savedAt = await store.save(room);
      } catch (err) {
        console.warn('[Videoroom] save failed', err);
      }
    }, SAVE_DEBOUNCE);
  }

  function onStoredRoom(next) {
    // Ignore the echo of our own save and don't clobber unsaved nudges.
    if (!next || saveTimer || next.updatedAt === savedAt) return;
    room = next;
    for (const id of [...players.keys()]) if (!cam(id)) evict(id);
    if (!cam(active)) active = room.cameras[0].videoId;
    renderAll();
    updatePool();
    sync(true);
  }

  // ---------- embeds pool ----------

  function load(id) {
    const c = cam(id);
    const layer = h('div', { class: id === active ? 'layer active' : 'layer' });
    stage.insertBefore(layer, poster);
    const p = new EmbedPlayer(id, Math.max(0, now() - c.offset), layer);
    p.layer = layer;
    p.lastUsed = performance.now();
    p.onReady = () => sync(true);
    p.onInfo = () => {
      const c2 = cam(id);
      if (c2 && p.duration && (!c2.duration || Math.abs(c2.duration - p.duration) > 1)) {
        c2.duration = VR.round2(p.duration);
        renderCoverage();
        updateSeekRange();
        scheduleSave();
      }
    };
    p.onError = (code) => onEmbedError(id, code);
    players.set(id, p);
    return p;
  }

  function evict(id) {
    const p = players.get(id);
    if (!p) return;
    if (audioId === id) audioId = null;
    p.destroy();
    p.layer.remove();
    players.delete(id);
  }

  function audioSourceCam() {
    if (room.audioMode === 'main') {
      const main = room.cameras[0];
      if (!blocked.has(main.videoId) && inRange(main) !== false) return main.videoId;
    }
    return active;
  }

  // Keep warm: active, the audio source, hovered, next, previous.
  function updatePool() {
    const ids = room.cameras.map((c) => c.videoId);
    const want = [];
    const add = (id) => {
      if (id && !blocked.has(id) && !want.includes(id) && cam(id)) want.push(id);
    };
    add(active);
    add(audioSourceCam());
    add(hovered);
    const i = Math.max(0, ids.indexOf(active));
    add(ids[(i + 1) % ids.length]);
    add(ids[(i - 1 + ids.length) % ids.length]);

    const keep = want.slice(0, MAX_EMBEDS);
    const t = performance.now();
    for (const id of keep) (players.get(id) || load(id)).lastUsed = t;
    if (players.size > MAX_EMBEDS) {
      const victims = [...players.values()].filter((p) => !keep.includes(p.videoId)).sort((a, b) => a.lastUsed - b.lastUsed);
      while (players.size > MAX_EMBEDS && victims.length) evict(victims.shift().videoId);
    }
    updateCards();
  }

  function setHovered(id) {
    clearTimeout(hoverTimer);
    if (id === hovered) return;
    hoverTimer = setTimeout(
      () => {
        hovered = id;
        if (id) updatePool();
      },
      id ? HOVER_DELAY : 0
    );
  }

  function onEmbedError(id, code) {
    console.info('[Videoroom] embed error', id, code);
    evict(id);
    if (EMBED_DENIED.has(code)) {
      deniedCodes.add(code);
      banner(
        `YouTube отказался показывать встроенный плеер на этой странице (ошибка ${code}).\n` +
          'Кинозал должен открываться с https-адреса, а не как страница расширения — проверьте адрес в настройках Videoroom.'
      );
    }
    blocked.add(id);
    const c = cam(id);
    if (id === active && c) toast(`${camLabel(c)}: встраивание запрещено — нажмите на ракурс, чтобы открыть его на YouTube`);
    updatePool();
    updatePoster();
  }

  function openOnYouTube(c) {
    const t = Math.max(0, Math.floor(now() - c.offset));
    window.open(`https://www.youtube.com/watch?v=${c.videoId}&t=${t}s`, '_blank', 'noopener');
  }

  // ---------- switching ----------

  function switchTo(id) {
    const c = cam(id);
    if (!c) return;
    if (blocked.has(id)) return openOnYouTube(c);
    if (id === active) return;

    const prev = players.get(active);
    active = id;
    const p = players.get(id) || load(id);
    p.lastUsed = performance.now();
    // Keep the outgoing camera opaque underneath while the new one fades in.
    if (prev) {
      prev.layer.classList.add('prev');
      setTimeout(() => prev.layer.classList.remove('prev'), 300);
    }
    for (const [pid, pl] of players) pl.layer.classList.toggle('active', pid === active);
    sync(true);
    applyAudio();
    updatePool();
    updatePoster();
    renderOffset();
    toast(`${camIndex(id) + 1} · ${camLabel(c)}`);
  }

  function step(dir) {
    const ids = room.cameras.map((c) => c.videoId);
    if (ids.length < 2) return;
    const i = ids.indexOf(active);
    switchTo(ids[(i + dir + ids.length) % ids.length]);
  }

  // ---------- playback ----------

  function play() {
    const { start, end } = span();
    if (now() >= end - 0.3) setClock(start);
    setClock(now());
    clock.playing = true;
    started = true;
    $('#start').hidden = true;
    applyAudio(true);
    sync(true);
    renderPlay();
  }

  function pause() {
    setClock(now());
    clock.playing = false;
    sync(true);
    renderPlay();
  }

  function seekTo(t) {
    const { start, end } = span();
    setClock(Math.min(Math.max(t, start), end));
    sync(true);
    updatePoster();
  }

  // Clock follows the visible camera; everyone else follows the clock.
  function tick() {
    const a = players.get(active);
    const ac = cam(active);
    if (
      clock.playing &&
      a &&
      a.ready &&
      a.everPlayed &&
      inRange(ac) !== false &&
      performance.now() - a.lastSeekAt > FOLLOW_GRACE
    ) {
      if (a.state === S.PLAYING) setClock(a.estimateTime() + ac.offset);
      else if (a.state === S.BUFFERING) setClock(a.time + ac.offset); // hold while it buffers
    }
    if (clock.playing && now() >= span().end) pause();

    sync(false);
    applyAudio();
    updatePoster();
    updateCards();
    renderTime();
  }

  function sync(force) {
    const t0 = now();
    const ts = performance.now();
    for (const [id, p] of players) {
      if (!p.ready || p.error) continue;
      const c = cam(id);
      if (!c) continue;
      const target = t0 - c.offset;
      const isActive = id === active;

      if (Math.abs(p.rate - clock.rate) > 0.01) p.setRate(clock.rate);

      if (inRange(c, t0) === false) {
        // Not recording at this moment: park at the nearest edge.
        if (p.playing) p.pause();
        const edge = target < 0 ? 0 : Math.max(0, (p.duration || 0) - 0.5);
        if (Math.abs(p.estimateTime() - edge) > 1 && ts - p.lastSeekAt > SEEK_COOLDOWN) p.seek(edge);
        continue;
      }

      const drift = p.estimateTime() - target;
      // A seek while playing buffers for a while and lands behind; learn by how much.
      if (p.leadCheck && p.state === S.PLAYING && ts - p.lastSeekAt > 1000) {
        p.seekLead = Math.min(2.5, Math.max(0, p.seekLead - drift * 0.8));
        p.leadCheck = false;
      }
      const limit = isActive ? (force ? DRIFT_FORCED : DRIFT_ACTIVE) : DRIFT_WARM;
      const cooling = !force && ts - p.lastSeekAt < SEEK_COOLDOWN;
      if (Math.abs(drift) > limit && !cooling) {
        p.seekLead ??= SEEK_LEAD;
        p.seek(target + (clock.playing ? p.seekLead : 0));
        p.leadCheck = clock.playing;
      }

      if (clock.playing && p.state !== S.PLAYING && p.state !== S.BUFFERING) p.play();
      else if (!clock.playing && (p.state === S.PLAYING || p.state === S.BUFFERING)) p.pause();
    }
  }

  // ---------- audio ----------

  function applyAudio(forceVolume) {
    const id = started && !prefs.muted ? audioSourceCam() : null;
    const p = id && players.get(id);
    const want = p && p.ready ? id : null;
    if (want !== audioId) {
      if (audioId) players.get(audioId)?.mute();
      audioId = want;
      if (p && want) {
        p.setVolume(prefs.volume);
        p.unMute();
      }
    } else if (forceVolume && p && want) {
      p.setVolume(prefs.volume);
    }
  }

  function setAudioMode(mode) {
    room.audioMode = mode;
    renderAudioMode();
    updatePool();
    applyAudio(true);
    scheduleSave();
    toast(mode === 'main' ? `Звук: ${camLabel(room.cameras[0])}` : 'Звук: активный ракурс');
  }

  // ---------- offsets ----------

  function nudge(delta) {
    const c = cam(active);
    if (!c) return;
    c.offset = VR.round2(c.offset + delta);
    sync(true);
    renderOffset();
    renderCoverage();
    updateSeekRange();
    scheduleSave();
  }

  // ---------- rendering ----------

  function renderAll() {
    $('#title').textContent = `🎬 ${room.name}`;
    document.title = `${room.name} — Videoroom`;
    renderCards();
    renderMap();
    renderAudioMode();
    renderOffset();
    renderPlay();
    updateSeekRange();
    renderTime();
    $('#volume').value = String(prefs.volume);
    $('#mute').textContent = prefs.muted ? '🔇' : '🔊';
  }

  function renderCards() {
    const list = $('#cams');
    list.textContent = '';
    cards.clear();
    room.cameras.forEach((c, i) => {
      const seg = h('span', { class: 'seg' });
      const head = h('span', { class: 'head' });
      const card = h(
        'button',
        { class: 'cam', type: 'button', dataset: { cam: c.videoId }, title: camLabel(c) },
        h('img', { src: VR.thumbUrl(c.videoId), alt: '' }),
        h('span', { class: 'num', text: String(i + 1) }),
        h('span', { class: 'dot' }),
        h('span', { class: 'label', text: camLabel(c) }),
        h('span', { class: 'cov' }, seg, head)
      );
      card.seg = seg;
      card.head = head;
      cards.set(c.videoId, card);
      list.append(card);
    });
    renderCoverage();
    updateCards();
  }

  function renderCoverage() {
    const { start, end } = span();
    const len = end - start;
    for (const [id, card] of cards) {
      const c = cam(id);
      if (!c) continue;
      card.seg.style.left = `${((c.offset - start) / len) * 100}%`;
      card.seg.style.width = c.duration ? `${(c.duration / len) * 100}%` : '2px';
    }
  }

  function updateCards() {
    const t = now();
    const { start, end } = span();
    const headPos = `${((t - start) / (end - start)) * 100}%`;
    for (const [id, card] of cards) {
      const c = cam(id);
      const p = players.get(id);
      card.classList.toggle('active', id === active);
      card.classList.toggle('blocked', blocked.has(id));
      card.classList.toggle('off', !!c && inRange(c, t) === false);
      card.classList.toggle('ready', !!(p && p.everPlayed));
      card.classList.toggle('loading', !!(p && !p.everPlayed));
      card.head.style.left = headPos;
    }
    updateMap();
  }

  // ---------- venue map ----------

  let map = null;

  function renderMap() {
    map.render();
  }

  function updateMap() {
    map?.update();
  }

  function bindMap() {
    map = new VRVenueMap({
      getRoom: () => room,
      getActive: () => active,
      isUnavailable: (id) => blocked.has(id) || inRange(cam(id)) === false,
      label: camLabel,
      onSelect: switchTo,
      onMove: (id, pos) => {
        cam(id).pos = pos;
        scheduleSave();
      },
      onStageMove: (pos) => {
        room.stage = pos;
        scheduleSave();
      },
      onEditToggle: (on) => toast(on ? 'Перетащите камеры и сцену туда, где они были. ✎ — готово' : 'Расстановка сохранена'),
    });
    $('#bottom').prepend(map.el);
  }

  function moveDir(dir) {
    const id = VR.pickDirection(room, active, dir, (vid) => blocked.has(vid));
    if (id) switchTo(id);
    else toast('В этом направлении камер нет');
  }

  function updatePoster() {
    const c = cam(active);
    const p = players.get(active);
    let mode = null;
    if (c && blocked.has(active)) mode = 'blocked';
    else if (c && inRange(c) === false) mode = 'off';
    else if (c && (!p || !p.everPlayed)) mode = 'loading';

    const key = mode && `${mode}:${active}`;
    if (key === posterKey) {
      if (mode === 'off') poster.querySelector('.note').textContent = offNote(c);
      return;
    }
    posterKey = key;
    poster.classList.toggle('show', !!mode);
    poster.textContent = '';
    if (!mode) return;
    poster.style.backgroundImage = `url("${VR.thumbUrl(c.videoId, 'hqdefault')}")`;
    if (mode === 'loading') {
      poster.append(h('div', { class: 'spinner' }), h('div', { text: `Загрузка: ${camLabel(c)}` }));
    } else if (mode === 'off') {
      poster.append(h('div', { text: `${camLabel(c)} не снимал в этот момент` }), h('div', { class: 'note', text: offNote(c) }));
    } else {
      poster.append(
        h('div', { text: `${camLabel(c)}: автор запретил встраивание` }),
        h('div', { class: 'note', text: 'Нажмите на карточку ракурса, чтобы открыть его на YouTube' })
      );
    }
  }

  function offNote(c) {
    const local = now() - c.offset;
    return local < 0 ? `Запись начнётся через ${fmtTime(-local)}` : 'Запись уже закончилась';
  }

  function updateSeekRange() {
    const { start, end } = span();
    const seek = $('#seek');
    seek.min = String(start);
    seek.max = String(end);
  }

  function renderTime() {
    const { start, end } = span();
    const t = now();
    $('#time').textContent = `${fmtTime(t - start)} / ${fmtTime(end - start)}`;
    if (!seeking) $('#seek').value = String(t);
  }

  function renderPlay() {
    $('#play').textContent = clock.playing ? '❚❚' : '▶';
  }

  function renderAudioMode() {
    $('#audio-mode').textContent = room.audioMode === 'main' ? `Звук: ${camLabel(room.cameras[0])}` : 'Звук: активный ракурс';
  }

  function renderOffset() {
    const c = cam(active);
    if (c) $('#offset-val').textContent = fmtOffset(c.offset);
  }

  // ---------- input ----------

  function bindUI() {
    $('#start').addEventListener('click', play);
    $('#play').addEventListener('click', () => (clock.playing ? pause() : play()));

    const seek = $('#seek');
    seek.addEventListener('input', () => {
      seeking = true;
      $('#time').textContent = `${fmtTime(Number(seek.value) - span().start)} / ${fmtTime(span().end - span().start)}`;
    });
    seek.addEventListener('change', () => {
      seeking = false;
      seekTo(Number(seek.value));
    });

    $('#volume').addEventListener('input', (e) => {
      prefs.volume = Number(e.target.value);
      prefs.muted = prefs.volume === 0;
      $('#mute').textContent = prefs.muted ? '🔇' : '🔊';
      savePrefs();
      applyAudio(true);
    });
    $('#mute').addEventListener('click', toggleMute);
    $('#audio-mode').addEventListener('click', () => setAudioMode(room.audioMode === 'main' ? 'active' : 'main'));
    $('#fullscreen').addEventListener('click', toggleFullscreen);
    document.querySelector('.offset').addEventListener('click', (e) => {
      const b = e.target.closest('[data-nudge]');
      if (b) nudge(Number(b.dataset.nudge));
    });

    const list = $('#cams');
    list.addEventListener('click', (e) => {
      const card = e.target.closest('[data-cam]');
      if (card) switchTo(card.dataset.cam);
    });
    list.addEventListener('mouseover', (e) => {
      const card = e.target.closest('[data-cam]');
      setHovered(card ? card.dataset.cam : null);
    });
    list.addEventListener('mouseleave', () => setHovered(null));

    document.addEventListener('keydown', onKey);
    bindMap();
  }

  function toggleMute() {
    prefs.muted = !prefs.muted;
    if (!prefs.muted && prefs.volume === 0) prefs.volume = 50;
    $('#mute').textContent = prefs.muted ? '🔇' : '🔊';
    $('#volume').value = String(prefs.muted ? 0 : prefs.volume);
    savePrefs();
    applyAudio(true);
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  }

  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target instanceof Element && e.target.closest('input[type="text"], textarea')) return;
    const code = e.code;
    let handled = true;
    if (/^Digit[1-9]$/.test(code)) {
      const idx = Number(code.slice(5)) - 1;
      if (idx < room.cameras.length) switchTo(room.cameras[idx].videoId);
    } else if (code === 'KeyQ' || code === 'KeyE') step(code === 'KeyE' ? 1 : -1);
    else if (code === 'KeyW') moveDir('up');
    else if (code === 'KeyS') moveDir('down');
    else if (code === 'KeyA') moveDir('left');
    else if (code === 'KeyD') moveDir('right');
    else if (code === 'Space' || code === 'KeyK') clock.playing ? pause() : play();
    else if (code === 'ArrowLeft' || code === 'ArrowRight') seekTo(now() + (code === 'ArrowRight' ? 5 : -5));
    else if (code === 'KeyJ' || code === 'KeyL') seekTo(now() + (code === 'KeyL' ? 10 : -10));
    else if (code === 'BracketLeft' || code === 'BracketRight') nudge(code === 'BracketRight' ? 0.1 : -0.1);
    else if (code === 'KeyM') toggleMute();
    else if (code === 'KeyF') toggleFullscreen();
    else handled = false;
    if (handled) {
      e.preventDefault();
      // Otherwise arrows also move a focused slider and Space re-clicks a focused button.
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLButtonElement) el.blur();
    }
  }

  // ---------- init ----------

  async function init() {
    const fromHash = VR.decodeRoomHash(location.hash);
    room = fromHash.room;

    if (fromHash.roomId) {
      try {
        store = await connectStore(fromHash.roomId);
        const stored = store && (await store.load());
        if (stored) {
          room = stored;
          canSave = true;
          store.watch(onStoredRoom);
        }
      } catch (err) {
        console.warn('[Videoroom] storage unavailable', err);
      }
    }

    if (!room) {
      banner('Комната не найдена. Откройте кинозал из виджета под видео на YouTube или из меню расширения.');
      $('#start').hidden = true;
      return;
    }
    if (!canSave) {
      toast('Сдвиги не сохраняются: расширение Videoroom не найдено');
    }

    active = cam(fromHash.cam) ? fromHash.cam : room.cameras[0].videoId;
    setClock(fromHash.t || cam(active).offset);

    bindUI();
    renderAll();
    updatePool();
    updatePoster();
    setInterval(tick, TICK);
  }

  init();
})();
