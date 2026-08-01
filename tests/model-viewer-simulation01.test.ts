import { expect, test } from "bun:test"
import type { AnyCircuitElement } from "circuit-json"
import { validateViewerSimulation } from "@/server/modeling/viewer-simulation"
import {
  getViewerInfrastructureFailures,
  getViewerPreviewFailures,
  type ValidationCircuitPreviewBuild,
} from "@/server/model-workflow/validation-circuit-previews"
import type { ValidationCase } from "@/server/spice-validation"

type MutableCircuitRecord = AnyCircuitElement & Record<string, unknown>

const transient_case: ValidationCase = {
  id: "startup",
  title: "Startup",
  requirement_ids: ["startup"],
  nets: ["supply"],
  fixtures: [
    {
      type: "voltage_source",
      id: "input_step",
      positive: "dut.IN",
      negative: "gnd",
      dc_volts: 0,
      pulse: {
        low: 0,
        high: 2,
        delay: 0.001,
        rise: 0.0002,
        fall: 0.0002,
        width: 0.001,
        period: 0.004,
      },
    },
    {
      type: "voltage_source",
      id: "dc_supply",
      positive: "net.supply",
      negative: "gnd",
      dc_volts: 5,
    },
    {
      type: "resistor",
      id: "r_load",
      positive: "net.supply",
      negative: "dut.OUT",
      resistance_ohms: 1_000,
    },
    {
      type: "capacitor",
      id: "c_load",
      positive: "dut.OUT",
      negative: "gnd",
      capacitance_farads: 0.000001,
    },
  ],
  analysis: { type: "transient", step: 0.001, stop: 0.002 },
  observations: [
    {
      id: "VOUT",
      requirement_id: "startup",
      type: "voltage",
      positive: "dut.OUT",
      negative: "gnd",
      unit: "V",
      scale: "linear",
      reference: {
        type: "curve",
        tolerance: 0.01,
        points: [
          { x: 0, y: 0 },
          { x: 0.001, y: 1 },
          { x: 0.002, y: 2 },
        ],
      },
    },
  ],
}

