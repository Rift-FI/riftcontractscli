import { chainKeys } from "./chains";
import { bold, cyan, dim, log } from "./util";

const GLOBAL = `
  ${bold("riftw")} — any smart-contract interaction on Base, signed by your Rift passkey wallet

  ${dim("riftw is a WalletConnect dApp. Your Rift app is the wallet. riftw never holds a key:")}
  ${dim("it builds a transaction, you approve it with your passkey, Rift sponsors the gas (USDC).")}

  ${bold("SESSION")}
    riftw connect [--chain base]        pair once: prints a wc: link, then persists the session
    riftw status [--live]               connected account, chain, expiry
    riftw disconnect [--purge]          end the session

  ${bold("COMMANDS")}
    riftw read <addr> "<fn>" [args…]    eth_call — no signing, no session needed
    riftw call <addr> "<fn>" [args…]    encode + send, wait for the receipt, print the link
    riftw send <to> <amount>            native value transfer (amount in ETH, e.g. 0.01)
    riftw deploy <artifact> [ctorArgs…] CREATE2 deploy via the canonical factory
    riftw batch <file.json>             run a list of steps; resumable, skips what is already done
    riftw selftest                      offline proofs (CREATE2 vs the live payout vault, encoding)

  ${bold("EVERY COMMAND")}
    --chain <${chainKeys().slice(0, 3).join("|")}|…>   default base          --rpc <url>
    --json                 one JSON document on stdout        --yes, -y   skip the confirmation
    --dry-run              preview only, never sends (works with no session)
    --expiry <s>           signing window, 300…604800 (default 1800)
    --confirm-timeout <ms> how long to wait for the on-chain effect (default 300000)
    --no-wait              do not wait for the receipt          --quiet, -q
    --help, -h             this, or \`riftw help <command>\`

  ${bold("ARGUMENTS")} ${dim("(coerced against the signature's types)")}
    address   0xabc…  ·  self / me  ·  zero
    uint/int  1000000 · 1_000_000 · 0x0f · 1e18 · 1.5e6 · 1ether · 25gwei · 100@6 ${dim("(USDC)")} · max
    bool      true · false · 1 · 0 · yes · no
    bytes     0x…  ·  str:hello  ·  keccak:PREMIA.NG.USDT.PREMIUM.V1 ${dim("(bytes32)")}
    arrays    "[1,2,3]"  ·  "0xa,0xb"  ·  JSON
    tuples    "[7,true]"  ·  '{"a":7,"b":true}'

  ${bold("EXAMPLES")}
    ${cyan('riftw read 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 "balanceOf(address) view returns (uint256)" self')}
    ${cyan('riftw call 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 "transfer(address,uint256)" 0xdead… 10@6')}
    ${cyan("riftw deploy PrmUSD 0x8fC19fBc01DD9b9aEEa626c2AE980F710A390da7 --salt-namespace premia-beta-v1:")}
    ${cyan("riftw batch examples/premia-beta.batch.json --plan")}

  ${dim("Secrets: WALLETCONNECT_PROJECT_ID is read at runtime and never printed. Session state lives")}
  ${dim("in ~/.riftw (session.json + the WalletConnect keychain).")}
`;

