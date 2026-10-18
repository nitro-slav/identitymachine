// Shared chain state. The running machine, my inventory and my pending mints are read from MachineViews in a few
// calls, then kept current by following new events (the machine and the inventory items). Full
// history is only scanned on demand: the parts I placed in earlier rounds (to claim) and the Leaders tab.
import {
  createWalletClient, custom, decodeEventLog, getAddress, maxUint256, toEventSelector, type AbiEvent, type Address, type Hex, type Log, type WalletClient,
} from "viem";
import { Board, AGENT_CORE } from "./geometry";
import { loadDeploy, publicClient, walletFor, chainFor, machineAbi, partsAbi, viewsAbi, erc20Abi, devAccount, type Deploy } from "./chain";
import { Connection, type WalletInfo } from "./wallet";
import { toast } from "./ui";

export type Ev = { name: string; args: any; block: bigint };
type Listener = (ev: Ev, live: boolean) => void;

/** MachineViews.status, plus my placed-part and referral earnings. */
export interface Status {
  time: bigint; start: bigint; round: bigint; begin: bigint; deadline: bigint; roundMinted: bigint; placed: bigint;
  open: bigint; pot: bigint; reserve: bigint; price: bigint; minted: bigint; nextId: bigint; totalWeight: bigint;
  totalPaid: bigint; totalWon: bigint; earned: bigint; referralEarned: bigint; balance: bigint; allowance: bigint; inventory: bigint;
}

export interface Pending { owner: string; drand: number; price?: bigint }

const ZERO = "0x0000000000000000000000000000000000000000";
const eventsOf = (abi: any[]) => new Map<string, AbiEvent>(abi.filter((x) => x.type === "event").map((x) => [toEventSelector(x as AbiEvent), x as AbiEvent]));
const EVENTS = eventsOf(machineAbi);
const PART_EVENTS = eventsOf(partsAbi);
export const selector = (name: string) => [...EVENTS].find(([, e]) => e.name === name)![0] as Hex;

/** Decode logs by contract address: the inventory ledger's or the machine's. */
export function decode(l: Log, D?: Deploy): Ev | null {
  const inventory = !!D && same(l.address, D.parts);
  const item = (inventory ? PART_EVENTS : EVENTS).get(l.topics[0] ?? "");
  if (!item) return null;
  try {
    const ev = decodeEventLog({ abi: [item], data: l.data, topics: l.topics }) as any;
    return { name: ev.eventName, args: ev.args, block: l.blockNumber ?? 0n };
  } catch {
    return null;
  }
}

const BOARD_PAGE = 800; // parts per board() call: 1,600 words, a few million gas of reads
const MINT_PAGE = 3000; // ids per pendingOf() call
const INVENTORY_PAGE = 2000; // ids per inventory() call (an ownerOf each)
const CLAIM_PAGE = 400; // ids per claimable() call and per claim transaction

export class Store {
  board = new Board();
  D!: Deploy;
  pub!: ReturnType<typeof publicClient>;
  wallet: WalletClient | null = null;
  me: Address | "" = "";
  devIndex: number | null = null;
  conn: Connection | null = null;
  /** unrevealed mints: mine from the contract, everyone's that happen while the page is open */
  pending = new Map<number, Pending>();
  /** the running machine's parts in placement order (the last ten are the prize places) */
  order: number[] = [];
  /** parts I placed, in any round (their earnings and prizes are mine to claim) */
  placedByMe = new Set<number>();
  /** of those, the ones with something to claim right now */
  claimIds: number[] = [];
  status: Status | null = null;
  offset = 0; // chain time minus local time, seconds
  ready = false; // the machine is loaded
  busy: string | null = null; // a transaction in flight
  snapshotBlock = 0n;
  private lastBlock = 0n;
  private syncing: Promise<void> | null = null;
  private listeners: Listener[] = [];
  accountVersion = 0;
  private statusRequest = 0;
  private earningsRequest = 0;
  private inventoryRequest = 0;
  private pendingRequest = 0;
  private statusFlight: { account: string; version: number; block?: bigint; promise: Promise<Status | undefined> } | null = null;

