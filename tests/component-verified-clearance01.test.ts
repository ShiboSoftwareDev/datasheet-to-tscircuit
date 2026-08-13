import { expect, test } from "bun:test"
import { verifiedMinimumPadClearance } from "../src/server/component-workflow/component-footprint-validation"
import type { ExpectedFootprintPad } from "../src/server/job-artifact-validator"

const smtPad = (input: Pick<ExpectedFootprintPad, "x" | "y" | "width" | "height">) => ({
  pin: null,
  kind: "smt" as const,
  ...input,
})

test("component validation retains the normal clearance for ordinary footprints", () => {
  expect(
    verifiedMinimumPadClearance([
      smtPad({ x: -1, y: 0, width: 1, height: 1 }),
      smtPad({ x: 1, y: 0, width: 1, height: 1 }),
    ]),
  ).toBe(0.1)
})

test("component validation honors a smaller clearance from exact verified geometry", () => {
  expect(
    verifiedMinimumPadClearance([
      smtPad({ x: 0, y: 0, width: 1, height: 1.5 }),
      smtPad({ x: 0.85, y: 0, width: 0.6, height: 0.25 }),
    ]),
  ).toBeCloseTo(0.05, 10)
})

test("component validation computes diagonal pad clearance", () => {
  expect(
    verifiedMinimumPadClearance([
      smtPad({ x: 0, y: 0, width: 1, height: 1 }),
      smtPad({ x: 0.6, y: 0.6, width: 0.1, height: 0.1 }),
    ]),
  ).toBeCloseTo(Math.hypot(0.05, 0.05), 10)
})
