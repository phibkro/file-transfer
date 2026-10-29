/**
 * Calls into the instance's relay budget object (relayBudgetObject.ts) from the Worker and from rooms. Unreachable
 * budget objects and malformed answers count as "not reached": the budget protects a quota, and failing open costs at
 * most what one report step relays.
 */
import type { DurableObjectNamespace } from "cloudflare:workers"
import { withOneRetry } from "./durableObjectCalls.ts"
import { decodeBudgetAnswer } from "./relayBudget.ts"
import type { BudgetAnswer } from "./relayBudget.ts"

export interface BudgetEnvironment {
  readonly RELAY_BUDGET: DurableObjectNamespace
}

const notReached: BudgetAnswer = { budgetReached: false, retryAfterMilliseconds: 0 }

/** Reports `bytes` more relayed (0 only asks) and returns whether today's budget is reached. */
export const askRelayBudget = async (environment: BudgetEnvironment, bytes: number, budgetBytes: number): Promise<BudgetAnswer> => {
  const body = JSON.stringify({ bytes, budgetBytes })

  const answer = await withOneRetry(
    async () =>
      await environment.RELAY_BUDGET.get(environment.RELAY_BUDGET.idFromName("relay-budget")).fetch("https://budget/report", { method: "POST", body }),
  )

  if (!answer.reached || answer.value.status !== 200) {
    return notReached
  }

  return decodeBudgetAnswer(await answer.value.json().catch(() => undefined)) ?? notReached
}
