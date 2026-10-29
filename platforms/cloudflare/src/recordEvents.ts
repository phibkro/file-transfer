/**
 * Sends events to the instance's counters Durable Object when the operator has turned counting on, and does nothing
 * otherwise (docs/decisions/0019-open-source-first.md). Failures to count never fail a transfer.
 */
import type { DurableObjectNamespace } from "cloudflare:workers"
import type { TelemetryEvent } from "@file-transfer/service-telemetry"
import { countersEnabled } from "./counters.ts"
import type { CounterVariables } from "./counters.ts"

export interface CountingEnvironment extends CounterVariables {
  readonly COUNTER_STORE: DurableObjectNamespace
}

/** The one counters object of an instance. */
export const counterStore = (environment: CountingEnvironment) => environment.COUNTER_STORE.get(environment.COUNTER_STORE.idFromName("counters"))

export const recordEvents = async (environment: CountingEnvironment, events: readonly TelemetryEvent[]): Promise<void> => {
  if (!countersEnabled(environment) || events.length === 0) {
    return
  }

  try {
    await counterStore(environment).fetch("https://counters/record", { method: "POST", body: JSON.stringify({ events }) })
  } catch {
    // Counting is best effort.
  }
}
