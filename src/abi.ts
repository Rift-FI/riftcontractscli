/**
 * Human-friendly function signatures and arguments.
 *
 * Signature forms all accepted:
 *   "transfer(address,uint256)"
 *   "function transfer(address to, uint256 amount)"
 *   "balanceOf(address) view returns (uint256)"          ← `returns` lets `read` decode typed output
 *   "setProtocol(address,bool)"
 *
 * Argument forms (coerced against the signature's types):
 *   address   0xabc…           · self / me (the connected account) · zero
 *   uint/int  1000000 · 1_000_000 · 0x0f · 1e18 · 1.5e6 · 1ether · 25gwei · 100@6 (USDC) · max
 *   bool      true/false · 1/0 · yes/no
 *   bytes     0x… · str:hello · keccak:PREMIA.NG.USDT.PREMIUM.V1 (= ethers id(), for bytes32)
 *   array     [1,2,3] · 0xa,0xb · ["0xa","0xb"] (JSON also accepted)
 *   tuple     [1,"0xabc",true] · {"a":1,"b":"0xabc"} (by component name)
 */

import { AbiCoder, FunctionFragment, ParamType, concat, getAddress, id, isHexString, keccak256, parseUnits, toUtf8Bytes, ZeroAddress } from "ethers";
import { commas, dim, fail, shortHex } from "./util";

const coder = AbiCoder.defaultAbiCoder();

const MAX_UINT: Record<string, bigint> = {};
function maxFor(type: string): bigint {
  if (MAX_UINT[type]) return MAX_UINT[type];
  const m = type.match(/^(u?int)(\d*)$/);
  const bits = m && m[2] ? Number(m[2]) : 256;
  const signed = !!m && m[1] === "int";
  const v = signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n;
  MAX_UINT[type] = v;
  return v;
}

export interface CoerceCtx {
  /** The connected smart-account address, so `self` / `me` resolve. */
  account?: string;
}

export function parseSignature(sig: string): FunctionFragment {
  const text = sig.trim();
  if (!text) fail("BAD_SIGNATURE", "empty function signature");
  if (!text.includes("(")) {
    fail(
      "BAD_SIGNATURE",
      `"${sig}" is not a function signature`,
      'write the full signature with parameter types, e.g. "transfer(address,uint256)"'
    );
  }
  try {
    return FunctionFragment.from(text.startsWith("function ") ? text : `function ${text}`);
  } catch (e: any) {
    return fail("BAD_SIGNATURE", `cannot parse "${sig}": ${e?.shortMessage || e?.message || e}`);
  }
}

/** Human-readable `name(type,type)` used for display and salting. */
export function sighash(frag: FunctionFragment): string {
  return frag.format("sighash");
}

export function coerceArgs(inputs: readonly ParamType[], raw: unknown[], ctx: CoerceCtx = {}): unknown[] {
  if (raw.length !== inputs.length) {
    fail(
      "BAD_ARGS",
      `expected ${inputs.length} argument(s) (${inputs.map((i) => i.type).join(", ") || "none"}), got ${raw.length}`,
      inputs.length > raw.length ? "quote whole arrays/tuples so the shell keeps them as one argument" : undefined
    );
  }
  return inputs.map((pt, i) => coerceValue(pt, raw[i], ctx, pt.name || `arg${i + 1}`));
}

