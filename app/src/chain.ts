import {
  createPublicClient, createWalletClient, custom, http, parseAbi, type Address, type PublicClient, type WalletClient,
  type Chain, defineChain, type Hex, isAddress,
} from "viem";
import { privateKeyToAccount, mnemonicToAccount } from "viem/accounts";
import MachineAbi from "./abi/IdentityMachine.json";
import BeaconAbi from "./abi/DrandBeacon.json";
import EthMinterAbi from "./abi/EthMinter.json";
import PartsAbi from "./abi/Parts.json";
import ViewsAbi from "./abi/MachineViews.json";

export const machineAbi = MachineAbi as any;
export const partsAbi = PartsAbi as any;
export const viewsAbi = ViewsAbi as any;
export const beaconAbi = BeaconAbi as any;
export const ethMinterAbi = EthMinterAbi as any;
export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function mint(address,uint256)",
]);

export interface Deploy {
  chainId: number;
  startBlock: number;
  imd: Address;
  beacon: Address;
  machine: Address;
  parts: Address; // non-transferable game inventory
  views: Address; // MachineViews
  ethMinter?: Address;
  start?: number; // unix time minting opens
  rpc?: string;
}

export const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "RobinScan", url: "https://robin.etherscan.io" } },
});
export const anvil = defineChain({
  id: 31337,
  name: "Identity Machine local test chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

export async function loadDeploy(): Promise<Deploy> {
  const which = deploymentNetwork();
  const res = await fetch(`./deploy.${which}.json`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Deployment for ${which === "robinhood" ? "Robinhood Chain" : which} is unavailable`);
  return validateDeploy(await res.json(), which);
}

export function deploymentNetwork(search = location.search, production = import.meta.env?.PROD === true): "local" | "fork" | "robinhood" {
  const net = new URLSearchParams(search).get("net") ?? (production ? "robinhood" : "local");
  if (net !== "robinhood" && (production || (net !== "local" && net !== "fork"))) throw new Error("Unsupported network");
  return net;
}

export function validateDeploy(value: unknown, net: "local" | "fork" | "robinhood"): Deploy {
  const d = value as Deploy;
  if (!d || typeof d !== "object" || d.chainId !== (net === "robinhood" ? 4663 : 31337)
    || !Number.isSafeInteger(d.startBlock) || d.startBlock < 0) throw new Error("Invalid deployment configuration");
  const zero = "0x0000000000000000000000000000000000000000";
  for (const key of ["imd", "beacon", "machine", "parts", "views"] as const) {
    if (!d[key] || !isAddress(d[key]!, { strict: false }) || d[key]!.toLowerCase() === zero) throw new Error(`Invalid deployment address: ${key}`);
  }
  if (d.ethMinter !== undefined && !isAddress(d.ethMinter, { strict: false })) throw new Error("Invalid deployment address: ethMinter");
  if (d.start !== undefined && (!Number.isSafeInteger(d.start) || d.start < 0)) throw new Error("Invalid deployment start");
  if (d.rpc !== undefined) {
    const url = new URL(d.rpc);
    if ((net === "robinhood" ? url.protocol !== "https:" : !["http:", "https:"].includes(url.protocol)) || url.username || url.password) throw new Error("Invalid deployment RPC");
  }
  return { ...d, ethMinter: d.ethMinter?.toLowerCase() === zero ? undefined : d.ethMinter };
}

export function chainFor(d: Deploy): Chain {
  const chain = d.chainId === 4663 ? robinhood : d.chainId === 31337 ? anvil : undefined;
  if (!chain) throw new Error("Unsupported chain");
  return d.rpc ? { ...chain, rpcUrls: { ...chain.rpcUrls, default: { http: [d.rpc] } } } : chain;
}

export function publicClient(d: Deploy): PublicClient {
  const chain = chainFor(d);
  return createPublicClient({ chain, transport: http(d.rpc ?? chain.rpcUrls.default.http[0]), pollingInterval: 1000 }) as PublicClient;
}

/** Local dev: the 10 anvil accounts. */
export function devAccount(i: number) {
  return mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: i });
}

export async function walletFor(d: Deploy, devIndex: number | null): Promise<WalletClient> {
  const chain = chainFor(d);
  if (devIndex !== null) {
    if (d.chainId !== 31337 || import.meta.env?.PROD || !Number.isInteger(devIndex) || devIndex < 0 || devIndex > 9) throw new Error("Test wallets are only available on the development chain");
    return createWalletClient({ chain, account: devAccount(devIndex), transport: http(chain.rpcUrls.default.http[0]) });
  }
  const eth = (window as any).ethereum;
  if (!eth) throw new Error("No wallet found");
  const [addr] = await eth.request({ method: "eth_requestAccounts" });
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + chain.id.toString(16) }] });
  } catch {
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: "0x" + chain.id.toString(16), chainName: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: chain.rpcUrls.default.http }],
    });
  }
  return createWalletClient({ chain, account: addr as Address, transport: custom(eth) });
}

// ---------------------------------------------------------------- drand

const DRAND = "https://api.drand.sh/v2/beacons/evmnet/rounds/";
/** when drand (evmnet) publishes round `r`, in unix seconds */
export const drandTime = (r: number) => 1727521075 + (r - 1) * 3;
const sigCache = new Map<number, Hex>();
export async function drandSig(round: number): Promise<Hex | null> {
  if (sigCache.has(round)) return sigCache.get(round)!;
  try {
    const r = await fetch(DRAND + round);
    if (!r.ok) return null;
    const j = await r.json();
    const sig = ("0x" + j.signature) as Hex;
    sigCache.set(round, sig);
    return sig;
  } catch {
    return null;
  }
}

export { privateKeyToAccount };
