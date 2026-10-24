// Adapted from the supplied Fieldglow flight engine; local anchors and shared pause control.
import { BUTTERFLIES, DEFS_SPRITE } from "./fieldglow-butterfly-art.js";

// Anchored flocks matching the approved Fieldglow mockup. Selectors are the live
// class names in public/app.js (renderLanding / renderProfile), not the mockup's.
// [selector, style, sizePx, mode, ax, ay, speed, desktopOnly]
//   mode "cross": flies across the anchor; speed = px/s (sign = direction)
//   mode "hover": loops around (ax, ay) inside the anchor; speed = loop rate multiplier
export const PRESETS = {
  about: [
    [null, "line", 66, "hover", .48, .16, .8],
    [null, "dot", 34, "hover", .78, .27, 1.2],
    [null, "stippleB", 26, "hover", .19, .6, .9, true],
    [null, "lineC", 22, "hover", .63, .79, 1.1, true],
    [null, "lineC", 46, "hover", .3, .43, 1.1],
    [null, "dot", 28, "hover", .62, .57, 1.3, true],
  ],
  roomsHero: [
    [null, "line", 76, "hover", .53, .05, .8],
    [null, "dot", 50, "cross", .25, .91, 22],
    [null, "stippleB", 26, "hover", .96, .12, 1.2, true],
    [null, "hatch", 32, "hover", .04, .79, .9],
  ],
  roomsPerspectives: [
    [null, "lineC", 58, "hover", .91, .1, .8],
    [null, "stippleB", 26, "hover", .6, .91, 1.1, true],
  ],
  roomsQuestions: [
    [null, "line", 72, "hover", .18, .34, .75],
    [null, "dot", 42, "hover", .08, .76, 1.2],
    [null, "stippleB", 28, "hover", .29, .56, .9, true],
  ],
  hero: [
    [".swarm-hero", "line", 86, "hover", .53, .12, 1],
    [".swarm-hero", "dot", 58, "cross", .72, .88, 24],
    [".swarm-hero", "stippleB", 30, "hover", .95, .10, 1.1, true],
    [".swarm-hero", "lineC", 36, "hover", .04, .8, 1.2],
    [".swarm-hero", "dot", 22, "hover", .55, .7, 1.4, true],
  ],
  // One coral butterfly in each blue connect card (/rooms and the home strip).
  roomsConnect: [
    [null, "dot", 40, "hover", .52, .16, 1.1],
  ],
  connectStrip: [
    [null, "dot", 34, "hover", .56, .22, 1.2],
  ],
  roomsGarden: [
    [null, "lineC", 20, "ceiling", .43, .13, 1.1],
    [null, "dot", 16, "ceiling", .65, .11, 1.4],
  ],
  closing: [
    [".closing-botanical", "line", 78, "flowerArc", 0, 0, 1.2],
    [null, "dot", 42, "hover", .91, .67, 1.1],
    [null, "stippleB", 28, "hover", .64, .83, 1.3, true],
  ],
};

const DEFAULTS = {
  preset: null, // "front" | "profile" | null (null -> auto-scatter using count/density)
  count: 14, // hard maximum on desktop
  mobileCap: 6, // hard maximum at or below mobileBreakpoint
  mobileBreakpoint: 700,
  mobileScale: 0.72,
  size: [13, 96], // px, min/max wingspan (auto-scatter; presets carry their own sizes)
  styles: ["dot", "line", "stipple", "hatch", "lineC", "stippleB"],
  density: 1.1, // butterflies per 100,000 px² of host (auto-scatter), capped by count
  keepOut:
    "h1, h2, h3, p, li > b, a, button, summary, code, input, textarea, select, label, .ld-room, .ld-cta-actions, .me-pill, .me-row, .ws-nav, .me-actions, [data-fg-keepout]",
  keepOutPad: 10,
  zIndex: 0, // layer z-index; give host content position:relative; z-index:1
  reducedMotion: "static", // "static" | "hide"
  startDelay: 400, // ms after idle before the first frame
  seed: 7,
};