function transientCircuit(timestamps_ms = [0, 1, 2]): AnyCircuitElement[] {
  return [
    {
      type: "source_component",
      source_component_id: "dut_1",
      name: "DUT",
    },
    {
      type: "source_port",
      source_port_id: "dut_in",
      source_component_id: "dut_1",
      name: "IN",
      port_hints: ["IN", "pin1"],
    },
    {
      type: "source_port",
      source_port_id: "dut_out",
      source_component_id: "dut_1",
      name: "OUT",
      port_hints: ["OUT", "pin1"],
    },
    {
      type: "source_component",
      source_component_id: "stimulus_1",
      name: "input_step",
      ftype: "simple_chip",
    },
    {
      type: "source_port",
      source_port_id: "stimulus_pos",
      source_component_id: "stimulus_1",
      name: "POS",
      port_hints: ["POS", "pin1"],
    },
    {
      type: "source_port",
      source_port_id: "stimulus_neg",
      source_component_id: "stimulus_1",
      name: "NEG",
      port_hints: ["NEG", "pin2"],
    },
    {
      type: "source_net",
      source_net_id: "ground",
      name: "GND",
      member_source_group_ids: [],
      is_ground: true,
    },
    {
      type: "source_net",
      source_net_id: "supply_net",
      name: "supply",
      member_source_group_ids: [],
    },
    {
      type: "source_trace",
      source_trace_id: "stimulus_positive_trace",
      connected_source_port_ids: ["stimulus_pos", "dut_in"],
      connected_source_net_ids: [],
    },
    {
      type: "source_trace",
      source_trace_id: "stimulus_negative_trace",
      connected_source_port_ids: ["stimulus_neg"],
      connected_source_net_ids: ["ground"],
    },
    {
      type: "simulation_spice_subcircuit",
      simulation_spice_subcircuit_id: "stimulus_model",
      source_component_id: "stimulus_1",
      spice_pin_to_source_port_map: { POS: "stimulus_pos", NEG: "stimulus_neg" },
      subcircuit_source:
        ".SUBCKT VALIDATION_INPUT_STEP POS NEG\n" +
        "VDRIVE POS NEG DC 0 PULSE(0 2 0.001 0.0002 0.0002 0.001 0.004)\n" +
        ".ENDS VALIDATION_INPUT_STEP\n",
    },
    {
      type: "source_component",
      source_component_id: "dc_supply_component",
      name: "dc_supply",
      ftype: "simple_voltage_source",
      voltage: 5,
    },
    {
      type: "source_port",
      source_port_id: "dc_supply_pin1",
      source_component_id: "dc_supply_component",
      name: "pin1",
      port_hints: ["pin1", "terminal1", "1"],
    },
    {
      type: "source_port",
      source_port_id: "dc_supply_pin2",
      source_component_id: "dc_supply_component",
      name: "pin2",
      port_hints: ["pin2", "terminal2", "2"],
    },
    {
      type: "source_trace",
      source_trace_id: "dc_supply_positive_trace",
      connected_source_port_ids: ["dc_supply_pin1"],
      connected_source_net_ids: ["supply_net"],
    },
    {
      type: "source_trace",
      source_trace_id: "dc_supply_negative_trace",
      connected_source_port_ids: ["dc_supply_pin2"],
      connected_source_net_ids: ["ground"],
    },
    {
      type: "source_component",
      source_component_id: "r_load_component",
      name: "r_load",
      ftype: "simple_resistor",
      resistance: 1_000,
    },
    {
      type: "source_port",
      source_port_id: "r_load_pin1",
      source_component_id: "r_load_component",
      name: "pin1",
      port_hints: ["pin1", "1"],
    },
    {
      type: "source_port",
      source_port_id: "r_load_pin2",
      source_component_id: "r_load_component",
      name: "pin2",
      port_hints: ["pin2", "2"],
    },
    {
      type: "source_trace",
      source_trace_id: "r_load_positive_trace",
      connected_source_port_ids: ["r_load_pin1"],
      connected_source_net_ids: ["supply_net"],
    },
    {
      type: "source_trace",
      source_trace_id: "r_load_negative_trace",
      connected_source_port_ids: ["r_load_pin2", "dut_out"],
      connected_source_net_ids: [],
    },
    {
      type: "source_component",
      source_component_id: "c_load_component",
      name: "c_load",
      ftype: "simple_capacitor",
      capacitance: 0.000001,
    },
    {
      type: "source_port",
      source_port_id: "c_load_pin1",
      source_component_id: "c_load_component",
      name: "pin1",
      port_hints: ["pin1", "1"],
    },
    {
      type: "source_port",
      source_port_id: "c_load_pin2",
      source_component_id: "c_load_component",
      name: "pin2",
      port_hints: ["pin2", "2"],
    },
    {
      type: "source_trace",
      source_trace_id: "c_load_positive_trace",
      connected_source_port_ids: ["c_load_pin1", "dut_out"],
      connected_source_net_ids: [],
    },
    {
      type: "source_trace",
      source_trace_id: "c_load_negative_trace",
      connected_source_port_ids: ["c_load_pin2"],
      connected_source_net_ids: ["ground"],
    },
    {
      type: "simulation_experiment",
      simulation_experiment_id: "experiment_1",
      name: "validation",
      experiment_type: "spice_transient_analysis",
      time_per_step: 1,
      start_time_ms: 0,
      end_time_ms: 2,
    },
    {
      type: "simulation_voltage_probe",
      simulation_voltage_probe_id: "probe_id_1",
      name: "probe_VOUT",
      signal_input_source_port_id: "dut_out",
    },
    {
      type: "simulation_transient_voltage_graph",
      simulation_transient_voltage_graph_id: "graph_1",
      simulation_experiment_id: "experiment_1",
      source_probe_id: "probe_id_1",
      name: "probe_VOUT",
      timestamps_ms,
      voltage_levels: [0, 1, 2],
      time_per_step: 1,
      start_time_ms: 0,
      end_time_ms: 2,
    },
  ] as unknown as AnyCircuitElement[]
}

const extra_fixtures: ValidationCase["fixtures"] = [
  {
    type: "current_source",
    id: "load_step",
    positive: "gnd",
    negative: "dut.OUT",
    dc_amps: 0,
    pulse: {
      low: 0,
      high: 0.001,
      delay: 0.001,
      rise: 0.0002,
      fall: 0.0002,
      width: 0.001,
      period: 0.004,
    },
  },
  {
    type: "current_source",
    id: "dc_bias",
    positive: "dut.OUT",
    negative: "gnd",
    dc_amps: 0.002,
  },
  {
    type: "inductor",
    id: "l_load",
    positive: "dut.OUT",
    negative: "gnd",
    inductance_henries: 0.004,
  },
  {
    type: "diode",
    id: "clamp",
    anode: "dut.OUT",
    cathode: "gnd",
  },
]

