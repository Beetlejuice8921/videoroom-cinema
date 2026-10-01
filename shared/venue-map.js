// Venue mini-map: the stage (top centre by default), cameras as numbered pins.
// Click a pin to switch; in edit mode (✎) drag pins to where cameras stood
// and the stage to where it was.
// Used by the cinema page and the strip under the YouTube player, so it builds
// DOM without innerHTML (youtube.com enforces Trusted Types).
(() => {
  'use strict';

  const VR = globalThis.VR;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  class VenueMap {
    // opts: {
    //   getRoom(), getActive(),
    //   isUnavailable(videoId) → bool  (greyed out),
    //   label(cam) → string,
    //   onSelect(videoId), onMove(videoId, {x, y}), onStageMove({x, y}), onEditToggle(editing)
    // }
    constructor(opts) {
      this.o = opts;
      this.pins = new Map();
      this.editing = false;
      this.drag = null;

      this.el = el('div', 'vmap');
      this.el.title = 'Карта площадки: клик — переключить ракурс';
      this.stageEl = el('div', 'vmap-stage', 'СЦЕНА');
      this.el.append(this.stageEl);
      this.editBtn = el('button', 'vmap-edit', '✎');
      this.editBtn.type = 'button';
      this.editBtn.title = 'Расставить камеры на карте';
      this.el.append(this.editBtn);

      this.editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setEditing(!this.editing);
      });
      this.el.addEventListener('pointerdown', (e) => this.onDown(e));
      this.el.addEventListener('pointermove', (e) => this.onMoveEvt(e));
      this.el.addEventListener('pointerup', () => this.onUp());
      this.el.addEventListener('pointercancel', () => this.onUp());
      this.el.addEventListener('click', (e) => {
        const pin = e.target.closest('.vmap-pin');
        if (!pin || this.justDragged) return;
        e.stopPropagation();
        this.o.onSelect(pin.dataset.cam);
      });
    }

    setEditing(on) {
      this.editing = on;
      this.el.classList.toggle('vmap-editing', on);
      this.stageEl.title = on ? 'Перетащите сцену' : '';
      this.o.onEditToggle?.(on);
    }

    render() {
      for (const pin of this.pins.values()) pin.remove();
      this.pins.clear();
      const room = this.o.getRoom();
      this.place(this.stageEl, VR.stagePos(room));
      this.stageEl.title = this.editing ? 'Перетащите сцену' : '';
      room.cameras.forEach((c, i) => {
        const pin = el('button', c.pos ? 'vmap-pin' : 'vmap-pin vmap-auto', String(i + 1));
        pin.type = 'button';
        pin.dataset.cam = c.videoId;
        pin.title = this.o.label(c);
        this.place(pin, VR.camPos(room, c.videoId));
        this.pins.set(c.videoId, pin);
        this.el.append(pin);
      });
      this.update();
    }

    update() {
      const active = this.o.getActive();
      for (const [id, pin] of this.pins) {
        pin.classList.toggle('vmap-active', id === active);
        pin.classList.toggle('vmap-off', !!this.o.isUnavailable?.(id));
      }
    }

    place(pin, pos) {
      pin.style.left = `${pos.x * 100}%`;
      pin.style.top = `${pos.y * 100}%`;
    }

    onDown(e) {
      if (!this.editing) return;
      const pin = e.target.closest('.vmap-pin') || (e.target === this.stageEl ? this.stageEl : null);
      if (!pin) return;
      e.preventDefault();
      this.drag = { pin, id: pin === this.stageEl ? null : pin.dataset.cam, pos: null };
      pin.setPointerCapture?.(e.pointerId);
      pin.classList.add('vmap-dragging');
    }

    onMoveEvt(e) {
      if (!this.drag) return;
      const r = this.el.getBoundingClientRect();
      this.drag.pos = {
        x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
        y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
      };
      this.place(this.drag.pin, this.drag.pos);
    }

    onUp() {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      d.pin.classList.remove('vmap-dragging');
      if (!d.pos) return;
      const pos = { x: VR.round2(d.pos.x), y: VR.round2(d.pos.y) };
      if (d.id) {
        d.pin.classList.remove('vmap-auto');
        this.o.onMove(d.id, pos);
      } else {
        this.o.onStageMove?.(pos);
      }
      // The click that follows a drag must not switch cameras.
      this.justDragged = true;
      setTimeout(() => (this.justDragged = false));
    }
  }

  globalThis.VRVenueMap = VenueMap;
})();
