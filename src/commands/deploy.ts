/**
 * riftw deploy <artifactPathOrName> [ctorArgs…]
 *
 * One transaction to the canonical CREATE2 factory. The address is known before anything is
 * signed, and a deploy that already landed is a no-op — which is what makes a multi-contract
 * rollout resumable.
 */

import fs from "fs";
import path from "path";
import { coerceArgs, jsonSafe } from "../abi";
import type { Args } from "../args";
import { addressUrl } from "../chains";
import { makeCtx } from "../context";
import { planCreate2 } from "../create2";
import { resolveArtifact } from "../artifacts";
import { sendAndConfirm, type TxPlan } from "../tx";
import { bold, commas, cyan, dim, emit, fail, green, log, rule, warn, yellow } from "../util";
import { closeClient, initClient, type Client } from "../wc";

export async function cmdDeploy(args: Args): Promise<void> {
  const [ref, ...ctorArgsRaw] = args.positional;
  if (!ref) {
    fail(
      "BAD_ARGS",
      "usage: riftw deploy <artifactPathOrName> [ctorArgs…]",
      'example: riftw deploy PrmUSD 0x8fC19fBc01DD9b9aEEa626c2AE980F710A390da7 --salt-namespace "premia-beta-v1:"'
    );
  }

  const ctx = makeCtx(args, { needSession: !args.bool("dry-run") });
  const session = ctx.session;

  const art = resolveArtifact(ref, {
    artifactDirs: args.str("artifacts"),
    ctorTypes: args.has("ctor-types") ? args.str("ctor-types") : undefined,
  });
  const ctorValues = coerceArgs(art.ctorInputs, ctorArgsRaw, { account: session?.account });

  const plan = planCreate2(art, ctorValues, {
    salt: args.str("salt"),
    namespace: args.has("salt-namespace") ? args.str("salt-namespace") : undefined,
    factory: args.str("factory"),
  });

  await ctx.rpc.assertChain();

  log("");
  log(bold(`  CREATE2 deploy — ${art.name}`));
  rule();
  log(`  artifact   ${dim(art.source)}`);
  log(`  bytecode   ${commas((art.bytecode.length - 2) / 2)} bytes`);
  if (art.ctorInputs.length) log(`  ctor       ${dim(`(${art.ctorInputs.map((i) => i.type).join(", ")})`)}`);

  // Already there? CREATE2 makes this a pure no-op, which is the whole point.
  const factoryCode = await ctx.rpc.hasCode(plan.factory);
  if (!factoryCode) {
    fail(
      "NO_FACTORY",
      `the CREATE2 factory ${plan.factory} has no code on ${ctx.chain.name}`,
      "deploy the deterministic-deployment proxy on this chain first, or pass --factory <addr>"
    );
  }
  if (await ctx.rpc.hasCode(plan.address)) {
    const url = addressUrl(ctx.chain, plan.address);
    log(`  ${green("already deployed")} at ${bold(plan.address)}${url ? "  " + cyan(url) : ""}`);
    log(dim("  same salt + same init code ⇒ same address. Nothing to send."));
    rule();
    emit({
      ok: true,
      action: "deploy",
      alreadyDeployed: true,
      name: art.name,
      address: plan.address,
      salt: plan.salt,
      initCodeHash: plan.initCodeHash,
      chainId: ctx.chain.id,
    });
    if (args.str("save")) saveDeployFile(args.str("save")!, plan, ctx.chain.id, null);
    return;
  }

  const notes: string[] = [];
  // Best-effort gas estimate: a 4337 userOp carrying a very large deploy can be rejected by the
  // bundler, and knowing that before the passkey prompt is worth one extra RPC call.
  try {
    const gas = await ctx.rpc.provider.estimateGas({
      from: session?.account,
      to: plan.tx.to,
      data: plan.tx.data,
    });
    notes.push(`gas estimate ${commas(gas.toString())}${gas > 4_000_000n ? "  ← large; the bundler may reject it" : ""}`);
  } catch (e: any) {
    notes.push(dim(`gas estimate unavailable (${e?.shortMessage || e?.message || "RPC refused"})`));
  }

  const txPlan: TxPlan = {
    kind: "deploy",
    label: `deploy ${art.name} → ${plan.address}`,
    to: plan.tx.to,
    data: plan.tx.data,
    fnSig: `CREATE2 factory call (salt ++ initCode)`,
    inputs: art.ctorInputs,
    values: ctorValues,
    create2: {
      factory: plan.factory,
      salt: plan.salt,
      saltSource: plan.saltSource,
      initCodeHash: plan.initCodeHash,
      initCodeBytes: (plan.initCode.length - 2) / 2,
    },
    predicted: plan.address,
    notes,
  };

  emit({ name: art.name, artifact: art.source, ctorArgs: jsonSafe(ctorValues), salt: plan.salt, initCodeHash: plan.initCodeHash });

  let client: Client | null = null;
  try {
    if (!ctx.run.dryRun) client = await initClient();
    const r = await sendAndConfirm(client, txPlan, ctx.run, () => ctx.rpc.hasCode(plan.address));

    if (r.confirmed) {
      const landed = await ctx.rpc.hasCode(plan.address);
      if (!landed) {
        warn("the transaction confirmed but the predicted address still has no code — check the explorer");
        emit({ ok: false, deployed: false });
        return;
      }
      const url = addressUrl(ctx.chain, plan.address);
      log("");
      log(`  ${green("deployed")} ${bold(art.name)} at ${bold(plan.address)}`);
      if (url) log(`           ${cyan(url)}`);
      emit({ ok: true, deployed: true, address: plan.address });
      if (args.str("save")) saveDeployFile(args.str("save")!, plan, ctx.chain.id, r.hash);
    } else {
      log(yellow(`  not yet confirmed — re-run the same command: it skips the deploy once code appears at ${plan.address}`));
    }
  } finally {
    await closeClient(client);
  }
}

/** Mirrors smart-wallet/contracts/vault-deploy.json so a deploy stays reproducible. */
function saveDeployFile(file: string, plan: ReturnType<typeof planCreate2>, chainId: number, txHash: string | null): void {
  const out = {
    name: plan.name,
    chainId,
    to: plan.factory,
    salt: plan.salt,
    saltSource: plan.saltSource,
    initCodeHash: plan.initCodeHash,
    address: plan.address,
    vault: plan.address, // the key vault-deploy.json uses, for drop-in compatibility
    txHash: txHash || undefined,
    data: plan.tx.data,
    savedAt: new Date().toISOString(),
  };
  const p = path.resolve(file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(out, null, 2) + "\n");
  log(dim(`  deploy record written to ${p}`));
}
