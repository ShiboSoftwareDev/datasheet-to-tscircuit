import { expect, test } from "bun:test"
import { referenceChannelKey } from "@/server/model-workflow/reference-graph-observation"
import { buildGraphValidationPlan } from "@/server/model-workflow/validation-plan-from-graphs"
import type { ModelContract, ModelRequirement } from "@/server/modeling"
import { IDENTIFIER_PATTERN } from "@/server/spice-validation/identifiers"

test("long graph and channel names produce distinct stable requirement identifiers", () => {
  const graph_id = "figure_8_1_level_translation_2_5_mhz"
  const response = referenceChannelKey(graph_id, "channel_4_b1_output_voltage")
  const stimulus = referenceChannelKey(graph_id, "channel_3_a1_input_voltage")

  expect(response).not.toBe(stimulus)
  expect(response.length).toBeLessThanOrEqual(64)
  expect(stimulus.length).toBeLessThanOrEqual(64)
  expect(IDENTIFIER_PATTERN.test(response)).toBe(true)
  expect(IDENTIFIER_PATTERN.test(stimulus)).toBe(true)
})

function loadTransientRequirement(
  id: string,
  graph_id = id,
  channel_id = "output_voltage",
): ModelRequirement {
  return {
    requirement_id: id,
    title: id,
    behavior: "Reproduce the documented output-voltage load transient.",
    analysis: "transient",
    support: { status: "modeled" },
    conditions: { graph_id, channel_id, channel_role: "response" },
    expected: { unit: "V", min: 3.2, max: 3.4 },
    reference_curve: {
      x_quantity: "time",
      x_unit: "s",
      y_quantity: "voltage",
      y_unit: "V",
      channel_id,
      channel_label: "VOUT",
      channel_role: "response",
      measurement: { type: "voltage", positive: "dut.VOUT", negative: "gnd" },
      tolerance: 0.1,
      points: [
        { x: 0, y: 3.3 },
        { x: 0.0005, y: 3.2 },
        { x: 0.001, y: 3.3 },
      ],
      electrical_binding: {
        response: { type: "voltage", positive: "dut.VOUT", negative: "gnd", nominal_volts: 3.3 },
        stimulus: {
          type: "current_step",
          positive: "dut.VOUT",
          negative: "gnd",
          pulse: {
            low: 0.1,
            high: 0.5,
            delay: 0.0001,
            rise: 0.00001,
            fall: 0.00001,
            width: 0.0007,
            period: 0.002,
          },
        },
        auxiliary_fixtures: [{ type: "dc_voltage", positive: "dut.VIN", negative: "gnd", dc_volts: 3.6 }],
      },
    },
    sources: [{ page: 1, locator: id, statement: "Documented graph" }],
  }
}

test("one source graph produces one comparison observation per plotted channel", () => {
  const response = loadTransientRequirement("figure_10_21__output_voltage", "figure_10_21", "output_voltage")
  response.reference_curve!.image = "evidence/figures/figure_10_21.png"
  response.sources[0]!.image = "evidence/source-page-1.png"
  const stimulus = structuredClone(response)
  stimulus.requirement_id = "figure_10_21__load_current"
  stimulus.title = "Figure 10-21 — ILOAD"
  stimulus.conditions.channel_id = "load_current"
  stimulus.conditions.channel_role = "stimulus"
  stimulus.expected = { unit: "A", min: 0.1, max: 0.5 }
  stimulus.reference_curve = {
    ...stimulus.reference_curve!,
    y_quantity: "current",
    y_unit: "A",
    channel_id: "load_current",
    channel_label: "ILOAD",
    channel_role: "stimulus",
    measurement: {
      type: "current",
      element_id: "stimulus",
      direction: "positive_to_negative",
    },
    points: [
      { x: 0, y: 0.1 },
      { x: 0.0005, y: 0.5 },
      { x: 0.001, y: 0.1 },
    ],
  }
  const contract: ModelContract = {
    version: 1,
    interface: {
      version: 1,
      part_number: "TEST-CONVERTER",
      entry_name: "TEST_CONVERTER",
      pins: [
        {
          physical_pin: "1",
          component_pin: "pin1",
          source_port_id: "source_port_1",
          spice_node: "VIN",
          labels: ["VIN"],
          role: "power_input",
        },
        {
          physical_pin: "2",
          component_pin: "pin2",
          source_port_id: "source_port_2",
          spice_node: "VOUT",
          labels: ["VOUT"],
          role: "power_output",
        },
      ],
    },
    characterization: {
      version: 1,
      family: "power_converter",
      strategy: "behavioral",
      requirements: [response, stimulus],
      assumptions: [],
      limitations: [],
    },
  }

  const plan = buildGraphValidationPlan(contract)

  expect(plan.cases).toHaveLength(1)
  expect(plan.cases[0]).toMatchObject({
    id: "figure_10_21",
    requirement_ids: ["figure_10_21__output_voltage", "figure_10_21__load_current"],
    observations: [
      {
        id: "output_voltage",
        role: "response",
        type: "voltage",
        positive: "dut.VOUT",
        negative: "gnd",
      },
      {
        id: "load_current",
        role: "stimulus",
        type: "current",
        element_id: "stimulus",
        direction: "positive_to_negative",
      },
    ],
  })
})