function comprehensiveFixtureCircuit(): AnyCircuitElement[] {
  return [
    ...transientCircuit(),
    {
      type: "source_component",
      source_component_id: "load_step_component",
      name: "load_step",
      ftype: "simple_chip",
    },
    {
      type: "source_port",
      source_port_id: "load_step_pos",
      source_component_id: "load_step_component",
      name: "POS",
      port_hints: ["POS", "pin1"],
    },
    {
      type: "source_port",
      source_port_id: "load_step_neg",
      source_component_id: "load_step_component",
      name: "NEG",
      port_hints: ["NEG", "pin2"],
    },
    {
      type: "source_trace",
      source_trace_id: "load_step_positive_trace",
      connected_source_port_ids: ["load_step_pos"],
      connected_source_net_ids: ["ground"],
    },
    {
      type: "source_trace",
      source_trace_id: "load_step_negative_trace",
      connected_source_port_ids: ["load_step_neg", "dut_out"],
      connected_source_net_ids: [],
    },
    {
      type: "simulation_spice_subcircuit",
      simulation_spice_subcircuit_id: "load_step_model",
      source_component_id: "load_step_component",
      spice_pin_to_source_port_map: { POS: "load_step_pos", NEG: "load_step_neg" },
      subcircuit_source:
        ".SUBCKT VALIDATION_LOAD_STEP POS NEG\n" +
        "IDRIVE POS NEG DC 0 PULSE(0 0.001 0.001 0.0002 0.0002 0.001 0.004)\n" +
        ".ENDS VALIDATION_LOAD_STEP\n",
    },
    ...nativeTwoTerminalFixture({
      component_id: "dc_bias_component",
      name: "dc_bias",
      ftype: "simple_current_source",
      value: { current: 0.002 },
      positive: "dut_out",
      negative: "ground",
    }),
    ...nativeTwoTerminalFixture({
      component_id: "l_load_component",
      name: "l_load",
      ftype: "simple_inductor",
      value: { inductance: "0.004H" },
      positive: "dut_out",
      negative: "ground",
    }),
    ...nativeTwoTerminalFixture({
      component_id: "clamp_component",
      name: "clamp",
      ftype: "simple_diode",
      value: {},
      positive: "dut_out",
      negative: "ground",
    }),
  ] as unknown as AnyCircuitElement[]
}

function nativeTwoTerminalFixture(input: {
  component_id: string
  name: string
  ftype: string
  value: Record<string, number | string>
  positive: "dut_out" | "ground"
  negative: "dut_out" | "ground"
}): AnyCircuitElement[] {
  const endpointFields = (port_id: string, endpoint: "dut_out" | "ground") =>
    endpoint === "ground"
      ? { connected_source_port_ids: [port_id], connected_source_net_ids: ["ground"] }
      : { connected_source_port_ids: [port_id, "dut_out"], connected_source_net_ids: [] }
  return [
    {
      type: "source_component",
      source_component_id: input.component_id,
      name: input.name,
      ftype: input.ftype,
      ...input.value,
    },
    {
      type: "source_port",
      source_port_id: `${input.component_id}_pin1`,
      source_component_id: input.component_id,
      name: "pin1",
      port_hints: ["pin1", "1"],
    },
    {
      type: "source_port",
      source_port_id: `${input.component_id}_pin2`,
      source_component_id: input.component_id,
      name: "pin2",
      port_hints: ["pin2", "2"],
    },
    {
      type: "source_trace",
      source_trace_id: `${input.name}_positive_trace`,
      ...endpointFields(`${input.component_id}_pin1`, input.positive),
    },
    {
      type: "source_trace",
      source_trace_id: `${input.name}_negative_trace`,
      ...endpointFields(`${input.component_id}_pin2`, input.negative),
    },
  ] as unknown as AnyCircuitElement[]
}

test("viewer validation scores the exact tscircuit time-domain graph", () => {
  const result = validateViewerSimulation({
    validation_case: transient_case,
    circuit_json: transientCircuit(),
  })

  expect(result.simulation_valid).toBe(true)
  expect(result.passed).toBe(true)
  expect(result.errors).toEqual([])
  expect(result.series[0]?.points).toEqual([
    { x: 0, y: 0 },
    { x: 0.001, y: 1 },
    { x: 0.002, y: 2 },
  ])
})

