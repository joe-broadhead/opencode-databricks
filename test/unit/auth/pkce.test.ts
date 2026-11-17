// PKCE S256 and the OAuth state: the RFC 7636 vector, the verifier's allowed characters, and a constant-time compare.
import { describe, expect, it } from "vitest"
import { challengeOf, createPkce, createState, sameState } from "../../../src/auth/pkce.js"

describe("PKCE", () => {
  it("computes the RFC 7636 S256 challenge for the standard verifier", () => {
    expect(challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
  })

  it("makes a fresh verifier of 43 to 128 characters from the PKCE alphabet, and its challenge", () => {
    const first = createPkce()
    const second = createPkce()
    expect(first.verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/u)
    expect(first.verifier).not.toBe(second.verifier)
    expect(first.challenge).toBe(challengeOf(first.verifier))
    expect(first.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(first.challenge).not.toBe(second.challenge)
  })
})

describe("the OAuth state", () => {
  it("is 32 random bytes and differs on every sign-in", () => {
    expect(createState()).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(createState()).not.toBe(createState())
  })

  it("compares byte for byte", () => {
    const state = createState()
    expect(sameState(state, state)).toBe(true)
    expect(sameState(`${state}x`, state)).toBe(false)
    expect(sameState("", state)).toBe(false)
  })
})
