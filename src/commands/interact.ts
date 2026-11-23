/** riftw read / call / send — the everyday commands. */

import { getAddress, isHexString, parseEther } from "ethers";
import { coerceArgs, coerceInt, decodeOutputs, encodeCall, formatValue, guessDecode, jsonSafe, parseSignature, plain, sighash } from "../abi";
import type { Args } from "../args";
import { addressUrl } from "../chains";
import { makeCtx } from "../context";
import { bold, cyan, dim, emit, fail, green, log, rule, warn } from "../util";
import { closeClient, initClient, type Client } from "../wc";
import { formatEth, sendAndConfirm, type TxPlan } from "../tx";

/** riftw read <address> "<fn[ view returns (…)]>" [args…] — plain eth_call, no session. */
export async function cmdRead(args: Args): Promise<void> {
  const [target, sig, ...rest] = args.positional;
  if (!target || !sig) {
    fail("BAD_ARGS", 'usage: riftw read <address> "<fnSignature>" [args…]', 'example: riftw read 0x833589… "balanceOf(address) view returns (uint256)" self');
  }
  const ctx = makeCtx(args, { needSession: false });
  const to = address(target, "address");
  const frag = parseSignature(sig);
  const values = coerceArgs(frag.inputs, rest, { account: ctx.session?.account });
  const data = encodeCall(frag, values);

  const from = args.str("from") ? address(args.str("from")!, "--from") : ctx.session?.account;
  const blockTag = args.str("block") || "latest";

  await ctx.rpc.assertChain();
  const raw = await ctx.rpc.call({ to, data, from, blockTag });

  const outs = frag.outputs.length ? decodeOutputs(frag, raw) : null;

  log("");
  log(`  ${bold(sighash(frag))} ${dim("@")} ${to}`);
  rule();
  log(`  chain      ${ctx.chain.name} (${ctx.chain.id})  ${dim(ctx.rpc.url)}`);
  if (frag.inputs.length) log(`  args       ${frag.inputs.map((p, i) => `${p.type} ${plain(values[i])}`).join(", ")}`);
  if (outs) {
    log(`  ${bold("result")}`);
    frag.outputs.forEach((o, i) => {
      const name = o.name || `out${i + 1}`;
      log(`    ${name.padEnd(16)} ${dim(o.type.padEnd(12))} ${formatValue(outs[i], o.type)}`);
    });
  } else {
    log(`  raw        ${raw}`);
    const guesses = guessDecode(raw);
    if (guesses.length) {
      log(dim("  no `returns (…)` clause in the signature, so this is a guess:"));
      for (const g of guesses) log(dim(`    ${g}`));
      log(dim('  add the return types for a typed decode: "…(address) view returns (uint256)"'));
    }
  }
  rule();

  emit({
    ok: true,
    action: "read",
    chain: { id: ctx.chain.id, key: ctx.chain.key, rpc: ctx.rpc.url },
    to,
    function: sighash(frag),
    args: jsonSafe(values),
    raw,
    result: outs ? jsonSafe(outs) : undefined,
    outputs: frag.outputs.length
      ? frag.outputs.map((o, i) => ({ name: o.name || null, type: o.type, value: jsonSafe(outs?.[i]) }))
      : undefined,
  });
}