test("viewer validation rejects a hidden non-transient experiment beside the planned transient", () => {
  const forged = transientCircuit()
  forged.push({
    type: "simulation_experiment",
    simulation_experiment_id: "hidden_experiment",
    name: "hidden",
    experiment_type: "spice_dc_operating_point",
  } as AnyCircuitElement)

  const result = validateViewerSimulation({ validation_case: transient_case, circuit_json: forged })

  expect(result.simulation_valid).toBe(false)
  expect(result.errors.map(({ code }) => code)).toContain("viewer_experiment_set_mismatch")
})

test("viewer validation rejects a current graph beside the planned voltage graph", () => {
  const forged = transientCircuit()
  forged.push({
    type: "simulation_transient_current_graph",
    simulation_transient_current_graph_id: "hidden_current_graph",
    simulation_experiment_id: "experiment_1",
    timestamps_ms: [0, 1, 2],
    current_levels: [0, 1, 2],
    time_per_step: 1,
    start_time_ms: 0,
    end_time_ms: 2,
  } as AnyCircuitElement)

  const result = validateViewerSimulation({ validation_case: transient_case, circuit_json: forged })

  expect(result.simulation_valid).toBe(false)
  expect(result.errors.map(({ code }) => code)).toContain("viewer_unsupported_simulation_graph")
})

test("viewer validation rejects an extra voltage graph not bound to a planned observation", () => {
  const forged = transientCircuit()
  forged.push({
    type: "simulation_transient_voltage_graph",
    simulation_transient_voltage_graph_id: "hidden_voltage_graph",
    simulation_experiment_id: "experiment_1",
    source_probe_id: "hidden_probe",
    timestamps_ms: [0, 1, 2],
    voltage_levels: [0, 1, 2],
    time_per_step: 1,
    start_time_ms: 0,
    end_time_ms: 2,
  } as AnyCircuitElement)

  const result = validateViewerSimulation({ validation_case: transient_case, circuit_json: forged })

  expect(result.simulation_valid).toBe(false)
  expect(result.errors.map(({ code }) => code)).toContain("viewer_unexpected_voltage_graph")
})

test("viewer validation accepts exact voltage/current sources, R/C/L, and diode fixtures", () => {
  const result = validateViewerSimulation({
    validation_case: {
      ...transient_case,
      fixtures: [...transient_case.fixtures, ...extra_fixtures],
    },
    circuit_json: comprehensiveFixtureCircuit(),
  })

  expect(result.simulation_valid).toBe(true)
  expect(result.passed).toBe(true)
  expect(result.errors).toEqual([])
})

test("viewer validation rejects an omitted pulsed helper component", () => {
  const forged = transientCircuit().filter(
    (element) => !(element.type === "source_component" && element.source_component_id === "stimulus_1"),
  )
  const result = validateViewerSimulation({ validation_case: transient_case, circuit_json: forged })

  expect(result.simulation_valid).toBe(false)
  expect(result.errors.map(({ code }) => code)).toContain("viewer_stimulus_source_count")
})

const support_fixture_mutations = [
  {
    fixture_id: "dc_supply",
    component_id: "dc_supply_component",
    value_field: "voltage",
    altered_value: 9,
    trace_id: "dc_supply_positive_trace",
    miswire: (trace: MutableCircuitRecord) => {
      trace.connected_source_net_ids = ["ground"]
    },
  },
  {
    fixture_id: "r_load",
    component_id: "r_load_component",
    value_field: "resistance",
    altered_value: 99,
    trace_id: "r_load_negative_trace",
    miswire: (trace: MutableCircuitRecord) => {
      trace.connected_source_port_ids = ["r_load_pin2", "dut_in"]
    },
  },
  {
    fixture_id: "c_load",
    component_id: "c_load_component",
    value_field: "capacitance",
    altered_value: 0.5,
    trace_id: "c_load_positive_trace",
    miswire: (trace: MutableCircuitRecord) => {
      trace.connected_source_port_ids = ["c_load_pin1", "dut_in"]
    },
  },
] as const

