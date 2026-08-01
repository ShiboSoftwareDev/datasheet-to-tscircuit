import { describe, expect, test } from "bun:test"
import { compileApplicationFixtureContract } from "../src/server/modeling"
import type { ApplicationFixtureContract } from "../src/server/modeling/application-fixture-contract"
import type { ModelInterface } from "../src/server/modeling/types"
import {
  eligibleObservedGraphs,
  parseReferenceGraphObservation,
} from "../src/server/model-workflow/reference-graph-observation"
import {
  deriveTimeGraphLocalConditionReceipt,
  findLikelyTimeGraphCandidates,
  parseTimeGraphDiscovery,
  type TimeGraphDiscovery,
} from "../src/server/model-workflow/time-graph-hints"

const SOURCE_PDF_SHA256 = "a".repeat(64)
const SOURCE_PLAN_SHA256 = "1".repeat(64)

const model_interface: ModelInterface = {
  version: 1,
  part_number: "TEST-CONVERTER",
  entry_name: "TEST_CONVERTER",
  pins: [
    { spice_node: "VIN", role: "power_input" },
    { spice_node: "SW", role: "passive" },
    { spice_node: "VOUT", role: "power_output" },
    { spice_node: "GND", role: "ground" },
  ].map(({ spice_node, role }, index) => ({
    physical_pin: String(index + 1),
    component_pin: `pin${index + 1}`,
    source_port_id: `source_port_${index + 1}`,
    spice_node,
    labels: [spice_node],
    role,
  })),
}

function documentedApplication(input: {
  capacitance: string
  inductance?: string
  capacitor_references?: string[]
  resistance?: string
  resistor_reference?: string
}): ApplicationFixtureContract {
  const capacitor_references = input.capacitor_references ?? ["COUT"]
  const resistor_reference = input.resistance ? (input.resistor_reference ?? "RLOAD") : undefined
  return compileApplicationFixtureContract({
    plan: {
      version: 4,
      availability: "documented",
      pcb_implementation: "schematic_only",
      title: "Typical application",
      description: "Canonical converter application fixture.",
      source_references: [{ page: 1, figure: "Figure 10" }],
      components: [
        { reference: "U1", kind: "integrated_circuit", value: "TEST-CONVERTER" },
        { reference: "L1", kind: "inductor", value: input.inductance ?? "0.47 uH" },
        ...capacitor_references.map((reference) => ({
          reference,
          kind: "capacitor",
          value: input.capacitance,
        })),
        ...(resistor_reference
          ? [{ reference: resistor_reference, kind: "resistor", value: input.resistance }]
          : []),
      ],
      connections: [
        { net: "VIN", pins: ["U1.VIN", "VIN"] },
        { net: "SW", pins: ["U1.SW", "L1.1"] },
        {
          net: "VOUT",
          pins: [
            "U1.VOUT",
            "L1.2",
            ...capacitor_references.map((reference) => `${reference}.1`),
            ...(resistor_reference ? [`${resistor_reference}.1`] : []),
            "VOUT",
          ],
        },
        {
          net: "GND",
          pins: [
            "U1.GND",
            ...capacitor_references.map((reference) => `${reference}.2`),
            ...(resistor_reference ? [`${resistor_reference}.2`] : []),
            "GND",
          ],
        },
      ],
    },
    model_interface,
    source_plan_sha256: SOURCE_PLAN_SHA256,
    source_pdf_sha256: SOURCE_PDF_SHA256,
  })
}

function unavailableApplication(): ApplicationFixtureContract {
  return compileApplicationFixtureContract({
    plan: {
      version: 4,
      availability: "not_present",
      title: "No documented application",
      description: "The complete datasheet has no canonical application.",
      source_references: [{ page: 1 }],
      searched_sections: ["application information"],
      components: [],
      connections: [],
    },
    model_interface,
    source_plan_sha256: SOURCE_PLAN_SHA256,
    source_pdf_sha256: SOURCE_PDF_SHA256,
  })
}

function datasheetText(local_conditions: string): string {
  return [
    "VI = 3.6 V; VOUT = 3.3 V",
    local_conditions,
    "IO from 0.1 A to 1 A, tr = 10 us, tf = 10 us",
    "VOUT RESPONSE",
    "TIME (100 us / div)",
    "Figure 1. Load Transient Response",
  ].join("\n")
}

