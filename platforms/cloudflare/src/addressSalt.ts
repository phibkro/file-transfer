/**
 * The salt mixed into client keys (worker.ts): the operator's `ADDRESS_SALT` when set, otherwise the one the
 * instance generated and keeps in its address salt object (addressSaltObject.ts). Each isolate asks once and keeps
 * the answer in memory; it caches the string, not a promise, so no request awaits I/O another request started.
 */
import type { DurableObjectNamespace } from "cloudflare:workers"
import { withOneRetry } from "./durableObjectCalls.ts"
import { decodeSaltAnswer } from "./salt.ts"

export interface SaltEnvironment {
  /** Optional: a salt the operator chose; the generated one is used when this is unset or empty. */
  readonly ADDRESS_SALT?: string
  readonly ADDRESS_SALT_STORE: DurableObjectNamespace
}

let generated: string | undefined

/** The instance's address salt, or undefined when the salt object could not be reached. */
export const addressSaltOf = async (environment: SaltEnvironment): Promise<string | undefined> => {
  if (environment.ADDRESS_SALT !== undefined && environment.ADDRESS_SALT !== "") {
    return environment.ADDRESS_SALT
  }

  if (generated !== undefined) {
    return generated
  }

  const answer = await withOneRetry(
    async () => await environment.ADDRESS_SALT_STORE.get(environment.ADDRESS_SALT_STORE.idFromName("address-salt")).fetch("https://salt/salt"),
  )

  if (!answer.reached || answer.value.status !== 200) {
    return undefined
  }

  generated = decodeSaltAnswer(await answer.value.json().catch(() => undefined))

  return generated
}