for (const mutation of support_fixture_mutations) {
  test(`viewer validation rejects omitted ${mutation.fixture_id} support`, () => {
    const forged = transientCircuit().filter(
      (element) =>
        !(element.type === "source_component" && element.source_component_id === mutation.component_id),
    )
    const result = validateViewerSimulation({ validation_case: transient_case, circuit_json: forged })

    expect(result.simulation_valid).toBe(false)
    expect(result.errors.map(({ code }) => code)).toContain("viewer_fixture_source_count")
  })

  test(`viewer validation rejects altered ${mutation.fixture_id} support value`, () => {
    const forged = transientCircuit() as MutableCircuitRecord[]
    const component = forged.find(
      (record) => record.type === "source_component" && record.source_component_id === mutation.component_id,
    )
    if (!component) throw new Error(`Missing test component ${mutation.component_id}`)
    component[mutation.value_field] = mutation.altered_value
    const result = validateViewerSimulation({ validation_case: transient_case, circuit_json: forged })

    expect(result.simulation_valid).toBe(false)
    expect(result.errors.map(({ code }) => code)).toContain("viewer_fixture_model_mismatch")
  })

  test(`viewer validation rejects miswired ${mutation.fixture_id} support`, () => {
    const forged = transientCircuit() as MutableCircuitRecord[]
    const trace = forged.find(
      (record) => record.type === "source_trace" && record.source_trace_id === mutation.trace_id,
    )
    if (!trace) throw new Error(`Missing test trace ${mutation.trace_id}`)
    mutation.miswire(trace)
    const result = validateViewerSimulation({ validation_case: transient_case, circuit_json: forged })

    expect(result.simulation_valid).toBe(false)
    expect(result.errors.map(({ code }) => code)).toContain("viewer_fixture_endpoint_mismatch")
  })
}

test("viewer validation rejects a missing bound pulsed source", () => {
  const forged = transientCircuit().filter(
    (element) =>
      !(
        element.type === "simulation_spice_subcircuit" &&
        "source_component_id" in element &&
        element.source_component_id === "stimulus_1"
      ),
  )
  const result = validateViewerSimulation({ validation_case: transient_case, circuit_json: forged })

  expect(result.passed).toBe(false)
  expect(result.errors.map(({ code }) => code)).toContain("viewer_stimulus_model_mismatch")
})

test("viewer validation rejects altered pulse values", () => {
  const forged = transientCircuit()
  const source = forged.find(
    (element) =>
      element.type === "simulation_spice_subcircuit" &&
      "source_component_id" in element &&
      element.source_component_id === "stimulus_1",
  ) as (AnyCircuitElement & { subcircuit_source?: string }) | undefined
  if (source) source.subcircuit_source = source.subcircuit_source?.replace("PULSE(0 2", "PULSE(0 9")
  const result = validateViewerSimulation({ validation_case: transient_case, circuit_json: forged })

  expect(result.passed).toBe(false)
  expect(result.errors.map(({ code }) => code)).toContain("viewer_stimulus_model_mismatch")
})

test("viewer validation rejects an extra hidden pulsed-source port", () => {
  const forged = transientCircuit()
  forged.push({
    type: "source_port",
    source_port_id: "stimulus_hidden",
    source_component_id: "stimulus_1",
    name: "HIDDEN",
    port_hints: ["HIDDEN", "pin3"],
  } as AnyCircuitElement)
  const result = validateViewerSimulation({ validation_case: transient_case, circuit_json: forged })

  expect(result.simulation_valid).toBe(false)
  expect(result.errors.map(({ code }) => code)).toContain("viewer_stimulus_model_mismatch")
})

test("viewer validation rejects a native fixture with a hidden SPICE override", () => {
  const forged = transientCircuit()
  forged.push({
    type: "simulation_spice_subcircuit",
    simulation_spice_subcircuit_id: "hidden_load_override",
    source_component_id: "r_load_component",
    spice_pin_to_source_port_map: { POS: "r_load_pin1", NEG: "r_load_pin2" },
    subcircuit_source: ".SUBCKT HIDDEN POS NEG\nR1 POS NEG 1\n.ENDS HIDDEN\n",
  } as AnyCircuitElement)
  const result = validateViewerSimulation({ validation_case: transient_case, circuit_json: forged })

  expect(result.simulation_valid).toBe(false)
  expect(result.errors.map(({ code }) => code)).toContain("viewer_fixture_model_mismatch")
})

test("viewer validation rejects reversed pulse polarity", () => {
  const forged = transientCircuit()
  const positive_trace = forged.find(
    (element) => element.type === "source_trace" && element.source_trace_id === "stimulus_positive_trace",
  ) as AnyCircuitElement & { connected_source_port_ids?: string[]; connected_source_net_ids?: string[] }
  const negative_trace = forged.find(
    (element) => element.type === "source_trace" && element.source_trace_id === "stimulus_negative_trace",
  ) as AnyCircuitElement & { connected_source_port_ids?: string[]; connected_source_net_ids?: string[] }
  positive_trace.connected_source_port_ids = ["stimulus_neg", "dut_in"]
  negative_trace.connected_source_port_ids = ["stimulus_pos"]
  negative_trace.connected_source_net_ids = ["ground"]
  const result = validateViewerSimulation({ validation_case: transient_case, circuit_json: forged })

  expect(result.passed).toBe(false)
  expect(result.errors.map(({ code }) => code)).toContain("viewer_stimulus_endpoint_mismatch")
})

