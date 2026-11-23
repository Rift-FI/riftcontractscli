/** Tiny argv parser: `--key=value`, `--key value` (for known value flags), `--flag`, `-y`. */

import { fail } from "./util";

/** Flags that consume the next token when written `--key value`. */
const VALUE_FLAGS = new Set([
  "chain",
  "rpc",
  "value",
  "expiry",
  "confirm-timeout",
  "salt",
  "salt-namespace",
  "factory",
  "artifacts",
  "from",
  "block",
  "state",
  "save",
  "ctor-types",
  "data",
  "only",
  "label",
  "name",
  "account",
  "pair-timeout",
]);

const SHORT: Record<string, string> = { y: "yes", h: "help", j: "json", q: "quiet", v: "version" };

export interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | true>;
  has(name: string): boolean;
  str(name: string, fallback?: string): string | undefined;
  num(name: string, fallback: number): number;
  bool(name: string): boolean;
}

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  let passthrough = false;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (passthrough) {
      positional.push(tok);
      continue;
    }
    if (tok === "--") {
      passthrough = true;
      continue;
    }
    if (tok.startsWith("--")) {
      const body = tok.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      if (VALUE_FLAGS.has(body)) {
        const next = argv[i + 1];
        if (next === undefined) fail("BAD_ARGS", `--${body} needs a value`);
        flags[body] = next;
        i++;
        continue;
      }
      flags[body] = true;
      continue;
    }
    if (/^-[a-zA-Z]$/.test(tok)) {
      const long = SHORT[tok.slice(1)];
      if (long) {
        flags[long] = true;
        continue;
      }
    }
    positional.push(tok);
  }

  const command = positional.shift() || "";

  return {
    command,
    positional,
    flags,
    has: (n) => n in flags,
    str: (n, fallback) => {
      const v = flags[n];
      if (v === undefined) return fallback;
      if (v === true) fail("BAD_ARGS", `--${n} needs a value`);
      return v;
    },
    num: (n, fallback) => {
      const v = flags[n];
      if (v === undefined || v === true) return fallback;
      const x = Number(v);
      if (!Number.isFinite(x)) fail("BAD_ARGS", `--${n} must be a number, got "${v}"`);
      return x;
    },
    bool: (n) => flags[n] === true || flags[n] === "true" || flags[n] === "1",
  };
}
