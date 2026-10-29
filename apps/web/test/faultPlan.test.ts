import * as fc from "fast-check"
import { describe, expect, it } from "vite-plus/test"
import { describePlan, faultPlan, randomSource } from "../scripts/faultPlan.ts"

describe("faultPlan", () => {
  it("gives the same plan for the same seed, so a failing run replays", () => {
    fc.assert(
      fc.property(fc.nat(), (seed) => {
        expect(faultPlan(seed)).toEqual(faultPlan(seed))
      }),
    )
  })

  it("plans two to four faults at increasing points inside the transfer", () => {
    fc.assert(
      fc.property(fc.nat(), (seed) => {
        const { faults } = faultPlan(seed)
        const points = faults.map((fault) => fault.at)

        expect(faults.length).toBeGreaterThanOrEqual(2)
        expect(faults.length).toBeLessThanOrEqual(4)
        expect(points).toEqual(points.toSorted((left, right) => left - right))
        expect(points.every((point) => point >= 0.05 && point <= 0.9)).toBe(true)
      }),
    )
  })

  it("drops a direct path only in runs that allow one", () => {
    fc.assert(
      fc.property(fc.nat(), (seed) => {
        const plan = faultPlan(seed)

        expect(plan.direct || plan.faults.every(({ fault }) => fault.kind !== "direct-drop")).toBe(true)
      }),
    )
  })

  it("reaches every kind of fault across seeds", () => {
    const kinds = new Set(Array.from({ length: 500 }, (_, seed) => faultPlan(seed).faults.map(({ fault }) => fault.kind)).flat())

    expect([...kinds].toSorted()).toEqual(["blackhole", "cut-clean", "cut-half-open", "direct-drop", "latency", "replay", "stall"])
  })

  it("draws numbers in [0, 1)", () => {
    const random = randomSource(42)
    const draws = Array.from({ length: 10_000 }, random)

    expect(draws.every((draw) => draw >= 0 && draw < 1)).toBe(true)
  })

  it("describes a plan with its seed and one line per fault", () => {
    const plan = faultPlan(7)

    expect(describePlan(plan).split("\n")).toHaveLength(plan.faults.length + 1)
    expect(describePlan(plan)).toContain("seed 7")
  })
})
