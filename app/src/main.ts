// The Machine page: the board, the round, minting, and plugging parts in.
//
// Flow: mint (one transaction) → a few seconds later the drand beacon publishes and this page works out which
// parts you got (src/reveal.ts) → arrange up to 50 parts → Install submits the whole draft together.
import { type Hex } from "viem";
import { TIER_CLASS, TIER_NAME, TIER_WEIGHT, bbox, footprint } from "./geometry";
import { rarityTag } from "./rarity";
import { Renderer, partImage } from "./render";
import { Jackpot } from "./jackpot";
import { TopTen } from "./topten";
import { PARTS } from "./parts.gen";
import { drandSig, drandTime, devAccount, ethMinterAbi } from "./chain";
import { EthCheckout, fmtEth } from "./eth";
import { Store, same, short, niceError, type Ev } from "./store";
import { buildBatch, MAX_INSTALL } from "./build";
import { shell, wallet, pickWallet } from "./shell";
import { fmt, plural, clock, quote, WIN, PLACES } from "./econ";
import { money, paren, usdEth } from "./usd";
import { predict } from "./reveal";
import { Referrals } from "./referrals";
import { toast, modal, partsLoader } from "./ui";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

shell("Dashboard");
const S = new Store();
const B = S.board;
const canvas = $<HTMLCanvasElement>("board");
const R = new Renderer(canvas, B);
R.jackpot = new Jackpot($("round-summary"));
/** the prize places under the jackpot; a row frames its part */
const topTen = new TopTen($("hud-stack"), (id) => {
  const fp = B.fp.get(id);
  if (!fp) return;
  const xs = fp.map((c) => c[0]), ys = fp.map((c) => c[1]);
  frameAt((Math.min(...xs) + Math.max(...xs) + 1) / 2, (Math.min(...ys) + Math.max(...ys) + 1) / 2, Math.max(R.cam.z, 1.6));
  R.placed(id);
  pickPart(id);
});

// ------------------------------------------------------------------ a part picked on the board: who owns it, what it does

let picked: number | null = null;
let pickedVersion = 0;
const nth = (n: number) => n.toLocaleString() + (n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th");

/** Pin the floating window to part `id` (0: the core), or close it (null). It replaces the hover tooltip: the same
 *  window, with the details, anchored to the part (above it, or below when there is no room) and following it as the
 *  board pans and zooms (placePinned, every frame). A tap on empty board, a second tap, × or Esc closes it. */
function pickPart(id: number | null) {
  const version = ++pickedVersion;
  const tip = $("tip");
  if (id !== null && id !== 0 && !B.parts.get(id)?.placed) id = null;
  picked = id;
  R.picked = id;
  delete tip.dataset.tier;
  tip.classList.toggle("pinned", id !== null);
  tip.hidden = id === null;
  if (id === null) return;
  const close = `<button type="button" class="tip-close" aria-label="Close">×</button>`;
  if (id === 0) {
    tip.innerHTML = `${close}<span class="tip-head"><b>Core</b></span><span class="sub">Every machine starts here, with twelve sockets. Plug-pay into it goes to the pot.</span>`;
  } else {
    const p = B.parts.get(id)!, d = B.designs.get(p.design)!;
    tip.dataset.tier = TIER_CLASS[d.tier];
    const mine = same(p.owner, S.me), k = S.order.indexOf(id) + 1, place = S.topTen().indexOf(id);
    tip.innerHTML = `${close}<span class="tip-head"><b>${d.name}${p.seat !== undefined ? " #" + p.seat : ""}</b>${rarityTag(d.tier)}</span>
      <a class="tip-owner${mine ? " mine" : ""}" ${S.D.chainId === 4663 ? `href="https://robin.etherscan.io/address/${p.owner}" target="_blank" rel="noopener"` : `href="#" data-copy="${p.owner}"`}>${mine ? "Yours" : short(p.owner)} ↗</a>
      <dl>
        <dt>Earned</dt><dd class="tip-earned">…</dd>
        ${place >= 0 ? `<dt>Prize place</dt><dd class="tip-prize"></dd>` : ""}
        <dt>Sockets</dt><dd>${B.links(id).length} of ${B.socketCount(id)} plugged</dd>
        <dt>Share</dt><dd>${TIER_WEIGHT[d.tier]}×</dd>
        ${k ? `<dt>Placed</dt><dd>${nth(k)} of ${S.order.length.toLocaleString()}</dd>` : ""}
      </dl>`;
    if (place >= 0 && S.status) {
      const prize = (S.status.pot * BigInt(WIN) * BigInt(PLACES[place])) / 100_000_000n;
      money(tip.querySelector<HTMLElement>(".tip-prize")!, prize, `${nth(place + 1)}, ${fmt(prize)} IMD`);
    }
    S.read("earned", [BigInt(id)]).then((v: bigint) => {
      const dd = picked === id && version === pickedVersion ? tip.querySelector<HTMLElement>(".tip-earned") : null;
      if (dd) money(dd, v);
    }).catch(() => {});
  }
  tip.querySelector<HTMLButtonElement>(".tip-close")!.onclick = () => pickPart(null);
  // local chains have no explorer: the owner's address copies instead
  const copy = tip.querySelector<HTMLAnchorElement>("[data-copy]");
  if (copy) copy.onclick = (e) => {
    e.preventDefault();
    navigator.clipboard?.writeText(copy.dataset.copy!).then(() => toast("Address copied", "ok", 1800)).catch(() => {});
  };
  tip.classList.remove("pop");
  void tip.offsetWidth; // restart the fade-in
  tip.classList.add("pop");
  placePinned();
}

/** keep the pinned window on its part: centred above it, below it if the top is cramped, always inside the board */
function placePinned() {
  if (picked === null) return;
  const tip = $("tip"), fp = picked === 0 ? [[-1, -1], [1, 1]] : B.fp.get(picked);
  if (!fp) return pickPart(null);
  const xs = fp.map((c) => c[0]), ys = fp.map((c) => c[1]);
  const [x0, y0] = R.toScreen(Math.min(...xs), Math.min(...ys)), [x1, y1] = R.toScreen(Math.max(...xs) + 1, Math.max(...ys) + 1);
  const r = canvas.getBoundingClientRect(), area = boardArea(), w = tip.offsetWidth, h = tip.offsetHeight, gap = 12;
  const offscreen = x1 < 0 || x0 > r.width || y1 < 0 || y0 > r.height;
  tip.style.visibility = offscreen ? "hidden" : "";
  const below = y0 - h - gap < area.top + 6;
  const left = Math.max(area.left + 6, Math.min(area.left + area.width - w - 6, (x0 + x1) / 2 - w / 2));
  const top = Math.max(6, Math.min(area.top + area.height - h - 6, below ? y1 + gap : y0 - h - gap));
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
  // the pointer aims at the part's centre
  tip.classList.toggle("below", below);
  tip.style.setProperty("--caret", `${Math.round(Math.max(14, Math.min(w - 14, (x0 + x1) / 2 - left)))}px`);
}
function renderTopTen() {
  const st = S.status;
  if (!st) return;
  topTen.update(S.topTen().map((id) => {
    const p = B.parts.get(id);
    return { id, name: `${B.designs.get(p?.design ?? -1)?.name ?? "Part"} #${id}`, placer: short(p?.owner ?? ""), mine: same(p?.owner, S.me) };
  }), st.pot);
}

type Panel = "parts" | "mint" | "you" | "stats";
let panel: Panel | null = null;
let placement = false;
let armed: number | null = null; // tap a tray part, then tap the board
const motionPreference = matchMedia("(prefers-reduced-motion: reduce)");
const display = { performance: false, crt: true };
try {
  const saved = JSON.parse(localStorage.getItem("machine-display") ?? "{}");
  display.performance = saved.performance === true;
  display.crt = saved.crt !== false;
} catch { /* use defaults when browser storage is unavailable or invalid */ }

function applyDisplay() {
  R.performanceMode = display.performance;
  R.reducedMotion = motionPreference.matches;
  R.crtEnabled = display.crt && !R.lowMotion;
  document.body.classList.toggle("low-motion", motionPreference.matches);
  document.body.classList.toggle("crt-enabled", display.crt && !R.lowMotion);
  const loader = $<HTMLImageElement>("load-animation");
  const loaderSource = motionPreference.matches || $("loading").hidden || $("loading").classList.contains("failed")
    ? "./parts-loader-static.svg" : "./parts-loader.svg";
  if (loader.getAttribute("src") !== loaderSource) loader.src = loaderSource;
  $("display-settings").classList.toggle("active", display.performance);
  $("shelf").dataset.key = "";
  if (S.ready) renderShelf();
}
applyDisplay();
motionPreference.addEventListener("change", applyDisplay);

function showPanel(next: Panel | null, returnFocus = false) {
  if (next === null && matchMedia("(min-width: 1000px)").matches) next = "parts";
  const previous = panel;
  zoomTarget = null;
  cancelDrag();
  armed = null;
  press = null;
  pointers.clear();
  pan = pinch = null;
  select(null);
  R.hover = null;
  $("tip").hidden = true;
  panel = next;
  placement = next === "parts";
  document.querySelectorAll<HTMLElement>(".game-panel").forEach(p => p.hidden = p.id !== (next === "parts" ? "parts-tray" : `${next}-panel`));
  document.querySelectorAll<HTMLButtonElement>("#game-dock button").forEach(b => {
    const on = b.dataset.panel === next;
    b.classList.toggle("on", on);
    b.setAttribute("aria-expanded", String(on));
  });
  $("stage").dataset.panel = next ?? "";
  syncPlacement();
  updatePanelSpace();
  if (next === "mint") mintButton();
  if (returnFocus && previous) $("dock-" + previous).focus();
}

/** where the picked or dragged part fits right now; recomputed when it, the machine or the drafts change */
type Spot = ReturnType<typeof B.fitSpots>[number];
let spots: Spot[] = [];
let spotsKey = "";
function updateHints() {
  const design = dragging ? dragging.design : armed !== null && placement ? designOf(armed) : null;
  if (design === null || design === undefined) {
    spots = [];
    spotsKey = "";
    R.hints = [];
    return;
  }
  const k = `${design}|${B.epoch}|${B.placedCount}|${[...B.drafts.values()].map(d => `${d.id}:${d.x}:${d.y}:${d.rot}`).join(",")}`;
  if (k === spotsKey) return;
  spotsKey = k;
  spots = B.fitSpots(B.tmplOf(design));
  const cells = new Map<string, [number, number]>();
  for (const s of spots) cells.set(`${s.cx},${s.cy}`, [s.cx, s.cy]);
  R.hints = [...cells.values()];
}

/** the fitting spot nearest world point (wx, wy): measured to the cell it plugs into (a tap) or to its middle (a
 *  drag, which also prefers the rotation it's held at); null if none is within `reach` cells */
function nearestSpot(wx: number, wy: number, reach: number, by: "cell" | "middle", rot?: number) {
  let best: Spot | null = null, score = Infinity;
  for (const s of spots) {
    const d = by === "cell" ? Math.hypot(s.cx + .5 - wx, s.cy + .5 - wy) : Math.hypot(s.mx - wx, s.my - wy);
    const v = d + (rot !== undefined && s.rot !== rot ? .75 : 0) + (by === "cell" ? Math.hypot(s.mx - wx, s.my - wy) * .2 : 0);
    if (d <= reach && v < score) [best, score] = [s, v];
  }
  return best;
}

function hintText() {
  return spots.length ? "Tap a green spot to place it" : "No open socket fits this part right now";
}

/** the board hint blinks a message, e.g. after a tap that missed the green spots */
function nudge(text: string) {
  const h = $("board-hint");
  h.textContent = text;
  h.hidden = false;
  h.classList.remove("nudge");
  void h.offsetWidth;
  h.classList.add("nudge");
}

function syncPlacement() {
  $("stage").classList.toggle("building", placement);
  updateHints();
  $("board-hint").hidden = !placement || armed === null;
  $("board-hint").textContent = hintText();
  updateShelfSelection();
  renderBuild();
}

function updateShelfSelection() {
  canvas.classList.toggle("armed", armed !== null);
  $("shelf").querySelectorAll<HTMLButtonElement>("[data-part]").forEach(b => {
    const on = Number(b.dataset.part) === armed;
    b.classList.toggle("selected", on);
    b.setAttribute("aria-pressed", String(on));
  });
}
let qty = 5;
let maxQty = 200;
let maxInstall = MAX_INSTALL;
let payment: "imd" | "eth" = "imd";
let checkingOut = false;
const ethCheckout = new EthCheckout(S, mintButton);
const validQty = () => [1, 5, 20].includes(qty) && qty <= maxQty;
const purchaseName = (n: number) => n === 1 ? "single part" : n === 5 ? "pack" : "booster box";
let base = 100_000_000_000_000_000n; // basePrice, read at boot
const chainNow = () => Date.now() / 1000 + S.offset;
let mySeats: { seat: number; proof: Hex[] }[] = [];
let seatsFor = "";
let seatRequest = 0;

/** my unrevealed mints whose part is already known from the beacon: mint id → design */
const predicted = new Map<number, number>();
const sigs = new Map<number, Hex>(); // drand round → signature
const referrals = new Referrals(S);

// ------------------------------------------------------------------ events → activity log

function describe(ev: { name: string; args: any }): [string, string] | null {
  const a = ev.args;
  switch (ev.name) {
    case "RoundEnded":
      return [(a.prize > 0n ? `Machine ${a.round} ended: ${fmt(a.prize)} IMD${paren(a.prize)} to the last ten placed` : `Machine ${a.round} ended with no parts placed`)
        + (a.carried > 0n ? `, ${fmt(a.carried)} IMD${paren(a.carried)} starts the next jackpot` : ""), "gold"];
    case "Prize":
      return a.place === 1 ? [`${who(a.placer)} took first place in machine ${a.round}: ${fmt(a.amount)} IMD${paren(a.amount)}`, "gold"] : null;
    case "Funded":
      return [`${who(a.who)} added ${fmt(a.amount)} IMD${paren(a.amount)} to ${a.reserve ? "the reserve" : "the pot"}`, a.reserve ? "" : "gold"];
    case "CoreClaimed":
      return [`Agent Core #${a.seat} claimed`, "hi"];
    case "Sponsored":
      return [`${who(a.who)} paid ${fmt(a.amount)} IMD${paren(a.amount)} to every placed part`, "gold"];
  }
  return null;
}

/** an event into the activity log; a batch (one wallet's mints or reveals in one block) is one line */
const mintOwner = new Map<number, string>(); // mint id → who minted it, until it is revealed
const groups = new Map<string, { n: number; total: bigint; got: { tier: number; name: string }[] }>();
function feed(ev: Ev, past = false) {
  const a = ev.args;
  const group = (k: string) => {
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { n: 0, total: 0n, got: [] }));
    if (groups.size > 200) groups.delete(groups.keys().next().value!);
    return g;
  };
  if (ev.name === "Minted") {
    mintOwner.set(Number(a.id), a.owner);
    if (mintOwner.size > 5000) mintOwner.delete(mintOwner.keys().next().value!);
    const k = `m:${a.owner}:${ev.block}`, g = group(k);
    g.n++;
    g.total += a.price;
    return log(`${who(a.owner)} minted ${g.n} for ${fmt(g.total)} IMD${paren(g.total)}`, same(a.owner, S.me) ? "hi" : "", past, k);
  }
  if (ev.name === "Revealed") {
    // the minter: a part that is revealed and placed in one build has no owner on record in between
    const d = B.designs.get(Number(a.design)), owner = mintOwner.get(Number(a.id)) || B.parts.get(Number(a.id))?.owner || "";
    mintOwner.delete(Number(a.id));
    if (!d) return;
    const k = `r:${owner}:${ev.block}`, g = group(k);
    g.got.push({ tier: d.tier, name: d.name });
    g.got.sort((x, y) => y.tier - x.tier);
    const top = g.got[0].tier;
    const names = g.got.slice(0, 3).map((x) => x.name).join(", ") + (g.got.length > 3 ? ` +${g.got.length - 3}` : "");
    return log(`${owner ? who(owner) : "Someone"} got ${names}`, top >= 3 ? "gold" : top === 2 ? "rare" : same(owner, S.me) ? "hi" : "", past, k);
  }
  if (ev.name === "Plugged") {
    // only what pays me: other players' plug-pay is noise here
    const into = Number(a.into);
    if (!into || !same(B.parts.get(into)?.owner, S.me)) return;
    const k = `p:${ev.block}`, g = group(k);
    g.total += a.amount;
    return log(`Plug-ins paid you ${fmt(g.total)} IMD${paren(g.total)}`, "gold", past, k);
  }
  const line = describe(ev);
  if (line) log(line[0], line[1], past);
}

