/** riftw connect / status / disconnect — the persisted WalletConnect session. */

import fs from "fs";
import type { Args } from "../args";
import { chainById, resolveChain } from "../chains";
import {
  clearSession,
  ensureHome,
  HOME,
  readSession,
  sessionExpired,
  URI_FILE,
  WC_STORAGE_DIR,
  writeSession,
  type StoredSession,
} from "../config";
import { bold, cyan, dim, emit, exit, fail, green, log, red, rule, warn, yellow } from "../util";
import {
  closeClient,
  disconnect as wcDisconnect,
  findSession,
  initClient,
  listSessions,
  sessionAccounts,
  sessionMethods,
  WALLET_METHODS,
  type Client,
} from "../wc";

export async function cmdConnect(args: Args): Promise<void> {
  const chain = resolveChain(args.str("chain"));
  const pairTimeout = args.num("pair-timeout", 300) * 1000;

  const existing = readSession();
  if (existing && !sessionExpired(existing) && !args.bool("force")) {
    log("");
    log(green("  already connected") + dim(" — pass --force to drop it and pair again"));
    printSession(existing);
    emit({ ok: true, alreadyConnected: true, ...sessionJson(existing) });
    return;
  }

  let client: Client | null = null;
  try {
    client = await initClient();

    if (existing && args.bool("force")) {
      const live = findSession(client, existing.topic);
      if (live) {
        log(dim("  dropping the existing session …"));
        await wcDisconnect(client, existing.topic);
      }
      clearSession();
    }

    // eth_sendTransaction is always required — without it the session is useless. Everything
    // else is optional, so a wallet that does not offer it cannot break the pairing.
    const methods = WALLET_METHODS.required;
    const optional = args.bool("minimal") ? [] : WALLET_METHODS.optional;

    const { uri, approval } = await client.connect({
      requiredNamespaces: {
        eip155: { chains: [`eip155:${chain.id}`], methods, events: [] },
      },
      ...(optional.length
        ? {
            optionalNamespaces: {
              eip155: { chains: [`eip155:${chain.id}`], methods: optional, events: ["chainChanged", "accountsChanged"] },
            },
          }
        : {}),
    });

    if (!uri) fail("NO_URI", "WalletConnect did not return a pairing URI");

    ensureHome();
    try {
      fs.writeFileSync(URI_FILE, uri + "\n");
    } catch {
      /* non-fatal */
    }

    log("");
    log(bold(`  PAIR THE RIFT APP — paste this into Rift (WalletConnect → paste / scan)`));
    rule();
    log("");
    log(cyan(uri));
    log("");
    log(dim(`  also written to ${URI_FILE}`));
    log(dim(`  pair on ${chain.name} (chain ${chain.id}). Rift's pairing timeout is 30s — paste it now.`));
    log(dim(`  waiting up to ${Math.round(pairTimeout / 1000)}s for the session …`));
    emit({ uri, chain: { id: chain.id, key: chain.key, name: chain.name } });

    let timer: NodeJS.Timeout | undefined;
    const session = await Promise.race([
      approval(),
      new Promise<never>((_r, reject) => {
        timer = setTimeout(() => reject(new Error(`no session within ${Math.round(pairTimeout / 1000)}s`)), pairTimeout);
      }),
    ])
      .finally(() => {
        // Otherwise the pending timer keeps the process alive after a successful pairing.
        if (timer) clearTimeout(timer);
      })
      .catch((e: any) => {
        return fail(
          "PAIRING_FAILED",
          `pairing failed: ${e?.message || e}`,
          "Rift's own pairing timeout is 30s — paste the URI immediately after it prints, then run `riftw connect` again"
        );
      });

    const accounts = sessionAccounts(session);
    const account = accounts[0];
    if (!account) fail("NO_ACCOUNT", "the wallet approved the session but reported no eip155 account");

    const approvedChainId = Number(
      (session.namespaces?.eip155?.accounts?.[0] || "").split(":")[1] || chain.id
    );
    if (approvedChainId !== chain.id) {
      warn(`the wallet paired on chain ${approvedChainId}, not ${chain.id} — storing ${approvedChainId}`);
    }
    const approvedMethods = sessionMethods(session);
    if (!approvedMethods.includes("eth_sendTransaction")) {
      fail(
        "NO_SEND_METHOD",
        "the session does not include eth_sendTransaction, so no transaction could ever be sent",
        "re-pair; if it keeps happening try `riftw connect --minimal`"
      );
    }

    const stored: StoredSession = {
      topic: session.topic,
      account,
      chainId: approvedChainId,
      chainKey: chainById(approvedChainId).key,
      expiry: session.expiry,
      peerName: session.peer?.metadata?.name,
      createdAt: new Date().toISOString(),
      methods: approvedMethods,
    };
    writeSession(stored);

    log("");
    log(green("  PAIRED"));
    printSession(stored);
    log(dim("  the session is saved — later commands reuse it, no re-pairing"));
    emit({ ok: true, ...sessionJson(stored) });
  } finally {
    await closeClient(client);
  }
}

