// The Docs page: the rules in one place, with numbers taken from the same code the game uses. A contents
// sidebar (a dropdown on phones) follows the section being read.
import { shell, wallet } from "./shell";
import { Store } from "./store";
import { fmt, priceAt, SPLIT, REFERRAL, WIN, PLACES } from "./econ";
import { DROPS, TIER_WEIGHT, TEMPLATE_NAME } from "./geometry";
import { rarityTag } from "./rarity";
import { PARTS } from "./parts.gen";

shell("Docs");
const pct = (bps: number) => `${bps / 100}%`;

const prices = [0, 500, 1500, 3000, 4500, 6000, 7500, 9000]
  .map((k) => `<tr><td>${(k + 1).toLocaleString()}</td><td>${fmt(priceAt(k))} IMD</td></tr>`).join("");

/** each rarity's shapes and their odds */
const shapes = (t: number) => Object.entries(DROPS[t]).map(([tmpl, w]) => [TEMPLATE_NAME[+tmpl].toLowerCase(), w / 10] as const)
  .sort((a, b) => b[1] - a[1]).map(([n, w]) => `${n} ${w}%`).join(", ");
const odds = [0, 1, 2, 3].map((t) => {
  const n = PARTS.filter((p) => p.tier === t).length;
  return `<tr><td>${rarityTag(t)}</td><td>${["70%", "22%", "7%", "1%"][t]}</td><td>${TIER_WEIGHT[t]}×</td><td>${n}</td></tr>`
    + `<tr class="sub"><td colspan="4">Shapes: ${shapes(t)}</td></tr>`;
}).join("");
const weights = ["common", "uncommon", "rare", "legendary", "Agent Core"].map((n, t) => `${n} ${TIER_WEIGHT[t]}`).join(", ");

const places = PLACES.map((b, i) => `<tr><td>${i + 1}</td><td>${pct(b)}</td></tr>`).join("");

const split = [
  ["Plug-pay", SPLIT.plug, "travels with the part, and goes to the parts it plugs into"],
  ["Shared", SPLIT.shared, "split across every part on the machine, by rarity"],
  ["Jackpot", SPLIT.pot, "this round's jackpot, doubled by the reserve"],
  ["Reserve", SPLIT.reserve, "saved to grow future jackpots"],
  ["Burned", SPLIT.burn, "sent to 0x…dEaD"],
  ["Developer", SPLIT.dev, ""],
].map(([n, b, w]) => `<tr><td>${n}</td><td>${pct(b as number)}</td><td class="muted">${w}</td></tr>`).join("");

const glance = [
  ["Currency", "IMD, or ETH swapped to IMD"],
  ["First part of a round", `${fmt(priceAt(0))} IMD, rising with every part bought`],
  ["Round clock", "24 hours, +30 seconds per part placed"],
  ["Jackpot", `the last ten parts placed share ${pct(WIN)}, the rest starts the next one`],
  ["Shared income", `${pct(SPLIT.shared)} of every purchase, to all placed parts`],
  ["Plug-pay", `${pct(SPLIT.plug)} of a part's price, to the parts it plugs into`],
  ["Install", "up to 50 parts in one transaction"],
].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");

const controls = ([
  ["Place a part", "Tap a green spot, or drag the part close to one", ["Enter"]],
  ["Move it", "Drag it", ["←", "↑", "→", "↓"]],
  ["Turn it", "Tap it, then the turn button", ["R"]],
  ["Take it back", "Tap it, then ×", ["Delete"]],
  ["Install the draft", "Press Install", []],
] as const).map(([a, t, k]) => `<tr><td>${a}</td><td>${t}</td><td>${k.map((w) => `<kbd>${w}</kbd>`).join(" ")}</td></tr>`).join("");