S.on((ev) => {
  const a = ev.args;
  feed(ev);
  // the pinned window follows the machine: new links, prize places and the round's end
  if (picked !== null && ["Placed", "Plugged", "Prize", "RoundEnded"].includes(ev.name)) pickPart(ev.name === "RoundEnded" ? null : picked);
  if (ev.name === "Minted" || ev.name === "Sponsored") R.pulse();
  if (ev.name === "Minted" && same(a.owner, S.me)) bought.add(Number(a.drandRound));
  if (ev.name === "Revealed") {
    // someone revealed a mint I had arranged: it's a real part now (a mint's id is its part's id)
    B.rekeyDraft(-Number(a.id), Number(a.id));
    predicted.delete(Number(a.id));
  }
  if (ev.name === "Placed" && Number(a.round) === B.round) {
    R.placed(Number(a.id));
    R.pulse(Number(a.id));
    B.drafts.delete(Number(a.id)); // if it was my draft, it's real now
    lostDrafts += B.relay().length;
  }
  render();
});
// the clock ran out: the finished machine celebrates and comes apart before the next one opens
S.hold = () => R.outro(S.topTen());
let lostDrafts = 0; // arranged parts whose spot someone else took, reported once per batch of events

// ------------------------------------------------------------------ boot

async function boot() {
  S.onProgress = (done, total) => {
    $("load-text").textContent = total ? `${done.toLocaleString()} / ${plural(total, "part")}` : "Empty machine";
    if (done > 0 && done === total) fitView();
  };
  requestAnimationFrame(loop);
  await S.init();
  await referrals.init();
  [base, maxQty] = await Promise.all([S.read("basePrice"), S.read("MAX_BATCH").then(Number)]);
  if (!validQty()) setQuantity("1");
  // Older local deployments lack this getter; the client still applies the installation ceiling.
  const deployedLimit = await S.read("MAX_BUILD").then(Number).catch(() => MAX_INSTALL);
  if (Number.isSafeInteger(deployedLimit) && deployedLimit > 0) maxInstall = Math.min(MAX_INSTALL, deployedLimit);
  B.draftLimit = maxInstall;
  $("loading").classList.add("done");
  setTimeout(() => {
    $("loading").hidden = true;
    $<HTMLImageElement>("load-animation").src = "./parts-loader-static.svg";
  }, 400);
  R.me = S.me;
  wallet(S, () => {
    if (R.me.toLowerCase() !== S.me.toLowerCase()) {
      mySeats = [];
      seatsFor = "";
      cancelDrag();
      B.removeDraft();
      armed = null;
      select(null);
      syncPlacement();
    }
    R.me = S.me;
    if (picked !== null) pickPart(picked);
    render();
    loadSeats().then(render).catch(() => {});
  });
  render();
  loadSeats().then(render).catch(() => {});
  setInterval(() => S.refreshStatus().then(render).catch(console.error), 2500);
  setInterval(tick, 250);
  setInterval(() => predictMine().catch(() => {}), 500); // a published round is fetched within half a second
  let warned = false;
  try { warned = !!localStorage.getItem("warned"); } catch { /* storage blocked: show it */ }
  if (!warned) $<HTMLDialogElement>("warn").showModal();
  // the latest activity before this visit, for the log
  S.recent(["Minted", "Revealed", "Plugged", "RoundEnded", "Prize", "Funded", "CoreClaimed", "Sponsored"]).then((evs) => {
    for (const ev of evs) {
      feed(ev, true);
    }
  }).catch(() => {});
}

