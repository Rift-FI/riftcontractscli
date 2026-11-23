/**
 * riftw selftest — everything that can be proven without a wallet, a passkey or a network.
 *
 * The anchor test is the CREATE2 one: it takes the real salt + init code out of
 * smart-wallet/contracts/vault-deploy.json and must reproduce the LIVE Rift payout vault at
 * 0x3400d7aD28AdBbc3918f190C2034d1ED912BeC63. If that passes, the address this CLI predicts
 * for a deploy is the address the deploy will land on.
 *
 * The second anchor replays the PREMIA beta plan (6 contracts, deployed to Base mainnet with
 * the one-off wc-deploy script) through this CLI's own artifact loading, constructor encoding,
 * salt scheme and CREATE2 maths, and compares every address with what that deploy produced.
 */

import fs from "fs";
import path from "path";
import { id, keccak256, parseUnits, ZeroAddress } from "ethers";
import { coerceArgs, coerceInt, encodeCall, parseSignature } from "../abi";
import type { Args } from "../args";
import { resolveArtifact } from "../artifacts";
import { CREATE2_FACTORY, planCreate2, predictAddress, resolveSalt } from "../create2";
import { bold, commas, dim, emit, exit, green, log, red, rule, yellow } from "../util";
import { WALLET_METHODS } from "../wc";
import { readBatch, resolveStep } from "./batch";

const VAULT_DEPLOY_JSON = process.env.RIFTW_VAULT_DEPLOY_JSON || "c:/Users/ADMIN/rift/smart-wallet/contracts/vault-deploy.json";
const LIVE_VAULT = "0x3400d7aD28AdBbc3918f190C2034d1ED912BeC63";

const PREMIA_CONTRACTS = "c:/Users/ADMIN/rift/vomma/contracts";
const PREMIA_GOV = "0x8fC19fBc01DD9b9aEEa626c2AE980F710A390da7";
const PREMIA_REPORTER = "0x7AB104FE43968CBf2Ca4b571d0c64C9D8eefE67C";
const PREMIA_NS = "premia-beta-v1:";
/** What the real deploy produced (wc-deploy/README.md + Base mainnet). */
const PREMIA_EXPECTED: Record<string, string> = {
  PrmUSD: "0x7152280AfE7493d84533565Cd5c79B5d4B4EC4CB",
  CollateralVault: "0x127048434EfD4ac79e5E4ff41E1c6e3d5Fd0279A",
  FeeSplitter: "0x17CA473D42131CB27C1BA129A4404a2FF0140f81",
  SettlementKeeper: "0xA10042C12F0ADE1CAF928F023799F6F594C4236b",
  PushOracleAdapter: "0x93D1dbAC87AcCf85C3070eEdD9EeD0Ad699b7090",
  MarketFactory: "0xf9CFf47DE2E6bEAA5F32Cf2090E35aC3B829c3A8",
};

let pass = 0;
let failed = 0;
let skipped = 0;
const results: { name: string; ok: boolean | null; detail?: string }[] = [];

function check(name: string, got: unknown, want: unknown, extra?: string): void {
  const g = norm(got);
  const w = norm(want);
  const ok = g === w;
  if (ok) pass++;
  else failed++;
  results.push({ name, ok, detail: ok ? extra : `got ${g} · want ${w}` });
  log(`  ${ok ? green("PASS") : red("FAIL")}  ${name}`);
  if (!ok) log(`        got  ${g}\n        want ${w}`);
  else if (extra) log(dim(`        ${extra}`));
}

function skip(name: string, why: string): void {
  skipped++;
  results.push({ name, ok: null, detail: why });
  log(`  ${yellow("SKIP")}  ${name} ${dim("— " + why)}`);
}

function norm(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v)) return v.toLowerCase();
  return String(v);
}