  private currentAccount(account: string, version: number) {
    return account.toLowerCase() === this.me.toLowerCase() && version === this.accountVersion;
  }
  /** loading progress of the machine: parts read so far, of total */
  onProgress: (done: number, total: number) => void = () => {};
  /** the wallet connected, switched account or network, or disconnected; or a transaction started or ended */
  onWallet: () => void = () => {};
  /** something wants a wallet (e.g. a button pressed while disconnected): open the picker */
  onNeedWallet: () => void = () => {};

  constructor(private opts: { board?: boolean } = {}) {}

  async init() {
    this.D = await loadDeploy();
    this.pub = publicClient(this.D);
    if (await this.pub.getChainId() !== this.D.chainId) throw new Error("Deployment RPC is on the wrong chain");
    await this.initWallet();
    const block = await this.pub.getBlockNumber();
    this.snapshotBlock = this.lastBlock = block;
    while (!this.status) await this.refreshStatus(block);
    this.board.round = Number(this.status!.round);
    if (this.opts.board !== false) await this.loadBoard(block);
    await Promise.all([this.loadMine(block), this.loadInventory(block)]);
    this.ready = true;
    setInterval(() => this.sync().catch(console.error), 1500);
    this.loadPlaced().then(() => this.refreshEarnings()).then(() => this.onWallet()).catch(console.error);
  }

  private addPlaced(id: number) {
    if (Number.isSafeInteger(id)) this.placedByMe.add(id);
  }

  /** the prize order, first place first: the machine's leaders() (its last ten placements, most recent first),
   *  kept current between reads by moving a placed part to the front */
  leaders: number[] | null = null;
  topTen(): number[] {
    return this.leaders ?? this.order.slice(-10).reverse();
  }

  private front(id: number) {
    if (this.leaders) this.leaders = [id, ...this.leaders.filter((x) => x !== id)].slice(0, 10);
  }

  on(fn: Listener) {
    this.listeners.push(fn);
  }

  // ------------------------------------------------------------------ reads

  /** read at a block if the node still has it, else at the latest (the event tail fixes any difference) */
  private async at<T>(fn: (block?: bigint) => Promise<T>, block?: bigint): Promise<T> {
    try {
      return await fn(block);
    } catch (e) {
      if (block === undefined) throw e;
      return fn(undefined);
    }
  }

  read(functionName: string, args: any[] = [], address: Address = this.D.machine, abi: any = machineAbi, blockNumber?: bigint) {
    return this.pub.readContract({ address, abi, functionName, args, blockNumber } as any) as Promise<any>;
  }

  readViews(functionName: string, args: any[] = [], blockNumber?: bigint) {
    return this.read(functionName, args, this.D.views, viewsAbi, blockNumber);
  }

  /** the round, totals and my balances in one call; then what my placed parts have to claim */
  refreshStatus(block?: bigint): Promise<Status | undefined> {
    const old = this.statusFlight;
    if (old && old.account === this.me && old.version === this.accountVersion && old.block === block) return old.promise;
    const flight = { account: this.me, version: this.accountVersion, block, promise: null! as Promise<Status | undefined> };
    flight.promise = this.doRefreshStatus(block).finally(() => { if (this.statusFlight === flight) this.statusFlight = null; });
    this.statusFlight = flight;
    return flight.promise;
  }

  private async doRefreshStatus(block?: bigint) {
    const owner = this.me, version = this.accountVersion, request = ++this.statusRequest;
    const current = () => this.currentAccount(owner, version) && request === this.statusRequest;
    const account = owner || ZERO;
    const [status, referralEarned] = await Promise.all([
      this.at((b) => this.readViews("status", [account, []], b), block),
      this.at((b) => this.read("referralBalance", [account], this.D.machine, machineAbi, b), block),
    ]);
    const s = { ...status, earned: this.status?.earned ?? 0n, referralEarned } as Status;
    if (!current()) return;
    const leaders = await this.at((b) => this.read("leaders", [s.round], this.D.machine, machineAbi, b), block) as bigint[];
    if (!current() || (this.ready && Number(s.round) !== this.board.round)) return;
    this.status = s;
    this.offset = Number(s.time) - Date.now() / 1000;
    this.leaders = leaders.map(Number);
    await this.refreshEarnings();
    return s;
  }