/** frame the whole machine (or the core, while it's small) */
function fitView() {
  zoomTarget = null;
  let x0 = -2, y0 = -2, x1 = 3, y1 = 3; // the 3 x 3 core and a margin
  for (const p of B.parts.values()) {
    if (!p.placed) continue;
    x0 = Math.min(x0, p.x - 1); y0 = Math.min(y0, p.y - 1); x1 = Math.max(x1, p.x + 3); y1 = Math.max(y1, p.y + 3);
  }
  const area = boardArea();
  const z = Math.min(2.2, Math.max(ZMIN, 0.9 * Math.min(area.width / ((x1 - x0) * R.cell), area.height / ((y1 - y0) * R.cell))));
  frameAt((x0 + x1) / 2, (y0 + y1) / 2, z);
}

let predicting = false;
/** work out which parts my unrevealed mints hold, as soon as their drand round is public */
async function predictMine() {
  if (predicting) return; // a slow beacon fetch: the next tick picks up
  predicting = true;
  try {
    const missed = new Set<number>(); // rounds not served yet: one request each per pass
    for (const [id, p] of S.pending) {
      if (!same(p.owner, S.me) || predicted.has(id) || missed.has(p.drand)) continue;
      if (Date.now() / 1000 < drandTime(p.drand)) continue; // not published yet
      let sig = sigs.get(p.drand);
      if (!sig) {
        const s = await drandSig(p.drand);
        if (!s) { missed.add(p.drand); continue; }
        sigs.set(p.drand, (sig = s));
      }
      predicted.set(id, predict(sig, id));
      render();
    }
    announce();
  } finally {
    predicting = false;
  }
}

/** one line per purchase once all its parts are known: what you got, rarest first. Only purchases this page saw
 *  happen (live Minted events), so reloading never repeats one; no clock comparison, as chain and browser clocks differ. */
const announced = new Set<number>(); // drand rounds
const bought = new Set<number>(); // drand rounds of my mints seen live
function announce() {
  const got = new Map<number, number[]>(), waiting = new Set<number>();
  for (const [id, p] of S.pending) {
    if (!same(p.owner, S.me) || announced.has(p.drand) || !bought.has(p.drand)) continue;
    const d = predicted.get(id);
    if (d === undefined) waiting.add(p.drand);
    else got.set(p.drand, [...(got.get(p.drand) ?? []), d]);
  }
  for (const [round, designs] of got) {
    if (waiting.has(round)) continue;
    announced.add(round);
    const tier = (d: number) => B.designs.get(d)?.tier ?? 0;
    designs.sort((a, b) => tier(b) - tier(a));
    const names = designs.slice(0, 3).map(d => B.designs.get(d)!.name + (tier(d) >= 2 ? ` (${TIER_NAME[tier(d)].toLowerCase()})` : "")).join(", ");
    toast(`You got ${names}${designs.length > 3 ? ` +${designs.length - 3} more` : ""}`, "ok", 6000);
  }
}

async function loadSeats() {
  if (!S.me || seatsFor === S.me) return;
  const account = S.me, version = S.accountVersion;
  const request = ++seatRequest;
  const current = () => account === S.me && version === S.accountVersion && request === seatRequest;
  seatsFor = account;
  try {
  let found: { seat: number; proof: Hex[] }[] = [];
  if (S.D.chainId === 31337) {
    if (same(account, devAccount(0).address)) found = [{ seat: 1723, proof: [] }];
  } else {
    // the tree library loads only here: most visits never check seats against the snapshot
    const [d, { StandardMerkleTree }] = await Promise.all([fetch("./seats.json").then((r) => r.json()), import("@openzeppelin/merkle-tree")]);
    const t = StandardMerkleTree.load(d.tree);
    if (!current()) return;
    for (const [i, v] of t.entries()) if (same(v[1] as string, account)) found.push({ seat: Number(v[0]), proof: t.getProof(i) as Hex[] });
  }
  const claimed = await Promise.all(found.map((f) => S.read("seatClaimed", [f.seat])));
  if (!current()) return;
  mySeats = found.filter((_, i) => !claimed[i]);
  } catch (e) {
    if (current()) seatsFor = "";
    throw e;
  }
}

// ------------------------------------------------------------------ actions

const live = () => !!S.status && Number(S.status.deadline) > chainNow();
const cost = () => quote(live() ? Number(S.status!.roundMinted) : 0, qty, base);

async function mint() {
  if (!validQty() || checkingOut || S.busy) return;
  const amount = qty, account = S.me;
  const max = (cost() * 102n) / 100n; // a little room in case someone mints first
  const eth = ethCheckout.quote;
  const referrer = referrals.address();
  const referred = referrer !== "0x0000000000000000000000000000000000000000";
  if (payment === "eth" && (!S.D.ethMinter || !eth || ethCheckout.loading || eth.expires <= BigInt(Math.floor(chainNow())))) return;
  checkingOut = true;
  mintButton();
  referrals.render(true);
  try {
    const name = purchaseName(amount);
    const feedback = { label: `Buying ${name}`, done: `${name[0].toUpperCase() + name.slice(1)} bought. Revealing in about 10 seconds` };
    let ok: boolean;
    if (payment === "eth") {
      const args = [BigInt(amount), eth!.maxImd, eth!.expires];
      ok = await S.send(referred ? "mintWithReferral" : "mint", referred ? [...args, referrer] : args, { ...feedback, address: S.D.ethMinter, abi: ethMinterAbi, value: eth!.maxEth });
    } else {
      if (!(await S.allow(S.D.machine, max)) || !same(account, S.me)) return;
      ok = await S.send(referred ? "mintWithReferral" : "mint", referred ? [BigInt(amount), max, referrer] : [BigInt(amount), max], feedback);
    }
    if (ok) {
      await S.refreshStatus();
      render();
      showPanel("parts");
    }
  } finally {
    checkingOut = false;
    mintButton();
    referrals.render();
  }
}

/** the shelf: parts I can plug in that aren't arranged yet. id = part id, or -mintId for a predicted mint */
function shelfItems() {
  const items: { id: number; design: number | null; drand?: number }[] = [];
  const moving = dragging?.origin ? dragging.id : null;
  for (const [mid, p] of S.pending) {
    if (!same(p.owner, S.me) || B.drafts.has(-mid) || moving === -mid) continue;
    items.push({ id: -mid, design: predicted.get(mid) ?? null, drand: p.drand });
  }
  for (const p of S.myParts()) if (!p.placed && !B.drafts.has(p.id) && moving !== p.id) items.push({ id: p.id, design: p.design });
  return items;
}

const designOf = (id: number) => (id < 0 ? predicted.get(-id)! : B.parts.get(id)!.design);

/** the plug-pay a part (or a mint, -id) carries: set when it was minted (IdentityMachine.parts(id).plug) */
async function plugOf(id: number): Promise<bigint> {
  if (id > 0 && B.parts.get(id)?.plug !== undefined) return B.parts.get(id)!.plug!;
  const p = S.pending.get(-id);
  if (id < 0 && p?.price !== undefined) return (p.price * 5000n) / 10_000n;
  return (await S.read("parts", [BigInt(Math.abs(id))]))[7] as bigint;
}

let building = false;
/** Install the whole bounded draft with one wallet confirmation. */
async function build() {
  if (building || S.busy) return;
  if (!live()) return toast("This machine's clock has run out. End the round, then build on the new one", "", 5000);
  const round = B.round;
  if ([...B.drafts.values()].some(d => !d.ok)) return toast("Move or remove the parts that don't fit", "", 4000);
  const remaining = [...B.drafts.values()].map(d => ({ ...d }));
  const n = remaining.length, account = S.me, wallet = S.wallet;
  if (!n) return;
  building = true;
  try {
    if (remaining.length && B.round === round) {
      S.busy = `Checking ${plural(Math.min(remaining.length, maxInstall), "part")}`;
      S.onWallet();
      const batch = await buildBatch(S, round, remaining, sigs, maxInstall);
      if (!same(account, S.me) || wallet !== S.wallet) throw new Error("Wallet changed. Try again");
      if (B.round !== round) return;
      const label = `Installing ${plural(batch.drafts.length, "part")}`;
      const ok = await S.send("build", batch.args, { label, gas: batch.gas, done: `${plural(batch.drafts.length, "part")} installed` });
      if (!ok) return;
      // Retire only placements confirmed by the receipt/sync.
      for (const d of batch.drafts) {
        const id = Math.abs(d.id);
        const placed = B.parts.get(id)?.placed || S.placedByMe.has(id);
        if (placed) { B.drafts.delete(d.id); B.drafts.delete(id); }
        else if (d.id < 0 && !S.pending.has(id)) B.rekeyDraft(d.id, id);
      }
      B.relay();
      if (R.selected !== null && !B.drafts.has(R.selected)) select(null);
      if (B.round !== round) toast(`Machine ${round} finished`, "ok", 6000);
    }
    await S.refreshStatus();
  } catch (e) {
    toast(niceError(e), "bad", 6000);
  } finally {
    building = false;
    S.busy = null;
    S.onWallet();
    render();
  }
}

