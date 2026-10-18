import { ScreenCurve } from "./crt";
import { type Jackpot } from "./jackpot";
import { Board, footprint, key, DIRS, jackAt } from "./geometry";
import { Wiring, SPEED, PULSE_LIFETIME, arcPoints, pointAt, arcDist, type Arrival } from "./signals";
import { PARTS, CORE, UNIT, SEG, DIGIT, type Layer, type Anim } from "./parts.gen";

// CPU-friendly: every layer of every part is rasterized once per zoom level from its SVG (art/parts.mjs).
// Each frame draws those bitmaps; moving layers only get a transform, an opacity or a clip.
//
// Signals (signals.ts): every mint sends light from the core through the actual wiring. It runs around each
// module's border and jumps across the cable leads where jacks are plugged together. Clicking a part sends one
// from that part. Parts it passes speed up for a moment.
// A legendary reveal sets the whole machine off.

const LIT = "#39d353", ALARM = "#ff6b62", MINE = "#ff8a3d";
/** rarity colours (style.css --common .. --seat) */
const CORE_CELLS = [-1, 0, 1].flatMap((y) => [-1, 0, 1].map((x) => [x, y]));

export interface Ghost {
  design: number;
  rot: number;
  x: number;
  y: number;
  ok: boolean;
  draft?: boolean; // arranged, waiting for the build transaction
  selected?: boolean; // the draft the toolbar is on
}

/** current value of an animation at time t (seconds) */
function sample(a: Anim, t: number, values: number[]): number;
function sample(a: Anim, t: number, values: number[][]): number[];
function sample(a: Anim, t: number, values: any[]): any {
  const u = (((t / a.dur + (a.phase ?? 0)) % 1) + 1) % 1;
  const n = values.length;
  if (a.ease === "step") return values[Math.min(n - 1, Math.floor(u * n))];
  const x = u * (n - 1), i = Math.min(n - 2, Math.floor(x));
  let f = x - i;
  if (a.ease === "sin") f = (1 - Math.cos(Math.PI * f)) / 2;
  const lerp = (p: number, q: number) => p + (q - p) * f;
  return Array.isArray(values[0]) ? values[0].map((_: number, k: number) => lerp(values[i][k], values[i + 1][k])) : lerp(values[i], values[i + 1]);
}

/** layer bitmaps, rasterized lazily per scale bucket */
class Sprites {
  private imgs = new Map<string, HTMLImageElement>();
  private ready = new Set<string>();
  private bitmaps = new Map<string, HTMLCanvasElement>();
  private budget = 0;
  pending = true;

  constructor() {
    PARTS.forEach((p) => p.layers.forEach((l, i) => this.load(`${p.id}:${i}`, l, p.w, p.h)));
    CORE.forEach((l, i) => this.load(`core:${i}`, l, 3, 3));
  }

  private load(id: string, l: Layer, w: number, h: number) {
    const [x, y, bw, bh] = l.box ?? [0, 0, w * UNIT, h * UNIT];
    const img = new Image();
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${bw} ${bh}" width="${bw}" height="${bh}">${l.svg}</svg>`);
    img.decode().then(() => this.ready.add(id), () => {});
    this.imgs.set(id, img);
  }

  /** call once per frame: limits how many bitmaps a zoom change rasterizes per frame */
  tick() {
    this.budget = 16;
    this.pending = false;
  }

  /** the bitmap of layer `id` for `pxPerUnit` device pixels per unit, or the nearest one already made */
  get(id: string, box: number[], pxPerUnit: number): CanvasImageSource | null {
    if (!this.ready.has(id)) {
      this.pending = true;
      return null;
    }
    const bucket = Math.max(-12, Math.min(9, Math.ceil(Math.log2(pxPerUnit) * 3)));
    const k = `${id}@${bucket}`;
    let c = this.bitmaps.get(k);
    if (c) return c;
    if (this.budget-- <= 0) {
      this.pending = true;
      for (let d = 1; d < 24; d++) {
        const near = this.bitmaps.get(`${id}@${bucket - d}`) ?? this.bitmaps.get(`${id}@${bucket + d}`);
        if (near) return near;
      }
      return null;
    }
    const s = 2 ** (bucket / 3);
    c = document.createElement("canvas");
    c.width = Math.max(1, Math.ceil(box[2] * s));
    c.height = Math.max(1, Math.ceil(box[3] * s));
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(this.imgs.get(id)!, 0, 0, c.width, c.height);
    this.bitmaps.set(k, c);
    return c;
  }
}

const TAIL = 1.4; // cells of fading light behind a signal's front
const DETAIL_IN = 24, DETAIL_OUT = 20; // zoom hysteresis avoids flickering between tiles and layers
const TILE = 16; // cells per side of a cached tile when zoomed out
const TILE_RENDERS = 6; // tiles rendered per frame at most

/** the bounding box of a footprint: x, y, width, height in cells */
function bboxOf(fp: number[][]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of fp) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}

/** a signal running through the wiring: its age, when it reaches each part, how long it lasts, its colours */
interface Pulse { t: number; arr: Map<number, Arrival>; life: number; rgb: readonly [string, string, string]; width: number }
const GREEN = ["57,211,83", "176,237,186", "200,255,210"] as const;
const GOLD = ["255,201,60", "255,226,140", "255,242,205"] as const; // legendary gold: the prize going out
const power = (p: Pulse) => Math.max(0, 1 - p.t / p.life) ** 2;
/** the round's end, in seconds: the celebration, the prize places lighting up, the machine taken apart outside in */
const OUTRO = { gold: 1.2, take: 3.4, takeFor: 3.0, die: 0.55, after: 0.5 };

