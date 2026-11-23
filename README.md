# riftw — any contract interaction on Base, signed by your Rift passkey

`riftw` is a WalletConnect **dApp**. Your Rift app is the **wallet**. The CLI builds a transaction,
Rift queues it for your passkey, gas is sponsored and paid in USDC. The CLI holds no private key and
can never broadcast anything on its own.

It is the one-off [`wc-deploy/deploy-wc.js`](../vomma/contracts/script/wc-deploy/README.md) deployer —
the script that put the PREMIA beta stack and Rift's payout vault on Base mainnet — generalised into
a tool: the same CREATE2 mechanics, the same resume-by-reading-chain-state logic, plus a session you
pair **once** instead of per command.

```
npm install          # once (also builds dist/)
npm run build        # after any source change
node bin/riftw.js --help
```

Optional, so you can type `riftw` anywhere:

```bash
npm link                      # then: riftw status
# or, without npm link:
alias riftw='node c:/Users/ADMIN/rift/rift-wallet-cli/bin/riftw.js'
```

Everything is proven offline first:

```
node bin/riftw.js selftest    # 56 checks, no network, nothing signed
```

---

## Commands

| | |
|---|---|
| `riftw connect [--chain base]` | prints a `wc:` link, waits for pairing, **persists the session** |
| `riftw status [--live]` | account, chain, expiry (exit code 1 when not usable) |
| `riftw disconnect [--purge]` | end the session |
| `riftw read <addr> "<fn>" [args…]` | plain `eth_call` — no signing, no session, no gas |
| `riftw call <addr> "<fn>" [args…]` | encode → simulate → preview → passkey → receipt → BaseScan link |
| `riftw send <to> <amount>` | native value transfer (`0.01` means 0.01 ETH) |
| `riftw deploy <artifact> [ctorArgs…]` | CREATE2 deploy through the canonical factory |
| `riftw batch <file.json>` | a whole flow as data: resumable, skips what is already done |
| `riftw selftest` | offline proofs (CREATE2 vs the live payout vault, encoding, pairing shape) |

Flags on every command: `--chain`, `--rpc`, `--json`, `--yes`/`-y`, `--dry-run`, `--expiry <s>`,
`--confirm-timeout <ms>`, `--no-wait`, `--quiet`, `--help`.
`riftw help <command>` has the per-command detail.

---

## The session

```bash
riftw connect
#   PAIR THE RIFT APP — paste this into Rift (WalletConnect → paste / scan)
#   wc:3f9a…@2?relay-protocol=irn&symKey=…
#   (also written to ~/.riftw/last-pairing-uri.txt)
```

Paste it into Rift → WalletConnect → paste/scan. **Rift's own pairing timeout is 30 s**, so paste it
as soon as it prints. After that:

```bash
$ riftw status
  connected
  ──────────────────────────────────────────────
  account    0x8fC19fBc01DD9b9aEEa626c2AE980F710A390da7
  chain      Base (8453)
  wallet     Rift Smart Wallet
  expires    2026-11-29T17:46:17.000Z  (in 6d 23h)
```

What lives where:

```
~/.riftw/session.json       topic, account, chain, expiry   (what `status` reads, offline)
~/.riftw/wc-storage/        the WalletConnect SDK keychain  (what makes the session reusable)
~/.riftw/state/             batch resume state
~/.riftw/last-pairing-uri.txt
~/.riftw/config.json        optional: {"walletconnectProjectId": "…"} or {"envFile": "…"}
```

A Rift session is bound to **one chain**. To switch: `riftw disconnect` then
`riftw connect --chain <other>`. If a session ever gets wedged, `riftw disconnect --purge` clears the
SDK store too.

`WALLETCONNECT_PROJECT_ID` is read at runtime — from the environment, from `~/.riftw/config.json`, or
from `c:/Users/ADMIN/rift/smart-wallet/.env` — handed to the WalletConnect SDK, and **never printed,
logged or copied anywhere**.

---

## Reading (no session needed)