const PER_COMMAND: Record<string, string> = {
  connect: `
  ${bold("riftw connect")} [--chain base] [--force] [--minimal] [--pair-timeout 300]

  Prints a \`wc:\` URI (also written to ~/.riftw/last-pairing-uri.txt). Paste it into Rift →
  WalletConnect → paste/scan. Rift's own pairing timeout is 30s, so paste it promptly.
  The session is then persisted, so later commands need no pairing.

    --force          drop an existing session and pair again
    --minimal        request only eth_sendTransaction (fallback if a richer request is refused)
    --pair-timeout   seconds to wait for the wallet (default 300)

  ${dim("A Rift session is bound to ONE chain. To switch: disconnect, then connect --chain <other>.")}
`,
  status: `
  ${bold("riftw status")} [--live] [--json]

  Offline by default: reads ~/.riftw/session.json and prints account, chain, expiry.
  --live also opens the WalletConnect store and confirms the session is still there.
  Exit code 1 when not connected or expired, so scripts can branch on it.
`,
  disconnect: `
  ${bold("riftw disconnect")} [--purge]

  Tells the wallet to end the session and clears the local record.
  --purge also deletes ~/.riftw/wc-storage (the SDK keychain) — use it if a session is wedged.
`,
  read: `
  ${bold("riftw read")} <address> "<fnSignature>" [args…] [--from 0x…] [--block latest]

  A plain eth_call. No session, no signing, no gas.
  Give return types for a typed decode:

    ${cyan('riftw read 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 "decimals() view returns (uint8)"')}
    ${cyan('riftw read 0x4200000000000000000000000000000000000006 "balanceOf(address) view returns (uint256)" self')}

  Without a \`returns (…)\` clause you get the raw bytes plus a labelled guess.
`,
  call: `
  ${bold("riftw call")} <address> "<fnSignature>" [args…] [--value 0.01] [--data 0x…]

  Encodes the call, simulates it with eth_call, shows a dry-run preview, asks for confirmation,
  then queues it in Rift for passkey approval and waits for the receipt.

    --value <amount>   payable calls (amount in ETH: 0.01, or 25gwei / 1e18 for literals)
    --data 0x…         send raw calldata instead of a signature
    --no-simulate      skip the pre-flight eth_call
    --force            send even though the simulation reverts
    --dry-run          preview and stop (no session needed)

    ${cyan('riftw call 0xToken "approve(address,uint256)" 0xSpender max')}
    ${cyan('riftw call 0xVault "setClusterCap(uint16,uint256)" 1 0.6e18 --yes')}
`,
  send: `
  ${bold("riftw send")} <to> <amount>

  A native value transfer. The amount is in the chain's currency: "0.01" is 0.01 ETH.
  Explicit units are taken literally: 25gwei, 1e18 (wei), 1000wei, 0x16345785d8a0000.

    ${cyan("riftw send 0xdead… 0.001")}
`,
  deploy: `
  ${bold("riftw deploy")} <artifactPathOrName> [ctorArgs…]

  One transaction to the canonical CREATE2 factory 0x4e59b44847b379578588920cA78FbF26c0B4956C,
  with calldata = <32-byte salt> ++ <creation bytecode ++ encoded ctor args>. A smart account
  cannot do a raw CREATE, and CREATE2 makes the address known before anything is signed.

    --salt 0x<64hex>          use this salt verbatim
    --salt "<text>"           salt = keccak256(text)
    --salt-namespace "<ns:>"  salt = keccak256(ns + contractName)   ${dim('default "riftw:v1:"')}
    --factory 0x…             a different CREATE2 factory
    --artifacts <dirs>        where to look for the artifact (';' separated)
    --ctor-types "address,uint256"   constructor types, for raw bytecode or an ABI-less artifact
    --save <file.json>        write a reproducible deploy record (salt, initCodeHash, calldata)

  The artifact can be a path (…/out/Foo.sol/Foo.json), a bare name (searched under --artifacts,
  RIFTW_ARTIFACTS and the cwd), Foo.sol:Foo, or raw 0x… creation bytecode.
  A deploy whose predicted address already has code is a no-op: re-running is always safe.

    ${cyan("riftw deploy PrmUSD 0x8fC19fBc01DD9b9aEEa626c2AE980F710A390da7 \\")}
    ${cyan('      --artifacts c:/Users/ADMIN/rift/vomma/contracts --salt-namespace "premia-beta-v1:" --dry-run')}
`,
  batch: `
  ${bold("riftw batch")} <file.json> [--plan] [--only id1,id2] [--state <path>]

  A whole flow as data. Each step is deploy / call / send / raw / derive, and carries a \`check\`
  that says when it is already satisfied — so the run skips what is done and resumes after a
  rejection, a timeout or a closed laptop. Deploy addresses are CREATE2, hence known up front,
  which is why a later step can take an earlier contract's address as an argument.

    --plan      resolve and print the whole plan, read chain state, send nothing (no pairing)
    --only      run just these step ids
    --state     state file (default ~/.riftw/state/<name>.<chainId>.json)
    --account   the wallet address to plan against, when not connected yet (--plan only)

    ${cyan("riftw batch examples/premia-beta.batch.json --plan")}
    ${cyan("riftw batch examples/premia-beta.batch.json --yes")}

  Step shape:

    { "id": "PrmUSD", "deploy": "PrmUSD", "args": ["$gov"] }
    { "id": "allow", "call": "setProtocol(address,bool)", "to": "$PrmUSD", "args": ["$vault", true],
      "check": { "to": "$PrmUSD", "fn": "isProtocol(address) view returns (bool)",
                 "args": ["$vault"], "equals": true } }
    { "id": "market", "derive": { "create": { "from": "$MarketFactory", "nonce": 1 } } }

  \`$name\` resolves from "vars", from a deploy step's id (its CREATE2 address), \`$account\`,
  \`$chainId\` and \`$zero\`. Checks support equals / notEquals / gte / nonZero / hasCode, and
  any / all to combine them. A step with no check needs "unverifiable": true, and then only the
  state file records it.
`,
  selftest: `
  ${bold("riftw selftest")} [--json]

  Offline. Proves the CREATE2 maths by reproducing the LIVE Rift payout vault
  (0x3400d7aD28AdBbc3918f190C2034d1ED912BeC63) from smart-wallet/contracts/vault-deploy.json,
  replays the PREMIA beta plan through this CLI's own artifact/encoding/salt path and compares
  all six addresses with the real Base mainnet deploy, and checks argument coercion end to end.
`,
};

export function printHelp(topic?: string): void {
  if (topic && PER_COMMAND[topic]) {
    log(PER_COMMAND[topic]);
    return;
  }
  if (topic) log(dim(`  (no help topic "${topic}")`));
  log(GLOBAL);
}
