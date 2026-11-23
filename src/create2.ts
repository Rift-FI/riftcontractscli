/**
 * CREATE2 deploys through the canonical deterministic-deployment proxy.
 *
 * A Rift wallet is an ERC-4337 smart account: it executes calls, it cannot do a raw CREATE.
 * So a contract creation is ONE ordinary transaction:
 *
 *   to   = 0x4e59b44847b379578588920cA78FbF26c0B4956C   (same address on every chain)
 *   data = <32-byte salt> ++ <creation bytecode ++ abi.encode(constructor args)>
 *
 * The address is caller-independent, so it is known before anything is signed:
 *
 *   address = keccak256(0xff ++ factory ++ salt ++ keccak256(initCode))[12:]
 *
 * That is what makes a multi-contract deploy both predictable (later constructors can take
 * earlier addresses) and idempotent (re-running skips whatever already has code).
 */

import { concat, getAddress, getCreate2Address, id, isHexString, keccak256 } from "ethers";
import { encodeConstructor } from "./abi";
import type { Artifact } from "./artifacts";
import { fail } from "./util";

export const CREATE2_FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

/** Default salt namespace, so `riftw deploy Foo` is reproducible without extra flags. */
export const DEFAULT_SALT_NAMESPACE = "riftw:v1:";

export interface Create2Plan {
  name: string;
  salt: string;
  saltSource: string;
  initCode: string;
  initCodeHash: string;
  address: string;
  factory: string;
  tx: { to: string; data: string };
}

/**
 * Salt resolution:
 *   --salt 0x<64 hex>        used verbatim
 *   --salt "<text>"          keccak256(text)                       ← exact, no namespace
 *   --salt-namespace "ns:"   keccak256("ns:" + <contract name>)
 *   (neither)                keccak256("riftw:v1:" + <contract name>)
 */
export function resolveSalt(name: string, opts: { salt?: string; namespace?: string }): { salt: string; source: string } {
  if (opts.salt) {
    if (isHexString(opts.salt, 32)) return { salt: opts.salt.toLowerCase(), source: "--salt (raw 32 bytes)" };
    if (isHexString(opts.salt)) {
      fail("BAD_SALT", `--salt ${opts.salt} is hex but not 32 bytes`, "pass a full 32-byte 0x… salt, or a text label to hash");
    }
    return { salt: id(opts.salt), source: `keccak256("${opts.salt}")` };
  }
  const ns = opts.namespace !== undefined ? opts.namespace : DEFAULT_SALT_NAMESPACE;
  return { salt: id(ns + name), source: `keccak256("${ns}${name}")` };
}

export function buildInitCode(art: Artifact, ctorValues: unknown[]): string {
  if (art.ctorInputs.length !== ctorValues.length) {
    fail(
      "BAD_ARGS",
      `${art.name}: constructor expects ${art.ctorInputs.length} argument(s) (${art.ctorInputs.map((i) => i.type).join(", ") || "none"}), got ${ctorValues.length}`
    );
  }
  const encoded = encodeConstructor(art.ctorInputs, ctorValues);
  return encoded === "0x" ? art.bytecode : concat([art.bytecode, encoded]);
}

export function predictAddress(factory: string, salt: string, initCode: string): string {
  return getCreate2Address(getAddress(factory), salt, keccak256(initCode));
}

export function planCreate2(
  art: Artifact,
  ctorValues: unknown[],
  opts: { salt?: string; namespace?: string; factory?: string }
): Create2Plan {
  const factory = getAddress(opts.factory || CREATE2_FACTORY);
  const { salt, source } = resolveSalt(art.name, opts);
  const initCode = buildInitCode(art, ctorValues);
  const initCodeHash = keccak256(initCode);
  const address = predictAddress(factory, salt, initCode);
  return {
    name: art.name,
    salt,
    saltSource: source,
    initCode,
    initCodeHash,
    address,
    factory,
    tx: { to: factory, data: concat([salt, initCode]) },
  };
}
