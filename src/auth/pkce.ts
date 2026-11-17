/**
 * PKCE (S256) and the OAuth `state`, per Databricks' U2M instructions [9].
 *
 * The verifier is 64 characters of `A-Z a-z 0-9 - _`, inside the standard's 43–128, so it is a valid PKCE verifier
 * (Databricks' own script generates one the same way); the challenge is the base64url SHA-256 of the verifier with the
 * padding stripped. A fresh pair is made for every sign-in, and the state is a fresh 32 random bytes.
 *
 * Neither value is a secret in the sense of a token, but both are compared byte for byte: the state proves the callback
 * belongs to this sign-in, and the verifier proves the code is exchanged by the process that asked for it.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

export interface Pkce {
  readonly verifier: string
  readonly challenge: string
}

export function createPkce(): Pkce {
  const verifier = randomBytes(48).toString("base64url")
  return { verifier, challenge: challengeOf(verifier) }
}

/** The S256 challenge for a verifier: base64url(sha256(verifier)), no padding. */
export function challengeOf(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url")
}

/** A fresh `state`: 32 random bytes, base64url. */
export function createState(): string {
  return randomBytes(32).toString("base64url")
}

/** Constant-time comparison of the callback's state with the one this sign-in issued. */
export function sameState(actual: string, expected: string): boolean {
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}
