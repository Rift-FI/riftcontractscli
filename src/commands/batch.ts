/**
 * riftw batch <file.json> — a whole deploy/wiring flow expressed as data.
 *
 * Every step carries a `check` (or, for deploys, the implicit "is there code at the predicted
 * CREATE2 address?"), so a run is:
 *
 *   resolve variables → read chain state → skip what is already true → send the rest → verify
 *
 * which makes it resumable: reject a prompt, close the app, lose the shell, re-run the same
 * command. Nothing is sent twice, and `--plan` shows the whole thing without pairing at all.
 *
 * Schema: see examples/premia-beta.batch.json and the README.
 */

import fs from "fs";
import path from "path";
import { ZeroAddress, getCreateAddress, isHexString } from "ethers";
import { coerceArgs, coerceInt, decodeOutputs, encodeCall, jsonSafe, parseSignature, plain, sighash } from "../abi";
import type { Args } from "../args";
import { addressUrl, resolveChain } from "../chains";
import { readSession, requireSession, statePath, type StoredSession } from "../config";
import { makeRpc, type Rpc } from "../rpc";
import { planCreate2 } from "../create2";
import { resolveArtifact } from "../artifacts";
import { sendAndConfirm, type RunOpts, type TxPlan } from "../tx";
import { bold, commas, confirm, cyan, dim, emit, exit, fail, green, isJsonMode, log, red, RiftwError, rule, warn, yellow } from "../util";
import { closeClient, initClient, type Client } from "../wc";
import { parseValue } from "./interact";

export interface BatchCheck {
  to?: string;
  fn?: string;
  args?: unknown[];
  equals?: unknown;
  notEquals?: unknown;
  gte?: unknown;
  nonZero?: boolean;
  hasCode?: string;
  /** Satisfied when any / all of these are. `any` is how a step stays idempotent when its
   *  immediate effect is later consumed by another step (minted balance → provided capital). */
  any?: BatchCheck[];
  all?: BatchCheck[];
}

export interface BatchStep {
  id: string;
  label?: string;
  deploy?: string;
  call?: string;
  send?: string;
  raw?: string;
  /**
   * Sends nothing: computes an address and exports it, for a contract a *factory* will create
   * with plain CREATE (nonce-derived, so still known in advance):
   *   { "id": "market", "derive": { "create": { "from": "$MarketFactory", "nonce": 1 } } }
   */
  derive?: { create?: { from: string; nonce?: number } };
  to?: string;
  args?: unknown[];
  value?: string | number;
  salt?: string;
  saltNamespace?: string;
  factory?: string;
  export?: string;
  check?: BatchCheck;
  /** Acknowledge that nothing on chain reads this back (an idempotent setter with no getter). */
  unverifiable?: boolean;
}

export interface BatchFile {
  name?: string;
  chain?: string;
  rpc?: string;
  artifacts?: string;
  saltNamespace?: string;
  factory?: string;
  vars?: Record<string, unknown>;
  steps: BatchStep[];
}

interface BatchState {
  name: string;
  chainId: number;
  done: Record<string, { at: string; hash?: string; address?: string }>;
  updatedAt?: string;
}

export interface Resolved {
  step: BatchStep;
  kind: "deploy" | "call" | "send" | "raw" | "derive";
  /** A derive step only computes an address; there is nothing to sign. */
  noSend?: boolean;
  label: string;
  to: string;
  data: string;
  value: bigint;
  predicted?: string;
  /** null when the step has no on-chain post-condition at all. */
  check: null | (() => Promise<boolean>);
  checkDescription?: string;
  fnSig?: string;
  inputs?: any;
  values?: unknown[];
  create2?: TxPlan["create2"];
}