/** riftw call <address> "<fn>" [args…] — encode, preview, send, verify. */
export async function cmdCall(args: Args): Promise<void> {
  const [target, sig, ...rest] = args.positional;
  if (!target) fail("BAD_ARGS", 'usage: riftw call <address> "<fnSignature>" [args…]');
  // --dry-run is a pure preview: it works with no session, which is also how you check an
  // encoding before pairing.
  const ctx = makeCtx(args, { needSession: !args.bool("dry-run") });
  const session = ctx.session;
  const to = address(target, "address");

  let data: string;
  let plan: TxPlan;
  const rawData = args.str("data");

  if (rawData) {
    if (!isHexString(rawData)) fail("BAD_ARGS", `--data must be hex, got "${rawData}"`);
    data = rawData;
    plan = { kind: "call", label: `raw call → ${to}`, to, data, fnSig: dim("(raw --data)") };
  } else {
    if (!sig) fail("BAD_ARGS", 'a function signature is required (or pass --data 0x…)', 'example: riftw call 0xToken "transfer(address,uint256)" 0xdead… 100@6');
    const frag = parseSignature(sig);
    const values = coerceArgs(frag.inputs, rest, { account: session?.account });
    data = encodeCall(frag, values);
    plan = {
      kind: "call",
      label: `${sighash(frag)} → ${to}`,
      to,
      data,
      fnSig: sighash(frag),
      inputs: frag.inputs,
      values,
    };
  }

  const value = args.str("value") ? parseValue(args.str("value")!) : 0n;
  plan.value = value;

  await ctx.rpc.assertChain();

  // A plain eth_call first: it catches reverts before anyone touches their passkey.
  // Without a session (a --dry-run preview) `--from` stands in for the sender.
  const simFrom = session?.account || (args.str("from") ? address(args.str("from")!, "--from") : undefined);
  if (!args.bool("no-simulate")) {
    try {
      await ctx.rpc.call({ to, data, from: simFrom, value });
      log(dim(`  simulated with eth_call${simFrom ? ` from ${simFrom}` : ""}: no revert`));
    } catch (e: any) {
      const note = e?.message || String(e);
      if (args.bool("force")) warn(`simulation failed (${note}) — continuing because --force was passed`);
      else
        fail(
          "SIMULATION_REVERTED",
          `the call reverts when simulated${simFrom ? ` from ${simFrom}` : " with no sender"}: ${note}`,
          simFrom
            ? "fix the arguments, or pass --force to send it anyway (--no-simulate skips the check)"
            : "no session and no --from, so msg.sender was the zero address — pass --from <your wallet> for a realistic simulation"
        );
    }
  }

  let client: Client | null = null;
  try {
    if (!ctx.run.dryRun) client = await initClient();
    await sendAndConfirm(client, plan, ctx.run);
  } finally {
    await closeClient(client);
  }
}

/** riftw send <to> <amount> — a plain value transfer. */
export async function cmdSend(args: Args): Promise<void> {
  const [target, amount] = args.positional;
  if (!target || !amount) fail("BAD_ARGS", "usage: riftw send <to> <amount>", "example: riftw send 0xdead… 0.01   (0.01 ETH)");
  const ctx = makeCtx(args, { needSession: !args.bool("dry-run") });
  const session = ctx.session;
  const to = address(target, "address");
  const value = parseValue(amount);
  if (value === 0n) warn("sending a zero-value transfer");

  await ctx.rpc.assertChain();
  const balance = session ? await ctx.rpc.provider.getBalance(session.account).catch(() => null) : null;
  const notes: string[] = [];
  if (balance !== null) {
    notes.push(
      `wallet balance ${formatEth(balance)} ${ctx.chain.currency}${balance < value ? "  ← LESS THAN THE AMOUNT" : ""}`
    );
  }
  const code = await ctx.rpc.hasCode(to).catch(() => false);
  if (code) notes.push("the recipient is a contract — a bare transfer will run its receive()/fallback()");

  const plan: TxPlan = {
    kind: "send",
    label: `send ${ctx.chain.currency} → ${to}`,
    to,
    data: "0x",
    value,
    notes,
  };

  let client: Client | null = null;
  try {
    if (!ctx.run.dryRun) client = await initClient();
    const r = await sendAndConfirm(client, plan, ctx.run);
    if (r.confirmed) {
      const url = addressUrl(ctx.chain, to);
      log(`  ${green("sent")} ${formatEth(value)} ${ctx.chain.currency} → ${to}${url ? "  " + cyan(url) : ""}`);
    }
  } finally {
    await closeClient(client);
  }
}

function address(v: string, label: string): string {
  try {
    return getAddress(v.trim());
  } catch {
    return fail("BAD_ARGS", `${label}: "${v}" is not an address`);
  }
}

/**
 * Amounts (`riftw send <to> <amount>` and `--value`) are denominated in the chain's native
 * currency: "0.01" is 0.01 ETH, "1" is 1 ETH. Anything with an explicit unit or an exponent
 * is taken literally: "25gwei", "1e18" (= 1 ETH in wei), "1000wei", "0x16345785d8a0000".
 */
export function parseValue(v: string): bigint {
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return parseEther(s);
  return coerceInt(s, "uint256", "value");
}
