/**
 * The write pipeline every signing command shares:
 *
 *   build → dry-run preview → confirm (unless --yes) → eth_sendTransaction over WalletConnect
 *         → wait for the passkey approval → verify on chain → BaseScan link
 */

import type { ParamType, TransactionReceipt } from "ethers";
import { argLines, jsonSafe } from "./abi";
import { addressUrl, txUrl, type ChainInfo } from "./chains";
import type { StoredSession } from "./config";
import type { Rpc } from "./rpc";
import { bold, commas, confirm, cyan, dim, emit, exit, fail, green, isJsonMode, log, red, rule, shortHex, yellow } from "./util";
import { closeClient, requestSendTransaction, requireLiveSession, type Client } from "./wc";

export interface TxPlan {
  kind: "call" | "send" | "deploy";
  /** One-line human label, e.g. `setProtocol(address,bool)` or `deploy PrmUSD`. */
  label: string;
  to: string;
  data: string;
  value?: bigint;
  fnSig?: string;
  inputs?: readonly ParamType[];
  values?: unknown[];
  /** CREATE2 details, for deploys. */
  create2?: { factory: string; salt: string; saltSource: string; initCodeHash: string; initCodeBytes: number };
  predicted?: string;
  notes?: string[];
}

export interface RunOpts {
  chain: ChainInfo;
  rpc: Rpc;
  /** null only while previewing (`--dry-run` works with no session at all). */
  session: StoredSession | null;
  yes: boolean;
  dryRun: boolean;
  wait: boolean;
  expiry: number;
  confirmMs: number;
}

export function printPreview(plan: TxPlan, o: RunOpts): void {
  log("");
  log(bold(`  DRY RUN — ${plan.label}`));
  rule();
  log(`  chain      ${o.chain.name} (${o.chain.id})   ${dim(o.rpc.url)}`);
  log(
    o.session
      ? `  from       ${bold(o.session.account)} ${dim("— Rift smart account, signs with your passkey")}`
      : `  from       ${yellow("(not connected)")} ${dim("— run `riftw connect` before sending")}`
  );
  const toUrl = addressUrl(o.chain, plan.to);
  log(`  to         ${bold(plan.to)}${toUrl ? "  " + dim(toUrl) : ""}`);
  if (plan.fnSig) log(`  function   ${cyan(plan.fnSig)}`);
  if (plan.inputs && plan.values && plan.inputs.length) {
    log(`  args`);
    for (const line of argLines(plan.inputs, plan.values)) log(line);
  } else if (plan.inputs && plan.values) {
    log(`  args       ${dim("(none)")}`);
  }
  if (plan.create2) {
    log(`  create2    factory ${plan.create2.factory}`);
    log(`  salt       ${plan.create2.salt}  ${dim(plan.create2.saltSource)}`);
    log(`  init code  ${commas(plan.create2.initCodeBytes)} bytes   ${dim("hash " + plan.create2.initCodeHash)}`);
  }
  if (plan.predicted) {
    const url = addressUrl(o.chain, plan.predicted);
    log(`  ${bold("predicted")}  ${bold(plan.predicted)}${url ? "  " + dim(url) : ""}`);
  }
  log(`  value      ${formatEth(plan.value || 0n)} ${o.chain.currency}`);
  log(`  calldata   ${shortHex(plan.data, 20)}`);
  log(`  gas        ${dim("sponsored by Rift — paid in USDC, no ETH needed")}`);
  for (const n of plan.notes || []) log(`  ${yellow("note")}       ${n}`);
  rule();
}

export function previewJson(plan: TxPlan, o: RunOpts): Record<string, unknown> {
  return {
    action: plan.kind,
    label: plan.label,
    chain: { id: o.chain.id, key: o.chain.key, name: o.chain.name, rpc: o.rpc.url },
    from: o.session?.account,
    to: plan.to,
    function: plan.fnSig,
    args: plan.values ? jsonSafe(plan.values) : undefined,
    argTypes: plan.inputs ? plan.inputs.map((i) => i.type) : undefined,
    valueWei: (plan.value || 0n).toString(),
    calldata: plan.data,
    calldataBytes: Math.max(0, (plan.data.length - 2) / 2),
    create2: plan.create2 ? { ...plan.create2 } : undefined,
    predicted: plan.predicted,
  };
}