/** Arrange at open sockets, up to the draft ceiling, for review before Install. */
function autoArrange() {
  let stuck = 0;
  for (const it of shelfItems()) {
    if (B.draftFull) break;
    if (it.design === null) continue;
    const s = B.autoSpot(B.tmplOf(it.design));
    if (s) B.addDraft(it.id, it.design, s.rot, s.x, s.y);
    else stuck++;
  }
  if (stuck) toast(`No socket fits ${plural(stuck, "part")} right now`, "", 4000);
  const drafts = [...B.drafts.values()];
  if (drafts.length) {
    const cells = drafts.flatMap(d => d.fp);
    const x0 = Math.min(...cells.map(c => c[0])), x1 = Math.max(...cells.map(c => c[0])) + 1;
    const y0 = Math.min(...cells.map(c => c[1])), y1 = Math.max(...cells.map(c => c[1])) + 1;
    const area = boardArea();
    frameAt((x0 + x1) / 2, (y0 + y1) / 2,
      Math.min(3, Math.max(ZMIN, .7 * Math.min(area.width / ((x1 - x0 + 2) * R.cell), area.height / ((y1 - y0 + 2) * R.cell)))));
    select(drafts[0].id);
  }
  render();
}

// ------------------------------------------------------------------ the clocks (every 250 ms)

function tick() {
  const st = S.status;
  if (!st) return;
  const opensIn = Number(st.start) - chainNow();
  const before = opensIn > 0;
  document.body.classList.toggle("countdown", before);
  $("launch").hidden = !before;
  if (before) {
    // the launch countdown: a different thing from a round's clock, and it looks different
    $("launch-clock").textContent = clock(opensIn);
    $("launch-when").textContent = new Date(Number(st.start) * 1000).toLocaleString(undefined, { weekday: "long", hour: "2-digit", minute: "2-digit" });
  }
  $("end-round").hidden = before || Number(st.deadline) > chainNow() || R.outroActive;
  R.jackpot!.update({ round: Number(st.round), prize: st.pot * BigInt(WIN) / 10_000n,
    deadline: Number(st.deadline), start: Number(st.start), now: chainNow() }, motionPreference.matches);
  renderTopTen();
  revealCountdown();
  mintButton();
}

/** the mint button always says what pressing it will do, or why it can't */
function mintButton() {
  const b = $<HTMLButtonElement>("mint"), note = $("mint-note");
  const st = S.status;
  const valid = validQty(), busy = !!S.busy || checkingOut;
  if (panel === "mint" && payment === "eth" && valid && st && S.D.ethMinter && !busy) ethCheckout.refresh(qty, cost(), chainNow());
  const eth = ethCheckout.quote;
  document.querySelectorAll<HTMLButtonElement>("#qty button").forEach(el => { el.disabled = busy || Number(el.dataset.q) > maxQty; });
  document.querySelectorAll<HTMLButtonElement>("#payment button").forEach(el => { el.disabled = busy; });
  const mt = $("mint-total"), mb = $("mint-balance");
  if (valid && st && payment === "imd") money(mt, cost());
  else if (valid && st && eth) money(mt, 0n, `≈ ${fmtEth(eth.eth)} ETH`, usdEth(eth.eth));
  else mt.textContent = "–";
  // the small line under the total: what you have, and for ETH the most it can cost
  if (S.me && st && payment === "imd") mb.textContent = `Balance ${fmt(st.balance)} IMD`;
  else if (S.me && st && eth) mb.textContent = `At most ${fmtEth(eth.maxEth)} ETH of your ${fmtEth(eth.balance)} ETH`;
  else mb.textContent = "";
  let text = "", off = false, act: (() => void) | null = null, sub = "";
  if (!S.ready || !st) [text, off] = ["Loading…", true];
  else if (Number(st.start) > chainNow()) [text, off] = [`Opens in ${clock(Number(st.start) - chainNow())}`, true];
  else if (busy) [text, off] = [`${S.busy ?? "Minting"}…`, true];
  else if (!valid) [text, off] = ["Choose your parts", true];
  else if (!S.me) [text, act] = ["Connect wallet", () => pickWallet(S)];
  else if (S.wrongChain) [text, act] = ["Switch network", () => S.conn!.switchChain().catch(() => {})];
  else if (payment === "eth") {
    text = `Buy ${purchaseName(qty)}`;
    if (!S.D.ethMinter) [off, sub] = [true, "ETH checkout is not deployed on this network."];
    else if (ethCheckout.loading) [off, sub] = [true, "Getting ETH quote…"];
    else if (!eth) [off, sub] = [true, ethCheckout.error];
    else if (eth.balance < eth.maxEth) [text, off] = ["Not enough ETH", true];
    else act = mint;
  }
  else if (st.balance < cost()) [text, off, sub] = ["Not enough IMD", true, ""];
  else {
    [text, act] = [`Buy ${purchaseName(qty)}`, mint];
  }
  if (b.textContent !== text) b.textContent = text;
  b.disabled = off;
  b.classList.toggle("working", busy);
  b.onclick = act;
  if (note.textContent !== sub) note.textContent = sub;
}

// ------------------------------------------------------------------ side panel

/** redraw the side panel, at most once a frame however many events arrive */
let queued = false;
function render() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    renderNow();
  });
}

let builders = { at: -1, n: 0 };
function renderNow() {
  const st = S.status;
  if (!st) return;
  if (lostDrafts) {
    toast(lostDrafts === 1 ? "Someone took one of your spots" : `Someone took ${lostDrafts} of your spots`, "", 5000);
    lostDrafts = 0;
  }
  R.stats = { minted: Number(st.minted), paid: Number(st.totalPaid / 10n ** 18n) };
  if (builders.at !== B.placedCount) {
    const owners = new Set<string>();
    for (const p of B.parts.values()) if (p.placed) owners.add(p.owner.toLowerCase());
    builders = { at: B.placedCount, n: owners.size };
  }
  $("total-parts").textContent = B.placedCount.toLocaleString();
  $("total-builders").textContent = builders.n.toLocaleString();
  money($("total-paid"), st.totalPaid);
  $("total-minted").textContent = Number(st.minted).toLocaleString();
  money($("total-won"), st.totalWon);
  $("my-placed").textContent = S.myParts().filter(p => p.placed).length.toLocaleString();
  $("r-open").textContent = Number(st.open).toLocaleString();
  money($("r-reserve"), st.reserve);

  money($("s-price"), st.price);
  mintButton();

  const myWeight = S.myParts().filter((p) => p.placed).reduce((s, p) => s + TIER_WEIGHT[B.designs.get(p.design)?.tier ?? 0], 0);
  money($("earned"), st.earned);
  $<HTMLButtonElement>("claim").disabled = st.earned === 0n || !!S.busy;
  $("share").textContent = st.totalWeight ? `${((myWeight / Number(st.totalWeight)) * 100).toFixed(2)}%` : "–";
  if (S.me) money($("bal"), st.balance);
  else $("bal").textContent = "–";
  $("earn-count").textContent = st.earned > 0n || st.referralEarned > 0n ? "●" : "";
  $("you-panel").classList.toggle("signed-out", !S.me);
  $("you-signin").hidden = !!S.me;
  referrals.render(checkingOut);

  updateHints();
  renderShelf();
  renderBuild();
  renderSeats();
}

let revealing = new Set<number>(); // shelf items waiting for the beacon at the last redraw

/** waiting tiles count down to their beacon round */
function revealCountdown() {
  document.querySelectorAll<HTMLElement>("#shelf .tile.waiting").forEach(el => {
    const left = Math.ceil(drandTime(Number(el.dataset.drand)) - Date.now() / 1000);
    // A minute without a fetched signature is a delivery delay; it does not establish a drand outage.
    const text = left > 0 ? `in ${left < 60 ? `${left}s` : clock(left)}` : left > -60 ? "now" : "delayed";
    const eta = el.querySelector(".eta")!;
    if (eta.textContent !== text) eta.textContent = text;
  });
}

/** the shelf tile a part is being dragged from stays in place, faded */
function markLifting() {
  const lifted = dragging && !dragging.origin ? dragging.id : null;
  $("shelf").querySelectorAll<HTMLElement>("[data-part]").forEach(el => el.classList.toggle("lifting", Number(el.dataset.part) === lifted));
}

