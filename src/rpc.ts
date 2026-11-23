/**
 * Read-side access to the chain. The CLI never signs or broadcasts anything itself:
 * the RPC is used for eth_call, code checks and receipt polling only.
 */

import { AbiCoder, JsonRpcProvider, type TransactionReceipt } from "ethers";
import type { ChainInfo } from "./chains";
import { rpcFor } from "./chains";
import { fail, sleep, tick } from "./util";

export interface Rpc {
  url: string;
  chain: ChainInfo;
  provider: JsonRpcProvider;
  call(req: { to: string; data: string; from?: string; value?: bigint; blockTag?: string }): Promise<string>;
  code(address: string): Promise<string>;
  hasCode(address: string): Promise<boolean>;
  receipt(hash: string): Promise<TransactionReceipt | null>;
  assertChain(): Promise<number>;
}

export function makeRpc(chain: ChainInfo, override?: string): Rpc {
  const url = rpcFor(chain, override);
  const provider = new JsonRpcProvider(url, chain.id, { staticNetwork: true, batchMaxCount: 1 });

  return {
    url,
    chain,
    provider,
    async call(req) {
      try {
        return await provider.call({
          to: req.to,
          data: req.data,
          from: req.from,
          value: req.value,
          blockTag: req.blockTag as any,
        });
      } catch (e: any) {
        const revert = decodeRevert(e);
        if (revert) fail("CALL_REVERTED", `eth_call reverted: ${revert}`);
        if (e?.code === "BAD_DATA" || e?.code === "NETWORK_ERROR" || e?.code === "SERVER_ERROR") {
          fail("RPC_ERROR", `RPC error from ${url}: ${e?.shortMessage || e?.message}`, "pass --rpc=<your endpoint> — public RPCs rate-limit");
        }
        return fail("CALL_FAILED", `eth_call failed: ${e?.shortMessage || e?.message || e}`);
      }
    },
    async code(address) {
      return await provider.getCode(address);
    },
    async hasCode(address) {
      const c = await provider.getCode(address).catch(() => "0x");
      return c !== "0x" && c !== "0x0" && c.length > 2;
    },
    async receipt(hash) {
      try {
        return await provider.getTransactionReceipt(hash);
      } catch {
        return null;
      }
    },
    async assertChain() {
      let net;
      try {
        net = await provider.getNetwork();
      } catch (e: any) {
        return fail("RPC_UNREACHABLE", `cannot reach ${url}: ${e?.shortMessage || e?.message}`, "check the URL or pass --rpc=<url>");
      }
      const id = Number(net.chainId);
      if (id !== chain.id) {
        fail("WRONG_RPC_CHAIN", `${url} serves chain ${id}, expected ${chain.id} (${chain.name})`);
      }
      return id;
    },
  };
}

/** Decode Error(string) / Panic(uint256) out of an ethers CALL_EXCEPTION. */
export function decodeRevert(e: any): string | null {
  const data: string | undefined = e?.data ?? e?.error?.data ?? e?.info?.error?.data;
  if (e?.reason) return String(e.reason);
  if (typeof data !== "string" || !data.startsWith("0x") || data.length < 10) return null;
  const selector = data.slice(0, 10);
  const coder = AbiCoder.defaultAbiCoder();
  try {
    if (selector === "0x08c379a0") return `Error(${JSON.stringify(coder.decode(["string"], "0x" + data.slice(10))[0])})`;
    if (selector === "0x4e487b71") return `Panic(0x${coder.decode(["uint256"], "0x" + data.slice(10))[0].toString(16)})`;
  } catch {
    /* fall through */
  }
  return `custom error ${selector} (data ${data.length > 74 ? data.slice(0, 74) + "…" : data})`;
}

/** Poll until `fn()` is truthy. Returns false on timeout. Prints dots as it waits. */
export async function waitFor(fn: () => Promise<boolean>, timeoutMs: number, intervalMs = 3000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await fn()) return true;
    } catch {
      /* transient RPC hiccup — keep polling */
    }
    if (Date.now() >= until) return false;
    tick();
    await sleep(intervalMs);
  }
}
