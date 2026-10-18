// Shared navigation and a wallet control in the top-right corner on every page.
import { devAccount } from "./chain";
import { Store, short, niceError } from "./store";
import { discover } from "./wallet";
import { modal, toast } from "./ui";

const PAGES = [
  ["index.html", "Dashboard"],
  ["archive.html", "Archive"],
  ["docs.html", "Docs"],
] as const;

/** Provider metadata is data, never HTML. Only data images belong in wallet controls. */
function walletIcon(icon?: string): HTMLElement {
  if (typeof icon === "string" && /^data:image\/(?:png|jpeg|gif|webp|svg\+xml)(?:;|,)/i.test(icon)) {
    const img = document.createElement("img");
    img.alt = "";
    img.src = icon;
    return img;
  }
  const dot = document.createElement("i");
  dot.className = "dot";
  return dot;
}

export function shell(active: (typeof PAGES)[number][1] | "Parts") {
  const top = document.getElementById("top")!;
  const q = location.search; // keep ?net= across pages
  top.innerHTML = `<a class="brand" href="./index.html${q}" aria-label="Identity Machine"><img class="mark" src="./brand/mark.svg" alt=""><span>Identity Machine</span></a>
    <nav aria-label="Site pages">${PAGES.map(([href, name]) => `<a href="./${href}${q}"${name === active ? ' class="on" aria-current="page"' : ""}>${name}</a>`).join("")}
      <a class="dev-link" href="https://x.com/nitroslaveth" target="_blank" rel="noopener noreferrer" aria-label="Developer and updates on X: @nitroslaveth (opens in a new tab)" title="Developer and updates: @nitroslaveth on X"><span>dev</span><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26L22.827 21.75H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg></a></nav>
    <div class="stats" id="stats"></div>
    <div class="wallet" id="wallet"><button class="btn outline" disabled>Connect</button></div>`;
}

/** stats in the header: [label, value, id?] */
export function stats(items: [string, string, string?][]) {
  const el = document.getElementById("stats")!;
  const key = items.map((i) => i[0]).join("|");
  if (el.dataset.key !== key) {
    el.dataset.key = key;
    el.innerHTML = items.map(([l, , id]) => `<div><label>${l}</label><b${id ? ` id="${id}"` : ""}></b></div>`).join("");
  }
  el.querySelectorAll("b").forEach((b, i) => (b.textContent = items[i][1]));
}

/** the wallet corner: a test-wallet picker on the local chain, else connect / account menu. Re-renders itself
 *  whenever the wallet changes (account switch in the wallet, network switch, disconnect) and calls `changed`. */
export function wallet(S: Store, changed: () => void) {
  const render = () => {
    const w = document.getElementById("wallet")!;
    if (S.D.chainId === 31337 && S.devIndex !== null) {
      if (w.dataset.mode === "dev") return;
      w.dataset.mode = "dev";
      const narrow = matchMedia("(max-width: 480px)").matches; // phones: the number alone fits the header
      w.innerHTML = `<span class="who">Test wallet</span><select id="dev" aria-label="Test wallet" title="Test wallet">${Array.from({ length: 10 }, (_, i) =>
        `<option value="${i}" ${i === S.devIndex ? "selected" : ""}>#${i}${narrow ? "" : " " + short(devAccount(i).address)}</option>`).join("")}</select>`;
      (document.getElementById("dev") as HTMLSelectElement).onchange = (e) => S.setDev(Number((e.target as HTMLSelectElement).value));
      return;
    }
    const mode = !S.me ? "out" : S.wrongChain ? "wrong" : "in:" + S.me;
    if (w.dataset.mode === mode) return;
    w.dataset.mode = mode;
    if (!S.me) {
      w.innerHTML = `<button class="btn outline" id="conn">Connect</button>`;
      document.getElementById("conn")!.onclick = () => pickWallet(S);
    } else if (S.wrongChain) {
      w.innerHTML = `<button class="btn outline warn" id="conn" aria-label="Switch network" title="Wrong network"><span class="wallet-full">Switch network</span><span class="wallet-short">Switch</span></button>`;
      document.getElementById("conn")!.onclick = () => S.conn!.switchChain().catch((e) => toast(niceError(e), "bad"));
    } else {
      const icon = S.conn?.state.info?.icon;
      w.innerHTML = `<button class="btn outline acct" id="conn" aria-haspopup="menu"><span class="wallet-full"></span><span class="wallet-short"></span></button>`;
      const button = document.getElementById("conn")!;
      button.setAttribute("aria-label", `Wallet ${S.me}`);
      button.title = S.me;
      button.prepend(walletIcon(icon));
      button.querySelector(".wallet-full")!.textContent = short(S.me);
      button.querySelector(".wallet-short")!.textContent = `${S.me.slice(0, 4)}…${S.me.slice(-2)}`;
      document.getElementById("conn")!.onclick = (e) => accountMenu(S, e.currentTarget as HTMLElement);
    }
  };
  S.onWallet = () => {
    render();
    changed();
  };
  S.onNeedWallet = () => pickWallet(S);
  render();
}