export class Renderer {
  jackpot: Jackpot | null = null;
  ctx: CanvasRenderingContext2D;
  cam = { x: 0.5, y: 0.5, z: 2.2 };
  cell = 24; // screen px per grid cell at zoom 1
  ghost: Ghost | null = null;
  /** empty cells where the picked part can plug in (shown while placing) */
  hints: [number, number][] = [];
  hover: number | null = null;
  picked: number | null = null; // the part whose card is open
  selected: number | null = null; // a selected draft
  me = "";
  time = 0;
  reducedMotion = false;
  private performance = false;
  private detailed = true;
  private snapshot = "";
  private needsFrame = true;
  private sprites = new Sprites();
  private curve: ScreenCurve;
  private dpr = 1;
  private dt = 0;
  private pulses: Pulse[] = [];
  private fresh = new Map<number, number>();
  private clocks = new Map<number, number>(); // each part's own animation time (it runs faster when energized)
  private alarm = 0;
  private wiring: Wiring;
  // zoomed-out tiles: which parts touch each tile, and each tile's last bitmap: the scale it was made at, how many of
  // the tile's parts it holds, and whether a neighbour's change (lit jacks) has made it out of date. An old bitmap
  // stays on screen until its replacement is ready, so zooming and new parts never leave empty squares.
  private tileParts = new Map<string, number[]>();
  private tileIndexed = new Set<number>();
  private tileEpoch = -1;
  private tileBitmaps = new Map<string, { c: HTMLCanvasElement; scale: number; n: number; stale: boolean }>();
  /** live numbers shown by parts with a display */
  stats = { minted: 0, paid: 0 };
  private last = 0;

  constructor(public canvas: HTMLCanvasElement, public board: Board, crt = true) {
    this.curve = new ScreenCurve(crt);
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    this.wiring = new Wiring(board);
  }

  get cs() {
    return this.cell * this.cam.z;
  }

  get performanceMode() { return this.performance; }
  set performanceMode(on: boolean) {
    if (on === this.performance) return;
    this.performance = on;
    this.pulses = [];
    this.fresh.clear();
    this.alarm = 0;
    this.resize();
  }
  // Kept for the existing performance harness. Motion never changes based on frame cost.
  get lowMotion() { return this.performance || this.reducedMotion; }
  set lowMotion(on: boolean) { this.performanceMode = on; }
  get detailMode() { return this.detailed ? "Detail" : "Overview"; }
  get crtEnabled() { return this.curve.enabled; }
  set crtEnabled(on: boolean) { this.curve.enabled = on; }

  resize() {
    // Supersample standard displays too; fine wires otherwise alias during fractional zoom.
    this.dpr = this.performance ? 1 : Math.min(2, Math.max(1.5, window.devicePixelRatio || 1));
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = "high";
    this.curve.resize(r.width, r.height);
    this.last = 0;
    this.needsFrame = true;
  }

  /** Public coordinates include the CRT warp; drawing uses the flat projection below. */
  toScreen(wx: number, wy: number): [number, number] {
    return this.curve.flatToScreen(...this.project(wx, wy));
  }

  toWorld(sx: number, sy: number): [number, number] {
    return this.unproject(...this.screenToFlat(sx, sy));
  }

  screenToFlat(sx: number, sy: number): [number, number] {
    return this.curve.screenToFlat(sx, sy);
  }