function renderShelf() {
  const shelf = $("shelf");
  const items = shelfItems();
  if (armed !== null && !items.some(i => i.id === armed)) {
    armed = null; // placed by Auto-arrange, or revealed by someone else
    updateHints();
    $("board-hint").hidden = true;
  }
  const appearance = (S.me || "-") + "|" + motionPreference.matches;
  const key = appearance + "|" + items.map((i) => `${i.id}:${i.design}`).join(",") + "|" + B.drafts.size;
  if (shelf.dataset.key !== key) {
    if (shelf.dataset.appearance !== appearance) shelf.replaceChildren();
    shelf.dataset.appearance = appearance;
    shelf.dataset.key = key;
    if (!items.length) {
      shelf.replaceChildren();
      const e = document.createElement("div");
      e.className = "empty";
      if (B.drafts.size) e.textContent = "All your parts are on the board. Install them to plug them in.";
      else if (S.me && S.myParts().some(p => p.placed)) e.textContent = "All your parts are placed.";
      else {
        // a new player: the whole game in three lines
        e.classList.add("how");
        e.innerHTML = `<b>How to play</b><ol><li>Buy parts. Each one is a surprise, and rarer parts earn more.</li>
          <li>Plug them into open sockets on the machine.</li>
          <li>Every part on the machine earns a share of each new purchase, and parts plugged into yours pay you too. When the clock runs out, the last ten placed share the jackpot.</li></ol>`;
      }
      shelf.appendChild(e);
    } else {
      shelf.querySelector(".empty")?.remove();
      const slots = new Map<string, { design: number | null; ids: number[]; drand?: number }>();
      for (const it of items) {
        // Unknown mints share a slot per beacon round (one purchase) until the beacon reveals their types.
        const slot = it.design === null ? `wait:${it.drand}` : `design:${it.design}`;
        const stack = slots.get(slot);
        if (stack) stack.ids.push(it.id);
        else slots.set(slot, { design: it.design, ids: [it.id], drand: it.drand });
      }
      const existing = new Map([...shelf.querySelectorAll<HTMLButtonElement>("[data-slot]")].map(el => [el.dataset.slot!, el]));
      const ordered = [...slots].sort(([, a], [, b]) =>
        (a.design ?? -1) - (b.design ?? -1) || b.ids[0] - a.ids[0]);
      let index = 0;
      for (const [slot, { design, ids, drand }] of ordered) {
        const id = armed !== null && ids.includes(armed) ? armed : ids[0];
        const el = existing.get(slot) ?? tile(design);
        el.dataset.slot = slot;
        if (design !== null) updateTile(el, id, design, ids.length);
        else {
          el.dataset.drand = String(drand);
          el.querySelector(".tile-amount")!.textContent = `×${ids.length}`;
        }
        // just revealed: the tile blinks a few times
        if (design !== null && ids.some(i => revealing.has(i))) {
          el.classList.remove("just");
          void el.offsetWidth;
          el.classList.add("just");
        }
        // Keep the slot, keyboard focus and scroll position as its quantity changes.
        if (shelf.children[index] !== el) shelf.insertBefore(el, shelf.children[index] ?? null);
        existing.delete(slot);
        index++;
      }
      for (const el of existing.values()) el.remove();
    }
    revealing = new Set(items.filter(i => i.design === null).map(i => i.id));
    revealCountdown();
  }
  const empty = items.length === 0 && B.drafts.size === 0;
  const buy = $("tray-mint");
  buy.textContent = empty ? "Buy parts" : "Buy more";
  buy.classList.toggle("primary", empty);
  buy.classList.toggle("secondary", !empty);
  markLifting();
  const ready = items.filter((i) => i.design !== null).length;
  const waiting = items.length - ready;
  $("autoplace").hidden = ready === 0;
  $<HTMLButtonElement>("autoplace").disabled = !!S.busy || B.draftFull;
  $("parts-tray").classList.toggle("empty-inventory", items.length === 0);
  $("parts-count").textContent = items.length ? `${items.length}` : "";
  const inventory = items.length + B.drafts.size + Number(!!dragging?.origin);
  $("inventory-count").textContent = inventory ? `${inventory}` : "";
  $("parts-hint").textContent = B.draftFull ? "Draft full. Install or remove a part to add another."
    : waiting ? `${waiting} revealing…` : "";
  updateShelfSelection();
}

function renderBuild() {
  const all = B.drafts.size, n = [...B.drafts.values()].filter((d) => d.ok).length, bad = all - n;
  $("buildbar").hidden = !placement || all === 0 || !!dragging;
  if (!all) return;
  const blocked = !bad && !B.growthExit();
  $("build-text").textContent = bad ? (bad === 1 ? "1 part doesn't fit. Move or remove it." : `${bad} parts don't fit. Move or remove them.`)
    : blocked ? "Leave an outside connection open" : `${plural(n, "part")} ready`;
  $("build-text").classList.toggle("bad", blocked || (bad > 0 && n === 0));
  const b = $<HTMLButtonElement>("build");
  b.textContent = S.busy ? `${S.busy}…` : "Install";
  b.disabled = !!S.busy || building || n === 0 || bad > 0 || blocked;
  b.classList.toggle("working", !!S.busy || building);
  $<HTMLButtonElement>("build-clear").disabled = !!S.busy || building;
}

function renderSeats() {
  const cc = $("core-claim");
  const ccKey = mySeats.map((m) => m.seat).join(",");
  if (cc.dataset.key === ccKey) return;
  cc.dataset.key = ccKey;
  cc.innerHTML = mySeats.length
    ? `<p><span class="seat">${plural(mySeats.length, "identity.md seat")}</span>: one free Agent Core each.</p><div class="btns">` +
      mySeats.slice(0, 12).map((m) => `<button class="btn sm" data-seat="${m.seat}">Claim core #${m.seat}</button>`).join("") + "</div>"
    : "";
  cc.querySelectorAll<HTMLElement>("[data-seat]").forEach((b) => (b.onclick = async () => {
    const m = mySeats.find((x) => x.seat === Number(b.dataset.seat))!;
    if (await S.send("claimAgentCore", [m.seat, m.proof], { label: `Claiming core #${m.seat}`, done: `Agent Core #${m.seat} claimed` })) {
      seatsFor = "";
      await loadSeats();
      render();
    }
  }));
}

function tile(design: number | null): HTMLElement {
  const el = document.createElement("button");
  el.type = "button";
  if (design === null) {
    el.disabled = true;
    el.className = "tile waiting";
    el.innerHTML = `<span>Revealing<br><em class="eta"></em></span><span class="tile-amount" aria-hidden="true"></span>`;
    el.prepend(partsLoader());
    return el;
  }
  el.setAttribute("aria-pressed", "false");
  el.appendChild(partImage(design, 64, !motionPreference.matches));
  const lab = document.createElement("span");
  lab.className = "tile-label";
  const amount = document.createElement("span");
  amount.className = "tile-amount";
  amount.setAttribute("aria-hidden", "true");
  el.append(lab, amount);
  el.addEventListener("pointerdown", e => {
    if (e.button !== 0 || S.busy) return;
    shelfPress = { id: Number(el.dataset.part), pointer: e.pointerId, x: e.clientX, y: e.clientY, touch: e.pointerType !== "mouse" };
  });
  el.addEventListener("click", e => {
    if (e.detail === 0) placeByKeys(Number(el.dataset.part)); // keyboard / assistive activation
  });
  return el;
}

function updateTile(el: HTMLElement, id: number, design: number, count: number) {
  const d = B.designs.get(design)!;
  const p = id > 0 ? B.parts.get(id) : null;
  el.className = `tile ${TIER_CLASS[d.tier]}${id < 0 ? " fresh" : ""}`;
  el.dataset.part = String(id);
  el.dataset.design = String(design);
  el.setAttribute("aria-label", `Place ${d.name}, ${TIER_NAME[d.tier]}, ${count} available`);
  el.querySelector(".tile-label")!.innerHTML = `${d.name}${count === 1 && p?.seat !== undefined ? ` #${p.seat}` : ""}<br>${rarityTag(d.tier)}`;
  el.querySelector(".tile-amount")!.textContent = `×${count}`;
}

// ------------------------------------------------------------------ drag & drop (arranging drafts)

// dragging a part from the shelf, or moving a draft (origin: where it was, to put it back if dropped nowhere)
// (grab: where in the part it's held, relative to its pivot, so a moved draft doesn't jump under the pointer)
let dragging: { id: number; design: number; rot: number; plug: bigint; grab: [number, number]; origin?: { rot: number; px: number; py: number }; snap?: Spot | null } | null = null;
let press: { draft: number; pointer: number; x: number; y: number } | null = null; // pointer down on a draft: a tap selects, a drag moves
let shelfPress: { id: number; pointer: number; x: number; y: number; touch: boolean } | null = null;
let lastPointer: [number, number] = [0, 0];
const REASON = { occupied: "Occupied", mismatch: "Edges don't match", unplugged: "Not connected", bounds: "Outside the board" };

function startDrag(id: number, e: PointerEvent, origin?: { rot: number; px: number; py: number }, grab: [number, number] = [0, 0]) {
  e.preventDefault();
  if (!B.canDraft(id)) return void toast("Draft full. Install or remove a part to add another", "", 3500);
  zoomTarget = null;
  armed = null;
  updateShelfSelection();
  select(null);
  if (Number(S.status?.start ?? 0) > chainNow()) return void toast("Not open yet", "", 2500);
  const design = designOf(id);
  dragging = { id, design, rot: origin?.rot ?? 0, plug: 0n, grab, origin };
  plugOf(id).then((p) => dragging && dragging.id === id && (dragging.plug = p)).catch(() => {});
  canvas.classList.add("placing");
  updateHints();
  const float = $("drag-float");
  float.replaceChildren(partImage(design, 56, false));
  moveFloat(e.clientX, e.clientY);
  markLifting();
  $("buildbar").hidden = true;
  $("placebar").hidden = false;
  bar(e.pointerType === "mouse" ? "Drop to place. R rotates." : "Drop to place", "");
}

/** keyboard: a part goes straight to a spot where it fits and is selected; arrows move it between fitting spots,
 *  R turns it, Delete returns it, Install sends the draft */
function placeByKeys(id: number) {
  if (S.busy) return;
  if (!B.canDraft(id)) return void toast("Draft full. Install or remove a part to add another", "", 3500);
  if (!placement) showPanel("parts");
  const design = designOf(id), s = B.autoSpot(B.tmplOf(design));
  if (!s) return void toast("No open socket fits this part right now", "", 3500);
  B.addDraft(id, design, s.rot, s.x, s.y);
  armed = null;
  select(id);
  showSelected();
  syncPlacement();
  render();
  toast(`${B.designs.get(design)!.name} placed. Arrow keys move it, R turns it, Delete returns it`, "", 5000);
}

/** move the selected draft to the nearest spot where it fits in direction (dx, dy) */
function stepSelected(dx: number, dy: number) {
  const d = R.selected === null ? undefined : B.drafts.get(R.selected);
  if (!d) return;
  const tmpl = B.tmplOf(d.design);
  let best: Spot | null = null, score = Infinity;
  for (const s of B.fitSpots(tmpl, d.id)) {
    const along = (s.mx - d.px) * dx + (s.my - d.py) * dy, across = Math.abs((s.mx - d.px) * dy - (s.my - d.py) * dx);
    if (along < .5) continue;
    const v = along + 2 * across + (s.rot === d.rot ? 0 : .5);
    if (v < score) [best, score] = [s, v];
  }
  if (!best) return;
  B.addDraft(d.id, d.design, best.rot, best.x, best.y);
  showSelected();
  render();
}