/** the list of wallets in this browser (EIP-6963); picking one connects it */
export async function pickWallet(S: Store) {
  const list = await discover();
  const body = document.createElement("div");
  body.className = "wallets";
  if (!list.length) {
    body.innerHTML = `<p class="muted">No wallet found. Install <a href="https://rabby.io" target="_blank" rel="noopener">Rabby</a> or <a href="https://metamask.io" target="_blank" rel="noopener">MetaMask</a> and reload.</p>`;
  }
  const m = modal("Connect", body);
  for (const info of list) {
    const b = document.createElement("button");
    b.className = "wallet-opt";
    b.innerHTML = `<span></span><em></em>`;
    b.prepend(walletIcon(info.icon));
    b.querySelector("span")!.textContent = info.name;
    b.onclick = async () => {
      b.disabled = true;
      b.querySelector("em")!.textContent = "Check wallet";
      if (await S.connectWith(info)) m.close();
      else {
        b.disabled = false;
        b.querySelector("em")!.textContent = "";
      }
    };
    body.appendChild(b);
  }
  if (list.length) {
    const p = document.createElement("p");
    p.className = "muted small";
    p.textContent = S.D.chainId === 4663 ? "Robinhood Chain (4663)" : "Local test chain (31337)";
    body.appendChild(p);
  }
}

function accountMenu(S: Store, anchor: HTMLElement) {
  document.querySelector(".menu")?.remove();
  const m = document.createElement("div");
  m.className = "menu";
  m.setAttribute("role", "menu");
  const explorer = S.D.chainId === 4663 ? `<a role="menuitem" href="https://robin.etherscan.io/address/${S.me}" target="_blank" rel="noopener">Explorer ↗</a>` : "";
  m.innerHTML = `<div class="menu-head"><label></label><span class="mono"></span></div>
    <button role="menuitem" data-a="copy">Copy address</button>${explorer}
    <button role="menuitem" data-a="switch">Switch wallet</button>
    <button role="menuitem" data-a="out">Disconnect</button>`;
  m.querySelector(".menu-head label")!.textContent = S.conn?.state.info?.name ?? "Wallet";
  m.querySelector(".menu-head .mono")!.textContent = S.me;
  const r = anchor.getBoundingClientRect();
  m.style.right = Math.max(8, innerWidth - r.right) + "px";
  document.body.appendChild(m);
  // Keep the account menu inside the window.
  m.style.top = Math.max(8, Math.min(r.bottom + 6, innerHeight - m.offsetHeight - 8)) + "px";
  const off = (e: Event) => {
    if (e instanceof KeyboardEvent && e.key !== "Escape") return;
    if (e.type === "pointerdown" && m.contains(e.target as Node)) return;
    m.remove();
    document.removeEventListener("pointerdown", off);
    document.removeEventListener("keydown", off);
  };
  setTimeout(() => {
    document.addEventListener("pointerdown", off);
    document.addEventListener("keydown", off);
  });
  m.querySelectorAll<HTMLButtonElement>("button").forEach((b) => (b.onclick = async () => {
    m.remove();
    if (b.dataset.a === "copy") {
      await navigator.clipboard?.writeText(S.me).catch(() => {});
      toast("Copied", "ok", 1500);
    }
    if (b.dataset.a === "switch") pickWallet(S);
    if (b.dataset.a === "out") S.conn?.disconnect();
  }));
}