  private project(wx: number, wy: number): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [(wx - this.cam.x) * this.cs + r.width / 2, (wy - this.cam.y) * this.cs + r.height / 2];
  }

  private unproject(sx: number, sy: number): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [(sx - r.width / 2) / this.cs + this.cam.x, (sy - r.height / 2) / this.cs + this.cam.y];
  }

  /** the draft under a world point, if any */
  draftAt(wx: number, wy: number): number | null {
    const fx = Math.floor(wx), fy = Math.floor(wy);
    for (const d of this.board.drafts.values()) if (d.fp.some(([x, y]) => x === fx && y === fy)) return d.id;
    return null;
  }

  partAt(wx: number, wy: number): number | null {
    const c = this.board.cells.get(key(Math.floor(wx), Math.floor(wy)));
    return c ? c.id : null;
  }

  /** a signal from part `src` (0 = the core) through the wiring */
  pulse(src = 0, life = PULSE_LIFETIME, rgb: Pulse["rgb"] = GREEN, width = 1) {
    if (this.lowMotion) return;
    const arr = this.wiring.arrivals(src, life);
    this.pulses.push({ t: 0, arr, life, rgb, width });
    if (this.pulses.length > 16) this.pulses.shift();
  }

  placed(id: number) {
    if (this.lowMotion) return;
    this.fresh.set(id, 1);
  }

  // ---- the round's end, on the finished machine, before the next one opens
  private out: { t: number; at: Map<number, number>; winners: number[]; fired: number; end: number; started: number; done: () => void } | null = null;
  private boot = false;
  private gone = -1; // the epoch of a machine whose outro has finished: drawn as the bare core until the next one opens
  get outroActive() { return !!this.out; }

  /**
   * The clock ran out: the machine blinks and three signals go out from the core, then a gold wave from the core and
   * gold signals from the ten prize places, then the parts come off from the outside in, faster and faster, each
   * flashing and drifting outward as it goes, down to the core. Resolves when it is
   * done (at once with reduced motion or an empty machine); the store opens the next machine after that.
   */
  outro(winners: number[]): Promise<void> {
    if (this.lowMotion || this.board.placedCount === 0) return Promise.resolve();
    return new Promise((done) => {
      const placed = [...this.board.parts.values()].filter((p) => p.placed && this.board.fp.has(p.id));
      const far = new Map(placed.map((p) => {
        const [bx, by, bw, bh] = bboxOf(this.board.fp.get(p.id)!);
        return [p.id, Math.hypot(bx + bw / 2 - 0.5, by + bh / 2 - 0.5) + Math.random() * 5];
      }));
      const order = placed.map((p) => p.id).sort((a, b) => far.get(b)! - far.get(a)!);
      const at = new Map(order.map((id, i) => [id, OUTRO.take + OUTRO.takeFor * Math.sqrt(i / order.length)]));
      const end = OUTRO.take + OUTRO.takeFor + OUTRO.die + OUTRO.after;
      this.out = { t: 0, at, winners, fired: 0, end, started: performance.now(), done };
      this.alarm = 1.8;
      // the next machine must open even if frames stop (a hidden tab)
      const watch = setInterval(() => {
        if (this.out && performance.now() - this.out.started < end * 1000 + 4000) return;
        clearInterval(watch);
        this.endOutro();
      }, 500);
    });
  }

  private endOutro() {
    const o = this.out;
    if (!o) return;
    this.out = null;
    this.gone = this.board.epoch; // the store opens the next machine just after this frame: don't draw the old one again
    this.boot = true; // the next machine's core lights up once
    o.done();
  }

  /** the outro's clock: signals on cue, the end on time */
  private stepOutro(dt: number) {
    const o = this.out!;
    o.t += dt;
    const cues: [number, () => void][] = [
      [0, () => this.pulse(0, 4.5, GREEN, 1.6)], [0.35, () => this.pulse(0, 4.5, GREEN, 1.6)], [0.7, () => this.pulse(0, 4.5, GREEN, 1.6)],
      [OUTRO.gold, () => { this.pulse(0, 6, GOLD, 2.2); o.winners.forEach((id) => this.pulse(id, 3.5, GOLD, 2.2)); }],
    ];
    while (o.fired < cues.length && o.t >= cues[o.fired][0]) cues[o.fired++][1]();
    if (o.t >= o.end) this.endOutro();
  }

  /** the finished machine, part by part: whole, then flashing as it comes off and drifting outward, turning,
   *  shrinking and fading, gone */
  private drawOutro(x0: number, y0: number, x1: number, y1: number) {
    const o = this.out!, ctx = this.ctx, cs = this.cs;
    this.drawLayers(ctx, "core", CORE, 3, 3, 0, ...this.project(-1, -1), cs, this.dpr, this.time);
    for (const p of this.board.parts.values()) {
      if (!p.placed || p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;
      const fp = this.board.fp.get(p.id), def = PARTS[p.design];
      if (!fp || !def) continue;
      const k = (o.t - (o.at.get(p.id) ?? Infinity)) / OUTRO.die;
      if (k >= 1) continue;
      if (k <= 0) {
        if (this.detailed) this.part(p.id);
        else { const [bx, by] = bboxOf(fp); this.drawLayers(ctx, String(def.id), def.layers, def.w, def.h, p.rot, ...this.project(bx, by), cs, this.dpr, 0); }
        if (this.alarm > 0) this.marks(p.id);
        continue;
      }
      const [bx, by, bw, bh] = bboxOf(fp), [sx, sy] = this.project(bx, by);
      const mx = bx + bw / 2 - 0.5, my = by + bh / 2 - 0.5, n = Math.hypot(mx, my) || 1, drift = 2.5 * k ** 1.5 * cs;
      const cx = sx + (bw * cs) / 2, cy = sy + (bh * cs) / 2, scale = 1 - 0.8 * k * k;
      ctx.save();
      ctx.globalAlpha = 1 - k * k * k;
      ctx.translate(cx + (mx / n) * drift, cy + (my / n) * drift);
      ctx.rotate(((p.id % 7) - 3) * 0.12 * k);
      ctx.scale(scale, scale);
      ctx.translate(-cx, -cy);
      this.drawLayers(ctx, String(def.id), def.layers, def.w, def.h, p.rot, sx, sy, cs, this.dpr, 0);
      ctx.restore();
      if (k < 0.35) this.border(fp, `rgba(${GREEN[2]},${1 - k / 0.35})`, 1.6);
    }
  }

  /** how strongly passing signals drive part `id` right now (0..1): it peaks as the light arrives */
  energy(id: number) {
    if (this.lowMotion) return 0;
    let e = 0;
    for (const p of this.pulses) {
      const a = p.arr.get(id);
      if (!a) continue;
      const dt = p.t - a.t;
      if (dt >= 0 && dt < 0.9) e = Math.max(e, (1 - dt / 0.9) * power(p));
    }
    return e;
  }

  /** the light itself, drawn over all parts: fronts with fading tails along borders, and flashing leads */
  private signals() {
    if (this.lowMotion || !this.pulses.length) return;
    const ctx = this.ctx, cs = this.cs;
    const w0 = Math.max(1.3, (2.2 / UNIT) * cs);
    let w = w0;
    const toS = (p: [number, number]) => this.project(p[0], p[1]);
    const stroke = (pts: [number, number][], color: string, width: number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      pts.forEach((q, i) => (i ? ctx.lineTo(...toS(q)) : ctx.moveTo(...toS(q))));
      ctx.stroke();
    };
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalCompositeOperation = "lighter";
    for (const p of this.pulses) {
      ctx.globalAlpha = power(p);
      const [c0, c1, c2] = p.rgb;
      w = w0 * p.width;
      for (const [id, a] of p.arr) {
        const l = this.wiring.loops.get(id);
        if (!l) continue;
        const dt = p.t - a.t;
        if (dt < 0) continue;
        if (a.s === null) {
          // the source: its whole frame flashes
          const k = 1 - dt / 0.6;
          if (k > 0) {
            const all = arcPoints(l, 0, l.len);
            stroke(all, `rgba(${c0},${0.35 * k})`, w * 3.2);
            stroke(all, `rgba(${c1},${k})`, w);
          }
        } else {
          const d = dt * SPEED, half = l.len / 2;
          if (d - TAIL < half) {
            for (const dir of [1, -1]) {
              const front = Math.min(d, half), back = Math.max(0, d - TAIL);
              if (front <= back) continue;
              const seg = (u: number, v: number) => (dir > 0 ? arcPoints(l, a.s! + u, a.s! + v) : arcPoints(l, a.s! - v + l.len, a.s! - u + l.len));
              stroke(seg(back, front), `rgba(${c0},0.22)`, w * 3.2);
              [0.18, 0.4, 0.75].forEach((alpha, i) => stroke(seg(back + ((front - back) * i) / 3, back + ((front - back) * (i + 1)) / 3), `rgba(${c0},${alpha})`, w));
              if (d < half) {
                const [hx, hy] = toS(pointAt(l, a.s! + dir * front));
                ctx.fillStyle = `rgba(${c2},0.9)`;
                ctx.beginPath();
                ctx.arc(hx, hy, w * 0.7, 0, Math.PI * 2);
                ctx.fill();
              }
            }
          }
        }
        // leads: the light crosses to the next part where it reaches a plugged jack
        for (const port of this.wiring.portsOf(id)) {
          const tp = a.t + (a.s === null ? 0 : arcDist(l, a.s, port.s) / SPEED);
          const k = 1 - (p.t - tp) / 0.3;
          if (k <= 0 || k > 1) continue;
          const ux = port.at[0] - port.toAt[0], uy = port.at[1] - port.toAt[1], n = Math.hypot(ux, uy) || 1, j = 4 / UNIT;
          const ja: [number, number] = [port.at[0] + (ux / n) * j, port.at[1] + (uy / n) * j], jb: [number, number] = [port.toAt[0] - (ux / n) * j, port.toAt[1] - (uy / n) * j];
          stroke([ja, jb], `rgba(${c0},${0.3 * k})`, w * 2.4);
          stroke([ja, jb], `rgba(${c1},${0.85 * k})`, w * 0.6);
          for (const q of [ja, jb]) {
            const [x, y] = toS(q);
            ctx.fillStyle = `rgba(${c0},${0.5 * k})`;
            ctx.beginPath();
            ctx.arc(x, y, (2 / UNIT) * cs * (1 + 0.5 * k), 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }
    ctx.restore();
  }

  frame(now: number, interacting = false) {
    if (!interacting && now - this.last < 32) return; // idle animations at ~30 fps; gestures follow the display
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0.03;
    this.last = now;
    this.dt = dt;
    const snapshot = this.lowMotion ? [this.cam.x, this.cam.y, this.cam.z, this.hover, this.picked, this.me, this.selected,
      this.board.epoch, this.board.placedCount, this.stats.minted, this.stats.paid, this.reducedMotion,
      JSON.stringify(this.ghost), this.hints.length && this.hints.join(";"), [...this.board.drafts.values()].map(d => `${d.id}:${d.rot}:${d.x}:${d.y}:${d.ok}`).join("|")].join("/") : "";
    if (this.lowMotion && snapshot === this.snapshot && !this.needsFrame) {
      this.jackpot?.paint(this.reducedMotion);
      return;
    }
    this.snapshot = snapshot;
    if (!this.lowMotion) this.time += dt;
    for (const p of this.pulses) p.t += dt;
    this.pulses = this.lowMotion ? [] : this.pulses.filter((p) => p.t < p.life);
    if (this.out) this.stepOutro(dt);
    if (this.boot && !this.out && this.board.placedCount === 0) { this.boot = false; this.pulse(0); }
    this.alarm = Math.max(0, this.alarm - dt);
    if (this.lowMotion) { this.fresh.clear(); this.alarm = 0; }
    for (const [id, g] of this.fresh) g - dt * 0.6 <= 0 ? this.fresh.delete(id) : this.fresh.set(id, g - dt * 0.6);
    this.sprites.tick();

    const ctx = this.ctx;
    const r = this.canvas.getBoundingClientRect();
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, r.width, r.height);
    this.grid(r.width, r.height);

    const [x0, y0] = this.unproject(-this.cs * 3, -this.cs * 3);
    const [x1, y1] = this.unproject(r.width + this.cs * 3, r.height + this.cs * 3);
    if (this.detailed && this.cs < DETAIL_OUT) this.detailed = false;
    else if (!this.detailed && this.cs >= DETAIL_IN) this.detailed = true;
    if (this.out) this.drawOutro(x0, y0, x1, y1);
    else if (this.gone === this.board.epoch) this.drawLayers(ctx, "core", CORE, 3, 3, 0, ...this.project(-1, -1), this.cs, this.dpr, this.time);
    else if (this.detailed) {
      // close up: every visible part, animated
      this.drawLayers(ctx, "core", CORE, 3, 3, 0, ...this.project(-1, -1), this.cs, this.dpr, this.time);
      for (const p of this.board.parts.values()) {
        if (!p.placed || p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;
        this.part(p.id);
      }
    } else {
      // zoomed out: still tiles of 16 x 16 cells, rendered once, plus the marks that change
      this.tiles(r.width, r.height);
      for (const p of this.board.parts.values()) {
        if (!p.placed || p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;
        if (this.fresh.has(p.id) || this.alarm > 0 || (this.me && p.owner.toLowerCase() === this.me.toLowerCase())) this.marks(p.id);
      }
    }
    this.signals();
    this.drawHints();
    for (const d of this.board.drafts.values()) this.part(-1, { design: d.design, rot: d.rot, x: d.x, y: d.y, ok: d.ok, draft: true, selected: d.id === this.selected });
    if (this.ghost) this.part(-1, this.ghost);
    this.hoverOutline(); // above all part art, signals and placement previews, before the CRT projection

    this.jackpot?.paint(this.reducedMotion); // DOM readout, independent of canvas performance mode
    this.curve.render(this.canvas);
    this.needsFrame = this.sprites.pending;
  }

  private grid(w: number, h: number) {
    const cs = this.cs;
    if (cs < 10) return;
    const ctx = this.ctx;
    ctx.fillStyle = "#262626";
    const [wx0, wy0] = this.unproject(0, 0);
    const [wx1, wy1] = this.unproject(w, h);
    for (let gx = Math.floor(wx0); gx <= wx1; gx++) {
      const [sx] = this.project(gx, 0);
      for (let gy = Math.floor(wy0); gy <= wy1; gy++) {
        const sy = (gy - this.cam.y) * cs + h / 2;
        ctx.fillRect(sx - 1, sy - 1, 2, 2);
      }
    }
  }

  /** draw a part's layers onto `ctx` with its bounding box's top-left at (sx, sy), `cs` px per cell,
   *  after `rot` quarter turns. `dpr`: device pixels per px, to pick bitmaps sharp enough. Returns false if a
   *  bitmap wasn't ready yet. */
  private drawLayers(ctx: CanvasRenderingContext2D, id: string, layers: Layer[], w: number, h: number, rot: number, sx: number, sy: number, cs: number, dpr: number, t: number) {
    const k = cs / UNIT, px = k * dpr;
    const bw = rot % 2 ? h : w, bh = rot % 2 ? w : h;
    let complete = true;
    ctx.save();
    ctx.translate(sx + (bw * cs) / 2, sy + (bh * cs) / 2);
    ctx.rotate((rot * Math.PI) / 2);
    ctx.translate((-w * cs) / 2, (-h * cs) / 2);
    layers.forEach((l, i) => {
      if (l.live) return this.digits(ctx, l.live, k);
      const box = l.box ?? [0, 0, w * UNIT, h * UNIT];
      const bmp = this.sprites.get(`${id}:${i}`, box, px);
      if (!bmp) return void (complete = false);
      const a = l.anim;
      if (!a) return ctx.drawImage(bmp, box[0] * k, box[1] * k, box[2] * k, box[3] * k);
      ctx.save();
      if (l.clip) {
        ctx.beginPath();
        ctx.rect(l.clip[0] * k, l.clip[1] * k, l.clip[2] * k, l.clip[3] * k);
        ctx.clip();
      }
      if (a.fade) ctx.globalAlpha *= sample(a, t, a.fade);
      if (a.move) {
        const [mx, my] = sample(a, t, a.move);
        ctx.translate(mx * k, my * k);
      }
      if (a.rot) {
        const [cx, cy, v] = a.rot;
        ctx.translate(cx * k, cy * k);
        ctx.rotate((sample(a, t, v) * Math.PI) / 180);
        ctx.translate(-cx * k, -cy * k);
      }
      ctx.drawImage(bmp, box[0] * k, box[1] * k, box[2] * k, box[3] * k);
      ctx.restore();
    });
    ctx.restore();
    return complete;
  }

  /** a live display: lit seven-segment digits of a machine number */
  private digits(ctx: CanvasRenderingContext2D, lv: NonNullable<Layer["live"]>, k: number) {
    const v = Math.min(this.stats[lv.kind], 10 ** lv.n - 1);
    const str = String(Math.floor(v)).padStart(lv.n, "0");
    const X = Math.round(lv.x * 10), Y = Math.round(lv.y * 10), u = k / 10;
    ctx.fillStyle = LIT;
    for (let d = 0; d < lv.n; d++) {
      const m = DIGIT[+str[d]];
      SEG.forEach(([dx, dy, sw, sh], i) => (m >> i) & 1 && ctx.fillRect((X + d * 75 + dx) * u, (Y + dy) * u, sw * u, sh * u));
    }
  }

  part(id: number, ghost?: Ghost) {
    const ctx = this.ctx;
    const p = ghost ? { id: -1, design: ghost.design, rot: ghost.rot, x: ghost.x, y: ghost.y, owner: "" } : this.board.parts.get(id)!;
    const def = PARTS[p.design];
    if (!def) return;
    const cs = this.cs;
    const fp = ghost ? footprint(def.tmpl, p.rot, p.x, p.y) : this.board.fp.get(id) ?? footprint(def.tmpl, p.rot, p.x, p.y);
    const [bx, by] = bboxOf(fp);
    const energy = ghost ? 0 : this.energy(id);

    // each part keeps its own clock; a passing signal makes it run faster for a moment
    let clock = this.clocks.get(id) ?? id * 0.37;
    if (!ghost && !this.lowMotion) this.clocks.set(id, (clock += this.dt * (1 + 5 * energy)));

    if (ghost) ctx.globalAlpha = ghost.draft && ghost.ok ? 0.92 : 0.7;
    this.drawLayers(ctx, String(def.id), def.layers, def.w, def.h, p.rot, ...this.project(bx, by), cs, this.dpr, ghost ? this.time : clock);
    ctx.globalAlpha = 1;

    // live connections: the jacks of plugged-in sockets light up, and flare as a signal passes
    if (!ghost && cs >= 10) {
      const r = (1.6 / UNIT) * cs;
      for (const [lx, ly, dd] of this.board.links(id)) {
        const [jx, jy] = this.project(...jackAt(lx, ly, dd));
        if (energy > 0.05) {
          ctx.fillStyle = `rgba(176,237,186,${0.5 * energy})`;
          ctx.beginPath();
          ctx.arc(jx, jy, r * (1.6 + 1.6 * energy), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = energy > 0.5 ? "#b0edba" : LIT;
        ctx.beginPath();
        ctx.arc(jx, jy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (ghost?.draft) {
      if (!ghost.selected) ctx.setLineDash([Math.max(3, cs / 6), Math.max(2, cs / 10)]);
      this.border(fp, ghost.ok ? MINE : ALARM);
      ctx.setLineDash([]);
    } else if (ghost) this.border(fp, ghost.ok ? LIT : ALARM);
    else this.marks(id);
  }

  /** a part's frame in a colour (placing preview, just placed, celebrations) */
  private border(fp: number[][], color: string, weight = 1) {
    const ctx = this.ctx, cs = this.cs;
    {
      const inset = (2.5 / UNIT) * cs;
      ctx.lineWidth = Math.max(1.5, (2 / UNIT) * cs) * weight;
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (const [fx, fy] of fp) {
        const [ex, ey] = this.project(fx, fy);
        const edges = DIRS.filter(([, vx, vy]) => !fp.some(([ox, oy]) => ox === fx + vx && oy === fy + vy));
        for (const [dd] of edges) {
          if (dd === 1) { ctx.moveTo(ex, ey + inset); ctx.lineTo(ex + cs, ey + inset); }
          if (dd === 4) { ctx.moveTo(ex, ey + cs - inset); ctx.lineTo(ex + cs, ey + cs - inset); }
          if (dd === 8) { ctx.moveTo(ex + inset, ey); ctx.lineTo(ex + inset, ey + cs); }
          if (dd === 2) { ctx.moveTo(ex + cs - inset, ey); ctx.lineTo(ex + cs - inset, ey + cs); }
        }
      }
      ctx.stroke();
    }

  }

  /** the width of a part's own ink border on screen (2 units of 40), never thinner than a pixel and a half */
  private inkWidth() {
    return Math.max(1.5, (2 / UNIT) * this.cs);
  }

  /** The outline of a part, any shape, on its own ink border (2.5 units inside its cells), in world coordinates, going
   *  round once. Cell edges with no neighbour in the part are joined into a polygon; every vertex then moves inward
   *  along both of its edges' normals, which keeps the corners square for rectilinear shapes. */
  private outline(fp: number[][]): [number, number][] {
    const has = (x: number, y: number) => fp.some(([ox, oy]) => ox === x && oy === y);
    // clockwise edges on screen (y down): the part lies to the right of each
    const next = new Map<string, [number, number, number, number]>();
    for (const [x, y] of fp) {
      if (!has(x, y - 1)) next.set(`${x},${y}`, [x, y, x + 1, y]);
      if (!has(x + 1, y)) next.set(`${x + 1},${y}`, [x + 1, y, x + 1, y + 1]);
      if (!has(x, y + 1)) next.set(`${x + 1},${y + 1}`, [x + 1, y + 1, x, y + 1]);
      if (!has(x - 1, y)) next.set(`${x},${y + 1}`, [x, y + 1, x, y]);
    }
    const [first] = next.values();
    const corners: [number, number, number, number][] = []; // vertex and the direction leaving it
    let e = first;
    do {
      const [x0, y0, x1, y1] = e;
      const d: [number, number] = [x1 - x0, y1 - y0];
      const last = corners[corners.length - 1];
      if (!last || last[2] !== d[0] || last[3] !== d[1]) corners.push([x0, y0, d[0], d[1]]);
      e = next.get(`${x1},${y1}`)!;
    } while (e !== first && e);
    if (corners.length > 1 && corners[0][2] === corners[corners.length - 1][2] && corners[0][3] === corners[corners.length - 1][3]) corners.shift();
    const inset = 2.5 / UNIT;
    return corners.map(([x, y, dx, dy], i) => {
      const [, , px, py] = corners[(i + corners.length - 1) % corners.length];
      // inward normal of a clockwise edge (dx, dy) is (-dy, dx)
      return [x + inset * (-dy - py), y + inset * (dx + px)];
    });
  }

  /** yours: short pieces of that outline at its corners, in your colour; they scale with the zoom */
  private mineMark(fp: number[][]) {
    const ctx = this.ctx, pts = this.outline(fp).map(([x, y]) => this.project(x, y)), n = pts.length;
    // short, thin and faint; they fade out as you zoom out, where a machine is mostly yours or nobody's
    const k = this.cs * 0.14, fade = Math.max(0, Math.min(1, (this.cs - 10) / 30));
    if (fade === 0) return;
    ctx.save();
    ctx.strokeStyle = `rgba(255,138,61,${(0.6 * fade).toFixed(3)})`;
    ctx.lineWidth = this.inkWidth() * 0.7; // under the hover and picked outline, which covers them
    ctx.lineJoin = "miter";
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const [x, y] = pts[i], [ax, ay] = pts[(i + n - 1) % n], [bx, by] = pts[(i + 1) % n];
      const toward = (tx: number, ty: number) => {
        const len = Math.hypot(tx - x, ty - y) || 1, l = Math.min(k, len / 2);
        return [x + ((tx - x) / len) * l, y + ((ty - y) / len) * l] as const;
      };
      const [p0x, p0y] = toward(ax, ay), [p1x, p1y] = toward(bx, by);
      ctx.moveTo(p0x, p0y); ctx.lineTo(x, y); ctx.lineTo(p1x, p1y);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** keep the tile index in step with the board; a newly placed part marks the tiles it touches out of date */
  private indexTiles() {
    if (this.tileEpoch !== this.board.epoch) {
      // a new machine: drop everything cached for the old one
      this.tileEpoch = this.board.epoch;
      this.tileIndexed.clear();
      this.tileParts.clear();
      this.tileBitmaps.clear();
      this.fresh.clear();
    }
    if (this.tileIndexed.size === this.board.placedCount) return;
    for (const p of this.board.parts.values()) {
      if (!p.placed || this.tileIndexed.has(p.id)) continue;
      this.tileIndexed.add(p.id);
      const fp = this.board.fp.get(p.id);
      if (!fp) continue;
      const [bx, by, bw, bh] = bboxOf(fp);
      for (let tx = Math.floor(bx / TILE); tx <= Math.floor((bx + bw - 1) / TILE); tx++)
        for (let ty = Math.floor(by / TILE); ty <= Math.floor((by + bh - 1) / TILE); ty++) {
          const k = `${tx},${ty}`;
          const list = this.tileParts.get(k) ?? [];
          list.push(p.id);
          this.tileParts.set(k, list);
        }
      // the part, and the neighbours whose jacks it lights, may sit in any tile within a cell of it
      for (let tx = Math.floor((bx - 1) / TILE); tx <= Math.floor((bx + bw) / TILE); tx++)
        for (let ty = Math.floor((by - 1) / TILE); ty <= Math.floor((by + bh) / TILE); ty++) {
          const t = this.tileBitmaps.get(`${tx},${ty}`);
          if (t) t.stale = true;
        }
    }
  }

  /**
   * draw the visible tiles at a scale bucket of the zoom. A few are (re)rendered per frame, missing ones first; until
   * then a tile shows its previous bitmap (stretched after a zoom), and parts that bitmap lacks are drawn one by one.
   */
  private tiles(w: number, h: number) {
    this.indexTiles();
    const cs = this.cs;
    const scale = 2 ** (Math.round(Math.log2(cs * this.dpr) * 2) / 2); // device px per cell, in half-octave steps
    const [wx0, wy0] = this.unproject(0, 0), [wx1, wy1] = this.unproject(w, h);
    const visible: [string, number, number, number[]][] = [];
    for (let tx = Math.floor(wx0 / TILE); tx <= Math.floor(wx1 / TILE); tx++)
      for (let ty = Math.floor(wy0 / TILE); ty <= Math.floor(wy1 / TILE); ty++) {
        const k = `${tx},${ty}`;
        const ids = this.tileParts.get(k);
        if (!ids && !((tx === 0 || tx === -1) && (ty === 0 || ty === -1))) continue; // the core spans tiles -1 and 0
        visible.push([k, tx, ty, ids ?? []]);
      }
    let budget = TILE_RENDERS;
    for (const missing of [true, false])
      for (const [k, tx, ty, ids] of visible) {
        if (budget <= 0) break;
        const t = this.tileBitmaps.get(k);
        if (missing ? t : !t || (!t.stale && t.scale === scale && t.n === ids.length)) continue;
        budget--;
        this.renderTile(tx, ty, ids, scale);
      }
    const loose = new Set<number>();
    for (const [k, tx, ty, ids] of visible) {
      const t = this.tileBitmaps.get(k);
      if (!t || t.stale || t.scale !== scale || t.n !== ids.length) this.sprites.pending = true;
      if (t) {
        // snap to whole pixels and overlap by one, so no seams show between tiles
        const [sx, sy] = this.project(tx * TILE, ty * TILE), [ex, ey] = this.project((tx + 1) * TILE, (ty + 1) * TILE);
        const x = Math.floor(sx), y = Math.floor(sy);
        this.ctx.drawImage(t.c, x, y, Math.ceil(ex) - x + 1, Math.ceil(ey) - y + 1);
      } else if ((tx === 0 || tx === -1) && (ty === 0 || ty === -1)) loose.add(0);
      for (let i = t?.n ?? 0; i < ids.length; i++) loose.add(ids[i]);
    }
    for (const id of loose) {
      if (id === 0) { this.drawLayers(this.ctx, "core", CORE, 3, 3, 0, ...this.project(-1, -1), cs, this.dpr, 0); continue; }
      const p = this.board.parts.get(id), def = p && PARTS[p.design], fp = this.board.fp.get(id);
      if (!p || !def || !fp) continue;
      const [bx, by] = bboxOf(fp);
      this.drawLayers(this.ctx, String(def.id), def.layers, def.w, def.h, p.rot, ...this.project(bx, by), cs, this.dpr, 0);
    }
  }

  private renderTile(tx: number, ty: number, ids: number[], scale: number) {
    const c = document.createElement("canvas");
    c.width = c.height = Math.ceil(TILE * scale);
    const g = c.getContext("2d")!;
    const ox = tx * TILE, oy = ty * TILE;
    let complete = true;
    if ((tx === 0 || tx === -1) && (ty === 0 || ty === -1)) complete = this.drawLayers(g, "core", CORE, 3, 3, 0, (-1 - ox) * scale, (-1 - oy) * scale, scale, 1, 0) && complete;
    for (const id of ids) {
      const p = this.board.parts.get(id)!;
      const def = PARTS[p.design];
      const fp = this.board.fp.get(id);
      if (!def || !fp) continue;
      const [bx, by] = bboxOf(fp);
      complete = this.drawLayers(g, String(def.id), def.layers, def.w, def.h, p.rot, (bx - ox) * scale, (by - oy) * scale, scale, 1, 0) && complete;
      g.fillStyle = LIT;
      for (const [lx, ly, dd] of this.board.links(id)) {
        const [jx, jy] = jackAt(lx, ly, dd);
        g.beginPath();
        g.arc((jx - ox) * scale, (jy - oy) * scale, (1.6 / UNIT) * scale, 0, Math.PI * 2);
        g.fill();
      }
    }
    if (complete) this.tileBitmaps.set(`${tx},${ty}`, { c, scale, n: ids.length, stale: false });
  }

  /** what changes on a placed part outside its art: the flash when paid or placed, your marks */
  private marks(id: number) {
    const p = this.board.parts.get(id)!;
    const fp = this.board.fp.get(id);
    if (!fp) return;
    const alarm = this.alarm > 0 && Math.floor(this.alarm * 6) % 2 === 0 ? 1 : 0;
    const lit = Math.max(this.fresh.get(id) ?? 0, alarm);
    if (lit > 0.05) this.border(fp, `rgba(57,211,83,${0.35 + 0.65 * lit})`);
    if (this.me && p.owner?.toLowerCase() === this.me.toLowerCase()) {
      this.mineMark(fp);
    }
  }

  /** where the picked part fits: a phosphor square in each empty cell it can plug into, blinking in steps */
  private drawHints() {
    if (!this.hints.length) return;
    const ctx = this.ctx, cs = this.cs;
    const on = this.lowMotion || Math.floor(this.time * 1.6) % 2 === 0;
    const pad = Math.max(1, cs * 0.14);
    ctx.save();
    ctx.fillStyle = on ? "rgba(57,211,83,0.22)" : "rgba(57,211,83,0.1)";
    ctx.strokeStyle = on ? LIT : "rgba(57,211,83,0.55)";
    ctx.lineWidth = Math.max(1, Math.min(2, cs / 20));
    for (const [x, y] of this.hints) {
      const [sx, sy] = this.project(x, y);
      ctx.fillRect(sx + pad, sy + pad, cs - 2 * pad, cs - 2 * pad);
      if (cs >= 8) ctx.strokeRect(sx + pad, sy + pad, cs - 2 * pad, cs - 2 * pad);
    }
    ctx.restore();
  }

  private hoverOutline() {
    // the picked part: the frame in its rarity colour; the hovered part: the same frame in white. Drawn after the parts,
    // so it covers your corner marks exactly (they are pieces of this frame)
    const frame = (id: number, width: number) => {
      const fp = id === 0 ? CORE_CELLS : this.board.fp.get(id);
      if (!fp) return;
      const ctx = this.ctx, pts = this.outline(fp).map(([x, y]) => this.project(x, y));
      ctx.save();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = width;
      ctx.lineJoin = "miter";
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    };
    // both white, on the part's own border: picked a little heavier than hover
    const ink = this.inkWidth();
    if (this.picked !== null) frame(this.picked, ink * 1.6);
    if (this.hover !== null && this.hover !== this.picked) frame(this.hover, ink);
  }
}

/** an animated picture of a part (shelf, tooltips, parts page): the same SVG the chain serves */
export function partImage(design: number, size: number, animate = true): HTMLImageElement {
  const img = new Image();
  const svg = animate ? PARTS[design].svg : PARTS[design].svg.replace(/<animate(?:Transform)?\b[^>]*\/>/g, "");
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  img.width = size;
  img.height = size;
  img.style.objectFit = "contain";
  img.alt = PARTS[design].name;
  img.draggable = false;
  return img;
}