export async function cmdBatch(args: Args): Promise<void> {
  const [file] = args.positional;
  if (!file) fail("BAD_ARGS", "usage: riftw batch <file.json> [--plan] [--yes] [--only id1,id2]");
  const planOnly = args.bool("plan") || args.bool("dry-run");

  const filePath = path.resolve(file);
  if (!fs.existsSync(filePath)) fail("NO_BATCH_FILE", `no such batch file: ${filePath}`);
  const batch = readBatch(filePath);
  const baseDir = path.dirname(filePath);

  const chain = resolveChain(args.str("chain") || batch.chain);
  const rpc = makeRpc(chain, args.str("rpc") || batch.rpc);
  const session: StoredSession | null = planOnly ? readSession() : requireSession(chain.id);

  const name = args.str("name") || batch.name || path.basename(filePath).replace(/\.(json|batch\.json)$/i, "");
  const sPath = statePath(name, chain.id, args.str("state"));
  const state = loadState(sPath, name, chain.id);

  const only = (args.str("only") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  await rpc.assertChain();

  // ── resolve every step up front: CREATE2 addresses are known before anything is sent ──
  const vars: Record<string, unknown> = {
    ...(batch.vars || {}),
    account: session?.account || args.str("account"),
    chainId: chain.id,
    zero: ZeroAddress,
  };

  const steps: Resolved[] = [];
  for (const raw of batch.steps) {
    steps.push(resolveStep(raw, { batch, baseDir, vars, rpc, args, session }));
  }

  log("");
  log(bold(`  BATCH ${name} — ${chain.name} (${chain.id})`));
  rule();
  log(`  file       ${dim(filePath)}`);
  log(`  rpc        ${dim(rpc.url)}`);
  log(`  state      ${dim(sPath)}`);
  log(`  wallet     ${session ? bold(session.account) : yellow("(not connected)")}`);
  rule();

  // ── status pass (read-only) ──
  const status: Record<string, "done" | "todo" | "skip" | "derive"> = {};
  for (const s of steps) {
    if (s.noSend) {
      status[s.step.id] = "derive";
      continue;
    }
    if (only.length && !only.includes(s.step.id)) {
      status[s.step.id] = "skip";
      continue;
    }
    status[s.step.id] = (await isSatisfied(s, state)) ? "done" : "todo";
  }

  steps.forEach((s, i) => {
    const st = status[s.step.id];
    const mark =
      st === "done" ? green("done") : st === "skip" ? dim("skip") : st === "derive" ? cyan("calc") : yellow("todo");
    log(`  ${String(i + 1).padStart(2)}. [${mark}] ${bold(s.step.id)}  ${s.label}`);
    if (!s.noSend) {
      log(
        dim(
          `         to ${s.to}  calldata ${commas((s.data.length - 2) / 2)} B` +
            (s.predicted ? `  → ${s.predicted}` : "") +
            (s.value ? `  value ${s.value}` : "")
        )
      );
    }
    if (s.checkDescription) log(dim(`         check ${s.checkDescription}`));
    else if (s.step.unverifiable) log(dim(`         check none — idempotent setter, recorded in the state file only`));
    else log(dim(`         check none — add "check" to make this step resumable`));
  });
  rule();

  const todo = steps.filter((s) => status[s.step.id] === "todo");
  const doneCount = steps.filter((s) => status[s.step.id] === "done").length;
  log(`  ${green(doneCount + " already satisfied")} · ${yellow(todo.length + " to send")}${only.length ? dim(`  (--only ${only.join(",")})`) : ""}`);

  emit({
    ok: true,
    action: "batch",
    name,
    chainId: chain.id,
    file: filePath,
    state: sPath,
    steps: steps.map((s) => ({
      id: s.step.id,
      kind: s.kind,
      status: status[s.step.id],
      label: s.label,
      to: s.to,
      predicted: s.predicted,
      calldataBytes: (s.data.length - 2) / 2,
      valueWei: s.value.toString(),
      function: s.fnSig,
      args: s.values ? jsonSafe(s.values) : undefined,
      create2: s.create2,
    })),
    exports: jsonSafe(vars),
  });

  if (planOnly) {
    log(dim("  --plan: nothing sent."));
    return;
  }
  if (!todo.length) {
    log(green("  nothing to do — every step is already satisfied on chain."));
    return;
  }
  if (!session) fail("NOT_CONNECTED", "no session", "run `riftw connect` first");

  if (!args.bool("yes")) {
    if (isJsonMode()) fail("CONFIRM_REQUIRED", "--json cannot prompt", "add --yes");
    const ok = await confirm(`  ${bold(`Run ${todo.length} step(s)?`)} [y/N] `);
    if (!ok) {
      log(dim("  aborted — nothing was sent."));
      await exit(1);
    }
  }

  const run: RunOpts = {
    chain,
    rpc,
    session,
    // Each step gets its own preview; the batch-level confirmation covers the run.
    yes: true,
    dryRun: false,
    wait: !args.bool("no-wait"),
    expiry: args.num("expiry", Number(process.env.RIFTW_EXPIRY || 1800)),
    confirmMs: args.num("confirm-timeout", 300000),
  };

  let client: Client | null = null;
  const results: Record<string, unknown>[] = [];
  try {
    client = await initClient();
    let n = 0;
    for (const s of steps) {
      n++;
      const tag = `[${String(n).padStart(2)}/${steps.length}]`;
      if (s.noSend) continue;
      if (only.length && !only.includes(s.step.id)) continue;

      // Re-check: an earlier step may have satisfied this one.
      if (await isSatisfied(s, state)) {
        log(`  ${tag} ${green("skip")} ${s.step.id} ${dim("(already satisfied)")}`);
        markDone(state, sPath, s.step.id, undefined, s.predicted);
        continue;
      }

      log("");
      log(`  ${tag} ${bold(s.step.id)} — ${s.label}`);
      const r = await sendAndConfirm(client, toTxPlan(s), run, s.check || undefined);
      results.push({ id: s.step.id, hash: r.hash, confirmed: r.confirmed });

      if (!r.confirmed) {
        log(
          red(`  ${tag} not confirmed — stopping here.`) +
            "\n" +
            yellow("  Nothing after this step was sent. Re-run the same command to resume: satisfied steps are skipped.")
        );
        emit({ ok: false, stoppedAt: s.step.id, results });
        await closeClient(client);
        await exit(1);
      }

      // Post-condition: a receipt is not proof that the intended effect happened.
      if (s.check) {
        const ok = await evalCheck(s.check);
        if (!ok) {
          warn(`${s.step.id}: the transaction confirmed but its check still reads false`);
        }
      } else if (!s.step.unverifiable) {
        log(dim("         (no check for this step — confirmed by its receipt only)"));
      }
      markDone(state, sPath, s.step.id, r.hash, s.predicted);
    }
  } finally {
    await closeClient(client);
  }

  log("");
  log(green(`  BATCH COMPLETE — ${name}`));
  rule();
  for (const s of steps) {
    if (s.predicted) {
      const url = addressUrl(chain, s.predicted);
      log(`  ${s.step.id.padEnd(24)} ${bold(s.predicted)}${url ? "  " + dim(url) : ""}`);
    }
  }
  rule();
  log(dim(`  state: ${sPath}`));
  emit({ ok: true, results, addresses: Object.fromEntries(steps.filter((s) => s.predicted).map((s) => [s.step.id, s.predicted])) });
}

// ───────────────────────────── resolution ─────────────────────────────

export function readBatch(p: string): BatchFile {
  let j: any;
  try {
    j = JSON.parse(stripJsonComments(fs.readFileSync(p, "utf8")));
  } catch (e: any) {
    return fail("BAD_BATCH_FILE", `cannot parse ${p}: ${e?.message}`);
  }
  if (!Array.isArray(j?.steps) || !j.steps.length) fail("BAD_BATCH_FILE", `${p} has no "steps" array`);
  const ids = new Set<string>();
  for (const [i, s] of j.steps.entries()) {
    if (!s?.id) fail("BAD_BATCH_FILE", `step ${i + 1} has no "id"`);
    if (ids.has(s.id)) fail("BAD_BATCH_FILE", `duplicate step id "${s.id}"`);
    ids.add(s.id);
  }
  return j as BatchFile;
}

/** Allow // comments in batch files — they are configuration, people annotate them. */
function stripJsonComments(src: string): string {
  return src.replace(/^\s*\/\/.*$/gm, "");
}

export function resolveStep(
  raw: BatchStep,
  c: { batch: BatchFile; baseDir: string; vars: Record<string, unknown>; rpc: Rpc; args: Args; session: StoredSession | null }
): Resolved {
  const kinds = (["deploy", "call", "send", "raw", "derive"] as const).filter((k) => raw[k] !== undefined);
  if (kinds.length !== 1) {
    fail("BAD_BATCH_FILE", `step "${raw.id}" must have exactly one of deploy/call/send/raw/derive (found ${kinds.length})`);
  }
  const kind = kinds[0];
  const V = (v: unknown) => subst(v, c.vars, raw.id);
  const value = raw.value !== undefined ? parseValue(String(V(raw.value))) : 0n;

  if (kind === "derive") {
    const spec = V(raw.derive) as { create?: { from: string; nonce?: number } };
    if (!spec?.create) fail("BAD_BATCH_FILE", `step "${raw.id}": derive currently supports only { "create": { "from": …, "nonce": … } }`);
    const from = requireAddress(spec.create.from, `step "${raw.id}" derive.create.from`);
    const nonce = Number(spec.create.nonce ?? 1);
    if (!Number.isInteger(nonce) || nonce < 0) fail("BAD_BATCH_FILE", `step "${raw.id}": derive.create.nonce must be a non-negative integer`);
    const address = getCreateAddress({ from, nonce });
    c.vars[raw.export || raw.id] = address;
    return {
      step: raw,
      kind,
      noSend: true,
      label: raw.label || `derive CREATE address: ${from} nonce ${nonce} → ${address}`,
      to: address,
      data: "0x",
      value: 0n,
      predicted: address,
      check: makeCheck(raw.check, c, raw.id),
      checkDescription: describeCheck(raw.check) || "nothing to send — this step only computes an address",
    };
  }

  if (kind === "deploy") {
    const artifactDirs = [c.args.str("artifacts"), c.batch.artifacts ? path.resolve(c.baseDir, c.batch.artifacts) : undefined]
      .filter(Boolean)
      .join(";");
    const art = resolveArtifact(String(V(raw.deploy)), { artifactDirs: artifactDirs || undefined });
    const ctorValues = coerceArgs(art.ctorInputs, (raw.args || []).map(V), { account: c.session?.account });
    const plan = planCreate2(art, ctorValues, {
      salt: raw.salt ? String(V(raw.salt)) : c.args.str("salt"),
      namespace:
        raw.saltNamespace !== undefined
          ? String(raw.saltNamespace)
          : c.batch.saltNamespace !== undefined
            ? c.batch.saltNamespace
            : c.args.has("salt-namespace")
              ? c.args.str("salt-namespace")
              : undefined,
      factory: raw.factory || c.batch.factory || c.args.str("factory"),
    });

    // Deterministic, so later steps can take this address as an argument right now.
    c.vars[raw.export || raw.id] = plan.address;

    return {
      step: raw,
      kind,
      label: `deploy ${art.name}`,
      to: plan.tx.to,
      data: plan.tx.data,
      value,
      predicted: plan.address,
      check: async () => c.rpc.hasCode(plan.address),
      checkDescription: `code at ${plan.address}`,
      fnSig: "CREATE2 factory call (salt ++ initCode)",
      inputs: art.ctorInputs,
      values: ctorValues,
      create2: {
        factory: plan.factory,
        salt: plan.salt,
        saltSource: plan.saltSource,
        initCodeHash: plan.initCodeHash,
        initCodeBytes: (plan.initCode.length - 2) / 2,
      },
    };
  }

  if (kind === "send") {
    const to = requireAddress(V(raw.send), `step "${raw.id}" send`);
    return {
      step: raw,
      kind,
      label: raw.label || `send ${value} wei → ${to}`,
      to,
      data: "0x",
      value,
      check: makeCheck(raw.check, c, raw.id),
      checkDescription: describeCheck(raw.check),
    };
  }

  if (kind === "raw") {
    const to = requireAddress(V(raw.to), `step "${raw.id}" to`);
    const data = String(V(raw.raw));
    if (!isHexString(data)) fail("BAD_BATCH_FILE", `step "${raw.id}": raw must be hex calldata`);
    return {
      step: raw,
      kind,
      label: raw.label || `raw calldata → ${to}`,
      to,
      data,
      value,
      check: makeCheck(raw.check, c, raw.id),
      checkDescription: describeCheck(raw.check),
    };
  }

  // call
  const to = requireAddress(V(raw.to), `step "${raw.id}" to`);
  const frag = parseSignature(String(V(raw.call)));
  const values = coerceArgs(frag.inputs, (raw.args || []).map(V), { account: c.session?.account });
  return {
    step: raw,
    kind,
    label: raw.label || `${sighash(frag)} → ${to}`,
    to,
    data: encodeCall(frag, values),
    value,
    check: makeCheck(raw.check, c, raw.id),
    checkDescription: describeCheck(raw.check),
    fnSig: sighash(frag),
    inputs: frag.inputs,
    values,
  };
}

function makeCheck(
  spec: BatchCheck | undefined,
  c: { vars: Record<string, unknown>; rpc: Rpc; session: StoredSession | null },
  stepId: string
): null | (() => Promise<boolean>) {
  if (!spec) return null;
  return async () => {
    const V = (v: unknown) => subst(v, c.vars, stepId);

    if (spec.any) {
      for (const sub of spec.any) {
        const f = makeCheck(sub, c, stepId);
        if (f && (await evalCheck(f))) return true;
      }
      return false;
    }
    if (spec.all) {
      for (const sub of spec.all) {
        const f = makeCheck(sub, c, stepId);
        if (!f || !(await evalCheck(f))) return false;
      }
      return true;
    }

    if (spec.hasCode) return c.rpc.hasCode(requireAddress(V(spec.hasCode), `check for "${stepId}"`));
    if (!spec.fn) fail("BAD_BATCH_FILE", `step "${stepId}": check needs "fn" or "hasCode"`);
    const to = requireAddress(V(spec.to), `check for "${stepId}" (to)`);
    const frag = parseSignature(String(V(spec.fn)));
    const values = coerceArgs(frag.inputs, (spec.args || []).map(V), { account: c.session?.account });
    const raw = await c.rpc.call({ to, data: encodeCall(frag, values), from: c.session?.account });
    const outs = frag.outputs.length ? decodeOutputs(frag, raw) : null;
    const actual = outs ? outs[0] : raw;

    if (spec.equals !== undefined) return same(actual, V(spec.equals));
    if (spec.notEquals !== undefined) return !same(actual, V(spec.notEquals));
    if (spec.gte !== undefined) return toBig(actual) >= toBig(V(spec.gte));
    if (spec.nonZero) return isNonZero(actual);
    // No comparator: truthiness, which covers the common `… returns (bool)` getter.
    return isNonZero(actual);
  };
}

function describeCheck(spec?: BatchCheck): string | undefined {
  if (!spec) return undefined;
  if (spec.any) return spec.any.map((s) => describeCheck(s)).join("  OR  ");
  if (spec.all) return spec.all.map((s) => describeCheck(s)).join("  AND  ");
  if (spec.hasCode) return `code at ${spec.hasCode}`;
  const cmp =
    spec.equals !== undefined
      ? `== ${plain(spec.equals)}`
      : spec.notEquals !== undefined
        ? `!= ${plain(spec.notEquals)}`
        : spec.gte !== undefined
          ? `>= ${plain(spec.gte)}`
          : spec.nonZero
            ? "!= 0"
            : "truthy";
  return `${spec.fn}${spec.args?.length ? `(${spec.args.map(plain).join(",")})` : ""} ${cmp}${spec.to ? ` @${spec.to}` : ""}`;
}

async function isSatisfied(s: Resolved, state: BatchState): Promise<boolean> {
  if (s.check) return evalCheck(s.check);
  return !!state.done[s.step.id];
}

/**
 * A check that cannot be evaluated because the contract is not there yet means "not satisfied".
 * A check that cannot be evaluated because the FILE is wrong (an unknown variable, a bad
 * signature) must not be swallowed: silently reporting such a step as todo forever is how a
 * batch re-sends work it has already done.
 */
const CONFIG_ERRORS = new Set([
  "UNKNOWN_VAR",
  "BAD_BATCH_FILE",
  "BAD_SIGNATURE",
  "BAD_ARGS",
  "ENCODE_FAILED",
  "DECODE_FAILED",
  "BAD_SALT",
  "NO_ARTIFACT",
  "BAD_ARTIFACT",
]);

async function evalCheck(f: () => Promise<boolean>): Promise<boolean> {
  try {
    return await f();
  } catch (e: any) {
    if (e instanceof RiftwError && CONFIG_ERRORS.has(e.code)) throw e;
    return false; // usually a dependency that does not exist yet
  }
}

function toTxPlan(s: Resolved): TxPlan {
  return {
    kind: s.kind === "deploy" ? "deploy" : s.kind === "send" ? "send" : "call",
    label: s.label,
    to: s.to,
    data: s.data,
    value: s.value,
    fnSig: s.fnSig,
    inputs: s.inputs,
    values: s.values,
    create2: s.create2,
    predicted: s.predicted,
    notes: s.step.unverifiable ? ["no on-chain getter reads this back — the receipt is the only confirmation"] : [],
  };
}

// ───────────────────────────── vars ─────────────────────────────

/** `$name` → the value; `${name}` inside a string → interpolated; recurses into arrays/objects. */
function subst(v: unknown, vars: Record<string, unknown>, stepId: string): unknown {
  if (Array.isArray(v)) return v.map((x) => subst(x, vars, stepId));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = subst(x, vars, stepId);
    return o;
  }
  if (typeof v !== "string") return v;

  if (/^\$[A-Za-z_][A-Za-z0-9_.-]*$/.test(v)) {
    const key = v.slice(1);
    if (!(key in vars) || vars[key] === undefined) {
      if (key === "account") {
        fail(
          "UNKNOWN_VAR",
          `step "${stepId}": $account needs a connected session`,
          'run `riftw connect` first, pass --account 0x… (planning only), or put the address in "vars"'
        );
      }
      fail(
        "UNKNOWN_VAR",
        `step "${stepId}": unknown variable ${v}`,
        `known: ${Object.keys(vars).filter((k) => vars[k] !== undefined).join(", ")} — a deploy step's id becomes a variable holding its CREATE2 address`
      );
    }
    return vars[key];
  }
  return v.replace(/\$\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g, (_m, key) => {
    if (!(key in vars) || vars[key] === undefined) fail("UNKNOWN_VAR", `step "${stepId}": unknown variable \${${key}}`);
    return String(vars[key]);
  });
}