/** keep the selected draft in view */
function showSelected() {
  const d = R.selected === null ? undefined : B.drafts.get(R.selected);
  if (!d) return;
  const [sx, sy] = R.toScreen(d.px, d.py), area = boardArea();
  if (sx < 40 || sx > area.width - 40 || sy < area.top + 40 || sy > area.top + area.height - 40) frameAt(d.px, d.py, Math.max(R.cam.z, 1));
}

function armPart(id: number) {
  if (S.busy) return;
  if (!B.canDraft(id)) return void toast("Draft full. Install or remove a part to add another", "", 3500);
  zoomTarget = null;
  armed = armed === id ? null : id;
  select(null);
  syncPlacement();
}

function cancelDrag() {
  shelfPress = null;
  if (dragging?.origin) B.setDraft(dragging.id, dragging.design, dragging.origin.rot, dragging.origin.px, dragging.origin.py);
  stopDrag();
}

function bar(text: string, cls: string) {
  const b = $("placebar");
  b.textContent = text;
  b.className = cls;
}

/** the part under the pointer while it is dragged outside the board (over the board, the board shows it) */
function moveFloat(x: number, y: number) {
  const f = $("drag-float");
  f.hidden = !dragging || overCanvas(x, y);
  f.style.left = `${x}px`;
  f.style.top = `${y}px`;
}

function stopDrag() {
  dragging = null;
  R.ghost = null;
  $("drag-float").hidden = true;
  updateHints();
  markLifting();
  canvas.classList.remove("placing");
  $("placebar").hidden = true;
  renderBuild();
  render();
}

function overCanvas(x: number, y: number) {
  const sheet = openPanel();
  if (sheet) {
    const p = sheet.getBoundingClientRect();
    if (x >= p.left && x <= p.right && y >= p.top && y <= p.bottom) return false;
  }
  const r = canvas.getBoundingClientRect();
  const [sx, sy] = R.screenToFlat(x - r.left, y - r.top);
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && sx >= 0 && sx <= r.width && sy >= 0 && sy <= r.height;
}

/** "pays 0.025 IMD to you", "to the pot", "to 0x12…34 and you" */
function payText(payees: number[], plug: bigint) {
  if (!payees.length || plug === 0n) return "";
  const share = plug / BigInt(payees.length);
  const names = payees.map((id) => (id === 0 ? "the pot" : id < 0 || B.drafts.has(id) || same(B.parts.get(id)?.owner, S.me) ? "you" : short(B.parts.get(id)?.owner ?? "")));
  const counts = new Map<string, number>();
  names.forEach((n) => counts.set(n, (counts.get(n) ?? 0) + 1));
  const list = [...counts].map(([n, c]) => `${fmt(share * BigInt(c))} IMD to ${n}`);
  return `Pays ${list.length > 1 ? list.slice(0, -1).join(", ") + " and " + list[list.length - 1] : list[0]}`;
}

/** the pivot a drop at this pointer position would give (world units) */
function pivotAt(cx: number, cy: number): [number, number] {
  const r = canvas.getBoundingClientRect();
  const [wx, wy] = R.toWorld(cx - r.left, cy - r.top);
  return [wx + dragging!.grab[0], wy + dragging!.grab[1]];
}

function ghostAt(cx: number, cy: number) {
  if (!dragging) return;
  if (!overCanvas(cx, cy)) return void (R.ghost = null);
  const tmpl = B.tmplOf(dragging.design);
  const { w, h } = bbox(tmpl);
  const [px, py] = pivotAt(cx, cy);
  // exactly the turn you gave it: no snapping, it shows whether it fits
  const rot = dragging.rot, x = Math.round(px - (rot % 2 ? h : w) / 2), y = Math.round(py - (rot % 2 ? w : h) / 2);
  const fit = B.fit(tmpl, rot, x, y);
  // close to a spot where it fits: it snaps there
  const snap = fit.ok ? null : nearestSpot(px, py, 1.4, "middle", rot);
  dragging.snap = snap;
  if (snap) {
    R.ghost = { design: dragging.design, rot: snap.rot, x: snap.x, y: snap.y, ok: true };
    return bar(payText(B.payees(tmpl, snap.rot, snap.x, snap.y), dragging.plug) || "Fits", "ok");
  }
  R.ghost = { design: dragging.design, rot, x, y, ok: fit.ok };
  if (fit.ok) bar(payText(B.payees(tmpl, rot, x, y), dragging.plug) || "Fits", "ok");
  else bar(`${REASON[fit.reason]}. ${spots.length ? "Try a green spot." : "Drop it, then rotate."}`, "no");
}

window.addEventListener("pointermove", (e) => {
  lastPointer = [e.clientX, e.clientY];
  if (shelfPress?.pointer === e.pointerId) {
    const dx = Math.abs(e.clientX - shelfPress.x), dy = Math.abs(e.clientY - shelfPress.y);
    const acrossShelf = matchMedia("(min-width: 1000px)").matches ? dx > dy : dy > dx;
    if (Math.max(dx, dy) > 8 && (!shelfPress.touch || acrossShelf)) {
      const id = shelfPress.id;
      shelfPress = null;
      startDrag(id, e);
    }
  }
  if (dragging) {
    moveFloat(e.clientX, e.clientY);
    ghostAt(e.clientX, e.clientY);
  }
});
window.addEventListener("pointerup", (e) => {
  if (shelfPress?.pointer === e.pointerId) {
    const p = shelfPress;
    shelfPress = null;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < 8) armPart(p.id);
  }
  if (!dragging) return;
  const d = dragging, inside = overCanvas(e.clientX, e.clientY), [px, py] = pivotAt(e.clientX, e.clientY);
  stopDrag();
  if (inside) {
    // anywhere on the board, fitting or not: rotate and move it until it fits
    if (d.snap ? B.addDraft(d.id, d.design, d.snap.rot, d.snap.x, d.snap.y) : B.setDraft(d.id, d.design, d.rot, px, py)) select(d.id);
    else toast("Draft full. Install or remove a part to add another", "", 3500);
  } else if (d.origin) B.setDraft(d.id, d.design, d.origin.rot, d.origin.px, d.origin.py); // dragged off the board: back where it was
  render();
});
window.addEventListener("pointercancel", () => {
  cancelDrag();
  press = null;
  pointers.clear();
  pan = pinch = null;
});
window.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement)?.closest?.("input, select, textarea, dialog")) return;
  if (e.key === "Escape") {
    if (picked !== null) return pickPart(null);
    const editing = !!dragging || armed !== null || R.selected !== null;
    cancelDrag();
    armed = null;
    select(null);
    syncPlacement();
    if (!editing && panel) showPanel(null, true);
    return;
  }
  if (!dragging) {
    if (R.selected === null || (e.target as HTMLElement)?.closest?.("input, select, textarea")) return;
    if (e.key === "r" || e.key === "R") rotateSelected();
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeSelected(); }
    const step = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[e.key];
    if (step) { e.preventDefault(); stepSelected(...step); }
    return;
  }
  if (e.key === "r" || e.key === "R") {
    dragging.rot = (dragging.rot + 1) % 4;
    ghostAt(...lastPointer);
  }
});

// ------------------------------------------------------------------ navigation & hover

const ZMIN = 0.12, ZMAX = 6;
const pointers = new Map<number, [number, number]>();
let pan: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
let pinch: { d: number; z: number } | null = null;
let zoomTarget: { z: number; sx: number; sy: number } | null = null;
let zoomTime = 0;

function openPanel() { return panel ? $(panel === "parts" ? "parts-tray" : `${panel}-panel`) : null; }

/** Space unobscured by the open panel, for framing parts and positioning board overlays. */
function boardArea() {
  const r = canvas.getBoundingClientRect(), p = openPanel()?.getBoundingClientRect();
  let width = r.width, height = r.height, top = 0;
  const overlaps = p && p.left < r.right && p.right > r.left && p.top < r.bottom && p.bottom > r.top;
  if (overlaps && p.width > r.width * .65) height = Math.max(80, p.top - r.top - 12);
  else if (overlaps) width = Math.max(80, p.left - r.left - 16);
  // small screens: the clock and jackpot sit over the top of the board, so frame parts below them
  const hud = $("round-summary").getBoundingClientRect();
  if (hud.left < r.right && hud.right > r.left && hud.bottom > r.top && hud.top < r.top + height) top = Math.min(height * .5, hud.bottom - r.top + 8);
  // desktop: the clock, jackpot and places float over the left of the board, so frame parts to their right
  let left = 0;
  const rail = $("prize-rail").getBoundingClientRect();
  if (!matchMedia("(max-width: 999px)").matches && rail.right > r.left) left = Math.min(width * .45, rail.right - r.left);
  return { left, top, width: width - left, height: height - top };
}

function frameAt(x: number, y: number, z: number) {
  zoomTarget = null;
  R.cam.z = z;
  const r = canvas.getBoundingClientRect(), area = boardArea();
  const [sx, sy] = R.screenToFlat(area.left + area.width / 2, area.top + area.height / 2);
  R.cam.x = x - (sx - r.width / 2) / R.cs;
  R.cam.y = y - (sy - r.height / 2) / R.cs;
}

function updatePanelSpace() {
  const r = canvas.getBoundingClientRect(), p = openPanel()?.getBoundingClientRect();
  const overlaps = p && p.left < r.right && p.right > r.left && p.top < r.bottom && p.bottom > r.top;
  const sheet = overlaps && p.width > r.width * .65;
  const inset = sheet ? Math.max(0, r.bottom - p.top) + 12 : 0;
  $("stage").style.setProperty("--sheet-inset", `${inset}px`);
  const sideInset = overlaps && !sheet ? Math.max(0, r.right - p.left) : 0;
  $("stage").style.setProperty("--panel-side-inset", `${sideInset}px`);
}