test("viewer validation rejects non-increasing time samples", () => {
  const result = validateViewerSimulation({
    validation_case: transient_case,
    circuit_json: transientCircuit([0, 1, 1]),
  })

  expect(result.simulation_valid).toBe(false)
  expect(result.passed).toBe(false)
  expect(result.errors.map(({ code }) => code)).toContain("viewer_waveform_time_not_increasing")
})

for (const [field, value] of [
  ["start_time_ms", 1],
  ["time_per_step", 0.5],
  ["end_time_ms", 3],
] as const) {
  test(`viewer validation rejects mutated transient experiment ${field}`, () => {
    const forged = transientCircuit() as MutableCircuitRecord[]
    const experiment = forged.find((record) => record.type === "simulation_experiment")
    if (!experiment) throw new Error("Missing test experiment")
    experiment[field] = value
    const result = validateViewerSimulation({ validation_case: transient_case, circuit_json: forged })

    expect(result.simulation_valid).toBe(false)
    expect(result.errors.map(({ code }) => code)).toContain("viewer_transient_experiment_timing_mismatch")
  })
}

for (const [field, value] of [
  ["start_time_ms", 1],
  ["time_per_step", 0.5],
  ["end_time_ms", 3],
] as const) {
  test(`viewer validation rejects mutated waveform ${field}`, () => {
    const forged = transientCircuit() as MutableCircuitRecord[]
    const graph = forged.find((record) => record.type === "simulation_transient_voltage_graph")
    if (!graph) throw new Error("Missing test graph")
    graph[field] = value
    const result = validateViewerSimulation({ validation_case: transient_case, circuit_json: forged })

    expect(result.simulation_valid).toBe(false)
    expect(result.errors.map(({ code }) => code)).toContain("viewer_waveform_timing_mismatch")
  })
}

test("viewer validation rejects truncated transient waveform coverage", () => {
  const forged = transientCircuit() as MutableCircuitRecord[]
  const graph = forged.find((record) => record.type === "simulation_transient_voltage_graph")
  if (!graph) throw new Error("Missing test graph")
  graph.timestamps_ms = [0, 1]
  graph.voltage_levels = [0, 1]
  const result = validateViewerSimulation({ validation_case: transient_case, circuit_json: forged })

  expect(result.simulation_valid).toBe(false)
  expect(result.errors.map(({ code }) => code)).toContain("viewer_waveform_coverage_mismatch")
})

test("viewer validation rejects gaps hidden inside matching waveform endpoints", () => {
  const forged = transientCircuit() as MutableCircuitRecord[]
  const graph = forged.find((record) => record.type === "simulation_transient_voltage_graph")
  if (!graph) throw new Error("Missing test graph")
  graph.timestamps_ms = [0, 0.5, 2]
  const result = validateViewerSimulation({ validation_case: transient_case, circuit_json: forged })

  expect(result.simulation_valid).toBe(false)
  expect(result.errors.map(({ code }) => code)).toContain("viewer_waveform_coverage_mismatch")
})

test("viewer validation normalizes only the installed runtime's redundant terminal boundary sample", () => {
  const forged = transientCircuit([0, 1, 1.9999999999999998, 2]) as MutableCircuitRecord[]
  const graph = forged.find((record) => record.type === "simulation_transient_voltage_graph")
  if (!graph) throw new Error("Missing test graph")
  graph.voltage_levels = [0, 1, 2, 2]
  const result = validateViewerSimulation({ validation_case: transient_case, circuit_json: forged })

  expect(result.simulation_valid).toBe(true)
  expect(result.passed).toBe(true)
  expect(result.series[0]?.points).toEqual([
    { x: 0, y: 0 },
    { x: 0.001, y: 1 },
    { x: 0.002, y: 2 },
  ])
})

