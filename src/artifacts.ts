/**
 * Finding creation bytecode + ABI.
 *
 * `riftw deploy <artifactPathOrName>` accepts
 *   • a path to a compiler artifact JSON  (foundry `out/Foo.sol/Foo.json`, hardhat, or {abi,bytecode})
 *   • a bare contract name, searched under --artifacts / RIFTW_ARTIFACTS / the cwd
 *   • `Foo.sol:Foo`
 *   • raw creation bytecode `0x60806040…` (then constructor types come from --ctor-types)
 */

import fs from "fs";
import path from "path";
import { Fragment, ParamType } from "ethers";
import { fail } from "./util";

export interface Artifact {
  name: string;
  source: string;
  abi: any[];
  /** Creation bytecode (NOT the deployed/runtime code). */
  bytecode: string;
  ctorInputs: readonly ParamType[];
}

const SKIP_DIRS = new Set(["node_modules", ".git", "cache", "broadcast", "dist", "build-info", ".next", "coverage", "lib", "forge-cache"]);

export function resolveArtifact(ref: string, opts: { artifactDirs?: string; ctorTypes?: string }): Artifact {
  const raw = ref.trim();

  // raw creation bytecode
  if (/^0x[0-9a-fA-F]{40,}$/.test(raw) && raw.length > 200) {
    const inputs = parseCtorTypes(opts.ctorTypes);
    return { name: "RawBytecode", source: "<inline>", abi: [], bytecode: raw, ctorInputs: inputs };
  }

  // explicit file
  if (/[\\/]/.test(raw) || raw.toLowerCase().endsWith(".json")) {
    const p = path.resolve(raw);
    if (!fs.existsSync(p)) fail("NO_ARTIFACT", `no such artifact file: ${p}`);
    return loadArtifactFile(p, opts.ctorTypes);
  }

  const name = raw.includes(":") ? raw.split(":").pop()!.trim() : raw;
  const roots = searchRoots(opts.artifactDirs);
  const hit = findArtifact(name, roots);
  if (!hit) {
    fail(
      "NO_ARTIFACT",
      `could not find a compiler artifact for "${name}"`,
      `searched (depth 5) in: ${roots.join(", ")}\n` +
        `         pass the path directly (…/out/${name}.sol/${name}.json), or --artifacts <dir>, or run \`forge build\` first`
    );
  }
  return loadArtifactFile(hit, opts.ctorTypes);
}

function searchRoots(flag?: string): string[] {
  const roots: string[] = [];
  const push = (p?: string) => {
    if (!p) return;
    const abs = path.resolve(p);
    if (fs.existsSync(abs) && !roots.includes(abs)) roots.push(abs);
  };
  for (const p of (flag || "").split(/[;,]/)) push(p.trim() || undefined);
  for (const p of (process.env.RIFTW_ARTIFACTS || "").split(/[;,]/)) push(p.trim() || undefined);
  push(process.cwd());
  return roots;
}

function findArtifact(name: string, roots: string[]): string | null {
  for (const root of roots) {
    // Fast paths first — the usual foundry/hardhat layouts.
    const direct = [
      path.join(root, "out", `${name}.sol`, `${name}.json`),
      path.join(root, `${name}.sol`, `${name}.json`),
      path.join(root, `${name}.json`),
    ];
    for (const p of direct) if (fs.existsSync(p)) return p;

    const found = walk(root, `${name}.json`, 5, 4000);
    if (found) return found;
  }
  return null;
}

function walk(dir: string, fileName: string, depth: number, budget: number): string | null {
  if (depth < 0 || budget <= 0) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let left = budget - entries.length;
  for (const e of entries) {
    if (e.isFile() && e.name === fileName) return path.join(dir, e.name);
  }
  for (const e of entries) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
    const r = walk(path.join(dir, e.name), fileName, depth - 1, left);
    if (r) return r;
    left -= 50;
    if (left <= 0) return null;
  }
  return null;
}

function loadArtifactFile(p: string, ctorTypes?: string): Artifact {
  let j: any;
  try {
    j = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e: any) {
    return fail("BAD_ARTIFACT", `cannot parse ${p}: ${e?.message}`);
  }

  const bytecode =
    pickHex(j?.bytecode?.object) ??
    pickHex(j?.bytecode) ??
    pickHex(j?.evm?.bytecode?.object) ??
    pickHex(j?.creationCode) ??
    pickHex(j?.data);

  if (!bytecode) {
    fail(
      "BAD_ARTIFACT",
      `${p} has no creation bytecode`,
      "foundry: re-run `forge build` (the artifact must contain bytecode.object, not just deployedBytecode)"
    );
  }
  if (bytecode.includes("__$")) {
    fail(
      "UNLINKED_LIBRARY",
      `${path.basename(p)} creation bytecode has unlinked library placeholders (__$…$__)`,
      "deploy the library first and link it, or make the library internal"
    );
  }

  const abi: any[] = Array.isArray(j?.abi) ? j.abi : [];
  const name = j?.contractName || j?.metadata?.settings?.compilationTarget
    ? j.contractName || Object.values(j.metadata.settings.compilationTarget)[0]
    : path.basename(p, ".json");

  let ctorInputs: readonly ParamType[] = [];
  if (ctorTypes !== undefined) {
    ctorInputs = parseCtorTypes(ctorTypes);
  } else {
    const ctor = abi.find((f) => f?.type === "constructor");
    if (ctor) {
      try {
        ctorInputs = (Fragment.from(ctor) as any).inputs as ParamType[];
      } catch {
        ctorInputs = (ctor.inputs || []).map((i: any) => ParamType.from(i));
      }
    }
  }

  return { name: String(name), source: p, abi, bytecode, ctorInputs };
}

function pickHex(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.startsWith("0x") ? v : `0x${v}`;
  return /^0x[0-9a-fA-F]*$/.test(s) && s.length > 4 ? s : null;
}

export function parseCtorTypes(spec?: string): readonly ParamType[] {
  if (!spec || !spec.trim()) return [];
  const body = spec.trim().replace(/^\(|\)$/g, "");
  if (!body) return [];
  try {
    return body.split(",").map((t) => ParamType.from(t.trim()));
  } catch (e: any) {
    return fail("BAD_ARGS", `--ctor-types "${spec}" is not a type list: ${e?.shortMessage || e?.message}`);
  }
}