const rng = (seed) => () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

export function mountButterflies(host, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const noop = { destroy() {}, pause() {}, resume() {} };
  if (!host) return noop;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  if (reduce.matches && o.reducedMotion === "hide") return noop;
  const small = matchMedia(`(max-width: ${o.mobileBreakpoint}px)`);

  const layer = document.createElement("div");
  layer.className = "fg-flutter";
  layer.dataset.preset = o.preset || "custom";
  layer.setAttribute("aria-hidden", "true");
  layer.style.zIndex = String(o.zIndex);
  if (!document.querySelector("svg.fg-defs"))
    document.body.insertAdjacentHTML("afterbegin", DEFS_SPRITE);
  if (getComputedStyle(host).position === "static")
    host.style.position = "relative";
  host.prepend(layer);

  let birds = [],
    keep = [],
    raf = 0,
    running = false,
    visible = true,
    destroyed = false,
    lastMeasure = 0;
  let elapsed = 4.2, lastFrame = null;

  function plan() {
    const rand = rng(o.seed);
    let list;
    if (o.preset && PRESETS[o.preset]) {
      list = PRESETS[o.preset].map(
        ([sel, style, size, mode, ax, ay, speed, desktopOnly]) => ({
          sel, style, size, mode, ax, ay, speed, desktopOnly,
        }),
      );
    } else {
      const area = host.offsetWidth * host.offsetHeight;
      const n = Math.min(o.count, Math.round((area / 1e5) * o.density));
      list = Array.from({ length: n }, (_, i) => ({
        sel: null,
        style: o.styles[i % o.styles.length],
        size: o.size[0] + (o.size[1] - o.size[0]) * Math.pow(rand(), 2), // mostly small
        mode: rand() < 0.2 ? "cross" : "hover",
        ax: rand(),
        ay: rand(),
        speed: rand() < 0.5 ? 0.8 + rand() : -(20 + rand() * 20),
        desktopOnly: i % 2 === 1,
      }));
    }
    if (small.matches)
      list = list.filter((b) => !b.desktopOnly).slice(0, o.mobileCap);
    else list = list.slice(0, o.count);
    return list;
  }

  function build() {
    layer.textContent = "";
    birds = plan().map((b, i) => {
      const size = small.matches ? Math.max(12, b.size * o.mobileScale) : b.size;
      const el = document.createElement("div");
      el.className = "bf";
      el.dataset.style = b.style;
      el.style.width = `${size}px`;
      el.style.height = `${(size * 76) / 92}px`;
      const dur = (b.mode === "flowerArc" ? .32 : 0.26 + size / 240 + (i % 3) * 0.04).toFixed(2);
      el.innerHTML = (BUTTERFLIES[b.style] || BUTTERFLIES.line).replace(
        /__DUR__/g,
        `${dur}s`,
      );
      layer.append(el);
      return { ...b, el, size, dur: +dur, seed: i * 1.731 + size * 0.07, rect: null, x: null, y: null };
    });
    measure();
    if (reduce.matches || document.hidden || document.documentElement.dataset.motionPaused === "true") {
      layer.querySelectorAll("svg").forEach((s) => s.pauseAnimations?.());
      place(4.2, false);
    }
  }

  function measure() {
    const h = host.getBoundingClientRect();
    const rel = (r) => ({ x: r.left - h.left, y: r.top - h.top, w: r.width, h: r.height });
    for (const b of birds) {
      const t = b.sel ? host.querySelector(b.sel) : host;
      const r = t && t.getClientRects().length ? t.getBoundingClientRect() : null;
      // hidden anchors (e.g. an inactive workspace panel) have no box: skip, don't pile up at 0,0
      b.rect = r && r.width && r.height ? rel(r) : null;
    }
    // Text blocks (h1, p...) are measured by their line boxes, not the full-width block,
    // so butterflies can still fly in the empty space beside a short heading.
    const range = document.createRange();
    const boxes = (e) => {
      if (/^(A|BUTTON|INPUT|TEXTAREA|FIGURE|DIV|CODE)$/.test(e.tagName))
        return [e.getBoundingClientRect()];
      range.selectNodeContents(e);
      return [...range.getClientRects()];
    };
    keep = o.keepOut
      ? [...host.querySelectorAll(o.keepOut)]
          .filter((e) => e.offsetParent !== null && !layer.contains(e))
          .flatMap(boxes)
          .map(rel)
          .filter((r) => r.w && r.h)
          .map((r) => ({
            x: r.x - o.keepOutPad,
            y: r.y - o.keepOutPad,
            w: r.w + 2 * o.keepOutPad,
            h: r.h + 2 * o.keepOutPad,
          }))
      : [];
    lastMeasure = performance.now();
  }

  // Push a butterfly box (x,y,s) out of keep-out rects, to the nearest edge. A few passes,
  // because leaving one rect can land in another. Returns [x, y, clear].
  const hits = (x, y, s, bh, r) =>
    !(x + s < r.x || x > r.x + r.w || y + bh < r.y || y > r.y + r.h);
  function avoid(x, y, s) {
    const bh = (s * 76) / 92;
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (const r of keep) {
        if (!hits(x, y, s, bh, r)) continue;
        const left = x + s - r.x, right = r.x + r.w - x, up = y + bh - r.y, down = r.y + r.h - y;
        const m = Math.min(left, right, up, down);
        if (m === left) x -= left;
        else if (m === right) x += right;
        else if (m === up) y -= up;
        else y += down;
        moved = true;
      }
      if (!moved) return [x, y, true];
    }
    return [x, y, !keep.some((r) => hits(x, y, s, bh, r))];
  }

  function place(t, smooth = true) {
    const W = host.clientWidth;
    for (const b of birds) {
      if (!b.rect) {
        b.el.hidden = true;
        continue;
      }
      const r = b.rect, s = b.seed;
      let x, y, vx;
      if (b.mode === "flowerArc") {
        // The supplied daisy is 160×200, with its flower at (80,70).
        // Follow the bloom's upper arc, from ten o'clock to one o'clock.
        const scale = Math.min(r.w / 160, r.h / 200);
        const phase = t * .42 * b.speed;
        const angle = (-105 + 43 * Math.sin(phase) + 6 * Math.sin(phase * 2.3 + s)) * Math.PI / 180;
        const cx = r.x + r.w / 2;
        const cy = r.y + (r.h - 200 * scale) / 2 + 70 * scale;
        x = cx + (58 * scale + b.size * .45) * Math.cos(angle) - b.size / 2 + 5 * Math.sin(t * 2.1 + s);
        y = cy + (48 * scale + b.size * .25 + 4) * Math.sin(angle) - b.size * 38 / 92 + 7 * Math.sin(t * 1.7 + s);
        vx = .55 * Math.cos(phase) + .2 * Math.cos(t * 2.1 + s);
      } else if (b.mode === "ceiling") {
        const phase = t * b.speed;
        x = r.x + r.w * b.ax + 26 * Math.sin(phase * .7 + s) + 7 * Math.sin(phase * 1.9);
        y = r.y + r.h * b.ay + 5 * Math.sin(phase * 1.3 + s);
        vx = .6 * Math.cos(phase * .7 + s);
      } else if (b.mode === "cross") {
        const span = r.w + b.size * 4;
        const p = (((t * b.speed + b.ax * span) % span) + span) % span;
        x = r.x + (b.speed > 0 ? p : span - p) - b.size * 2;
        y = r.y + r.h * b.ay + 34 * Math.sin(t * 0.55 + s) + 12 * Math.sin(t * 1.9 + s * 2);
        vx = Math.sign(b.speed) + 0.4 * Math.cos(t * 0.55 + s);
      } else {
        const k = b.speed, rx = 46 + b.size * 0.9, ry = 22 + b.size * 0.45;
        x = r.x + r.w * b.ax + rx * Math.sin(t * 0.31 * k + s) + rx * 0.35 * Math.sin(t * 0.83 * k + s * 3);
        y = r.y + r.h * b.ay + ry * Math.sin(t * 0.47 * k + s * 2) + ry * 0.3 * Math.cos(t * 1.21 * k + s);
        vx = Math.cos(t * 0.31 * k + s) + 0.3 * Math.cos(t * 0.83 * k + s * 3);
      }
      y += Math.sin((t / b.dur) * Math.PI * 2) * b.size * 0.035; // lift on each wingbeat
      let clear;
      if (b.mode === "flowerArc") clear = true;
      else [x, y, clear] = avoid(x, y, b.size);
      x = Math.max(-b.size, Math.min(W, x));
      // ease toward the target so keep-out nudges don't jump
      if (smooth && b.x !== null) {
        x = b.x + (x - b.x) * 0.35;
        y = b.y + (y - b.y) * 0.35;
      }
      // still boxed in (dense text): fade out instead of sitting on top of it
      clear = clear && !keep.some((r) => hits(x, y, b.size, (b.size * 76) / 92, r));
      b.el.classList.toggle("is-tucked", !clear);
      b.x = x;
      b.y = y;
      const tilt = Math.max(-28, Math.min(28, vx * 20));
      b.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) rotate(${tilt.toFixed(1)}deg)`;
      b.el.hidden = false;
    }
  }

  function frame(now) {
    if (destroyed) return;
    if (!host.isConnected) return destroy();
    raf = requestAnimationFrame(frame);
    if (now - lastMeasure > 2000) measure();
    if (lastFrame !== null) elapsed += Math.min((now - lastFrame) / 1000, .05);
    lastFrame = now;
    place(elapsed);
  }
  function resume() {
    if (destroyed || running || reduce.matches || !visible || document.hidden || document.documentElement.dataset.motionPaused === "true") return;
    running = true;
    lastFrame = null;
    layer.querySelectorAll("svg").forEach((s) => s.unpauseAnimations?.());
    raf = requestAnimationFrame(frame);
  }
  function pause() {
    running = false;
    lastFrame = null;
    cancelAnimationFrame(raf);
    layer.querySelectorAll("svg").forEach((s) => s.pauseAnimations?.());
  }
  function restart() {
    pause();
    build();
    resume();
  }
  const motionObserver = new MutationObserver(() => {
    if (document.documentElement.dataset.motionPaused === "true") pause();
    else resume();
  });
  motionObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion-paused"] });
  const onVisibility = () => (document.hidden ? pause() : resume());
  const onResize = () => {
    measure();
    if (reduce.matches) place(4.2, false);
  };
  const io = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible) resume();
    else pause();
  });
  const ro = new ResizeObserver(onResize);
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    pause();
    io.disconnect();
    ro.disconnect();
    motionObserver.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
    reduce.removeEventListener("change", restart);
    small.removeEventListener("change", restart);
    host.removeEventListener("toggle", onResize, true);
    layer.remove();
  }

  // Lazy start: after first paint, when the browser is idle.
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
  idle(
    () =>
      setTimeout(() => {
        if (destroyed || !host.isConnected) return destroy();
        build();
        io.observe(host);
        ro.observe(host);
        document.addEventListener("visibilitychange", onVisibility);
        reduce.addEventListener("change", restart);
        small.addEventListener("change", restart);
        host.addEventListener("toggle", onResize, true); // FAQ <details> change height
        resume();
      }, o.startDelay),
    { timeout: 1500 },
  );
  return { destroy, pause, resume };
}
