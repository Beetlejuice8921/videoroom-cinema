// Minimal YouTube embed controller that speaks the IFrame API postMessage
// protocol directly. MV3 content scripts can't load the remote iframe_api
// script, but the protocol it uses is plain postMessage, so we drive it here.
(() => {
  'use strict';

  const ORIGIN = 'https://www.youtube.com';
  let nextId = 1;

  // YouTube player states.
  const S = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

  class EmbedPlayer {
    constructor(videoId, startSeconds, container) {
      this.videoId = videoId;
      this.id = nextId++;
      this.ready = false;
      this.everPlayed = false;
      this.state = S.UNSTARTED;
      this.time = Math.max(0, startSeconds);
      this.timeAt = performance.now();
      this.duration = 0;
      this.rate = 1;
      this.muted = true;
      this.error = null;
      this.lastSeekAt = 0;
      this.onReady = null;
      this.onError = null;
      this.onInfo = null;

      const params = new URLSearchParams({
        enablejsapi: '1',
        origin: location.origin,
        autoplay: '1',
        mute: '1',
        controls: '0',
        disablekb: '1',
        playsinline: '1',
        rel: '0',
        iv_load_policy: '3',
        fs: '0',
        start: String(Math.floor(Math.max(0, startSeconds))),
      });
      const iframe = document.createElement('iframe');
      iframe.src = `${ORIGIN}/embed/${videoId}?${params}`;
      iframe.allow = 'autoplay; encrypted-media';
      iframe.setAttribute('tabindex', '-1');
      this.iframe = iframe;

      this._onMessage = this._onMessage.bind(this);
      window.addEventListener('message', this._onMessage);
      iframe.addEventListener('load', () => this._handshake());
      container.appendChild(iframe);
    }

    // Like the official API: repeat "listening" until the player answers.
    _handshake() {
      clearInterval(this._hsTimer);
      let tries = 0;
      const ping = () => {
        if (this.ready || ++tries > 60) return clearInterval(this._hsTimer);
        this._post({ event: 'listening', id: this.id, channel: 'widget' });
      };
      ping();
      this._hsTimer = setInterval(ping, 250);
    }

    _post(msg) {
      try {
        this.iframe.contentWindow?.postMessage(JSON.stringify(msg), ORIGIN);
      } catch {
        // iframe is being torn down
      }
    }

    command(func, ...args) {
      this._post({ event: 'command', func, args, id: this.id, channel: 'widget' });
    }

    _onMessage(e) {
      if (e.origin !== ORIGIN || e.source !== this.iframe.contentWindow) return;
      let data;
      try {
        data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      } catch {
        return;
      }
      if (!data || typeof data.event !== 'string') return;

      if (!this.ready && data.event !== 'onError') this._markReady();

      switch (data.event) {
        case 'initialDelivery':
        case 'infoDelivery':
          this._applyInfo(data.info);
          break;
        case 'onStateChange':
          this._applyInfo({ playerState: data.info });
          break;
        case 'onError':
          this.error = data.info;
          this.onError?.(data.info);
          break;
      }
    }

    _markReady() {
      this.ready = true;
      clearInterval(this._hsTimer);
      this.command('addEventListener', 'onStateChange');
      this.command('addEventListener', 'onError');
      this.onReady?.();
    }

    _applyInfo(info) {
      if (!info || typeof info !== 'object') return;
      if (typeof info.playerState === 'number') {
        this.state = info.playerState;
        if (this.state === S.PLAYING) this.everPlayed = true;
      }
      if (typeof info.currentTime === 'number') {
        this.time = info.currentTime;
        this.timeAt = performance.now();
      }
      if (typeof info.duration === 'number' && info.duration > 0) this.duration = info.duration;
      if (typeof info.playbackRate === 'number') this.rate = info.playbackRate;
      if (typeof info.muted === 'boolean') this.muted = info.muted;
      this.onInfo?.(info);
    }

    get playing() {
      return this.state === S.PLAYING;
    }

    // Current position, extrapolated between infoDelivery updates.
    estimateTime() {
      if (this.state !== S.PLAYING) return this.time;
      return this.time + ((performance.now() - this.timeAt) / 1000) * this.rate;
    }

    play() {
      this.command('playVideo');
    }

    pause() {
      this.command('pauseVideo');
      this.state = S.PAUSED;
      this.time = this.estimateTime();
      this.timeAt = performance.now();
    }

    seek(t) {
      t = Math.max(0, t);
      this.command('seekTo', t, true);
      this.time = t;
      this.timeAt = performance.now();
      this.lastSeekAt = this.timeAt;
    }

    mute() {
      this.command('mute');
      this.muted = true;
    }

    unMute() {
      this.command('unMute');
      this.muted = false;
    }

    setVolume(v) {
      this.command('setVolume', Math.round(v));
    }

    setRate(r) {
      this.command('setPlaybackRate', r);
      this.rate = r;
    }

    destroy() {
      clearInterval(this._hsTimer);
      window.removeEventListener('message', this._onMessage);
      this.iframe.remove();
    }
  }

  EmbedPlayer.State = S;
  globalThis.VREmbedPlayer = EmbedPlayer;
})();