function requireAddress(v: unknown, what: string): string {
  const s = String(v ?? "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) fail("BAD_BATCH_FILE", `${what}: "${s}" is not an address`);
  return s;
}

function same(a: unknown, b: unknown): boolean {
  if (typeof a === "bigint" || typeof b === "bigint") {
    try {
      return toBig(a) === toBig(b);
    } catch {
      return false;
    }
  }
  if (typeof a === "boolean" || typeof b === "boolean") return Boolean(a) === parseBool(b);
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  return plain(a) === plain(b);
}

function parseBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

/**
 * Numbers in a check use exactly the same syntax as arguments — 5000000@6, 500000e18, max, 0x…
 * (a comparator that silently failed to parse "5000000@6" would quietly report every step as
 * not-done, which is worse than an error).
 */
function toBig(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "boolean") return v ? 1n : 0n;
  return coerceInt(v, "int256", "check value");
}

function isNonZero(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "bigint") return v !== 0n;
  if (typeof v === "string") {
    if (v === ZeroAddress) return false;
    if (/^0x0*$/.test(v)) return false;
    return v !== "0x" && v !== "";
  }
  return !!v;
}

// ───────────────────────────── state ─────────────────────────────

function loadState(p: string, name: string, chainId: number): BatchState {
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return { name, chainId, done: {}, ...j };
  } catch {
    return { name, chainId, done: {} };
  }
}

function markDone(state: BatchState, p: string, id: string, hash?: string, address?: string): void {
  state.done[id] = { at: new Date().toISOString(), hash, address };
  state.updatedAt = new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(state, null, 2) + "\n");
  } catch (e: any) {
    warn(`could not write the state file ${p}: ${e?.message}`);
  }
}
