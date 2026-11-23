/**
 * Chains the Rift wallet can sign for (mirrors smart-wallet/src/chainConfig.ts).
 * Base is the default; everything else works the same way.
 */

import { fail } from "./util";

export interface ChainInfo {
  id: number;
  key: string;
  name: string;
  rpc: string;
  explorer: string;
  /** Env var consulted for an RPC override, matching the smart-wallet convention. */
  envPrefix: string;
  currency: string;
}

const LIST: ChainInfo[] = [
  { id: 8453, key: "base", name: "Base", rpc: "https://mainnet.base.org", explorer: "https://basescan.org", envPrefix: "BASE", currency: "ETH" },
  { id: 1, key: "ethereum", name: "Ethereum", rpc: "https://eth.llamarpc.com", explorer: "https://etherscan.io", envPrefix: "ETHEREUM", currency: "ETH" },
  { id: 137, key: "polygon", name: "Polygon", rpc: "https://polygon-rpc.com", explorer: "https://polygonscan.com", envPrefix: "POLYGON", currency: "POL" },
  { id: 42220, key: "celo", name: "Celo", rpc: "https://forno.celo.org", explorer: "https://celoscan.io", envPrefix: "CELO", currency: "CELO" },
  { id: 42161, key: "arbitrum", name: "Arbitrum One", rpc: "https://arb1.arbitrum.io/rpc", explorer: "https://arbiscan.io", envPrefix: "ARBITRUM", currency: "ETH" },
  { id: 43114, key: "avalanche", name: "Avalanche C-Chain", rpc: "https://api.avax.network/ext/bc/C/rpc", explorer: "https://snowtrace.io", envPrefix: "AVALANCHE", currency: "AVAX" },
  { id: 56, key: "bsc", name: "BNB Smart Chain", rpc: "https://bsc-dataseed.binance.org", explorer: "https://bscscan.com", envPrefix: "BSC", currency: "BNB" },
  { id: 80094, key: "berachain", name: "Berachain", rpc: "https://rpc.berachain.com", explorer: "https://berascan.com", envPrefix: "BERACHAIN", currency: "BERA" },
];

export const DEFAULT_CHAIN_KEY = "base";

export function chainKeys(): string[] {
  return LIST.map((c) => c.key);
}

/** Resolve `--chain base` / `--chain 8453`. Unknown numeric ids need --rpc. */
export function resolveChain(input?: string): ChainInfo {
  const want = (input || process.env.RIFTW_CHAIN || DEFAULT_CHAIN_KEY).trim().toLowerCase();
  const byKey = LIST.find((c) => c.key === want || c.name.toLowerCase() === want);
  if (byKey) return byKey;
  if (/^\d+$/.test(want)) {
    const id = Number(want);
    const byId = LIST.find((c) => c.id === id);
    if (byId) return byId;
    return { id, key: String(id), name: `chain ${id}`, rpc: "", explorer: "", envPrefix: "", currency: "ETH" };
  }
  return fail(
    "BAD_CHAIN",
    `unknown chain "${input}"`,
    `known chains: ${chainKeys().join(", ")} — or pass a numeric chain id together with --rpc`
  );
}

export function chainById(id: number): ChainInfo {
  const hit = LIST.find((c) => c.id === id);
  return hit || { id, key: String(id), name: `chain ${id}`, rpc: "", explorer: "", envPrefix: "", currency: "ETH" };
}

/** RPC precedence: --rpc > RIFTW_RPC_URL > <PREFIX>_RPC_URL > public default. */
export function rpcFor(chain: ChainInfo, override?: string): string {
  if (override) return override;
  if (process.env.RIFTW_RPC_URL) return process.env.RIFTW_RPC_URL;
  if (chain.envPrefix && process.env[`${chain.envPrefix}_RPC_URL`]) {
    return process.env[`${chain.envPrefix}_RPC_URL`] as string;
  }
  if (chain.rpc) return chain.rpc;
  return fail("NO_RPC", `no RPC URL known for chain ${chain.id}`, "pass --rpc=<url>");
}

export function txUrl(chain: ChainInfo, hash: string): string | null {
  return chain.explorer ? `${chain.explorer}/tx/${hash}` : null;
}
export function addressUrl(chain: ChainInfo, address: string): string | null {
  return chain.explorer ? `${chain.explorer}/address/${address}` : null;
}