test("every independent graph receives fallback biasing when no application topology exists", () => {
  const contract: ModelContract = {
    version: 1,
    interface: {
      version: 1,
      part_number: "TEST-CONVERTER",
      entry_name: "TEST_CONVERTER",
      pins: [
        {
          physical_pin: "1",
          component_pin: "pin1",
          source_port_id: "source_port_1",
          spice_node: "VIN",
          labels: ["VIN"],
          role: "power_input",
        },
        {
          physical_pin: "2",
          component_pin: "pin2",
          source_port_id: "source_port_2",
          spice_node: "VOUT",
          labels: ["VOUT"],
          role: "power_output",
        },
        {
          physical_pin: "3",
          component_pin: "pin3",
          source_port_id: "source_port_3",
          spice_node: "MODE",
          labels: ["MODE"],
          role: "input",
        },
      ],
    },
    characterization: {
      version: 1,
      family: "power_converter",
      strategy: "behavioral",
      requirements: [loadTransientRequirement("graph_a"), loadTransientRequirement("graph_b")],
      assumptions: [],
      limitations: [],
    },
  }

  const plan = buildGraphValidationPlan(contract)

  expect(plan.cases.map(({ id }) => id)).toEqual(["graph_a", "graph_b"])
  for (const validation_case of plan.cases) {
    expect(validation_case.fixtures).toContainEqual({
      id: "pin_bias_3",
      type: "resistor",
      positive: "dut.MODE",
      negative: "gnd",
      resistance_ohms: 1e9,
    })
  }
})

test("steady switching references use static fixtures without inventing a pulse", () => {
  const requirement = loadTransientRequirement("switching_output")
  requirement.reference_curve!.electrical_binding = {
    response: { type: "voltage", positive: "dut.VOUT", negative: "gnd", nominal_volts: 3.3 },
    stimulus: { type: "steady_state" },
    auxiliary_fixtures: [
      { type: "dc_voltage", positive: "dut.VIN", negative: "gnd", dc_volts: 3.3 },
      { type: "resistor", positive: "dut.VOUT", negative: "gnd", resistance_ohms: 10 },
    ],
  }
  const contract: ModelContract = {
    version: 1,
    interface: {
      version: 1,
      part_number: "TEST-CONVERTER",
      entry_name: "TEST_CONVERTER",
      pins: [
        {
          physical_pin: "1",
          component_pin: "pin1",
          source_port_id: "source_port_1",
          spice_node: "VIN",
          labels: ["VIN"],
          role: "power_input",
        },
        {
          physical_pin: "2",
          component_pin: "pin2",
          source_port_id: "source_port_2",
          spice_node: "VOUT",
          labels: ["VOUT"],
          role: "power_output",
        },
      ],
    },
    characterization: {
      version: 1,
      family: "power_converter",
      strategy: "behavioral",
      requirements: [requirement],
      assumptions: [],
      limitations: [],
    },
  }

  const validation_case = buildGraphValidationPlan(contract).cases[0]!
  expect(validation_case.fixtures.some((fixture) => "pulse" in fixture && fixture.pulse)).toBe(false)
  expect(validation_case.fixtures).toContainEqual({
    id: "condition_2",
    type: "resistor",
    positive: "dut.VOUT",
    negative: "gnd",
    resistance_ohms: 10,
  })
  expect(validation_case.analysis.type).toBe("transient")
})

test("nonzero reference curves are bracketed by the transient output window", () => {
  const requirement = loadTransientRequirement("delayed_reference")
  requirement.reference_curve!.points = [
    { x: 0.0001, y: 3.3 },
    { x: 0.0005, y: 3.2 },
    { x: 0.001, y: 3.3 },
  ]
  const contract: ModelContract = {
    version: 1,
    interface: {
      version: 1,
      part_number: "TEST-CONVERTER",
      entry_name: "TEST_CONVERTER",
      pins: [
        {
          physical_pin: "1",
          component_pin: "pin1",
          source_port_id: "source_port_1",
          spice_node: "VIN",
          labels: ["VIN"],
          role: "power_input",
        },
        {
          physical_pin: "2",
          component_pin: "pin2",
          source_port_id: "source_port_2",
          spice_node: "VOUT",
          labels: ["VOUT"],
          role: "power_output",
        },
      ],
    },
    characterization: {
      version: 1,
      family: "power_converter",
      strategy: "behavioral",
      requirements: [requirement],
      assumptions: [],
      limitations: [],
    },
  }

  const analysis = buildGraphValidationPlan(contract).cases[0]!.analysis
  expect(analysis.type).toBe("transient")
  if (analysis.type !== "transient") throw new Error("Expected a transient analysis")
  expect(analysis.start).toBeLessThan(0.0001)
  expect(analysis.stop).toBeGreaterThan(0.001)
  expect(analysis.start).toBeCloseTo(0.0001 - analysis.step, 15)
})