  /** what the parts I placed have earned (plug-pay, shared income, prizes), in chunks */
  async refreshEarnings() {
    if (!this.status) return;
    const account = this.me, version = this.accountVersion, status = this.status, request = ++this.earningsRequest;
    const current = () => this.currentAccount(account, version) && this.status === status && request === this.earningsRequest;
    const ids = [...this.placedByMe].map(BigInt);
    let total = 0n;
    const claim: number[] = [];
    for (let i = 0; i < ids.length; i += CLAIM_PAGE) {
      const [got, sum] = (await this.readViews("claimable", [account || ZERO, ids.slice(i, i + CLAIM_PAGE)])) as [bigint[], bigint];
      if (!current()) return;
      claim.push(...got.map(Number));
      total += sum;
    }
    if (!current()) return;
    this.claimIds = claim;
    status.earned = total;
  }

  /** the running machine from board(), a page at a time, a few pages in flight */
  private async loadBoard(block: bigint) {
    const round = this.status!.round;
    const total = Number(this.status!.placed);
    let done = 0;
    this.onProgress(0, total);
    const starts: number[] = [];
    for (let from = 1; from <= total; from += BOARD_PAGE) starts.push(from);
    const worker = async () => {
      for (let from = starts.shift(); from !== undefined; from = starts.shift()) {
        const f = from;
        const words = (await this.at((b) => this.readViews("board", [round, BigInt(f), BigInt(BOARD_PAGE)], b), block)) as bigint[];
        for (let k = 0; k < words.length / 2; k++) this.applyWords(f + k, words[2 * k], words[2 * k + 1]);
        done += words.length / 2;
        this.onProgress(done, total);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }

  private applyWords(k: number, w0: bigint, w1: bigint) {
    const { placer, design, rot, place, id, x, y } = boardEntry(w0, w1);
    this.board.upsert({ id, owner: placer, design, plug: 0n, ...(place && { place }) });
    if (!this.board.parts.get(id)!.placed) this.board.place(id, rot, x, y);
    this.order[k - 1] = id;
    if (same(placer, this.me)) this.addPlaced(id);
  }

  /** my unrevealed mints (any age), with what it takes to predict them */
  async loadMine(block?: bigint) {
    if (!this.status) return;
    const account = this.me, version = this.accountVersion, request = ++this.pendingRequest;
    const current = () => this.currentAccount(account, version) && request === this.pendingRequest;
    for (const [id, p] of this.pending) if (same(p.owner, account)) this.pending.delete(id); // reloaded below
    if (!account) return;
    const total = Number(this.status.nextId) - 1;
    for (let from = 1; from <= total; from += MINT_PAGE) {
      const [ids, rounds] = (await this.at((b) => this.readViews("pendingOf", [account, BigInt(from), BigInt(MINT_PAGE)], b), block)) as [bigint[], bigint[]];
      if (!current()) return;
      ids.forEach((id, i) => this.pending.set(Number(id), { owner: account, drand: Number(rounds[i]) }));
    }
  }

  /** my inventory: the inventory items I hold */
  async loadInventory(block?: bigint) {
    if (!this.status) return;
    const account = this.me, version = this.accountVersion, request = ++this.inventoryRequest;
    const current = () => this.currentAccount(account, version) && request === this.inventoryRequest;
    for (const [id, p] of this.board.parts) if (!p.placed && same(p.owner, account)) this.board.parts.delete(id);
    if (!account) return;
    const total = Number(this.status.nextId) - 1;
    const starts: number[] = [];
    for (let from = 1; from <= total; from += INVENTORY_PAGE) starts.push(from);
    const worker = async () => {
      for (let from = starts.shift(); from !== undefined; from = starts.shift()) {
        const f = from;
        const [ids, designs, seats, plugs] = (await this.at((b) => this.readViews("inventory", [account, BigInt(f), BigInt(INVENTORY_PAGE)], b), block)) as [bigint[], number[], number[], bigint[]];
        if (!current()) return;
        ids.forEach((id, i) => {
          // A live placement may have consumed an item since this snapshot was requested.
          if (this.board.parts.get(Number(id))?.placed) return;
          this.board.upsert({ id: Number(id), owner: account, design: Number(designs[i]), plug: plugs[i], placed: false, ...(seats[i] && { seat: Number(seats[i]) - 1 }) });
        });
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  /** every part I placed since deploy (Placed events with me as the placer), so I can claim from old machines */
  async loadPlaced() {
    if (!this.me) return;
    const me = this.me;
    const version = this.accountVersion;
    const topic = ("0x" + me.slice(2).toLowerCase().padStart(64, "0")) as Hex;
    await this.logs(BigInt(this.D.startBlock ?? 0), this.lastBlock || this.snapshotBlock, [[selector("Placed")], null, null, [topic]], (evs) => {
      if (!this.currentAccount(me, version)) return;
      for (const ev of evs) if (ev.name === "Placed" && same(ev.args.placer, me)) this.addPlaced(Number(ev.args.id));
    }, 100_000n, [this.D.machine]);
  }

  // ------------------------------------------------------------------ events

  sync(): Promise<void> {
    if (!this.syncing) this.syncing = this.doSync().finally(() => (this.syncing = null));
    return this.syncing;
  }

  private async doSync() {
    const head = await this.pub.getBlockNumber();
    if (head <= this.lastBlock) return;
    await this.logs(this.lastBlock + 1n, head, undefined, async (evs, to) => {
      for (const ev of evs) await this.apply(ev, true);
      this.lastBlock = to;
    }, 5000n, [this.D.machine, this.D.parts]);
  }

  /**
   * Read logs over [from, to] in spans that adapt: a span that fails (too many results, too big a response, a
   * range limit) is halved, and spans that succeed grow again. `each` gets every span's events in order.
   */
  async logs(from: bigint, to: bigint, topics: Hex[] | (Hex[] | null)[] | undefined, each: (evs: Ev[], to: bigint) => void | Promise<void>, span = 5000n, address: Address[] = [this.D.machine]) {
    // a flat list of selectors means "any of these events"; a nested list is a full topic filter
    const filter = topics && (Array.isArray(topics[0]) || topics[0] === null ? topics : [topics]);
    for (let a = from; a <= to; ) {
      const b = a + span - 1n > to ? to : a + span - 1n;
      let raw: Log[];
      try {
        // eth_getLogs directly: viem's getLogs builds topics only from an event ABI and drops a raw filter
        const hex = (n: bigint) => `0x${n.toString(16)}`;
        const got = (await this.pub.request({ method: "eth_getLogs", params: [{ address, fromBlock: hex(a), toBlock: hex(b), ...(filter && { topics: filter }) }] } as any)) as any[];
        raw = got.map((l) => ({ ...l, blockNumber: l.blockNumber ? BigInt(l.blockNumber) : null }));
      } catch (e) {
        if (span === 1n) throw e;
        span = span / 2n;
        continue;
      }
      await each(raw.map((l) => decode(l, this.D)).filter((e): e is Ev => !!e), b);
      a = b + 1n;
      if (span < 2_000_000n) span *= 2n;
    }
  }

  /** the latest `want` events of the given kinds before the snapshot, oldest first (for the activity log) */
  async recent(names: string[], want = 40, maxCalls = 8): Promise<Ev[]> {
    const topics = names.map(selector);
    const out: Ev[] = [];
    let to = this.snapshotBlock, span = 50n, calls = 0; // start small: a busy stretch can hold a lot
    const floor = BigInt(this.D.startBlock ?? 0);
    while (out.length < want && to >= floor && calls++ < maxCalls) {
      const from = to - span + 1n > floor ? to - span + 1n : floor;
      const got: Ev[] = [];
      try {
        await this.logs(from, to, topics, (evs) => { got.push(...evs); }, span);
      } catch {
        break;
      }
      out.unshift(...got);
      to = from - 1n;
      span *= 4n;
    }
    return out.slice(-want);
  }

  /** every event of the given kinds from deploy up to the snapshot; progress goes 0..1 */
  async history(names: string[], progress: (f: number) => void = () => {}): Promise<Ev[]> {
    const out: Ev[] = [];
    const from = BigInt(this.D.startBlock ?? 0), to = this.snapshotBlock;
    await this.logs(from, to, names.map(selector), (evs, b) => {
      out.push(...evs);
      progress(to > from ? Number(b - from) / Number(to - from) : 1);
    }, 100_000n);
    return out;
  }

  private async apply(ev: Ev, live: boolean) {
    const a = ev.args;
    const B = this.board;
    switch (ev.name) {
      case "Issued":
        B.upsert({ id: Number(a.id), owner: a.owner });
        break;
      case "Consumed": // keep the design for the Placed event in the same transaction
        if (!B.parts.get(Number(a.id))?.placed) B.upsert({ id: Number(a.id), owner: "" });
        break;
      case "Minted":
        this.pending.set(Number(a.id), { owner: a.owner, drand: Number(a.drandRound), price: a.price });
        if (same(a.owner, this.me) && a.price > 0n) this.refreshMine();
        break;
      case "Revealed": {
        const m = this.pending.get(Number(a.id));
        this.pending.delete(Number(a.id));
        B.upsert({ id: Number(a.id), design: Number(a.design), ...(m?.price !== undefined && { plug: (m.price * 5000n) / 10_000n }) });
        break;
      }
      case "CoreClaimed":
        B.upsert({ id: Number(a.id), seat: Number(a.seat), owner: a.owner, design: AGENT_CORE, plug: 0n });
        break;
      case "Placed": {
        const id = Number(a.id);
        if (Number(a.round) !== B.round) {
          if (same(a.placer, this.me)) this.addPlaced(id);
          break;
        }
        if (!B.parts.get(id)?.designKnown) {
          const epoch = B.epoch;
          const p = await this.at(b => this.read("parts", [BigInt(id)], this.D.machine, machineAbi, b), ev.block);
          if (B.epoch !== epoch) return;
          B.upsert({ id, design: Number(p[0]), ...(p[6] && { seat: Number(p[6]) - 1 }) });
        }
        if (same(a.placer, this.me)) this.addPlaced(id);
        B.upsert({ id, owner: a.placer, plug: 0n });
        if (!B.parts.get(id)?.placed) {
          B.place(id, Number(a.rot), Number(a.x), Number(a.y));
          this.order.push(id);
          this.front(id);
        }
        break;
      }
      case "Prize":
        if (Number(a.round) === B.round) B.upsert({ id: Number(a.id), place: Number(a.place) });
        break;
      case "RoundEnded":
        if (Number(a.round) < B.round) return; // a retried event span must not reset an already-open machine
        // listeners see the old machine's last state first (the prize places), then the client's outro plays on it
        // (later events wait in line), then the new machine opens
        for (const fn of this.listeners) fn(ev, live);
        if (live && this.hold) await this.hold();
        this.ended.push({ round: Number(a.round), pot: a.pot, prize: a.prize, top: this.topTen() });
        B.reset(Number(a.round) + 1);
        this.order = [];
        this.leaders = [];
        this.refreshStatus().then(() => this.onWallet()).catch(() => {});
        return;
    }
    for (const fn of this.listeners) fn(ev, live);
  }

  /** awaited after a live RoundEnded reaches the listeners, before the next machine opens */
  hold: (() => Promise<void>) | null = null;

  /** machines that ended while the page was open: the round, its pot and prize, and its last ten parts */
  ended: { round: number; pot: bigint; prize: bigint; top: number[] }[] = [];

  private mineTimer: ReturnType<typeof setTimeout> | null = null;
  /** reload my pending mints soon (a mint of mine landed: its position in the round sets its odds) */
  refreshMine() {
    if (this.mineTimer) return;
    this.mineTimer = setTimeout(() => {
      this.mineTimer = null;
      this.loadMine().then(() => this.onWallet()).catch(() => {});
    }, 300);
  }

  // ------------------------------------------------------------------ wallet

  private async initWallet() {
    const chain = chainFor(this.D);
    // local chain: built-in test wallets, unless ?wallet=injected asks for your browser wallet (MetaMask, Rabby…)
    if (this.D.chainId === 31337 && new URLSearchParams(location.search).get("wallet") !== "injected") {
      this.devIndex = Number(localStorage.getItem("devIndex") ?? 0);
      await this.setDev(this.devIndex, true);
      return;
    }
    this.conn = new Connection(chain, (s) => {
      const was = this.me;
      this.me = s.account;
      this.wallet = s.account && s.info ? createWalletClient({ chain, account: s.account, transport: custom(s.info.provider) }) : null;
      if (was.toLowerCase() !== this.me.toLowerCase()) {
        if (this.ready) void this.reloadAccount();
        else ++this.accountVersion;
      }
      this.onWallet();
    });
    await this.conn.resume().catch(() => false);
  }

  get wrongChain() {
    return !!this.conn?.wrongChain;
  }

  async connectWith(info: WalletInfo) {
    try {
      await this.conn!.connect(info);
      return true;
    } catch (e: any) {
      toast(niceError(e), e?.code === 4001 ? "" : "bad");
      return false;
    }
  }

  async setDev(i: number, quiet = false) {
    this.devIndex = i;
    try {
      localStorage.setItem("devIndex", String(i));
    } catch {}
    this.wallet = await walletFor(this.D, i);
    this.me = (this.wallet.account?.address ?? "") as Address;
    if (!quiet && this.ready) await this.reloadAccount();
    this.onWallet();
  }

  /** everything that depends on the account: inventory, pending mints, the parts I placed, balances */
  async reloadAccount() {
    const version = ++this.accountVersion;
    ++this.statusRequest;
    this.placedByMe = new Set(this.order.filter((id) => same(this.board.parts.get(id)?.owner, this.me)));
    this.claimIds = [];
    if (this.status) Object.assign(this.status, { earned: 0n, referralEarned: 0n, balance: 0n, allowance: 0n, inventory: 0n });
    try {
      await Promise.all([this.loadMine(), this.loadInventory()]);
      if (version !== this.accountVersion) return;
      await this.refreshStatus();
      if (version !== this.accountVersion) return;
      this.onWallet();
      await this.loadPlaced();
      if (version !== this.accountVersion) return;
      await this.refreshEarnings();
    } catch (e) {
      console.warn(e);
    }
    this.onWallet();
  }

  // ------------------------------------------------------------------ transactions

  /**
   * Send a transaction with feedback at every step: checked first (so a doomed call shows the reason instead of
   * a wallet prompt), then "confirm in your wallet", "sending", and done or the reason it failed.
   */
  async send(functionName: string, args: any[], o: { label: string; done?: string; address?: Address; abi?: any; quiet?: boolean; value?: bigint; gas?: bigint; doneMs?: number }) {
    if (!this.wallet || !this.me) {
      this.onNeedWallet();
      return false;
    }
    if (this.wrongChain) {
      try {
        await this.conn!.switchChain();
      } catch (e) {
        toast(niceError(e), "bad");
        return false;
      }
    }
    const address = o.address ?? this.D.machine, abi = o.abi ?? machineAbi;
    const account = this.me, wallet = this.wallet;
    const t = toast(`${o.label}. Confirm in your wallet`, "wait", 0);
    this.busy = o.label;
    this.onWallet();
    try {
      const { request } = await this.pub.simulateContract({ address, abi, functionName, args, account, value: o.value, gas: o.gas } as any);
      if (!same(account, this.me) || wallet !== this.wallet || this.wrongChain) throw new Error("Wallet changed. Try again");
      const hash = await wallet.writeContract({ ...(request as any), account: wallet.account!, chain: wallet.chain });
      t.update(`${o.label}…`, "wait", 0, this.txLink(hash));
      // local test chain only: after a chain reset, wallets remember old nonces and their transactions queue
      // forever. If it hasn't mined in 8 s, line the chain's nonce up with the wallet's and resubmit.
      const stuck = this.D.chainId === 31337 ? setTimeout(() => this.unstickLocal().catch((e) => console.warn("unstick", e)), 8000) : 0;
      const rc = await this.pub.waitForTransactionReceipt({ hash }).finally(() => clearTimeout(stuck));
      if (rc.status !== "success") throw new Error("The transaction failed on chain");
      await this.sync();
      t.update(o.done ?? "Done", "ok", o.doneMs ?? 4000, this.txLink(hash));
      return true;
    } catch (e: any) {
      const msg = niceError(e);
      if (o.quiet) t.close();
      else t.update(msg, msg === "Cancelled" ? "" : "bad", 6000);
      return false;
    } finally {
      this.busy = null;
      this.onWallet();
    }
  }

  /** make sure `spender` may take `need` of my IMD (one approval, then never again) */
  async allow(spender: Address, need: bigint, token: Address = this.D.imd, name = "IMD") {
    if (!this.me) return false;
    const cur = spender === this.D.machine && token === this.D.imd && this.status
      ? this.status.allowance
      : ((await this.read("allowance", [this.me, spender], token, erc20Abi)) as bigint);
    if (cur >= need) return true;
    const ok = await this.send("approve", [spender, maxUint256], { label: `Approve ${name}`, done: `${name} approved`, doneMs: 1500, address: token, abi: erc20Abi });
    if (ok && spender === this.D.machine) await this.refreshStatus();
    return ok;
  }

  /** local anvil: the wallet signed with nonces ahead of the chain (it was reset). Set the account's nonce to the
   *  first queued one and resubmit the signed transactions in order, so they mine. */
  private async unstickLocal() {
    const rpc = (method: string, params: unknown[] = []) => this.pub.request({ method, params } as any) as Promise<any>;
    const pool = await rpc("txpool_content");
    // "queued" = waiting for an earlier nonce that will never come
    const mine = Object.entries((pool.queued ?? {}) as Record<string, Record<string, any>>)
      .filter(([a]) => same(a, this.me)).flatMap(([, txs]) => Object.values(txs))
      .sort((x, y) => Number(BigInt(x.nonce) - BigInt(y.nonce)));
    if (!mine.length) return;
    const raws = await Promise.all(mine.map((t) => rpc("eth_getRawTransactionByHash", [t.hash])));
    await rpc("anvil_removePoolTransactions", [this.me]);
    await rpc("anvil_setNonce", [this.me, mine[0].nonce]);
    await new Promise((r) => setTimeout(r, 1500)); // the pool sees the new nonce from the next block on
    for (const raw of raws) await rpc("eth_sendRawTransaction", [raw]);
    toast("Test chain was reset. Fixed your wallet's nonce", "", 4000);
  }

  txLink(hash: Hex) {
    return this.D.chainId === 4663 ? `https://robin.etherscan.io/tx/${hash}` : "";
  }

  /** my inventory parts, and the parts I placed in the running machine */
  myParts() {
    return [...this.board.parts.values()].filter((p) => p.id && same(p.owner, this.me));
  }

  /** claim what my placed parts earned, CLAIM_PAGE parts per transaction */
  async claimAll(label: (n: number) => string) {
    let ok = true;
    const ids = [...this.claimIds];
    for (let i = 0; i < ids.length && ok; i += CLAIM_PAGE) {
      ok = await this.send("claim", [ids.slice(i, i + CLAIM_PAGE).map(BigInt)], { label: label(Math.min(ids.length - i, CLAIM_PAGE)), done: "Claimed" });
    }
    await this.refreshStatus();
    return ok;
  }

  devAccounts() {
    return Array.from({ length: 10 }, (_, i) => devAccount(i).address);
  }
}

export const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const checksums = new Map<string, string>();
/** 0x1234…abcd, checksummed (addresses read from packed words come in lowercase) */
/** one placement from MachineViews.board: word 0 = placer | design << 160 | rot << 176 | place << 184,
 *  word 1 = id | x << 64 | y << 96 */
export function boardEntry(w0: bigint, w1: bigint) {
  return {
    placer: "0x" + (w0 & ((1n << 160n) - 1n)).toString(16).padStart(40, "0"),
    design: Number((w0 >> 160n) & 0xffffn),
    rot: Number((w0 >> 176n) & 0xffn),
    place: Number((w0 >> 184n) & 0xffn),
    id: Number(w1 & 0xffffffffffffffffn),
    x: Number(BigInt.asIntN(32, (w1 >> 64n) & 0xffffffffn)),
    y: Number(BigInt.asIntN(32, (w1 >> 96n) & 0xffffffffn)),
  };
}

export const short = (a: string) => {
  if (!a) return "";
  let c = checksums.get(a);
  if (!c) {
    try {
      c = getAddress(a);
    } catch {
      c = a;
    }
    checksums.set(a, c);
  }
  return c.slice(0, 6) + "…" + c.slice(-4);
};

const REASONS: Record<string, string> = {
  Mismatch: "Edges don't match",
  NotPlugged: "Not connected",
  Occupied: "Spot taken",
  OutOfBounds: "Off the board",
  TooExpensive: "Price moved. Try again",
  QuoteExpired: "Quote expired. Try again",
  NotEnoughEth: "ETH price moved. Try again",
  PartialFill: "Not enough pool liquidity. Try fewer parts",
  RefundFailed: "Wallet could not receive the ETH refund",
  NotReady: "Beacon not ready. Try again in a few seconds",
  RoundOver: "This machine is finished. Arrange your parts on the new one",
  NeedGas: "Needs more gas: this placement ends the round",
  NotOwner: "Not your part",
  SeatClaimed: "Core already claimed",
  BadProof: "Seat not in the snapshot",
  NoSuchPart: "No such part",
  NotStarted: "Not open yet",
  BadBatch: "Mint 1 to 200 at a time",
  BadBuildSize: "A draft can contain up to 50 parts",
  NoGrowthExit: "Leave an outside connection open",
  BadRot: "Bad rotation",
  UnknownPart: "That part isn't in an inventory any more",
  RoundRunning: "Round still running",
  TooSoon: "One buy per 5 minutes",
  ERC20InsufficientBalance: "Not enough IMD",
  ERC20InsufficientAllowance: "IMD not approved",
};
export function niceError(e: any): string {
  const causes: any[] = [];
  for (let c = e; c && !causes.includes(c); c = c.cause) causes.push(c);
  const text = causes.map(c => c.shortMessage ?? c.message ?? "").join("\n");
  if (causes.some(c => c.code === 4001) || /user (rejected|denied)|rejected the request|cancel/i.test(text)) return "Cancelled";
  for (const c of causes) {
    const name = c?.data?.errorName;
    if (name && REASONS[name]) return REASONS[name];
  }
  if (isGasLimitError(e)) return "This transaction needs too much gas. Try fewer parts";
  const reason = causes.find(c => typeof c.reason === "string" && c.reason.trim() && c.reason !== "execution reverted")?.reason;
  const lines = String(reason ?? e?.shortMessage ?? e?.message ?? e).split("\n").map(s => s.trim()).filter(Boolean);
  const msg = (/following (?:reason|signature):$/.test(lines[0] ?? "") ? lines[1] : lines[0]) || "Transaction reverted. Try again";
  if (/insufficient funds/i.test(text)) return "Not enough ETH for gas";
  if (/insufficient/i.test(text)) return "Not enough balance";
  return msg.length > 140 ? msg.slice(0, 140) + "…" : msg;
}

/** Only resource failures may shrink a build; wiring and ownership errors must remain visible. */
export function isGasLimitError(e: any): boolean {
  const seen = new Set();
  for (let c = e; c && !seen.has(c); c = c.cause) {
    seen.add(c);
    if (c?.data?.errorName === "NeedGas") return true;
    if (/out[ _]?of[ _]?gas|gas required exceeds|exceeds (?:the )?(?:block |transaction )?gas limit|intrinsic gas too low/i.test([c.shortMessage, c.details, c.message, c.reason].filter(Boolean).join("\n"))) return true;
  }
  return false;
}

export type { Hex };