```bash
$ riftw read 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 "symbol() view returns (string)"
    out1             string       USDC

$ riftw read 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
      "balanceOf(address) view returns (uint256)" 0x8fC19fBc01DD9b9aEEa626c2AE980F710A390da7
    out1             uint256      311,373

# live PREMIA beta on Base
$ riftw read 0xf9CFf47DE2E6bEAA5F32Cf2090E35aC3B829c3A8 \
      "marketOf(bytes32) view returns (address)" keccak:PREMIA.NG.USDT.PREMIUM.V1
    out1             address      0xa2F5e7CE731b1ed1e7bc0501eAEF451685AA3dE7
```

Leave out `returns (…)` and you get the raw bytes plus a clearly-labelled guess.
`self` (or `me`) in any address argument means the connected account.

## Calling

```bash
# 10 USDC, 6 decimals — "10@6" is 10 * 10^6
riftw call 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
      "transfer(address,uint256)" 0x3400d7aD28AdBbc3918f190C2034d1ED912BeC63 10@6
```

Every write prints a dry-run preview and waits for a `y` (or `--yes`):

```
  DRY RUN — transfer(address,uint256) → 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
  ──────────────────────────────────────────────────────────────────────────────
  chain      Base (8453)   https://mainnet.base.org
  from       0x8fC19fBc01DD9b9aEEa626c2AE980F710A390da7 — Rift smart account, signs with your passkey
  to         0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913  https://basescan.org/address/0x8335…
  function   transfer(address,uint256)
  args
     1. arg1             address      0x3400d7aD28AdBbc3918f190C2034d1ED912BeC63
     2. arg2             uint256      10,000,000 ≈ 10 @6 · 0.00000000001 @18
  value      0 ETH
  calldata   0xa9059cbb000000000000…00000000000000989680 (68 bytes)
  gas        sponsored by Rift — paid in USDC, no ETH needed
  Send it? [y/N]
```

The call is simulated with `eth_call` first, so a revert is caught **before** you touch your passkey:

```
  error the call reverts when simulated from 0x8fC1…: eth_call reverted: ERC20: transfer amount exceeds balance
  hint  fix the arguments, or pass --force to send it anyway (--no-simulate skips the check)
```

`--dry-run` previews with **no session at all** (add `--from 0x…` to simulate as your wallet), which is
the fastest way to check an encoding before pairing.

Also useful: `--value 0.01` for payable functions, `--data 0x…` for raw calldata,
`--no-wait` to skip receipt polling, `--json` for scripting.

## Arguments

Coerced against the signature's types, so you type what you mean:

| type | accepted |
|---|---|
| `address` | `0xabc…`, `self` / `me`, `zero` |
| `uint*` / `int*` | `1000000`, `1_000_000`, `0x0f`, `1e18`, `1.5e6`, `1ether`, `25gwei`, `100@6` (6-decimal token), `max` |
| `bool` | `true`/`false`, `1`/`0`, `yes`/`no` |
| `bytes`, `bytesN` | `0x…`, `str:hello`, `keccak:PREMIA.NG.USDT.PREMIUM.V1` (a `bytes32`) |
| arrays | `"[1,2,3]"`, `"0xa,0xb"`, JSON |
| tuples | `"[7,true]"`, `'{"mu":"0.03e18","tau":30}'` (by component name) |

A decimal without a scale is refused rather than guessed:

```
  error arg2: "1.5" has decimals but uint256 is an integer
  hint  say how to scale it: 1.5e18 · 1.5ether · 1.5@6 (6-decimal token) · or pass the raw integer
```

## Sending value

```bash
riftw send 0x3400d7aD28AdBbc3918f190C2034d1ED912BeC63 0.001     # 0.001 ETH
riftw send 0xdead… 25gwei                                       # explicit units are literal
```

---

## Deploying (CREATE2)

A Rift wallet is an ERC-4337 smart account: it executes calls, it cannot do a raw `CREATE`. So every
contract creation is **one** transaction to the canonical deterministic-deployment proxy:

```
to   = 0x4e59b44847b379578588920cA78FbF26c0B4956C
data = <32-byte salt> ++ <creation bytecode ++ abi.encode(ctor args)>

address = keccak256(0xff ++ factory ++ salt ++ keccak256(initCode))[12:]
```

The address does not depend on the caller, so it is known **before** anything is signed — which is
what lets a later contract take an earlier one as a constructor argument, and what makes re-running
safe (a deploy whose predicted address already has code is a no-op).

```bash
$ riftw deploy PrmUSD 0x8fC19fBc01DD9b9aEEa626c2AE980F710A390da7 \
      --artifacts c:/Users/ADMIN/rift/vomma/contracts \
      --salt-namespace "premia-beta-v1:" --dry-run

  CREATE2 deploy — PrmUSD
  artifact   …\vomma\contracts\out\PrmUSD.sol\PrmUSD.json
  bytecode   4,431 bytes
  ctor       (address)
  already deployed at 0x7152280AfE7493d84533565Cd5c79B5d4B4EC4CB
  same salt + same init code ⇒ same address. Nothing to send.
```

With a salt that has not been used:

```
  salt       0x42e7…fab9  keccak256("riftw-smoke-test-2026-11-22")
  init code  4,463 bytes   hash 0xbecd0edb…82b2
  predicted  0x31C87E2234F5DE20628860c398Ba521086A6D7b3
  note       gas estimate 909,318
```

Salt rules:

| flag | salt |
|---|---|
| `--salt 0x<64 hex>` | used verbatim |
| `--salt "<text>"` | `keccak256(text)` |
| `--salt-namespace "ns:"` | `keccak256("ns:" + ContractName)` |
| *(neither)* | `keccak256("riftw:v1:" + ContractName)` |

The artifact can be a path (`…/out/Foo.sol/Foo.json`, foundry or hardhat), a bare contract name
(searched under `--artifacts`, `RIFTW_ARTIFACTS`, then the cwd), `Foo.sol:Foo`, or raw `0x…` creation
bytecode with `--ctor-types "address,uint256"`. Unlinked library placeholders (`__$…$__`) are
refused rather than deployed. `--save <file.json>` writes a reproducible record (salt, initCodeHash,
exact calldata) in the same shape as `smart-wallet/contracts/vault-deploy.json`.

---

## Batch: a whole flow as data