function discoveryFor(local_conditions: string): TimeGraphDiscovery {
  const candidates = findLikelyTimeGraphCandidates(datasheetText(local_conditions))
  expect(candidates).toHaveLength(1)
  return parseTimeGraphDiscovery(
    {
      version: 1,
      source_pdf_sha256: SOURCE_PDF_SHA256,
      page_count: 1,
      hints: candidates.map((candidate, index) => ({
        hint_id: `time_graph_${String(index + 1).padStart(3, "0")}`,
        ...candidate,
      })),
    },
    SOURCE_PDF_SHA256,
  )
}

function digitizedCurve() {
  return {
    method: "manual_pixel_trace",
    x_quantity: "time",
    x_unit: "s",
    y_quantity: "voltage",
    y_unit: "V",
    x_range: { min: 0, max: 0.0015 },
    y_range: { min: 3, max: 3.6 },
    x_axis: {
      scale: "linear",
      first: { pixel: 10, value: 0 },
      second: { pixel: 190, value: 0.0015 },
    },
    y_axis: {
      scale: "linear",
      first: { pixel: 90, value: 3 },
      second: { pixel: 10, value: 3.6 },
    },
    trace_color: { r: 20, g: 80, b: 180, tolerance: 24 },
    points: Array.from({ length: 16 }, (_, index) => {
      const ratio = index / 15
      return {
        pixel_x: 10 + ratio * 180,
        pixel_y: 90 - ratio * 80,
        x: ratio * 0.0015,
        y: 3 + ratio * 0.6,
      }
    }),
  }
}

function observerValue(discovery: TimeGraphDiscovery) {
  const hint = discovery.hints[0]!
  return {
    version: 1,
    source_pdf_sha256: SOURCE_PDF_SHA256,
    reviewed_hints: [
      {
        hint_id: hint.hint_id,
        disposition: "graph",
        graph_id: "load_transient",
        reason: "The elapsed-time graph plots the public VOUT response.",
      },
    ],
    graphs: [
      {
        graph_id: "load_transient",
        page: hint.page,
        locator: `${hint.figure}. Load Transient Response`,
        x_axis: "time",
        time_axis_evidence: "TIME (100 us / div)",
        response_quantity: "voltage",
        public_pin_observable: true,
        fixture_reproducible: true,
        reason: "The public VOUT response is driven by the printed load-current step.",
        crop: {
          page: hint.page,
          render_dpi: 200,
          x_px: 100,
          y_px: 200,
          width_px: 200,
          height_px: 100,
        },
        electrical_binding: {
          response: {
            type: "voltage",
            positive: "dut.VOUT",
            negative: "gnd",
            nominal_volts: 3.3,
          },
          stimulus: {
            type: "current_step",
            positive: "dut.VOUT",
            negative: "gnd",
            pulse: {
              low: 0.1,
              high: 1,
              delay: 0.0001,
              rise: 0.00001,
              fall: 0.00001,
              width: 0.002,
              period: 0.003,
            },
          },
          auxiliary_fixtures: [
            {
              type: "dc_voltage",
              positive: "dut.VIN",
              negative: "gnd",
              dc_volts: 3.6,
            },
          ],
        },
        digitized_curve: digitizedCurve(),
      },
    ],
  }
}