/** Preview → confirm → send → verify. Returns the hash, or exits on abort/rejection. */
export async function sendAndConfirm(
  /** null is only valid together with `--dry-run`, which returns before the wallet is needed. */
  client: Client | null,
  plan: TxPlan,
  o: RunOpts,
  /** Optional on-chain post-condition; lets a send be confirmed even if the hash is a userOp hash. */
  effect?: () => Promise<boolean>
): Promise<{ hash: string; receipt: TransactionReceipt | null; confirmed: boolean }> {
  printPreview(plan, o);
  emit(previewJson(plan, o));

  if (o.dryRun) {
    log(dim("  --dry-run: nothing sent."));
    emit({ ok: true, sent: false, dryRun: true });
    await exit(0);
  }

  if (!o.yes) {
    if (isJsonMode()) {
      fail("CONFIRM_REQUIRED", "--json cannot prompt for confirmation", "add --yes once you have checked the preview");
    }
    const ok = await confirm(`  ${bold("Send it?")} [y/N] `);
    if (!ok) {
      log(dim("  aborted — nothing was sent."));
      emit({ ok: false, sent: false, aborted: true });
      await closeClient(client);
      await exit(1);
    }
  }

  const session = o.session;
  if (!session) fail("NOT_CONNECTED", "no session — run `riftw connect` first");
  if (!client) fail("INTERNAL", "no WalletConnect client for a live send");
  requireLiveSession(client, session.topic);

  log("");
  log(yellow(`  → open Rift and approve with your passkey (the request expires in ${Math.round(o.expiry / 60)} min)`));

  const hash = await requestSendTransaction(client, {
    topic: session.topic,
    chainId: o.chain.id,
    from: session.account,
    to: plan.to,
    data: plan.data,
    value: plan.value ? "0x" + plan.value.toString(16) : "0x0",
    expiry: o.expiry,
  });

  const url = txUrl(o.chain, hash);
  log(`  ${green("signed")}  ${bold(hash)}`);
  if (url) log(`           ${cyan(url)}`);
  emit({ txHash: hash, explorer: url || undefined, sent: true });

  if (!o.wait) {
    emit({ ok: true, confirmed: false, waited: false });
    return { hash, receipt: null, confirmed: false };
  }

  const r = await waitForEffect(o, hash, effect);
  if (r.receipt) {
    if (r.receipt.status === 0) {
      log(red("  REVERTED on chain"));
      emit({ ok: false, confirmed: true, reverted: true, blockNumber: r.receipt.blockNumber });
      fail("TX_REVERTED", `transaction ${hash} reverted on chain`, url ? `inspect it: ${url}` : undefined);
    }
    log(
      `  ${green("confirmed")} block ${r.receipt.blockNumber}  gas ${commas(r.receipt.gasUsed.toString())}` +
        (r.receipt.contractAddress ? `  contract ${r.receipt.contractAddress}` : "")
    );
    emit({
      ok: true,
      confirmed: true,
      receipt: { blockNumber: r.receipt.blockNumber, gasUsed: r.receipt.gasUsed.toString(), status: r.receipt.status },
    });
    return { hash, receipt: r.receipt, confirmed: true };
  }

  if (r.effectOk) {
    log(`  ${green("confirmed")} ${dim("on-chain effect verified (no receipt for that hash — it is the userOp hash)")}`);
    emit({ ok: true, confirmed: true, viaEffect: true });
    return { hash, receipt: null, confirmed: true };
  }

  log(red(`  NOT CONFIRMED within ${Math.round(o.confirmMs / 1000)}s`));
  log(
    yellow(
      "  The wallet accepted it, but neither a receipt for that hash nor the expected on-chain effect appeared.\n" +
        "  Rift returns the userOp hash when the bundler has not surfaced a transaction hash yet, so this is\n" +
        "  often just slow inclusion. Check the hash in the Rift app or on the explorer before re-running."
    )
  );
  emit({ ok: false, confirmed: false, timedOut: true });
  return { hash, receipt: null, confirmed: false };
}

async function waitForEffect(
  o: RunOpts,
  hash: string,
  effect?: () => Promise<boolean>
): Promise<{ receipt: TransactionReceipt | null; effectOk: boolean }> {
  const until = Date.now() + o.confirmMs;
  if (!isJsonMode()) process.stdout.write("  verifying on chain ");
  for (;;) {
    const receipt = await o.rpc.receipt(hash).catch(() => null);
    if (receipt) {
      if (!isJsonMode()) process.stdout.write("\n");
      return { receipt, effectOk: true };
    }
    if (effect) {
      const ok = await effect().catch(() => false);
      if (ok) {
        if (!isJsonMode()) process.stdout.write("\n");
        return { receipt: null, effectOk: true };
      }
    }
    if (Date.now() >= until) {
      if (!isJsonMode()) process.stdout.write("\n");
      return { receipt: null, effectOk: false };
    }
    if (!isJsonMode()) process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 3000));
  }
}

export function formatEth(wei: bigint): string {
  if (wei === 0n) return "0";
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return `${whole}${frac ? "." + frac : ""}`;
}