`riftw batch` is the deploy script's entire structure expressed as JSON. Each step carries a `check`
that says when it is **already satisfied** — for deploys that check is implicit ("is there code at
the predicted address?"). A run therefore reads chain state, skips what is done, sends the rest and
verifies each effect. Reject a prompt, close the app, lose the shell: re-run the same command.

```bash
riftw batch examples/premia-beta.batch.json --plan    # resolve + read chain state, send nothing
riftw batch examples/premia-beta.batch.json           # preview + confirm, then step by step
riftw batch examples/premia-beta.batch.json --only activate
```

### Reproducing the PREMIA beta deploy

[`examples/premia-beta.batch.json`](examples/premia-beta.batch.json) is the full 20-transaction PREMIA
beta rollout — the one that went to Base mainnet on 2026-11-22 — as data. Planned against live Base
today it reports what is already there:

```
$ riftw batch examples/premia-beta.batch.json --plan

  BATCH premia-beta — Base (8453)
   1. [done] PrmUSD  deploy PrmUSD
         to 0x4e59b44847b379578588920cA78FbF26c0B4956C  calldata 4,495 B  → 0x7152280AfE7493d84533565Cd5c79B5d4B4EC4CB
   2. [done] CollateralVault  deploy CollateralVault
         …                                              calldata 7,240 B  → 0x127048434EfD4ac79e5E4ff41E1c6e3d5Fd0279A
   6. [done] MarketFactory  deploy MarketFactory
         …                                              calldata 22,181 B → 0xf9CFf47DE2E6bEAA5F32Cf2090E35aC3B829c3A8
   9. [done] vault-setFactory  lets the factory call registerMarket
         check factory() view returns (address) == $MarketFactory @$CollateralVault
  16. [calc] market  the PerpMarket address — plain CREATE from the factory, so nonce-derived
         check marketOf(bytes32) view returns (address)($marketId) == $market @$MarketFactory
  21. [todo] activate  activate() — comes up FROZEN until the first oracle push
         check none — idempotent setter, recorded in the state file only
  ──────────────────────────────────────────────────────────────────────────────
  19 already satisfied · 1 to send
```

All six CREATE2 addresses match the live deploy, and step 16 derives the PerpMarket at
`0xa2F5e7CE731b1ed1e7bc0501eAEF451685AA3dE7` — which is what `MarketFactory.marketOf()` returns on
chain. `activate()` shows `todo` because `_activated` has no getter and `state()` is `Frozen` from the
constructor, so nothing on chain distinguishes activated from dormant; `activate()` carries no
already-activated guard, so re-sending it is harmless. (The original script looked for the
`Activated()` event instead.)

To deploy a *fresh* stack, change `saltNamespace` (every address moves) and run without `--plan`.

### Step shapes

```jsonc
{
  "name": "premia-beta",
  "chain": "base",
  "artifacts": "../../vomma/contracts",     // relative to this file
  "saltNamespace": "premia-beta-v1:",
  "vars": { "gov": "0x8fC1…", "marketId": "keccak:PREMIA.NG.USDT.PREMIUM.V1", "kWad": "500000e18" },
  "steps": [
    // CREATE2 deploy — its id becomes a variable holding the predicted address
    { "id": "PrmUSD", "deploy": "PrmUSD", "args": ["$gov"] },

    // a contract call, with the read that proves it already happened
    { "id": "allow-vault", "call": "setProtocol(address,bool)", "to": "$PrmUSD",
      "args": ["$CollateralVault", true],
      "check": { "to": "$PrmUSD", "fn": "isProtocol(address) view returns (bool)",
                 "args": ["$CollateralVault"], "equals": true } },

    // two ways a step can be "already done" (minted, or already pushed into the vault)
    { "id": "mint-seed", "call": "mint(address,uint256)", "to": "$PrmUSD", "args": ["$gov", "$seedUsdc"],
      "check": { "any": [
        { "to": "$PrmUSD", "fn": "balanceOf(address) view returns (uint256)", "args": ["$gov"], "gte": "$seedUsdc" },
        { "to": "$CollateralVault", "fn": "providedCapital(address) view returns (uint256)", "args": ["$gov"], "gte": "$seedWad" }
      ] } },

    // the address of a contract a factory creates with plain CREATE (nonce-derived)
    { "id": "market", "derive": { "create": { "from": "$MarketFactory", "nonce": 1 } } },

    // a step with nothing to read back
    { "id": "activate", "call": "activate()", "to": "$market", "unverifiable": true },

    // value transfer, and raw calldata
    { "id": "tip", "send": "$gov", "value": "0.001" },
    { "id": "whatever", "raw": "0xdeadbeef", "to": "$PrmUSD" }
  ]
}
```

- `$name` resolves from `vars`, from a deploy/derive step's id, and from the builtins `$account`,
  `$chainId`, `$zero`. `${name}` interpolates inside a longer string.
- `check` supports `equals`, `notEquals`, `gte`, `nonZero`, `hasCode`, and `any` / `all` to combine
  them. Numbers in a check use the same syntax as arguments (`500000e18`, `100@6`, `max`).
- A step with no check must say `"unverifiable": true`; then only the state file records it.
- State lives in `~/.riftw/state/<name>.<chainId>.json` (`--state <path>` to move it).
- `// comments` are allowed in batch files.
- `--plan` needs no session; add `--account 0x…` if the file references `$account`.

---

## What `selftest` proves

```
$ node bin/riftw.js selftest
  1. CREATE2 maths vs the live Rift payout vault
  PASS  CREATE2 factory is the canonical proxy
  PASS  initCodeHash matches vault-deploy.json
  PASS  predicted address == the live payout vault
        keccak256(0xff ++ factory ++ salt ++ keccak256(initCode))[12:] → 0x3400d7aD28AdBbc3918f190C2034d1ED912BeC63
  2. argument parsing and ABI encoding          (units, selectors, byte-exact calldata, refusals)
  3. salt derivation
  4. replay the PREMIA beta deploy plan         (all 6 addresses == the Base mainnet deploy)
  5. batch file resolution
  6. WalletConnect namespace handshake          (offline: the Rift wallet would approve the proposal)
  SELFTEST PASSED  56 passed · 0 failed · 0 skipped
```

Test 1 is the anchor: it takes the real salt and init code out of
`smart-wallet/contracts/vault-deploy.json` and reproduces the **live** payout vault
`0x3400d7aD28AdBbc3918f190C2034d1ED912BeC63`. Test 4 is the end-to-end one: artifact loading →
constructor encoding → salt → CREATE2 must reproduce all six PREMIA addresses that the original
script put on mainnet. Test 6 runs the namespaces `riftw connect` proposes through WalletConnect's own
validator and through `buildApprovedNamespaces` with Rift's supported method list, so the pairing
handshake is checked without pairing.

---

## Chains

`base` (default, 8453), `ethereum`, `polygon`, `celo`, `arbitrum`, `avalanche`, `bsc`, `berachain` —
the set Rift's smart wallet supports. `--chain <key|id>`, `--rpc <url>` to override the endpoint
(`RIFTW_RPC_URL`, or `<PREFIX>_RPC_URL` like `BASE_RPC_URL`, work too). Public RPCs rate-limit; pass
your own endpoint for long batches.

## Scripting

`--json` puts exactly one JSON document on stdout; all progress text moves to stderr.

```bash
riftw read 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 "decimals() view returns (uint8)" --json \
  | jq -r '.result[0]'
# 6

riftw batch examples/premia-beta.batch.json --plan --json | jq '.steps[] | select(.status=="todo")'
```

In `--json` mode a write needs `--yes`: there is no way to prompt without corrupting stdout.
Exit codes: `0` success, `1` error / not connected / aborted / not confirmed, `2` unknown command.

## Errors you should expect to see

| | |
|---|---|
| `NOT_CONNECTED` | no session → `riftw connect` |
| `SESSION_EXPIRED` / `SESSION_GONE` | the session or the SDK store is stale → `riftw connect` |
| `WRONG_CHAIN` | `--chain` disagrees with the session (Rift binds one chain per session) |
| `USER_REJECTED` | rejected in the Rift app — nothing was sent |
| `REQUEST_EXPIRED` | not approved inside the signing window → raise `--expiry` |
| `SIMULATION_REVERTED` | `eth_call` says it would revert → fix the args, or `--force` |
| `TX_REVERTED` | it reverted on chain; the BaseScan link is printed |
| not confirmed in time | Rift returned a userOp hash before the bundler surfaced a tx hash — check the app, then re-run (deploys and checked batch steps skip themselves once the effect is visible) |

## Debugging

```bash
RIFTW_DEBUG=1 riftw …    # stack traces + WalletConnect SDK logs
RIFTW_HOME=…             # move ~/.riftw (useful for a second wallet)
RIFTW_ARTIFACTS=…        # default artifact search path(s), ';' separated
RIFTW_EXPIRY=3600        # default signing window
```

## Layout

```
bin/riftw.js              launcher (requires dist/)
src/index.ts              dispatch, error rendering, exit codes
src/help.ts               --help text
src/wc.ts                 WalletConnect dApp side + the persistent store
src/tx.ts                 preview → confirm → send → verify (shared by every write)
src/abi.ts                signatures, argument coercion, encode/decode, formatting
src/create2.ts            salts, init code, address prediction, the factory call
src/artifacts.ts          foundry/hardhat artifact resolution
src/rpc.ts                eth_call, code checks, receipts, revert decoding
src/chains.ts             chain + explorer registry
src/config.ts             ~/.riftw, session store, project-id loading
src/context.ts            flags → chain/rpc/session
src/commands/             session.ts · interact.ts · deploy.ts · batch.ts · selftest.ts
examples/                 premia-beta.batch.json · usdc-approve-transfer.batch.json
```