export async function cmdStatus(args: Args): Promise<void> {
  const s = readSession();
  if (!s) {
    log("");
    log(`  ${yellow("not connected")} ${dim("— run `riftw connect`")}`);
    log(dim(`  session file would be ${HOME}\\session.json`));
    emit({ ok: false, connected: false });
    await exit(1);
    return; // unreachable: exit() never returns
  }

  const expired = sessionExpired(s);
  log("");
  log(`  ${expired ? red("session expired") : green("connected")}`);
  printSession(s);

  let live: { known: boolean; methods?: string[]; expiry?: number } | undefined;
  if (args.bool("live")) {
    let client: Client | null = null;
    try {
      client = await initClient();
      const sess = findSession(client, s.topic);
      live = sess
        ? { known: true, methods: sessionMethods(sess), expiry: sess.expiry }
        : { known: false };
      log(
        `  relay      ${live.known ? green("the SDK store still holds this session") : red("the local store no longer has this topic — re-connect")}`
      );
      if (live.known && sess) {
        log(`  methods    ${dim(sessionMethods(sess).join(", "))}`);
        const others = listSessions(client).filter((x) => x.topic !== s.topic);
        if (others.length) log(dim(`  (${others.length} other session(s) in the store)`));
      }
    } finally {
      await closeClient(client);
    }
  } else {
    log(dim("  (offline view — add --live to check the WalletConnect store too)"));
  }

  const usable = !expired && (live ? live.known : true);
  emit({ ok: usable, connected: usable, ...sessionJson(s), live });
  if (!usable) await exit(1);
}

export async function cmdDisconnect(args: Args): Promise<void> {
  const s = readSession();
  if (!s) {
    log(`  ${dim("no stored session — nothing to disconnect")}`);
    if (args.bool("purge")) purgeStore();
    emit({ ok: true, disconnected: false });
    return;
  }

  let client: Client | null = null;
  try {
    client = await initClient();
    const live = findSession(client, s.topic);
    if (live) await wcDisconnect(client, s.topic);
    else log(dim("  the local store no longer had this session; clearing the local record"));
  } catch (e: any) {
    warn(`could not tell the wallet (${e?.message || e}); clearing the local record anyway`);
  } finally {
    await closeClient(client);
  }

  clearSession();
  if (args.bool("purge")) purgeStore();
  log(`  ${green("disconnected")} ${dim(s.account)}`);
  emit({ ok: true, disconnected: true, account: s.account, topic: s.topic });
}

function purgeStore(): void {
  try {
    fs.rmSync(WC_STORAGE_DIR, { recursive: true, force: true });
    log(dim(`  purged ${WC_STORAGE_DIR}`));
  } catch (e: any) {
    warn(`could not purge ${WC_STORAGE_DIR}: ${e?.message}`);
  }
}

function printSession(s: StoredSession): void {
  const chain = chainById(s.chainId);
  const left = s.expiry * 1000 - Date.now();
  rule();
  log(`  account    ${bold(s.account)}`);
  log(`  chain      ${chain.name} (${s.chainId})`);
  log(`  wallet     ${s.peerName || dim("unknown peer")}`);
  log(
    `  expires    ${new Date(s.expiry * 1000).toISOString()}  ${
      left > 0 ? dim(`(in ${humanDuration(left)})`) : red("(expired)")
    }`
  );
  log(`  paired     ${s.createdAt}`);
  log(`  topic      ${dim(s.topic.slice(0, 12) + "…")}`);
  rule();
}

function sessionJson(s: StoredSession): Record<string, unknown> {
  return {
    account: s.account,
    chainId: s.chainId,
    chainKey: s.chainKey,
    expiry: s.expiry,
    expiresAt: new Date(s.expiry * 1000).toISOString(),
    expired: sessionExpired(s),
    peerName: s.peerName,
    topic: s.topic,
    methods: s.methods,
  };
}

function humanDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
