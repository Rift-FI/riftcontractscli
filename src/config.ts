/**
 * ~/.riftw — where the persisted session lives.
 *
 *   ~/.riftw/session.json        topic + account + chain + expiry (what `riftw status` reads)
 *   ~/.riftw/wc-storage/         the WalletConnect SDK's own keychain/session store.
 *                                This is what makes the session survive between commands:
 *                                the topic in session.json is useless without the symmetric
 *                                key the SDK keeps here.
 *   ~/.riftw/state/              batch run state (resume markers)
 *   ~/.riftw/last-pairing-uri.txt  the most recent wc: URI, for awkward copy/paste
 *   ~/.riftw/config.json         optional: { "walletconnectProjectId" | "projectIdFile" | "envFile" }
 *
 * The WalletConnect project id is a secret: it is read at runtime, handed to the SDK, and
 * NEVER printed, logged or written anywhere by this tool.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { fail } from "./util";

export const HOME = process.env.RIFTW_HOME || path.join(os.homedir(), ".riftw");
export const SESSION_FILE = path.join(HOME, "session.json");
export const WC_STORAGE_DIR = path.join(HOME, "wc-storage");
export const STATE_DIR = path.join(HOME, "state");
export const URI_FILE = path.join(HOME, "last-pairing-uri.txt");
export const CONFIG_FILE = path.join(HOME, "config.json");

/** Fallback location of the Rift smart-wallet env file that holds the project id. */
const SMART_WALLET_ENV = process.env.RIFTW_ENV_FILE || "c:/Users/ADMIN/rift/smart-wallet/.env";

export interface StoredSession {
  topic: string;
  account: string;
  chainId: number;
  chainKey: string;
  /** Unix seconds, from the WalletConnect session. */
  expiry: number;
  peerName?: string;
  createdAt: string;
  methods?: string[];
}

export function ensureHome(): void {
  fs.mkdirSync(HOME, { recursive: true });
}

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

export function readSession(): StoredSession | null {
  const s = readJson<StoredSession>(SESSION_FILE);
  if (!s || !s.topic || !s.account) return null;
  return s;
}

export function writeSession(s: StoredSession): void {
  ensureHome();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2) + "\n");
}

export function clearSession(): void {
  try {
    fs.unlinkSync(SESSION_FILE);
  } catch {
    /* already gone */
  }
}

export function sessionExpired(s: StoredSession): boolean {
  return !!s.expiry && s.expiry * 1000 <= Date.now();
}

/**
 * The connected session, or a clear error explaining how to get one.
 * `wantChainId` guards against sending a Base transaction over a Polygon session.
 */
export function requireSession(wantChainId?: number): StoredSession {
  const s = readSession();
  if (!s) {
    fail(
      "NOT_CONNECTED",
      "no WalletConnect session on this machine",
      "run `riftw connect` first — it prints a wc: link to paste into the Rift app"
    );
  }
  if (sessionExpired(s)) {
    fail(
      "SESSION_EXPIRED",
      `the session expired ${new Date(s.expiry * 1000).toISOString()}`,
      "run `riftw connect` to pair again (`riftw disconnect` first if the app still lists it)"
    );
  }
  if (wantChainId !== undefined && s.chainId !== wantChainId) {
    fail(
      "WRONG_CHAIN",
      `the session is bound to chain ${s.chainId} (${s.chainKey}) but this command targets chain ${wantChainId}`,
      "Rift binds one session to one chain: `riftw disconnect` then `riftw connect --chain <chain>`"
    );
  }
  return s;
}

export function statePath(name: string, chainId: number, override?: string): string {
  if (override) return path.resolve(override);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "_");
  return path.join(STATE_DIR, `${safe}.${chainId}.json`);
}

/**
 * WalletConnect project id. Never printed — only handed to the SDK.
 * Order: env → ~/.riftw/config.json → the Rift smart-wallet .env file.
 */
export function loadProjectId(explicit?: string): string {
  if (explicit) return explicit.trim();
  if (process.env.WALLETCONNECT_PROJECT_ID) return process.env.WALLETCONNECT_PROJECT_ID.trim();

  const cfg = readJson<{ walletconnectProjectId?: string; projectIdFile?: string; envFile?: string }>(CONFIG_FILE);
  if (cfg?.walletconnectProjectId) return cfg.walletconnectProjectId.trim();
  if (cfg?.projectIdFile) {
    const v = readFirstLine(cfg.projectIdFile);
    if (v) return v;
  }

  const envFile = cfg?.envFile || SMART_WALLET_ENV;
  const v = readEnvVar(envFile, "WALLETCONNECT_PROJECT_ID");
  if (v) return v;

  return fail(
    "NO_PROJECT_ID",
    "WALLETCONNECT_PROJECT_ID is not set and could not be read from a config file",
    `set the env var, or put {"walletconnectProjectId":"…"} in ${CONFIG_FILE}, or make it readable in ${envFile}`
  );
}

function readFirstLine(p: string): string | null {
  try {
    const first = fs.readFileSync(p, "utf8").split(/\r?\n/)[0];
    return first ? first.trim() || null : null;
  } catch {
    return null;
  }
}

function readEnvVar(file: string, key: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const m = raw.match(new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(.*)$`, "m"));
  if (!m) return null;
  const v = m[1]
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\s+#.*$/, "");
  return v || null;
}
