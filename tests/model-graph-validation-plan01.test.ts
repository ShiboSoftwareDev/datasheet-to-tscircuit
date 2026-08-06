import { expect, test } from "bun:test"
import { buildGraphValidationPlan } from "@/server/model-workflow/validation-plan-from-graphs"
import type { ModelContract, ModelRequirement } from "@/server/modeling"

function loadTransientRequirement(id: string): ModelRequirement {
  return {
    requirement_id: id,
    title: id,
    behavior: "Reproduce the documented output-voltage load transient.",
    analysis: "transient",
    support: { status: "modeled" },
    conditions: {},
    expected: { unit: "V", min: 3.2, max: 3.4 },
    reference_curve: {
      x_quantity: "time",
      x_unit: "s",
      y_quantity: "voltage",
      y_unit: "V",
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
