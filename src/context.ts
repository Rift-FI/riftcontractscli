/** Flags → chain, RPC, session, run options. Shared by every command. */

import type { Args } from "./args";
import { resolveChain, type ChainInfo } from "./chains";
import { readSession, requireSession, type StoredSession } from "./config";
import { makeRpc, type Rpc } from "./rpc";
import { fail } from "./util";
import type { RunOpts } from "./tx";

export interface Ctx {
  chain: ChainInfo;
  rpc: Rpc;
  session: StoredSession | null;
  run: RunOpts;
}

/**
 * `needSession: true` for anything that signs. The chain then comes from the session unless the
 * user named one explicitly — a session is bound to exactly one chain in Rift, and silently
 * signing on the wrong one is the mistake worth preventing.
 */
export function makeCtx(args: Args, opts: { needSession: boolean }): Ctx {
  const chainFlagGiven = args.has("chain");
  let session: StoredSession | null = null;

  if (opts.needSession) {
    session = requireSession();
    if (!chainFlagGiven) {
      // Follow the session.
      const chain = resolveChain(String(session.chainId));
      return finish(args, chain, session);
    }
    const chain = resolveChain(args.str("chain"));
    if (chain.id !== session.chainId) {
      fail(
        "WRONG_CHAIN",
        `--chain ${chain.key} (${chain.id}) does not match the session's chain ${session.chainId}`,
        "Rift binds one session to one chain: `riftw disconnect` then `riftw connect --chain " + chain.key + "`"
      );
    }
    return finish(args, chain, session);
  }

  session = readSession();
  const chain = resolveChain(args.str("chain") || (session && !chainFlagGiven ? String(session.chainId) : undefined));
  return finish(args, chain, session);
}

function finish(args: Args, chain: ChainInfo, session: StoredSession | null): Ctx {
  const rpc = makeRpc(chain, args.str("rpc"));
  const expiry = args.num("expiry", Number(process.env.RIFTW_EXPIRY || 1800));
  if (expiry < 300 || expiry > 604800) {
    fail("BAD_EXPIRY", `--expiry must be between 300 and 604800 seconds (got ${expiry})`);
  }
  const run: RunOpts = {
    chain,
    rpc,
    session,
    yes: args.bool("yes"),
    dryRun: args.bool("dry-run"),
    wait: !args.bool("no-wait"),
    expiry,
    confirmMs: args.num("confirm-timeout", 300000),
  };
  return { chain, rpc, session, run };
}