export function coerceValue(pt: ParamType, raw: unknown, ctx: CoerceCtx, label: string): unknown {
  if (pt.isArray()) {
    const items = parseList(raw, label);
    const child = pt.arrayChildren as ParamType;
    if (pt.arrayLength !== null && pt.arrayLength >= 0 && items.length !== pt.arrayLength) {
      fail("BAD_ARGS", `${label}: ${pt.type} needs exactly ${pt.arrayLength} items, got ${items.length}`);
    }
    return items.map((v, i) => coerceValue(child, v, ctx, `${label}[${i}]`));
  }

  if (pt.isTuple()) {
    const comps = pt.components as readonly ParamType[];
    const obj = parseStruct(raw, label);
    if (Array.isArray(obj)) {
      if (obj.length !== comps.length) {
        fail("BAD_ARGS", `${label}: tuple needs ${comps.length} fields (${comps.map((c) => c.type).join(",")}), got ${obj.length}`);
      }
      return obj.map((v, i) => coerceValue(comps[i], v, ctx, `${label}.${comps[i].name || i}`));
    }
    return comps.map((c, i) => {
      const key = c.name || String(i);
      if (!(key in (obj as Record<string, unknown>))) {
        fail("BAD_ARGS", `${label}: tuple field "${key}" missing`, `fields: ${comps.map((x) => x.name || "?").join(", ")}`);
      }
      return coerceValue(c, (obj as Record<string, unknown>)[key], ctx, `${label}.${key}`);
    });
  }

  const base = pt.baseType;
  const s = typeof raw === "string" ? raw.trim() : raw;

  if (base === "address") return coerceAddress(s, ctx, label);
  if (base === "bool") return coerceBool(s, label);
  if (base === "string") return raw === undefined || raw === null ? "" : String(raw);
  if (base === "bytes" || /^bytes\d+$/.test(base)) return coerceBytes(s, base, label);
  if (/^u?int\d*$/.test(base)) return coerceInt(s, base, label);

  fail("BAD_ARGS", `${label}: unsupported ABI type ${pt.type}`);
}

function coerceAddress(raw: unknown, ctx: CoerceCtx, label: string): string {
  const s = String(raw ?? "").trim();
  const low = s.toLowerCase();
  if (low === "self" || low === "me" || low === "$account") {
    if (!ctx.account) fail("BAD_ARGS", `${label}: "${s}" needs a connected session`, "run `riftw connect`, or pass the address literally");
    return getAddress(ctx.account);
  }
  if (low === "zero" || low === "0x0") return ZeroAddress;
  try {
    return getAddress(s);
  } catch {
    return fail("BAD_ARGS", `${label}: "${s}" is not an address`, "a 20-byte 0x… address, or `self` for the connected wallet");
  }
}

function coerceBool(raw: unknown, label: string): boolean {
  if (typeof raw === "boolean") return raw;
  const s = String(raw ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(s)) return true;
  if (["false", "0", "no", "n", "off"].includes(s)) return false;
  return fail("BAD_ARGS", `${label}: "${raw}" is not a bool`, "use true/false");
}

function coerceBytes(raw: unknown, base: string, label: string): string {
  let s = String(raw ?? "").trim();
  if (/^(str|utf8):/i.test(s)) s = hexlify(toUtf8Bytes(s.replace(/^(str|utf8):/i, "")));
  else if (/^(keccak|id|hash):/i.test(s)) s = id(s.replace(/^(keccak|id|hash):/i, ""));
  else if (/^keccakhex:/i.test(s)) s = keccak256(s.replace(/^keccakhex:/i, ""));

  if (!isHexString(s)) {
    fail("BAD_ARGS", `${label}: "${raw}" is not hex`, 'use 0x…, or str:<text> / keccak:<text> to derive it');
  }
  const fixed = base.match(/^bytes(\d+)$/);
  if (fixed) {
    const want = Number(fixed[1]);
    const got = (s.length - 2) / 2;
    if (got !== want) {
      fail(
        "BAD_ARGS",
        `${label}: ${base} needs exactly ${want} bytes, got ${got}`,
        want === 32 ? "keccak:<text> produces a bytes32" : undefined
      );
    }
  }
  return s;
}

function hexlify(b: Uint8Array): string {
  return "0x" + Buffer.from(b).toString("hex");
}