function smoothZoom(sx: number, sy: number, factor: number) {
  const z = Math.min(ZMAX, Math.max(ZMIN, (zoomTarget?.z ?? R.cam.z) * factor));
  if (R.lowMotion) { zoomTarget = null; zoomAt(sx, sy, z); }
  else { zoomTarget = { z, sx, sy }; zoomTime = performance.now(); }
}

function zoomAt(sx: number, sy: number, z: number) {
  const [wx, wy] = R.toWorld(sx, sy);
  R.cam.z = Math.min(ZMAX, Math.max(ZMIN, z));
  const [nx, ny] = R.toWorld(sx, sy);
  R.cam.x += wx - nx;
  R.cam.y += wy - ny;
}

canvas.addEventListener("pointerdown", (e) => {
  if (dragging || e.button !== 0) return;
  zoomTarget = null;
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z: R.cam.z };
    press = null;
    pan = null;
    return;
  }
  const rr = canvas.getBoundingClientRect();
  const onDraft = placement && armed === null && overCanvas(e.clientX, e.clientY) ? R.draftAt(...R.toWorld(e.clientX - rr.left, e.clientY - rr.top)) : null;
  if (onDraft !== null && onDraft === R.selected && e.isPrimary && !S.busy) {
    press = { draft: onDraft, pointer: e.pointerId, x: e.clientX, y: e.clientY };
    return;
  }
  pan = { x: e.clientX, y: e.clientY, cx: R.cam.x, cy: R.cam.y, moved: false };
});
canvas.addEventListener("pointermove", (e) => {
  const r = canvas.getBoundingClientRect();
  if (press?.pointer === e.pointerId && Math.abs(e.clientX - press.x) + Math.abs(e.clientY - press.y) > 6) {
    // moving a draft: lift it and drag it, held where it was grabbed
    const d = B.drafts.get(press.draft)!;
    const [wx, wy] = R.toWorld(press.x - r.left, press.y - r.top);
    press = null;
    pointers.clear();
    B.removeDraft(d.id);
    startDrag(d.id, e, { rot: d.rot, px: d.px, py: d.py }, [d.px - wx, d.py - wy]);
    ghostAt(e.clientX, e.clientY);
    return;
  }
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    zoomAt((a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top, (pinch.z * Math.hypot(a[0] - b[0], a[1] - b[1])) / pinch.d);
    return;
  }
  if (pan) {
    const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) pan.moved = true;
    if (pan.moved) {
      const [sx, sy] = R.screenToFlat(pan.x - r.left, pan.y - r.top);
      const [ex, ey] = R.screenToFlat(e.clientX - r.left, e.clientY - r.top);
      R.cam.x = pan.cx - (ex - sx) / R.cs;
      R.cam.y = pan.cy - (ey - sy) / R.cs;
    }
  }
  const [wx, wy] = R.toWorld(e.clientX - r.left, e.clientY - r.top);
  const onGlass = overCanvas(e.clientX, e.clientY);
  const draft = placement && onGlass ? R.draftAt(wx, wy) : null;
  const id = draft === null && onGlass ? R.partAt(wx, wy) : null;
  R.hover = id;
  canvas.classList.toggle("over-draft", draft !== null && draft === R.selected);
  const tip = $("tip");
  if (picked !== null) {
    // a pinned window stays put; the pointer only moves the hover outline
  } else if ((id !== null || draft !== null) && !dragging && !pan?.moved && e.pointerType === "mouse") {
    tip.hidden = false;
    tip.style.visibility = "";
    delete tip.dataset.tier;
    if (draft !== null) {
      const d = B.designs.get(B.drafts.get(draft)!.design)!;
      tip.dataset.tier = TIER_CLASS[d.tier];
      const dr = B.drafts.get(draft)!;
      tip.innerHTML = `<b>${d.name}</b> <span class="${dr.ok ? "mine" : "bad"}">${dr.ok ? "ready" : REASON[dr.reason as keyof typeof REASON]}</span>`;
    } else if (id === 0) tip.innerHTML = `<b>Core</b><br><span class="sub">The heart of the machine. Still beating.</span>`;
    else {
      const p = B.parts.get(id!)!;
      const d = B.designs.get(p.design)!;
      tip.dataset.tier = TIER_CLASS[d.tier];
      tip.innerHTML = `<span class="tip-head"><b>${d.name}${p.seat !== undefined ? " #" + p.seat : ""}</b>${rarityTag(d.tier)}</span>
        <span class="sub">${same(p.owner, S.me) ? "Yours" : short(p.owner)}. Click for details</span>`;
    }
    const area = boardArea();
    const x = e.clientX - r.left, y = e.clientY - r.top, gap = 14;
    const right = area.left + area.width - 6, bottom = area.top + area.height - 6;
    // Width/height are extents, not coordinates: include the HUD offsets before checking the edges.
    const left = x + gap + tip.offsetWidth <= right ? x + gap : x - tip.offsetWidth - gap;
    const top = y + gap + tip.offsetHeight <= bottom ? y + gap : y - tip.offsetHeight - gap;
    // Hover remains next to the cursor even outside the area reserved for camera framing.
    tip.style.left = Math.max(6, Math.min(left, right - tip.offsetWidth)) + "px";
    tip.style.top = Math.max(6, Math.min(top, bottom - tip.offsetHeight)) + "px";
  } else tip.hidden = true;
});
const release = (e: PointerEvent) => {
  if (press?.pointer === e.pointerId) {
    // a tap on a draft selects it (the toolbar shows above it); a second tap deselects
    select(R.selected === press.draft ? null : press.draft);
    press = null;
    pointers.delete(e.pointerId);
    pickPart(null);
    $("tip").hidden = true;
    return;
  }
  if (dragging) return;
  // a click (not a drag) on the board: deselect, and a part sends a signal through the wiring
  if (pan && !pan.moved && !dragging && !pinch && overCanvas(e.clientX, e.clientY)) {
    const r = canvas.getBoundingClientRect();
    if (placement && armed !== null) {
      const id = armed, design = designOf(id);
      const [px, py] = R.toWorld(e.clientX - r.left, e.clientY - r.top);
      const spot = nearestSpot(px, py, 1.6, "cell");
      pointers.delete(e.pointerId);
      pan = null;
      // a miss keeps the part picked; the hint says where it fits
      if (!spot) return nudge(spots.length ? "Tap one of the green spots" : hintText());
      if (!B.addDraft(id, design, spot.rot, spot.x, spot.y)) toast("Draft full. Install or remove a part to add another", "", 3500);
      armed = null;
      select(id);
      syncPlacement();
      render();
      pointers.delete(e.pointerId);
      pan = null;
      return;
    }
    const draft = placement ? R.draftAt(...R.toWorld(e.clientX - r.left, e.clientY - r.top)) : null;
    if (draft !== null) {
      select(draft);
      pointers.delete(e.pointerId);
      pan = null;
      pickPart(null);
      $("tip").hidden = true;
      return;
    }
    select(null);
    const id = R.partAt(...R.toWorld(e.clientX - r.left, e.clientY - r.top));
    pickPart(id === picked ? null : id); // a second tap on the same part closes its window
    if (id !== null) R.pulse(id);
  }
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  pan = null;
  if (pointers.size === 1) {
    const [[x, y]] = [...pointers.values()];
    pan = { x, y, cx: R.cam.x, cy: R.cam.y, moved: true };
  }
};
canvas.addEventListener("pointerup", release);
canvas.addEventListener("pointerleave", () => {
  R.hover = null;
  canvas.classList.remove("over-draft");
  if (picked === null) $("tip").hidden = true; // a pinned window stays
});
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const delta = e.deltaY * (e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? r.height : 1);
  smoothZoom(e.clientX - r.left, e.clientY - r.top, Math.exp(-delta * 0.0015));
}, { passive: false });
document.querySelectorAll<HTMLButtonElement>("#zoom button").forEach((b) => (b.onclick = () => {
  if (b.dataset.z === "home") frameAt(.5, .5, 2.2);
  else if (b.dataset.z === "fit") fitView();
  else {
    const area = boardArea();
    smoothZoom(area.left + area.width / 2, area.top + area.height / 2, Number(b.dataset.z));
  }
}));
new ResizeObserver(() => { zoomTarget = null; R.resize(); updatePanelSpace(); }).observe(canvas);
matchMedia("(min-width: 1000px)").addEventListener("change", e => { if (e.matches && panel === null) showPanel("parts"); });
const panelObserver = new ResizeObserver(updatePanelSpace);
document.querySelectorAll<HTMLElement>(".game-panel").forEach(p => panelObserver.observe(p));

// ------------------------------------------------------------------ controls