describe("graph-local fixture condition fidelity", () => {
  test("retains R/C/L values and typed environmental/parasitic blockers across strict reparse", () => {
    const direct_receipt = deriveTimeGraphLocalConditionReceipt({
      fixture_evidence_context:
        "RLOAD = 3.3 ohm; COUT = 47 uF; L = 1 uH; TA = 85 C; fSW = 2 MHz; ESR = 20 mΩ",
    })
    expect(
      direct_receipt.conditions
        .flatMap((condition) => (condition.kind === "passive_value" ? [condition.passive_type] : []))
        .sort(),
    ).toEqual(["capacitor", "inductor", "resistor"])

    const discovery = discoveryFor("COUT = 47 uF; L = 1 uH; TA = 85 C; fSW = 2 MHz; ESR = 20 mΩ")
    const hint = discovery.hints[0]!
    expect(hint.graph_local_conditions).toEqual({
      method: "graph_local_fixture_conditions_v1",
      conditions: expect.arrayContaining([
        expect.objectContaining({
          kind: "passive_value",
          label: "COUT",
          passive_type: "capacitor",
          value_si: 47e-6,
        }),
        expect.objectContaining({
          kind: "passive_value",
          label: "L",
          passive_type: "inductor",
          value_si: 1e-6,
        }),
        expect.objectContaining({ kind: "temperature", label: "TA", degrees_celsius: 85 }),
        expect.objectContaining({ kind: "frequency", label: "FSW", hertz: 2e6 }),
        expect.objectContaining({
          kind: "parasitic",
          label: "ESR",
          parameter: "esr",
          value_si: 20e-3,
        }),
      ]),
    })
    expect(hint.unsupported_fixture_conditions).toEqual([
      "temperature_control",
      "frequency_control",
      "unrepresentable_parasitic",
    ])

    const tampered = structuredClone(discovery)
    tampered.hints[0]!.graph_local_conditions!.conditions.pop()
    expect(() => parseTimeGraphDiscovery(tampered, SOURCE_PDF_SHA256)).toThrow(
      /graph_local_conditions do not match the retained graph-local conditions/,
    )

    const observation = parseReferenceGraphObservation(
      observerValue(discovery),
      discovery,
      model_interface,
      documentedApplication({ capacitance: "22 uF", inductance: "0.47 uH" }),
    )
    expect(eligibleObservedGraphs(observation)).toEqual([])
    expect(observation.graphs[0]).toMatchObject({
      fixture_reproducible: false,
      reason: expect.stringContaining("temperature_control, frequency_control, unrepresentable_parasitic"),
    })
    expect(observation.graphs[0]!.electrical_binding).toBeUndefined()
  })

  test("fails closed when otherwise supported caption passives mismatch the application", () => {
    const discovery = discoveryFor("COUT = 47 uF; L = 1 uH")
    const observation = parseReferenceGraphObservation(
      observerValue(discovery),
      discovery,
      model_interface,
      documentedApplication({ capacitance: "22 uF", inductance: "0.47 uH" }),
    )
    expect(eligibleObservedGraphs(observation)).toEqual([])
    expect(observation.graphs[0]).toMatchObject({
      fixture_reproducible: false,
      reason: expect.stringContaining("graph_passive_application_fixture_value_mismatch"),
    })
    expect(observation.graphs[0]!.electrical_binding).toBeUndefined()
  })

  test("keeps an exact, uniquely resolved C/L application fixture eligible", () => {
    const discovery = discoveryFor("COUT = 22 uF; L = 0.47 uH")
    const application = documentedApplication({ capacitance: "22 uF", inductance: "0.47 uH" })
    const observation = parseReferenceGraphObservation(
      observerValue(discovery),
      discovery,
      model_interface,
      application,
    )
    const eligible = eligibleObservedGraphs(observation)
    expect(eligible).toHaveLength(1)
    expect(eligible[0]!.electrical_binding.application_fixture_sha256).toBe(application.contract_sha256)
    expect(eligible[0]!.electrical_binding.application_topology_sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  test("reconciles RLOAD exactly and rejects a different application resistance", () => {
    const discovery = discoveryFor("RLOAD = 3.3 ohm")
    const exact = parseReferenceGraphObservation(
      observerValue(discovery),
      discovery,
      model_interface,
      documentedApplication({ capacitance: "22 uF", resistance: "3.3 ohm" }),
    )
    expect(eligibleObservedGraphs(exact)).toHaveLength(1)

    const mismatch = parseReferenceGraphObservation(
      observerValue(discovery),
      discovery,
      model_interface,
      documentedApplication({ capacitance: "22 uF", resistance: "4.7 ohm" }),
    )
    expect(eligibleObservedGraphs(mismatch)).toEqual([])
    expect(mismatch.graphs[0]!.reason).toContain("graph_passive_application_fixture_value_mismatch")
    expect(mismatch.graphs[0]!.electrical_binding).toBeUndefined()
  })

  test("fails closed for missing, not-present, and ambiguous application passives", () => {
    const discovery = discoveryFor("COUT = 22 uF")
    const cases: Array<{
      name: string
      application?: ApplicationFixtureContract
      code: string
    }> = [
      {
        name: "missing",
        code: "graph_passive_application_fixture_missing",
      },
      {
        name: "not-present",
        application: unavailableApplication(),
        code: "graph_passive_application_fixture_not_present",
      },
      {
        name: "ambiguous",
        application: documentedApplication({
          capacitance: "22 uF",
          capacitor_references: ["C1", "C2"],
        }),
        code: "graph_passive_application_fixture_ambiguous",
      },
    ]
    for (const fixture_case of cases) {
      const observation = parseReferenceGraphObservation(
        observerValue(discovery),
        discovery,
        model_interface,
        fixture_case.application,
      )
      expect(eligibleObservedGraphs(observation), fixture_case.name).toEqual([])
      expect(observation.graphs[0]!.reason, fixture_case.name).toContain(fixture_case.code)
      expect(observation.graphs[0]!.electrical_binding, fixture_case.name).toBeUndefined()
    }
  })
})