export function coerceInt(raw: unknown, base = "uint256", label = "value"): bigint {
  if (typeof raw === "bigint") return raw;
  if (typeof raw === "number") {
    if (!Number.isInteger(raw)) {
      fail("BAD_ARGS", `${label}: ${raw} is not an integer`, "write scaled values as a string: \"1.5e18\", \"1.5ether\", \"1.5@6\"");
    }
    return BigInt(raw);
  }
  let s = String(raw ?? "").trim().replace(/_/g, "").replace(/,/g, "");
  if (!s) fail("BAD_ARGS", `${label}: empty number`);

  const low = s.toLowerCase();
  if (low === "max" || low === "maxuint" || low === `max${base}` || low === "maxuint256") return maxFor(base);
  if (low === "min" && base.startsWith("int")) return -maxFor(base) - 1n;

  if (/^-?0x[0-9a-f]+$/i.test(s)) return BigInt(s);

  // 1ether / 25gwei / 100wei
  const unit = s.match(/^(-?[\d.]+)\s*(wei|gwei|ether|eth)$/i);
  if (unit) return scale(unit[1], unit[2].toLowerCase() === "wei" ? 0 : unit[2].toLowerCase() === "gwei" ? 9 : 18, label);

  // 100@6 — "100 tokens with 6 decimals" (USDC)
  const at = s.match(/^(-?[\d.]+)@(\d{1,3})$/);
  if (at) return scale(at[1], Number(at[2]), label);

  // 1e18 / 1.5e6
  const sci = s.match(/^(-?[\d.]+)e\+?(\d{1,3})$/i);
  if (sci) return scale(sci[1], Number(sci[2]), label);

  if (/^-?\d+$/.test(s)) {
    const v = BigInt(s);
    if (!base.startsWith("int") && v < 0n) fail("BAD_ARGS", `${label}: ${base} cannot be negative`);
    if (v > maxFor(base)) fail("BAD_ARGS", `${label}: ${s} overflows ${base}`);
    return v;
  }

  if (/^-?\d*\.\d+$/.test(s)) {
    fail(
      "BAD_ARGS",
      `${label}: "${s}" has decimals but ${base} is an integer`,
      "say how to scale it: 1.5e18 · 1.5ether · 1.5@6 (6-decimal token) · or pass the raw integer"
    );
  }
  return fail("BAD_ARGS", `${label}: "${raw}" is not a number`);
}

function scale(num: string, decimals: number, label: string): bigint {
  try {
    return parseUnits(num, decimals);
  } catch (e: any) {
    return fail("BAD_ARGS", `${label}: cannot scale ${num} by 10^${decimals}: ${e?.shortMessage || e?.message}`);
  }
}

/** Split "[1,[2,3]]" or "a,b" into items without needing valid JSON. */
export function parseList(raw: unknown, label: string): unknown[] {
  if (Array.isArray(raw)) return raw;
  let s = String(raw ?? "").trim();
  if (s === "" || s === "[]") return [];
  if (s.startsWith("[") && s.endsWith("]")) {
    try {
      const j = JSON.parse(s);
      if (Array.isArray(j)) return j;
    } catch {
      /* not JSON — split manually below */
    }
    s = s.slice(1, -1).trim();
    if (!s) return [];
  }
  return splitTopLevel(s, label);
}

function parseStruct(raw: unknown, label: string): unknown[] | Record<string, unknown> {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  const s = String(raw ?? "").trim();
  if (s.startsWith("{")) {
    try {
      return JSON.parse(s) as Record<string, unknown>;
    } catch (e: any) {
      fail("BAD_ARGS", `${label}: invalid JSON object: ${e?.message}`);
    }
  }
  return parseList(s, label);
}

