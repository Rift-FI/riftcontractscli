/**
 * Output, colours, errors and the confirmation prompt.
 *
 * Two output modes:
 *   human  — everything on stdout, colourised when stdout is a TTY
 *   --json — stdout carries exactly one JSON document; all progress/log lines
 *            are diverted to stderr so stdout stays machine-readable.
 */

import readline from "readline";

let JSON_MODE = false;
let QUIET = false;

export function setJsonMode(on: boolean): void {
  JSON_MODE = on;
}
export function isJsonMode(): boolean {
  return JSON_MODE;
}
export function setQuiet(on: boolean): void {
  QUIET = on;
}

const COLOR = !!process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: unknown) => (COLOR ? `\x1b[${code}m${String(s)}\x1b[0m` : String(s));
export const bold = (s: unknown) => c("1", s);
export const dim = (s: unknown) => c("2", s);
export const red = (s: unknown) => c("31", s);
export const green = (s: unknown) => c("32", s);
export const yellow = (s: unknown) => c("33", s);
export const cyan = (s: unknown) => c("36", s);

/** Human-readable progress. Goes to stderr in --json mode so stdout stays pure. */
export function log(line = ""): void {
  if (QUIET) return;
  if (JSON_MODE) process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export function warn(line: string): void {
  process.stderr.write(yellow("warning: ") + line + "\n");
}

/** In-place progress dots (suppressed in --json/quiet mode). */
export function tick(s = "."): void {
  if (QUIET || JSON_MODE) return;
  process.stdout.write(s);
}

export function rule(width = 78): void {
  log(dim("─".repeat(width)));
}

export function heading(title: string): void {
  log("");
  log(bold(title));
  rule();
}

/** The single JSON document emitted by --json mode. */
let jsonPayload: Record<string, unknown> | null = null;
export function emit(obj: Record<string, unknown>): void {
  jsonPayload = { ...(jsonPayload || {}), ...obj };
}
export function flushJson(): void {
  if (JSON_MODE && jsonPayload) process.stdout.write(JSON.stringify(jsonPayload, null, 2) + "\n");
  jsonPayload = null;
}

export class RiftwError extends Error {
  code: string;
  hint?: string;
  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

export function fail(code: string, message: string, hint?: string): never {
  throw new RiftwError(code, message, hint);
}

/** Flush stdout/stderr, then exit. console.log to a pipe is async on Windows. */
export async function exit(code: number): Promise<never> {
  flushJson();
  await new Promise<void>((r) => {
    if (process.stdout.write("")) r();
    else process.stdout.once("drain", () => r());
  });
  process.exit(code);
}

export function confirm(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      // Non-interactive and no --yes: refuse rather than hang forever.
      resolve(false);
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (a) => {
      rl.close();
      const v = String(a).trim().toLowerCase();
      resolve(v === "y" || v === "yes");
    });
  });
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const commas = (n: unknown) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export const byteLen = (hex: string) => Math.max(0, (hex.length - 2) / 2);

export const eqAddr = (a?: string | null, b?: string | null) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Shorten a long hex blob for display: 0x1234…cdef (1,234 bytes). */
export function shortHex(hex: string, keep = 10): string {
  if (hex.length <= keep * 2 + 8) return hex;
  return `${hex.slice(0, keep + 2)}…${hex.slice(-keep)} ${dim(`(${commas(byteLen(hex))} bytes)`)}`;
}
