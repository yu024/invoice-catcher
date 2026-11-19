/* 虚拟时钟：接管 Date / 定时器 / rAF / CSS 动画，让渲染器逐帧推进，保证视频时间与画面严格一致。 */
(function () {
  'use strict';
  const BASE = new Date('2026-11-19T10:24:06+08:00').getTime();
  const RealDate = Date;
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  let rafs = [];

  function FakeDate(...args) {
    if (!(this instanceof FakeDate)) return new RealDate(BASE + now).toString();
    return args.length ? new RealDate(...args) : new RealDate(BASE + now);
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = () => BASE + now;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  window.Date = FakeDate;

  try {
    Object.defineProperty(performance, 'now', { value: () => now, configurable: true });
  } catch (e) {}

  window.setTimeout = (fn, ms, ...args) => {
    const id = nextId++;
    timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, args, every: 0 });
    return id;
  };
  window.setInterval = (fn, ms, ...args) => {
    const id = nextId++;
    const every = Math.max(1, Number(ms) || 1);
    timers.set(id, { at: now + every, fn, args, every });
    return id;
  };
  window.clearTimeout = window.clearInterval = (id) => timers.delete(id);
  window.requestAnimationFrame = (fn) => {
    const id = nextId++;
    rafs.push({ id, fn });
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    rafs = rafs.filter((r) => r.id !== id);
  };

  function syncAnimations() {
    if (!document.getAnimations) return;
    for (const anim of document.getAnimations()) {
      if (anim.__vstart === undefined) anim.__vstart = now;
      try {
        anim.pause();
        anim.currentTime = now - anim.__vstart;
      } catch (e) {}
    }
  }

  window.__clock = {
    get now() {
      return now;
    },
    advance(ms) {
      const target = now + ms;
      for (let guard = 0; guard < 10000; guard++) {
        let dueId = null;
        let due = null;
        for (const [id, t] of timers) {
          if (t.at <= target && (!due || t.at < due.at)) {
            due = t;
            dueId = id;
          }
        }
        if (!due) break;
        now = Math.max(now, due.at);
        if (due.every) due.at += due.every;
        else timers.delete(dueId);
        try {
          due.fn(...due.args);
        } catch (e) {
          console.error(e);
        }
      }
      now = target;
      const batch = rafs;
      rafs = [];
      for (const r of batch) {
        try {
          r.fn(now);
        } catch (e) {
          console.error(e);
        }
      }
      syncAnimations();
    },
  };
})();