const q = location.search;
/** the page, in groups: [group, [id, title, body][]] */
const groups: [string, [string, string, string][]][] = [
  ["Start here", [
    ["overview", "Overview", `
      <p>Everyone builds one machine together each round, on Robinhood Chain, paying in IMD. Your parts earn while the machine runs, and the last ten placed share the jackpot. There's no owner, admin or server: the contracts run everything on this page.</p>
      <h3>Quick start</h3>
      <ol class="steps-list">
        <li><b>Buy parts.</b> Each one is a surprise, and rarer parts earn more.</li>
        <li><b>Plug them into open sockets</b> on the machine, then press Install.</li>
        <li><b>Earn.</b> Every part on the machine earns a share of each new purchase, and parts plugged into yours pay you too. When the clock runs out, the last ten placed share the jackpot.</li>
      </ol>
      <p><a class="cta" href="./index.html${q}">Open the game →</a></p>
      <h3>At a glance</h3>
      <table class="tbl kv"><tbody>${glance}</tbody></table>`],
  ]],
  ["Playing", [
    ["buy", "Buy parts", `
      <p>Every part is a surprise. <a href="https://drand.love" target="_blank" rel="noopener">drand</a>, a public randomness service, picks it, and the contract checks the draw. It lands in your inventory about 10 seconds after you buy.</p>
      <p>Pay with IMD, or with ETH, which is swapped for exactly the IMD needed in the same transaction. Buy a single part, a pack of 5 or a booster box of 20.</p>
      <h3>Price</h3>
      <p>Each round starts at ${fmt(priceAt(0))} IMD a part, and the price rises with every part bought in it. A new round starts over.</p>
      <div class="tbl-wrap"><table class="tbl narrow"><thead><tr><th>Part # this round</th><th>Price</th></tr></thead><tbody>${prices}</tbody></table></div>`],
    ["place", "Place", `
      <p>Each round has a new machine. It grows out from a 3×3 core with twelve sockets.</p>
      <h3>Rules</h3>
      <ul>
        <li>A part must plug into at least one socket.</li>
        <li>Every edge it touches must match: socket to socket, blank to blank.</li>
        <li>The machine must always be able to grow, so you can't close off its last open outer socket. The game checks this for you.</li>
      </ul>
      <h3>Drafts and Install</h3>
      <p>Pick a part and every spot where it fits lights up green. Parts you place are a draft until you press <b>Install</b>, which places up to 50 at once with one wallet confirmation. Installing is permanent: the parts become part of that machine.</p>
      <p>Parts you don't place stay in your inventory for a later round.</p>
      <h3>Controls</h3>
      <div class="tbl-wrap"><table class="tbl controls"><thead><tr><th>To</th><th>Touch or mouse</th><th>Keyboard</th></tr></thead><tbody>${controls}</tbody></table></div>`],
    ["earning", "Earn", `
      <p>A placed part earns in two ways, until its round's clock runs out. What it earned stays yours to claim at any time.</p>
      <h3>Plug-pay</h3>
      <p>Half of what a part cost travels with it. When it's placed, that half is split equally between the parts it plugs into. If it plugs into the core, that share goes to the jackpot. Plug into your own parts and you keep it.</p>
      <p>Rare parts have 4–5 sockets and legendaries 6–8, so there's more room for others to plug in and pay you.</p>
      <h3>Shared income</h3>
      <p>${pct(SPLIT.shared)} of every later purchase in the round is split across all placed parts by rarity: ${weights}. What you paid for a part doesn't change its share.</p>`],
    ["rounds", "Rounds", `
      <p>The clock starts at 24 hours. <b>Every part placed adds 30 seconds</b>, up to 24 hours. Buying doesn't move it.</p>
      <p>When the clock hits zero the round is over. Anyone can close it, and the next purchase does it automatically. A new machine opens right away with a full clock, ${pct(10000 - WIN)} of the old jackpot, and the price back at ${fmt(priceAt(0))} IMD.</p>
      <p>Round 1 opens after a launch countdown. Until then, anyone can add to its jackpot.</p>`],
    ["jackpot", "Jackpot", `
      <p><b>The last ten parts placed share ${pct(WIN)} of the jackpot</b>, paid to whoever placed them. The last part placed before the clock runs out takes first place.</p>
      <table class="tbl narrow"><thead><tr><th>Place</th><th>Share</th></tr></thead><tbody>${places}</tbody></table>
      <h3>The next jackpot</h3>
      <p>The other ${pct(10000 - WIN)}, plus any empty places, starts the next round's jackpot, so a new round never opens empty.</p>
      <h3>The reserve</h3>
      <p>The reserve takes ${pct(SPLIT.reserve)} of every purchase. While it lasts, it matches the IMD that goes into the jackpot from each purchase, so jackpots grow faster.</p>`],
  ]],
  ["Economy", [
    ["split", "Where your IMD goes", `
      <p>Every purchase is split the same way:</p>
      <table class="tbl"><tbody>${split}</tbody></table>
      <p>If the buyer came through a referral link, ${pct(REFERRAL)} of the price moves from shared to the referrer.</p>
      <p class="muted">Once a part is placed, anyone can also sponsor the builders with <code>sponsor(amount)</code>: the IMD is split across the running machine's parts by rarity.</p>`],
    ["parts", "Parts and odds", `
      <p>A part rolls a rarity, then a shape, then a design. The odds are the same for everyone, every time. See every part on the <a href="./parts.html${q}">Parts</a> page.</p>
      <div class="tbl-wrap"><table class="tbl odds"><thead><tr><th>Rarity</th><th>Chance</th><th>Share</th><th>Designs</th></tr></thead><tbody>${odds}</tbody></table></div>
      <h3>Agent Core</h3>
      <p>identity.md seat holders can claim one free Agent Core per seat. It earns shared income like a common, with no plug-pay.</p>`],
    ["referrals", "Referrals", `
      <p>Share your link from <b>You</b> and earn ${pct(REFERRAL)} of what the people you bring spend, whether they pay in IMD or ETH. Claim any time.</p>`],
  ]],
  ["Reference", [
    ["archive", "Archive", `
      <p>Finished machines stay on chain. The <a href="./archive.html${q}">Archive</a> draws each one so you can explore it part by part.</p>`],
    ["agents", "For agents", `
      <p>Everything is a plain contract call. <a href="./llms.txt">llms.txt</a> covers buying, revealing with drand, the wiring rules, <code>check()</code> (a dry run that also shows who a placement would pay), <code>build</code> and the round functions.</p>`],
    ["contracts", "Contracts", `
      <div class="tbl-wrap"><table class="tbl" id="addrs"><tbody><tr><td class="muted">Loading…</td></tr></tbody></table></div>`],
    ["risks", "Risks", `
      <ul>
        <li>Nobody can change, pause or undo the contracts, including us. There's no admin. Purchases cannot be cancelled or refunded.</li>
        <li>Each purchase waits on one specific drand draw. If drand never publishes it, the purchase stays unrevealed.</li>
        <li>Prices rise through a round, but a part's share depends on its rarity, not what it cost. Late parts are mostly a shot at the jackpot.</li>
        <li>Parts stop earning when the clock runs out.</li>
        <li>Bots race for the last ten places.</li>
        <li>Robinhood Chain has a single sequencer that orders transactions and sets block times. The game trusts it, like every app on the chain.</li>
        <li>Only spend what you're fine losing.</li>
      </ul>`],
  ]],
];