test("viewer validation rejects two extra near-terminal samples", () => {
  const forged = transientCircuit([0, 1, 1.9999999999999996, 1.9999999999999998, 2]) as MutableCircuitRecord[]
  const graph = forged.find((record) => record.type === "simulation_transient_voltage_graph")
  if (!graph) throw new Error("Missing test graph")
  graph.voltage_levels = [0, 1, 2, 2, 2]
  const result = validateViewerSimulation({ validation_case: transient_case, circuit_json: forged })

  expect(result.simulation_valid).toBe(false)
  expect(result.errors.map(({ code }) => code)).toContain("viewer_waveform_coverage_mismatch")
})

test("viewer validation rejects an interior off-grid extra sample", () => {
  const forged = transientCircuit([0, 0.5, 1, 2]) as MutableCircuitRecord[]
  const graph = forged.find((record) => record.type === "simulation_transient_voltage_graph")
  if (!graph) throw new Error("Missing test graph")
  graph.voltage_levels = [0, 0.5, 1, 2]
  const result = validateViewerSimulation({ validation_case: transient_case, circuit_json: forged })

  expect(result.simulation_valid).toBe(false)
  expect(result.errors.map(({ code }) => code)).toContain("viewer_waveform_coverage_mismatch")
})

test("viewer validation rejects a near-grid extra sample away from the terminal boundary", () => {
  const forged = transientCircuit([0, 0.9999999999999998, 1, 2]) as MutableCircuitRecord[]
  const graph = forged.find((record) => record.type === "simulation_transient_voltage_graph")
  if (!graph) throw new Error("Missing test graph")
  graph.voltage_levels = [0, 1, 1, 2]
  const result = validateViewerSimulation({ validation_case: transient_case, circuit_json: forged })

  expect(result.simulation_valid).toBe(false)
  expect(result.errors.map(({ code }) => code)).toContain("viewer_waveform_coverage_mismatch")
})

test("viewer validation binds an explicit nonzero transient start", () => {
  const circuit_json = transientCircuit([1, 2, 3]) as MutableCircuitRecord[]
  const experiment = circuit_json.find((record) => record.type === "simulation_experiment")
  const graph = circuit_json.find((record) => record.type === "simulation_transient_voltage_graph")
  if (!experiment || !graph) throw new Error("Missing transient test records")
  experiment.start_time_ms = 1
  experiment.end_time_ms = 3
  graph.start_time_ms = 1
  graph.end_time_ms = 3
  const observation = transient_case.observations[0]
  if (!observation || observation.type !== "voltage") throw new Error("Missing voltage observation")
  const result = validateViewerSimulation({
    validation_case: {
      ...transient_case,
      analysis: { type: "transient", start: 0.001, step: 0.001, stop: 0.003 },
      observations: [
        {
          ...observation,
          reference: {
            type: "curve",
            tolerance: 0.01,
            points: [
              { x: 0.001, y: 0 },
              { x: 0.002, y: 1 },
              { x: 0.003, y: 2 },
            ],
          },
        },
      ],
    },
    circuit_json,
  })

  expect(result.simulation_valid).toBe(true)
  expect(result.passed).toBe(true)
})

test("a forged graph name cannot substitute for a real voltage probe", () => {
  const forged = transientCircuit().filter(({ type }) => type !== "simulation_voltage_probe")
  const result = validateViewerSimulation({
    validation_case: transient_case,
    circuit_json: forged,
  })

  expect(result.simulation_valid).toBe(false)
  expect(result.passed).toBe(false)
  expect(result.errors.map(({ code }) => code)).toContain("viewer_probe_count")
})

test("viewer validation rejects a named probe wired to the wrong planned endpoint", () => {
  const forged = transientCircuit()
  forged.push({
    type: "source_port",
    source_port_id: "other_out",
    source_component_id: "other_component",
    name: "OUT",
  } as AnyCircuitElement)
  const probe = forged.find(({ type }) => type === "simulation_voltage_probe") as
    | (AnyCircuitElement & { signal_input_source_port_id?: string })
    | undefined
  if (probe) probe.signal_input_source_port_id = "other_out"
  const result = validateViewerSimulation({
    validation_case: transient_case,
    circuit_json: forged,
  })

  expect(result.simulation_valid).toBe(false)
  expect(result.passed).toBe(false)
  expect(result.errors.map(({ code }) => code)).toContain("viewer_probe_endpoint_mismatch")
  expect(result.errors.map(({ path }) => path)).toContain("observations.VOUT.positive")
})