export async function cmdSelftest(_args: Args): Promise<void> {
  log("");
  log(bold("  riftw selftest — offline. No network, no wallet, nothing signed."));

  // ── 1. CREATE2 against the live Rift payout vault ──────────────────────────
  log("");
  log(bold("  1. CREATE2 maths vs the live Rift payout vault"));
  rule();
  if (!fs.existsSync(VAULT_DEPLOY_JSON)) {
    skip("vault-deploy.json reproduces the live vault", `${VAULT_DEPLOY_JSON} not found`);
  } else {
    const j = JSON.parse(fs.readFileSync(VAULT_DEPLOY_JSON, "utf8"));
    const salt = "0x" + String(j.data).slice(2, 66);
    const initCode = "0x" + String(j.data).slice(66);
    const initCodeHash = keccak256(initCode);
    const predicted = predictAddress(j.to || CREATE2_FACTORY, salt, initCode);

    log(`  source      ${dim(VAULT_DEPLOY_JSON)}`);
    log(`  salt        ${salt}`);
    log(`  init code   ${commas((initCode.length - 2) / 2)} bytes`);
    check("CREATE2 factory is the canonical proxy", j.to, CREATE2_FACTORY);
    check("initCodeHash matches vault-deploy.json", initCodeHash, j.initCodeHash);
    check("predicted address == the live payout vault", predicted, LIVE_VAULT, `keccak256(0xff ++ factory ++ salt ++ keccak256(initCode))[12:] → ${predicted}`);
    check("the file's own recorded address", j.vault, LIVE_VAULT);
  }

  // ── 2. argument coercion ───────────────────────────────────────────────────
  log("");
  log(bold("  2. argument parsing and ABI encoding"));
  rule();
  check("1e18", coerceInt("1e18"), 10n ** 18n);
  check("1.5e18", coerceInt("1.5e18"), parseUnits("1.5", 18));
  check("1ether", coerceInt("1ether"), 10n ** 18n);
  check("25gwei", coerceInt("25gwei"), 25_000_000_000n);
  check("100@6 (USDC)", coerceInt("100@6"), 100_000_000n);
  check("5_000_000", coerceInt("5_000_000"), 5_000_000n);
  check("0xff", coerceInt("0xff"), 255n);
  check("max (uint256)", coerceInt("max"), (1n << 256n) - 1n);
  check("max (uint8)", coerceInt("max", "uint8"), 255n);
  check("1000 wei", coerceInt("1000wei"), 1000n);

  // Well-known selectors: ground truth that does not depend on this code.
  check("selector transfer(address,uint256)", parseSignature("transfer(address,uint256)").selector, "0xa9059cbb");
  check("selector approve(address,uint256)", parseSignature("approve(address,uint256)").selector, "0x095ea7b3");
  check("selector balanceOf(address)", parseSignature("balanceOf(address) view returns (uint256)").selector, "0x70a08231");
  check(
    "keccak:Transfer(address,address,uint256)",
    coerceArgs(parseSignature("f(bytes32)").inputs, ["keccak:Transfer(address,address,uint256)"])[0],
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
  );

  // Full calldata, byte for byte.
  {
    const frag = parseSignature("transfer(address,uint256)");
    const values = coerceArgs(frag.inputs, ["0x8fC19fBc01DD9b9aEEa626c2AE980F710A390da7", "100@6"]);
    check(
      "calldata transfer(0x8fC1…, 100 USDC)",
      encodeCall(frag, values),
      "0xa9059cbb" +
        "0000000000000000000000008fc19fbc01dd9b9aeea626c2ae980f710a390da7" +
        "0000000000000000000000000000000000000000000000000000000005f5e100"
    );
  }
  {
    const frag = parseSignature("setProtocol(address,bool)");
    const values = coerceArgs(frag.inputs, ["0x127048434EfD4ac79e5E4ff41E1c6e3d5Fd0279A", "true"]);
    check(
      "calldata setProtocol(0x1270…, true)",
      encodeCall(frag, values),
      "0x" +
        frag.selector.slice(2) +
        "000000000000000000000000127048434efd4ac79e5e4ff41e1c6e3d5fd0279a" +
        "0000000000000000000000000000000000000000000000000000000000000001"
    );
  }
  // Arrays, tuples, self, zero.
  {
    const frag = parseSignature("multi(address[],uint256[2],(uint256,bool))");
    const values = coerceArgs(
      frag.inputs,
      ["[0x0000000000000000000000000000000000000001,zero]", "[1e18,2]", "[7,true]"],
      { account: PREMIA_GOV }
    ) as any[];
    check("address[] with `zero`", values[0][1], ZeroAddress);
    check("uint256[2] scaling", values[1][0], 10n ** 18n);
    check("tuple field", values[2][0], 7n);
    check("tuple bool", values[2][1], true);
  }
  {
    const frag = parseSignature("g(address)");
    const values = coerceArgs(frag.inputs, ["self"], { account: PREMIA_GOV });
    check("`self` resolves to the connected account", values[0], PREMIA_GOV);
  }
  // Errors a human should see, not a stack trace.
  checkThrows("decimals without a unit are refused", () => coerceInt("1.5"), /decimals/i);
  checkThrows("bad address is refused", () => coerceArgs(parseSignature("g(address)").inputs, ["0x123"]), /not an address/i);
  checkThrows("wrong argument count is refused", () => coerceArgs(parseSignature("g(address,uint256)").inputs, ["self"]), /expected 2/i);
  checkThrows("short bytes32 is refused", () => coerceArgs(parseSignature("g(bytes32)").inputs, ["0x1234"]), /32 bytes/i);

  // ── 3. salt scheme ─────────────────────────────────────────────────────────
  log("");
  log(bold("  3. salt derivation"));
  rule();
  check("default namespace", resolveSalt("Foo", {}).salt, id("riftw:v1:Foo"));
  check("explicit namespace", resolveSalt("PrmUSD", { namespace: PREMIA_NS }).salt, id(PREMIA_NS + "PrmUSD"));
  check("text salt is hashed verbatim", resolveSalt("Foo", { salt: "my-salt" }).salt, id("my-salt"));
  check(
    "32-byte hex salt is used as-is",
    resolveSalt("Foo", { salt: "0x" + "11".repeat(32) }).salt,
    "0x" + "11".repeat(32)
  );
  checkThrows("a short hex salt is refused", () => resolveSalt("Foo", { salt: "0x1234" }), /32 bytes/i);

  // ── 4. the PREMIA beta plan, end to end ────────────────────────────────────
  log("");
  log(bold("  4. replay the PREMIA beta deploy plan (artifacts → ctor encoding → CREATE2)"));
  rule();
  if (!fs.existsSync(path.join(PREMIA_CONTRACTS, "out", "PrmUSD.sol", "PrmUSD.json"))) {
    skip("PREMIA addresses reproduce the Base mainnet deploy", `no forge artifacts in ${PREMIA_CONTRACTS}/out`);
  } else {
    const addr: Record<string, string> = {};
    const deploy = (name: string, ctorArgs: unknown[]) => {
      const art = resolveArtifact(name, { artifactDirs: PREMIA_CONTRACTS });
      const values = coerceArgs(art.ctorInputs, ctorArgs);
      const plan = planCreate2(art, values, { namespace: PREMIA_NS });
      addr[name] = plan.address;
      check(`${name} CREATE2 address`, plan.address, PREMIA_EXPECTED[name], `salt ${plan.salt}  initCodeHash ${plan.initCodeHash}`);
    };

    deploy("PrmUSD", [PREMIA_GOV]);
    deploy("CollateralVault", [addr.PrmUSD, PREMIA_GOV, "0.75e18"]);
    deploy("FeeSplitter", [addr.PrmUSD, addr.CollateralVault, PREMIA_GOV]);
    deploy("SettlementKeeper", [PREMIA_GOV, PREMIA_GOV]);
    deploy("PushOracleAdapter", [PREMIA_GOV, PREMIA_REPORTER]);
    deploy("MarketFactory", [
      PREMIA_GOV,
      addr.CollateralVault,
      addr.PushOracleAdapter,
      addr.FeeSplitter,
      addr.SettlementKeeper,
    ]);
  }

  // ── 5. batch planning (offline resolution of the shipped example) ──────────
  log("");
  log(bold("  5. batch file resolution"));
  rule();
  const example = path.join(__dirname, "..", "..", "examples", "premia-beta.batch.json");
  if (!fs.existsSync(example)) {
    skip("example batch file resolves", `${example} not found`);
  } else if (!fs.existsSync(path.join(PREMIA_CONTRACTS, "out", "PrmUSD.sol", "PrmUSD.json"))) {
    skip("example batch file resolves", "PREMIA artifacts not built");
  } else {
    const batch = readBatch(example);
    const vars: Record<string, unknown> = { ...(batch.vars || {}), account: PREMIA_GOV, chainId: 8453, zero: ZeroAddress };
    // The check closures are never invoked here, so a stub RPC is enough for planning.
    const stubRpc = { hasCode: async () => false, call: async () => "0x", url: "stub" } as any;
    const resolvedSteps = batch.steps.map((s) =>
      resolveStep(s, {
        batch,
        baseDir: path.dirname(example),
        vars,
        rpc: stubRpc,
        args: { str: () => undefined, has: () => false, bool: () => false, num: (_n: string, d: number) => d } as any,
        session: null,
      })
    );
    check("every step resolved", resolvedSteps.length, batch.steps.length);
    const deploys = resolvedSteps.filter((s) => s.kind === "deploy");
    check("deploy steps in the example", deploys.length, 6);
    for (const s of deploys) {
      const want = PREMIA_EXPECTED[s.step.id];
      if (want) check(`batch step ${s.step.id} → predicted address`, s.predicted, want);
    }
    const callSteps = resolvedSteps.filter((s) => s.kind === "call");
    // A selector alone is 4 bytes ("0x" + 8 hex), e.g. activate().
    check("call steps carry calldata", callSteps.every((s) => s.data.length >= 10), true);
    check("every call step has a resumability check or is flagged unverifiable", callSteps.every((s) => !!s.check || !!s.step.unverifiable), true);
    check("CREATE2 factory is the target of every deploy step", deploys.every((s) => s.to.toLowerCase() === CREATE2_FACTORY.toLowerCase()), true);
  }

  // ── 6. the pairing handshake, simulated locally ────────────────────────────
  // Run the namespaces riftw proposes through the exact functions the SDK and the Rift wallet
  // use (`isValidRequiredNamespaces` dApp-side, `buildApprovedNamespaces` wallet-side), with
  // the method list copied from smart-wallet/src/walletconnect.ts. Proves the proposal would
  // be accepted without pairing anything.
  log("");
  log(bold("  6. WalletConnect namespace handshake (offline simulation)"));
  rule();
  try {
    const u = require("@walletconnect/utils");
    const CHAIN = "eip155:8453";
    const proposal = {
      requiredNamespaces: { eip155: { chains: [CHAIN], methods: WALLET_METHODS.required, events: [] } },
      optionalNamespaces: {
        eip155: { chains: [CHAIN], methods: WALLET_METHODS.optional, events: ["chainChanged", "accountsChanged"] },
      },
    };
    check("the proposal passes the SDK's own validator", u.isValidRequiredNamespaces(proposal.requiredNamespaces, "connect", "requiredNamespaces"), null);

    // What Rift's WalletConnect handler supports (smart-wallet/src/walletconnect.ts).
    const supportedNamespaces = {
      eip155: {
        chains: [CHAIN],
        methods: [
          "eth_sendTransaction",
          "personal_sign",
          "eth_sign",
          "eth_signTypedData",
          "eth_signTypedData_v3",
          "eth_signTypedData_v4",
          "eth_chainId",
          "eth_accounts",
          "wallet_switchEthereumChain",
        ],
        events: ["chainChanged", "accountsChanged"],
        accounts: [`${CHAIN}:${PREMIA_GOV}`],
      },
    };
    const approved = u.buildApprovedNamespaces({ proposal, supportedNamespaces });
    check("the Rift wallet would approve it", !!approved?.eip155, true);
    check("the approved session can send transactions", approved.eip155.methods.includes("eth_sendTransaction"), true);
    check("the approved session carries the account", approved.eip155.accounts[0], `${CHAIN}:${PREMIA_GOV}`);
    check("--minimal shape is also approvable", (() => {
      const minimal = { requiredNamespaces: proposal.requiredNamespaces, optionalNamespaces: {} };
      const a = u.buildApprovedNamespaces({ proposal: minimal, supportedNamespaces });
      return a.eip155.methods.includes("eth_sendTransaction");
    })(), true);
  } catch (e: any) {
    skip("namespace handshake", `@walletconnect/utils not usable here (${e?.message || e})`);
  }

  // ── summary ────────────────────────────────────────────────────────────────
  log("");
  rule();
  const verdict = failed === 0;
  log(
    `  ${verdict ? green("SELFTEST PASSED") : red("SELFTEST FAILED")}  ${pass} passed · ${failed} failed · ${skipped} skipped`
  );
  rule();
  emit({ ok: verdict, passed: pass, failed, skipped, results });
  if (!verdict) await exit(1);
}

function checkThrows(name: string, fn: () => unknown, pattern: RegExp): void {
  try {
    fn();
    failed++;
    results.push({ name, ok: false, detail: "no error was thrown" });
    log(`  ${red("FAIL")}  ${name} ${dim("— expected an error, got none")}`);
  } catch (e: any) {
    const msg = String(e?.message || e);
    const ok = pattern.test(msg);
    if (ok) pass++;
    else failed++;
    results.push({ name, ok, detail: msg });
    log(`  ${ok ? green("PASS") : red("FAIL")}  ${name}${ok ? dim(`  (${msg.slice(0, 70)})`) : `\n        message: ${msg}`}`);
  }
}