function setQuantity(value: string) {
  if (checkingOut || S.busy) return;
  qty = /^\d+$/.test(value) ? Number(value) : 0;
  document.querySelectorAll("#qty button").forEach((x) => {
    const on = validQty() && Number((x as HTMLElement).dataset.q) === qty;
    x.classList.toggle("on", on);
    x.setAttribute("aria-pressed", String(on));
  });
  mintButton();
}
document.querySelectorAll<HTMLButtonElement>("#qty button").forEach(b => b.onclick = () => setQuantity(b.dataset.q!));
document.querySelectorAll<HTMLButtonElement>("#payment button").forEach(b => b.onclick = () => {
  if (checkingOut || S.busy) return;
  payment = b.dataset.pay as "imd" | "eth";
  document.querySelectorAll<HTMLButtonElement>("#payment button").forEach(x => {
    const on = x === b;
    x.classList.toggle("on", on);
    x.setAttribute("aria-pressed", String(on));
  });
  mintButton();
});
document.querySelectorAll<HTMLButtonElement>("#game-dock button").forEach(b => b.onclick = () => showPanel(panel === b.dataset.panel && !matchMedia("(min-width: 1000px)").matches ? null : b.dataset.panel as Panel));
document.querySelectorAll<HTMLButtonElement>(".panel-close").forEach(b => b.onclick = () => showPanel(null, true));
$("tray-mint").onclick = () => { showPanel("mint"); $("mint").focus(); };
// small screens: the clock and jackpot open the prize places under them (the desktop column always shows them)
const folded = matchMedia("(max-width: 999px)");
const railToggle = () => {
  const open = folded.matches && $("prize-rail").classList.toggle("open");
  $("round-summary").setAttribute("aria-expanded", String(!!open));
};
$("round-summary").onclick = railToggle;
$("round-summary").onkeydown = (e) => { if (folded.matches && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); railToggle(); } };
const railRole = () => {
  const r = $("round-summary");
  if (folded.matches) { r.setAttribute("role", "button"); r.tabIndex = 0; r.setAttribute("aria-controls", "hud-stack"); r.setAttribute("aria-expanded", String($("prize-rail").classList.contains("open"))); }
  else { r.setAttribute("role", "group"); r.removeAttribute("tabindex"); r.removeAttribute("aria-expanded"); $("prize-rail").classList.remove("open"); }
};
folded.addEventListener("change", railRole);
railRole();
$("display-settings").onclick = () => {
  const body = document.createElement("div");
  body.innerHTML = `<label class="setting"><span><b>Performance mode</b><small>Stops canvas animation and effects.</small></span><input id="performance-mode" type="checkbox" ${display.performance ? "checked" : ""}></label>
    <label class="setting"><span><b>CRT effect</b><small>Curved glass and scanlines.</small></span><input id="crt-mode" type="checkbox" ${display.crt ? "checked" : ""}></label>
    <p class="small muted" id="motion-note" ${motionPreference.matches ? "" : "hidden"}>Reduced motion follows your device setting.</p>`;
  modal("Display", body);
  const perf = body.querySelector<HTMLInputElement>("#performance-mode")!, crt = body.querySelector<HTMLInputElement>("#crt-mode")!;
  const update = () => {
    display.performance = perf.checked;
    display.crt = crt.checked;
    try { localStorage.setItem("machine-display", JSON.stringify(display)); } catch { /* still apply for this visit */ }
    applyDisplay();
    crt.disabled = R.lowMotion;
    const note = body.querySelector<HTMLElement>("#motion-note")!;
    note.hidden = !motionPreference.matches;
  };
  crt.disabled = R.lowMotion;
  perf.onchange = crt.onchange = update;
};
document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => (b.onclick = () => {
  document.querySelectorAll(".tabs button").forEach((x) => {
    x.classList.toggle("on", x === b);
    x.setAttribute("aria-selected", String(x === b));
    (x as HTMLButtonElement).tabIndex = x === b ? 0 : -1;
  });
  document.querySelectorAll<HTMLElement>("section.tab").forEach((s) => (s.hidden = s.dataset.tab !== b.dataset.tab));
}));
document.querySelectorAll<HTMLElement>('[role="tablist"]').forEach(nav => nav.addEventListener("keydown", e => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
  const tabs = [...nav.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const i = tabs.indexOf(e.target as HTMLButtonElement);
  if (i < 0) return;
  e.preventDefault();
  const next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].click();
  tabs[next].focus();
}));
$("autoplace").onclick = () => autoArrange();
$("you-connect").onclick = () => pickWallet(S);
$("build").onclick = () => build();
$("dt-rotate").onclick = () => rotateSelected();
$("dt-remove").onclick = () => removeSelected();
$("build-clear").onclick = () => {
  B.removeDraft();
  select(null);
  render();
};
$("claim").onclick = async () => {
  const amt = S.status?.earned ?? 0n;
  if (await S.claimAll((n) => `Claiming from ${plural(n, "part")}`)) toast(`Claimed ${fmt(amt)} IMD${paren(amt)}`, "ok", 4000);
  render();
};
$("end-round").onclick = async () => {
  if (await S.send("endRound", [], { label: "Ending the round", done: "Round ended" })) await S.refreshStatus().then(render);
};
$("warn-ok").onclick = () => {
  try { localStorage.setItem("warned", "1"); } catch { /* storage blocked: ask again next visit */ }
  $<HTMLDialogElement>("warn").close();
};

const who = (a: string) => (same(a, S.me) ? "You" : short(a));

function log(msg: string, cls = "", past = false, key = "") {
  const first = $("log").firstElementChild as HTMLElement | null;
  if (key && first?.dataset.key === key) {
    // the same batch: update its line
    first.className = "l " + cls + (past ? " past" : "");
    first.querySelector("span")!.textContent = msg;
    return;
  }
  const d = document.createElement("div");
  d.dataset.key = key;
  d.className = "l " + cls + (past ? " past" : "");
  const t = document.createElement("time");
  t.textContent = past ? "" : new Date().toTimeString().slice(0, 5); // earlier activity: no time of its own
  const m = document.createElement("span");
  m.textContent = msg;
  m.title = msg;
  d.append(t, m);
  $("log").prepend(d);
  while ($("log").childElementCount > 80) $("log").lastElementChild!.remove();
}

// ------------------------------------------------------------------ the draft toolbar

function select(id: number | null) {
  R.selected = id;
  placeTools();
}

function rotateSelected() {
  if (R.selected === null) return;
  const d = B.drafts.get(R.selected);
  if (!d) return;
  // the next quarter turn that fits around where it is (it may shift a cell to plug in); else a plain turn
  const tmpl = B.tmplOf(d.design), own = B.fitSpots(tmpl, d.id), cells = new Set(d.fp.map(([x, y]) => `${x},${y}`));
  for (let k = 1; k < 4; k++) {
    const r = (d.rot + k) % 4;
    const near = own.filter(s => s.rot === r && footprint(tmpl, r, s.x, s.y).some(([x, y]) => cells.has(`${x},${y}`)))
      .sort((a, b) => Math.hypot(a.mx - d.px, a.my - d.py) - Math.hypot(b.mx - d.px, b.my - d.py))[0];
    if (near) {
      B.addDraft(d.id, d.design, r, near.x, near.y);
      placeTools();
      render();
      return;
    }
  }
  B.rotateDraft(R.selected);
  placeTools();
  render();
}

function removeSelected() {
  if (R.selected === null) return;
  B.removeDraft(R.selected);
  select(null);
  render();
}

/** keep the toolbar just above the selected draft (below it near the top edge) */
function placeTools() {
  const tools = $("draft-tools");
  const d = R.selected === null ? undefined : B.drafts.get(R.selected);
  if (!placement || !d || dragging) return void (tools.hidden = true);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of d.fp) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x + 1), Math.max(y1, y + 1)];
  const [sx0, sy0] = R.toScreen(x0, y0), [sx1, sy1] = R.toScreen(x1, y1);
  tools.hidden = false;
  const why = $("dt-why");
  const text = d.ok ? "" : REASON[d.reason as keyof typeof REASON];
  if (why.textContent !== text) why.textContent = text;
  const w = tools.offsetWidth, h = tools.offsetHeight;
  const area = boardArea();
  tools.style.left = `${Math.max(4, Math.min(area.left + area.width - w - 4, (sx0 + sx1) / 2 - w / 2))}px`;
  const above = sy0 - h - 8 > area.top + 4;
  tools.style.top = `${Math.max(area.top + 4, Math.min(area.top + area.height - h - 4, above ? sy0 - h - 8 : sy1 + 8))}px`;
}

function loop(t: number) {
  if (!document.hidden) {
    const moving = !!zoomTarget || !!pan?.moved || !!pinch || !!dragging;
    if (zoomTarget) {
      const dt = Math.min(64, Math.max(0, t - zoomTime));
      zoomTime = t;
      const { z, sx, sy } = zoomTarget, distance = Math.log(z / R.cam.z);
      zoomAt(sx, sy, R.lowMotion || Math.abs(distance) < .0005 ? z : R.cam.z * Math.exp(distance * (1 - Math.exp(-dt / 65))));
      if (R.lowMotion || Math.abs(distance) < .0005) zoomTarget = null;
    }
    R.frame(t, moving);
    placePinned();
    $("zoom-readout").textContent = `${Math.round(R.cam.z * 100)}%`;
    if (R.selected !== null) placeTools();
  }
  requestAnimationFrame(loop);
}

R.resize();
syncPlacement();
if (matchMedia("(min-width: 1000px)").matches) showPanel("parts");
(window as any).__store = S;
(window as any).__frame = (x: number, y: number) => frameAt(x, y, R.cam.z); // testing: centre the view on a cell
(window as any).__R = R;
/** testing only: fill this browser's copy of the board with n random parts placed by the wiring rules */
(window as any).__stress = (n: number) => {
  let id = 1_000_000;
  for (let i = 0; i < n; i++) {
    const d = PARTS[Math.floor(Math.random() * PARTS.length)];
    const s = B.autoSpot(d.tmpl);
    if (!s) continue;
    B.upsert({ id, design: d.id, owner: "0x" + (i % 40).toString(16).padStart(40, "0") });
    B.place(id++, s.rot, s.x, s.y);
  }
  return B.placedCount;
};
(window as any).__predicted = predicted;
(window as any).__shelf = () => shelfItems();
boot().catch((e) => {
  console.error(e);
  $("load-text").textContent = `Couldn't reach the chain: ${String(e.shortMessage ?? e.message ?? e).split("\n")[0]}`;
  $("loading").classList.add("failed");
  $("loading").querySelector("label")!.textContent = "Couldn't load machine";
  $<HTMLImageElement>("load-animation").src = "./parts-loader-static.svg";
});
