// Shared room model + storage helpers (content script, popup, cinema page).
//
// Room shape:
// {
//   id: string,
//   name: string,
//   audioMode: 'main' | 'active',   // cinema audio: from camera 1 (continuous) or the active camera
//   cameras: [{ videoId, label, offset, duration? }],
//   updatedAt: number
// }
//
// offset — the moment (in seconds of the shared event timeline) at which the
// video starts. timeline = videoTime + offset, so cameras line up when
// their offsets are right.
(() => {
  'use strict';

  const ID_RE = /^[A-Za-z0-9_-]{11}$/;

  // YouTube refuses embeds on chrome-extension:// pages (error 153), so the
  // cinema is served from GitHub Pages (tools/publish-cinema.sh).
  const DEFAULT_CINEMA_URL = 'https://beetlejuice8921.github.io/videoroom-cinema/room/room.html';

  function parseVideoId(input) {
    if (!input) return null;
    const s = String(input).trim();
    if (ID_RE.test(s)) return s;
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s);
    } catch {
      return null;
    }
    const host = url.hostname.replace(/^(www|m)\./, '');
    if (host === 'youtu.be') {
      const id = url.pathname.slice(1).split('/')[0];
      return ID_RE.test(id) ? id : null;
    }
    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      const v = url.searchParams.get('v');
      if (v && ID_RE.test(v)) return v;
      const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
      if (m) return m[1];
    }
    return null;
  }

  function newRoomId() {
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  function clamp01(n) {
    return Math.min(1, Math.max(0, Math.round(n * 1000) / 1000));
  }

  // ---------- venue map ----------

  // Unplaced cameras sit on an arc facing the stage, in list order left→right,
  // so A/D behave like previous/next until the user arranges the map.
  function defaultPos(index, count) {
    const f = count < 2 ? 0.5 : index / (count - 1);
    return { x: round2(0.12 + 0.76 * f), y: round2(0.55 + 0.15 * Math.sin(Math.PI * f)) };
  }

  function camPos(room, videoId) {
    const i = room.cameras.findIndex((c) => c.videoId === videoId);
    return room.cameras[i]?.pos || defaultPos(i, room.cameras.length);
  }

  // Stage centre on the map (movable in the map editor); top centre by default.
  const DEFAULT_STAGE = { x: 0.5, y: 0.1 };
  function stagePos(room) {
    return room.stage || DEFAULT_STAGE;
  }

  // WASD: the camera that lies most in the given direction from the current one,
  // as seen by a viewer facing the stage: up = towards the stage, down = away,
  // left/right across. Prefers near cameras within ±60° of the direction.
  function pickDirection(room, fromId, dir, skip = () => false) {
    const p = camPos(room, fromId);
    const s = stagePos(room);
    let fx = s.x - p.x;
    let fy = s.y - p.y;
    const fl = Math.hypot(fx, fy);
    if (fl < 1e-6) [fx, fy] = [0, -1];
    else [fx, fy] = [fx / fl, fy / fl];
    const [dx, dy] = { up: [fx, fy], down: [-fx, -fy], left: [fy, -fx], right: [-fy, fx] }[dir];
    let best = null;
    let bestScore = Infinity;
    for (const c of room.cameras) {
      if (c.videoId === fromId || skip(c.videoId)) continue;
      const q = camPos(room, c.videoId);
      const vx = q.x - p.x;
      const vy = q.y - p.y;
      const dist = Math.hypot(vx, vy);
      if (dist < 1e-6) continue;
      const cos = (vx * dx + vy * dy) / dist;
      if (cos < 0.5) continue;
      const score = dist * (1 + 2 * (1 - cos));
      if (score < bestScore) {
        bestScore = score;
        best = c.videoId;
      }
    }
    return best;
  }

  // Coerces untrusted input (import, old storage) into a valid room.
  function normalizeRoom(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const seen = new Set();
    const cameras = [];
    for (const c of Array.isArray(obj.cameras) ? obj.cameras : []) {
      const videoId = parseVideoId(c && (c.videoId || c.url));
      if (!videoId || seen.has(videoId)) continue;
      seen.add(videoId);
      const offset = Number(c.offset);
      const duration = Number(c.duration);
      const cam = {
        videoId,
        label: typeof c.label === 'string' ? c.label.slice(0, 80) : '',
        offset: Number.isFinite(offset) ? round2(offset) : 0,
      };
      // Learned from the players; lets us tell when a camera wasn't recording.
      if (Number.isFinite(duration) && duration > 0) cam.duration = round2(duration);
      // Position on the venue mini-map, 0..1 (stage at the top).
      const x = Number(c.pos?.x);
      const y = Number(c.pos?.y);
      if (Number.isFinite(x) && Number.isFinite(y)) cam.pos = { x: clamp01(x), y: clamp01(y) };
      cameras.push(cam);
    }
    if (!cameras.length) return null;
    const sx = Number(obj.stage?.x);
    const sy = Number(obj.stage?.y);
    const stage = Number.isFinite(sx) && Number.isFinite(sy) ? { stage: { x: clamp01(sx), y: clamp01(sy) } } : {};
    return {
      ...stage,
      id: typeof obj.id === 'string' && obj.id ? obj.id : newRoomId(),
      name: typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim().slice(0, 120) : 'Без названия',
      audioMode: obj.audioMode === 'active' ? 'active' : 'main',
      cameras,
      updatedAt: Number(obj.updatedAt) || Date.now(),
    };
  }

  // Cinema page link. The room itself travels in the hash too, so the page
  // also works when hosted outside the extension (no chrome.storage there).
  function encodeRoomHash({ room, cam, t }) {
    const { name, audioMode, cameras, stage } = room;
    const json = JSON.stringify({ name, audioMode, cameras, stage });
    const data = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
    const p = new URLSearchParams({ room: room.id, data });
    if (cam) p.set('cam', cam);
    if (Number.isFinite(t)) p.set('t', t.toFixed(2));
    return '#' + p.toString();
  }

  function decodeRoomHash(hash) {
    const p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    let room = null;
    try {
      const bytes = Uint8Array.from(atob(p.get('data') || ''), (ch) => ch.charCodeAt(0));
      room = normalizeRoom({ ...JSON.parse(new TextDecoder().decode(bytes)), id: p.get('room') || undefined });
    } catch {
      room = null;
    }
    const t = Number(p.get('t'));
    return { roomId: p.get('room'), room, cam: parseVideoId(p.get('cam') || ''), t: Number.isFinite(t) ? t : 0 };
  }

  const hasStorage = () => !!globalThis.chrome?.storage?.local;

  async function loadSettings() {
    if (!hasStorage()) return {};
    const { settings } = await chrome.storage.local.get('settings');
    return settings && typeof settings === 'object' ? settings : {};
  }

  async function saveSettings(settings) {
    await chrome.storage.local.set({ settings });
  }

  async function cinemaUrl() {
    return (await loadSettings()).cinemaUrl || DEFAULT_CINEMA_URL;
  }

  async function loadRooms() {
    const { rooms } = await chrome.storage.local.get('rooms');
    return rooms && typeof rooms === 'object' ? rooms : {};
  }

  async function saveRoom(room) {
    const rooms = await loadRooms();
    room.updatedAt = Date.now();
    rooms[room.id] = room;
    await chrome.storage.local.set({ rooms });
    return room;
  }

  async function deleteRoom(id) {
    const rooms = await loadRooms();
    delete rooms[id];
    await chrome.storage.local.set({ rooms });
  }

  function findRoomByVideo(rooms, videoId) {
    if (!videoId) return null;
    return Object.values(rooms).find((r) => r.cameras.some((c) => c.videoId === videoId)) || null;
  }

  function thumbUrl(videoId, size = 'mqdefault') {
    return `https://i.ytimg.com/vi/${videoId}/${size}.jpg`;
  }

  globalThis.VR = {
    parseVideoId,
    newRoomId,
    normalizeRoom,
    loadRooms,
    saveRoom,
    deleteRoom,
    findRoomByVideo,
    thumbUrl,
    round2,
    encodeRoomHash,
    decodeRoomHash,
    hasStorage,
    loadSettings,
    saveSettings,
    cinemaUrl,
    DEFAULT_CINEMA_URL,
    defaultPos,
    camPos,
    stagePos,
    pickDirection,
  };
})();