function splitTopLevel(s: string, label: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "[" || ch === "(" || ch === "{") depth++;
    if (ch === "]" || ch === ")" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (depth !== 0) fail("BAD_ARGS", `${label}: unbalanced brackets in "${s}"`);
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// ───────────────────────────── encode / decode ─────────────────────────────

export function encodeCall(frag: FunctionFragment, values: unknown[]): string {
  try {
    return concat([frag.selector, coder.encode(frag.inputs as unknown as ParamType[], values)]);
  } catch (e: any) {
    return fail("ENCODE_FAILED", `cannot encode ${sighash(frag)}: ${e?.shortMessage || e?.message || e}`);
  }
}

export function encodeConstructor(inputs: readonly ParamType[], values: unknown[]): string {
  if (!inputs.length) return "0x";
  try {
    return coder.encode(inputs as unknown as ParamType[], values);
  } catch (e: any) {
    return fail("ENCODE_FAILED", `cannot encode constructor args: ${e?.shortMessage || e?.message || e}`);
  }
}

export function decodeOutputs(frag: FunctionFragment, data: string): unknown[] | null {
  if (!frag.outputs.length) return null;
  try {
    return Array.from(coder.decode(frag.outputs as unknown as ParamType[], data));
  } catch (e: any) {
    return fail("DECODE_FAILED", `cannot decode return data as (${frag.outputs.map((o) => o.type).join(",")}): ${e?.shortMessage || e?.message}`);
  }
}

/** Best-effort guesses for a `read` whose signature had no `returns (...)` clause. */
export function guessDecode(data: string): string[] {
  const guesses: string[] = [];
  const tryOne = (type: string) => {
    try {
      const [v] = coder.decode([type], data);
      guesses.push(`${type.padEnd(8)} ${plain(v)}`);
    } catch {
      /* not this shape */
    }
  };
  if (data === "0x") return guesses;
  tryOne("uint256");
  tryOne("address");
  tryOne("bool");
  tryOne("string");
  return guesses;
}

// ───────────────────────────── display ─────────────────────────────

export function plain(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return `[${v.map(plain).join(", ")}]`;
  if (v && typeof v === "object") return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
  return String(v);
}

/** JSON-safe clone (bigint → decimal string) for --json output. */
export function jsonSafe(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = jsonSafe(x);
    return o;
  }
  return v;
}

export function formatValue(v: unknown, type?: string): string {
  if (typeof v === "bigint") {
    let s = commas(v.toString());
    // Spotting a decimals mistake is the single most valuable hint here.
    if (v >= 1_000_000n && type && /^u?int/.test(type)) {
      const h6 = fmtUnits(v, 6);
      const h18 = fmtUnits(v, 18);
      s += ` ${dim(`≈ ${h6} @6 · ${h18} @18`)}`;
    }
    return s;
  }
  if (typeof v === "string" && v.startsWith("0x") && v.length > 66) return shortHex(v);
  if (typeof v === "string" && v === ZeroAddress) return `${v} ${dim("(zero address)")}`;
  if (Array.isArray(v)) return `[${v.map((x) => formatValue(x)).join(", ")}]`;
  return plain(v);
}

function fmtUnits(v: bigint, decimals: number): string {
  const sign = v < 0n ? "-" : "";
  const abs = v < 0n ? -v : v;
  const d = 10n ** BigInt(decimals);
  const whole = abs / d;
  const frac = (abs % d).toString().padStart(decimals, "0").replace(/0+$/, "");
  if (whole === 0n && frac) {
    // Keep the first significant digits rather than printing 0.000000.
    const lead = (frac.match(/^0*/) || [""])[0].length;
    return `${sign}0.${"0".repeat(lead)}${frac.slice(lead, lead + 4)}`;
  }
  return `${sign}${commas(whole.toString())}${frac ? "." + frac.slice(0, 6) : ""}`;
}

/** The decoded-argument table shown in every dry-run preview. */
export function argLines(inputs: readonly ParamType[], values: unknown[]): string[] {
  return inputs.map((pt, i) => {
    const name = pt.name ? pt.name : `arg${i + 1}`;
    return `    ${String(i + 1).padStart(2)}. ${name.padEnd(16)} ${dim(pt.type.padEnd(12))} ${formatValue(values[i], pt.type)}`;
  });
}
