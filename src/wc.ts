/**
 * The WalletConnect dApp side.
 *
 * riftw is the dApp; the Rift app is the wallet. riftw prints a `wc:` URI, you paste it into
 * Rift, and from then on every transaction is pushed to Rift as `eth_sendTransaction` and
 * approved there with your passkey (gas sponsored, paid in USDC). This process holds no key
 * and can never broadcast anything by itself.
 *
 * Session persistence: the SDK's keychain lives in ~/.riftw/wc-storage, so a session paired
 * once keeps working across commands and shells until it expires or the wallet drops it.
 */

import { SignClient } from "@walletconnect/sign-client";
import type { SessionTypes } from "@walletconnect/types";
import { clearSession, ensureHome, loadProjectId, WC_STORAGE_DIR } from "./config";
import { dim, fail, log, RiftwError } from "./util";

export type Client = Awaited<ReturnType<typeof SignClient.init>>;

/** Methods Rift's WalletConnect handler supports (smart-wallet/src/walletconnect.ts). */
export const WALLET_METHODS = {
  /** The one method every riftw write goes through. Required, so pairing fails loudly if absent. */
  required: ["eth_sendTransaction"],
  /** Nice to have; requested as optional so pairing never fails because of them. */
  optional: ["personal_sign", "eth_sign", "eth_signTypedData", "eth_signTypedData_v4", "eth_accounts", "eth_chainId"],
};

const METADATA = {
  name: "riftw CLI",
  description: "Rift wallet CLI — contract calls and CREATE2 deploys, passkey-signed",
  url: "https://rift.fi",
  icons: ["https://rift.fi/icon.png"],
};

/**
 * Init the SDK against the persistent on-disk store.
 * The project id is read here and handed straight to the SDK — never printed or stored.
 */
export async function initClient(opts: { projectId?: string; timeoutMs?: number } = {}): Promise<Client> {
  ensureHome();
  const projectId = loadProjectId(opts.projectId);
  const timeoutMs = opts.timeoutMs ?? 45000;

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_r, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new RiftwError(
            "RELAY_TIMEOUT",
            `could not reach the WalletConnect relay within ${Math.round(timeoutMs / 1000)}s`,
            "check your network; the relay is relay.walletconnect.org over wss"
          )
        ),
      timeoutMs
    );
  });

  try {
    const client = await Promise.race([
      SignClient.init({
        projectId,
        metadata: METADATA,
        storageOptions: { database: WC_STORAGE_DIR },
        logger: process.env.RIFTW_DEBUG ? "debug" : "silent",
      }),
      timeout,
    ]);
    return client as Client;
  } catch (e: any) {
    if (e instanceof RiftwError) throw e;
    return fail("WC_INIT_FAILED", `WalletConnect init failed: ${e?.message || e}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function findSession(client: Client, topic: string): SessionTypes.Struct | null {
  try {
    return client.session.get(topic);
  } catch {
    return null;
  }
}

export function listSessions(client: Client): SessionTypes.Struct[] {
  try {
    return client.session.getAll();
  } catch {
    return [];
  }
}

export function sessionAccounts(session: SessionTypes.Struct): string[] {
  const ns = session.namespaces?.eip155;
  return (ns?.accounts || []).map((a) => a.split(":").pop() as string);
}

export function sessionMethods(session: SessionTypes.Struct): string[] {
  return session.namespaces?.eip155?.methods || [];
}

/**
 * The session this topic names, or a precise error: a stale session.json (the SDK store was
 * cleared) reads very differently from an expired session, and both read differently from
 * "the wallet hung up".
 */
export function requireLiveSession(client: Client, topic: string): SessionTypes.Struct {
  const s = findSession(client, topic);
  if (!s) {
    const others = listSessions(client);
    clearSession();
    fail(
      "SESSION_GONE",
      "the stored session is no longer in the local WalletConnect store",
      others.length
        ? "the store holds a different session — run `riftw connect` to pair again"
        : "run `riftw connect` to pair again (the store may have been cleared, or the wallet disconnected)"
    );
  }
  if (s.expiry * 1000 <= Date.now()) {
    fail("SESSION_EXPIRED", `the session expired ${new Date(s.expiry * 1000).toISOString()}`, "run `riftw connect` to pair again");
  }
  return s;
}

export interface SendTxRequest {
  topic: string;
  chainId: number;
  from: string;
  to: string;
  data: string;
  /** Wei, as a hex quantity. */
  value?: string;
  expiry: number;
}

/**
 * Queue one eth_sendTransaction in the Rift app and wait for the passkey approval.
 * Resolves to whatever the wallet returns: the transaction hash, or the userOp hash if the
 * bundler had not surfaced a transaction hash yet.
 */
export async function requestSendTransaction(client: Client, req: SendTxRequest): Promise<string> {
  const params = [
    {
      from: req.from,
      to: req.to,
      data: req.data,
      value: req.value || "0x0",
    },
  ];
  try {
    const result = await client.request<string>({
      topic: req.topic,
      chainId: `eip155:${req.chainId}`,
      expiry: req.expiry,
      request: { method: "eth_sendTransaction", params },
    });
    if (typeof result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(result)) {
      fail("BAD_WALLET_RESULT", `the wallet returned something that is not a 32-byte hash: ${JSON.stringify(result)}`);
    }
    return result;
  } catch (e: any) {
    throw mapRequestError(e);
  }
}

export async function requestSign(
  client: Client,
  req: { topic: string; chainId: number; method: string; params: unknown[]; expiry: number }
): Promise<string> {
  try {
    return await client.request<string>({
      topic: req.topic,
      chainId: `eip155:${req.chainId}`,
      expiry: req.expiry,
      request: { method: req.method, params: req.params },
    });
  } catch (e: any) {
    throw mapRequestError(e);
  }
}

function mapRequestError(e: any): RiftwError {
  const msg = String(e?.message || e || "unknown");
  if (/reject/i.test(msg)) {
    return new RiftwError("USER_REJECTED", "rejected in the Rift app", "nothing was sent; re-run when you are ready to approve");
  }
  if (/expire|timeout/i.test(msg)) {
    return new RiftwError(
      "REQUEST_EXPIRED",
      "the request expired before it was approved",
      "re-run; raise the signing window with --expiry=<seconds> (300…604800)"
    );
  }
  if (/No matching key|session topic doesn't exist/i.test(msg)) {
    clearSession();
    return new RiftwError("SESSION_GONE", "the wallet no longer knows this session", "run `riftw connect` to pair again");
  }
  if (/Missing or invalid|unsupported|unauthorized/i.test(msg)) {
    return new RiftwError(
      "METHOD_NOT_APPROVED",
      `the session does not allow this method: ${msg}`,
      "run `riftw disconnect` then `riftw connect` to re-pair with the full method set"
    );
  }
  return new RiftwError("WALLET_ERROR", `the wallet returned an error: ${msg}`);
}

export async function disconnect(client: Client, topic: string): Promise<void> {
  try {
    await client.disconnect({ topic, reason: { code: 6000, message: "riftw disconnect" } });
  } catch (e: any) {
    log(dim(`  (the wallet did not acknowledge the disconnect: ${e?.message || e})`));
  }
}

/** Close the relay socket so the process can exit. */
export async function closeClient(client: Client | null): Promise<void> {
  if (!client) return;
  try {
    await (client.core as any).relayer.transportClose();
  } catch {
    /* already closed */
  }
}