const navLinks = groups.map(([g, items]) => `<div class="docs-group"><span>${g}</span>${items.map(([id, t]) => `<a href="#${id}" data-id="${id}">${t}</a>`).join("")}</div>`).join("");
document.getElementById("docs")!.innerHTML = `
  <details class="docs-mobile" id="docs-mobile"><summary><span>Contents</span><b id="docs-current">Overview</b></summary><nav aria-label="Contents">${navLinks}</nav></details>
  <aside class="docs-nav"><nav aria-label="Contents">${navLinks}</nav></aside>
  <article class="docs-body">
    <h1>How Identity Machine works</h1>
    ${groups.map(([, items]) => items.map(([id, t, body]) => `
    <section id="${id}">${id === "overview" ? `<h2 class="sr-only">${t}</h2>` : `<h2><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${t}</h2>`}${body}</section>`).join("")).join("")}
  </article>`;

// highlight the section being read: the last one whose heading has passed the top third of the screen
const sections = [...document.querySelectorAll<HTMLElement>(".docs-body section")];
const mobile = document.getElementById("docs-mobile") as HTMLDetailsElement;
let current = "";
function spy() {
  const line = innerHeight / 3;
  let id = sections[0].id;
  for (const s of sections) if (s.getBoundingClientRect().top <= line) id = s.id;
  if (innerHeight + scrollY >= document.documentElement.scrollHeight - 2) id = sections[sections.length - 1].id;
  if (id === current) return;
  current = id;
  document.querySelectorAll<HTMLAnchorElement>(".docs-group a").forEach((a) => a.classList.toggle("on", a.dataset.id === id));
  document.getElementById("docs-current")!.textContent = sections.find((s) => s.id === id)!.querySelector("h2")!.textContent!.replace(/^#/, "");
}
let ticking = false;
addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(() => { ticking = false; spy(); }); } }, { passive: true });
addEventListener("resize", spy);
mobile.addEventListener("click", (e) => { if ((e.target as HTMLElement).closest("a")) mobile.open = false; });
spy();

const S = new Store({ board: false });
S.init().then(() => {
  wallet(S, () => {});
  const D = S.D;
  const rows = [["Machine (buying, rounds, jackpot)", D.machine], ["Inventory", D.parts], ["Views", D.views],
    ...(D.ethMinter ? [["ETH checkout", D.ethMinter]] : []), ["drand beacon", D.beacon], ["IMD", D.imd]];
  const link = (a: string) => (D.chainId === 4663 ? `<a href="https://robin.etherscan.io/address/${a}" target="_blank" rel="noopener">${a}</a>` : a);
  document.querySelector("#addrs tbody")!.innerHTML = rows.map(([n, a]) => `<tr><td>${n}</td><td class="mono">${link(a)}</td></tr>`).join("")
    + `<tr><td>Chain</td><td class="mono">${D.chainId === 4663 ? "Robinhood Chain (4663)" : `local test chain (${D.chainId})`}</td></tr>`;
}).catch(() => {});
if (location.hash) setTimeout(() => { document.querySelector(location.hash)?.scrollIntoView(); spy(); }, 50);
