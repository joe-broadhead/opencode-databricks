/**
 * The plugin's account wiring (contract §5): the profile schema and the credential setup live in `src/auth/`, and this
 * entry is what `src/index.ts` calls. The integration per alias is registered through the contract's `accounts` module.
 */
export { createAuth, type AuthSetup, type CreateAuthInput } from "./auth/index.js"
export { accountSettings, settingsOf, type AccountSettings } from "./auth/accounts.js"