test("viewer validation rejects an explicit non-ground reference for a ground-referenced plan", () => {
  const forged = transientCircuit()
  forged.push({
    type: "source_net",
    source_net_id: "source_net_supply",
    name: "supply",
    member_source_group_ids: [],
  } as AnyCircuitElement)
  const probe = forged.find(({ type }) => type === "simulation_voltage_probe") as
    | (AnyCircuitElement & { reference_input_source_net_id?: string })
    | undefined
  if (probe) probe.reference_input_source_net_id = "source_net_supply"
  const result = validateViewerSimulation({
    validation_case: transient_case,
    circuit_json: forged,
  })

  expect(result.simulation_valid).toBe(false)
  expect(result.errors.map(({ code }) => code)).toContain("viewer_probe_endpoint_mismatch")
  expect(result.errors.map(({ path }) => path)).toContain("observations.VOUT.negative")
})

test("an omitted probe reference cannot impersonate a planned differential measurement", () => {
  const circuit_json = transientCircuit()
  const observation = transient_case.observations[0]
  if (!observation || observation.type !== "voltage") {
    throw new Error("Viewer probe fixture requires one voltage observation")
  }
  circuit_json.push({
    type: "source_net",
    source_net_id: "source_net_reference",
    name: "reference",
    member_source_group_ids: [],
  } as AnyCircuitElement)
  const result = validateViewerSimulation({
    validation_case: {
      ...transient_case,
      nets: ["reference"],
      observations: [
        {
          ...observation,
          negative: "net.reference",
        },
      ],
    },
    circuit_json,
  })

  expect(result.simulation_valid).toBe(false)
  expect(result.errors.map(({ code }) => code)).toContain("viewer_probe_endpoint_mismatch")
  expect(result.errors.map(({ path }) => path)).toContain("observations.VOUT.negative")
})

test("an out-of-tolerance waveform remains runnable and inspectable", () => {
  const result = validateViewerSimulation({
    validation_case: {
      ...transient_case,
      observations: [
        {
          ...transient_case.observations[0]!,
          reference: {
            type: "curve",
            tolerance: 0.01,
            points: [
              { x: 0, y: 0 },
              { x: 0.001, y: 10 },
              { x: 0.002, y: 20 },
            ],
          },
        },
      ],
    },
    circuit_json: transientCircuit(),
  })

  expect(result.simulation_valid).toBe(true)
  expect(result.passed).toBe(false)
  expect(result.series[0]?.points).toHaveLength(3)
  expect(result.errors.every(({ kind }) => kind === "comparison")).toBe(true)
})

test("operating-point Circuit JSON cannot become a viewer simulation", () => {
  const operating_point_case: ValidationCase = {
    ...transient_case,
    analysis: { type: "operating_point" },
    observations: [
      {
        ...transient_case.observations[0]!,
        reference: { type: "bounds", max: 2 },
      },
    ],
  }
  const result = validateViewerSimulation({
    validation_case: operating_point_case,
    circuit_json: [{ type: "source_component", source_component_id: "dut" }] as AnyCircuitElement[],
  })

  expect(result.simulation_valid).toBe(false)
  expect(result.passed).toBe(false)
  expect(result.errors.map(({ code }) => code)).toEqual(
    expect.arrayContaining([
      "viewer_analysis_not_transient",
      "viewer_reference_not_time_curve",
      "viewer_transient_experiment_count",
    ]),
  )
})

test("curve mismatches are repairable while missing authoritative viewer status is infrastructure", () => {
  const comparison_validation = validateViewerSimulation({
    validation_case: {
      ...transient_case,
      observations: [
        {
          ...transient_case.observations[0]!,
          reference: {
            type: "curve",
            tolerance: 0.01,
            points: [
              { x: 0, y: 0 },
              { x: 0.001, y: 10 },
              { x: 0.002, y: 20 },
            ],
          },
        },
      ],
    },
    circuit_json: transientCircuit(),
  })
  const comparison_build: ValidationCircuitPreviewBuild = {
    circuit_json_by_case: { startup: transientCircuit() },
    circuit_build_errors_by_case: {},
    errors_by_case: { startup: "viewer curve comparison failed" },
    viewer_validation_by_case: { startup: comparison_validation },
  }
  expect(getViewerPreviewFailures(comparison_build)).toHaveLength(1)
  expect(getViewerInfrastructureFailures(comparison_build)).toEqual([])

  const provenance_build: ValidationCircuitPreviewBuild = {
    ...comparison_build,
    errors_by_case: { startup: "viewer_model_provenance_failed" },
    viewer_validation_by_case: { startup: undefined },
  }
  expect(getViewerInfrastructureFailures(provenance_build)).toEqual([
    { case_id: "startup", message: "viewer_model_provenance_failed" },
  ])
})
