import { expect, test } from "bun:test"
import type { ModelCircuitPreview } from "@/shared/job-types"
import { getRunframeCircuitJson } from "@/web/components/model-live-preview"

const previous_circuit_json: NonNullable<ModelCircuitPreview["circuit_json"]> = []
const live_circuit_json: NonNullable<ModelCircuitPreview["circuit_json"]> = []

test("the code tab keeps a stable Circuit JSON reference while live previews update", () => {
  expect(getRunframeCircuitJson("code", live_circuit_json, previous_circuit_json)).toBe(previous_circuit_json)
  expect(getRunframeCircuitJson("analog_simulation", live_circuit_json, previous_circuit_json)).toBe(
    live_circuit_json,
  )
  expect(getRunframeCircuitJson("schematic", live_circuit_json, previous_circuit_json)).toBe(
    live_circuit_json,
  )
})

test("the code tab uses live Circuit JSON until it has captured a snapshot", () => {
  expect(
    getRunframeCircuitJson("code", live_circuit_json as ModelCircuitPreview["circuit_json"], undefined),
  ).toBe(live_circuit_json)
})
