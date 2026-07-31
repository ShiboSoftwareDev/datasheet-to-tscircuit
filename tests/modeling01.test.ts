import { describe, expect, test } from "bun:test"
import type { AnyCircuitElement } from "circuit-json"
import type { ComponentEvidence } from "../src/server/component-evidence"
import {
  assertCircuitEmbedsModel,
  createModelInterface,
  createModelManifest,
  parseModelCharacterization,
  parseModelContract,
  validateModelSource,
} from "../src/server/modeling"

const evidence: ComponentEvidence = {
  version: 1,
  status: "resolved",
  part_number: { value: "ABC-123", sources: [] },
  package: {
    name: { value: "TEST", sources: [] },
    pin_count: { value: 3, sources: [] },
  },
  pinout: {
    pins: [
      { number: "1", labels: ["IN+"], role: "input", sources: [] },
      { number: "2", labels: ["IN-"], role: "input", sources: [] },
      { number: "3", labels: ["OUT"], role: "output", sources: [] },
    ],
  },
  footprint: {
    view: "pcb_top",
    units: "mm",
    drawing_orientation: { value: "pcb_top", sources: [] },
    pads: [],
  },
  unresolved_ambiguities: [],
}

const component_circuit = evidence.pinout.pins.flatMap((pin, index) => [
  ...(index === 0 ? [{ type: "source_component", source_component_id: "component", name: "U1" }] : []),
  {
    type: "source_port",
    source_port_id: `port-${pin.number}`,
    source_component_id: "component",
    pin_number: pin.number,
    name: pin.labels[0],
    port_hints: [`pin${pin.number}`, ...pin.labels],
  },
]) as AnyCircuitElement[]

describe("server-owned model interface", () => {
  test("derives stable, selector-safe pins without collapsing polarity", () => {
    const model_interface = createModelInterface(evidence, component_circuit)
    expect(model_interface.entry_name).toBe("ABC_123")
    expect(model_interface.pins.map(({ component_pin }) => component_pin)).toEqual(["pin1", "pin2", "pin3"])
    expect(model_interface.pins.map(({ spice_node }) => spice_node)).toEqual(["INPOS", "INNEG", "OUT"])
  })

  test("strictly parses persisted interfaces before downstream use", () => {
    const model_interface = createModelInterface(evidence, component_circuit)
    const valid_contract = {
      version: 1,
      interface: model_interface,
      characterization: {
        version: 1,
        family: "other",
        strategy: "behavioral",
        requirements: [
          {
            requirement_id: "output_bias",
            title: "Output bias",
            behavior: "Hold the output near ground at zero input",
            analysis: "operating_point",
            support: { status: "modeled" },
            conditions: { input_voltage: 0 },
            expected: { unit: "V", target: 0, tolerance: 0.001 },
            sources: [
              {
                page: 3,
                locator: "Electrical characteristics",
                statement: "Output bias is specified at zero input.",
              },
            ],
          },
        ],
        assumptions: [],
        limitations: [],
      },
    }
    expect(parseModelContract(valid_contract).interface).toEqual(model_interface)
    expect(() =>
      parseModelContract({
        ...valid_contract,
        interface: {
          ...model_interface,
          pins: [{ ...model_interface.pins[0], component_pin: "pin[1]" }],
        },
      }),
    ).toThrow(/selector-safe/)
    expect(() =>
      parseModelContract({
        ...valid_contract,
        interface: {
          ...model_interface,
          pins: model_interface.pins.map((pin) => ({ ...pin, source_port_id: "duplicate" })),
        },
      }),
    ).toThrow(/source ports must contain unique values/)
  })

  test("validates one public entry while allowing self-contained helper models", () => {
    const model_interface = createModelInterface(evidence, component_circuit)
    const source = `.SUBCKT ABC_123 INPOS INNEG OUT\nEOUT OUT 0 INPOS INNEG 2\n.ENDS ABC_123\n`
    expect(() => validateModelSource(source, model_interface)).not.toThrow()
    const source_with_helpers = `.MODEL DCLAMP D(IS=1e-12)\n.SUBCKT LIMITER IN OUT\nD1 IN OUT DCLAMP\n.ENDS LIMITER\n${source.replace("EOUT OUT 0 INPOS INNEG 2", "XHELP INPOS OUT LIMITER")}`
    expect(() => validateModelSource(source_with_helpers, model_interface)).not.toThrow()
    expect(() =>
      validateModelSource(source.replace("INPOS INNEG OUT", "OUT INPOS INNEG"), model_interface),
    ).toThrow(/pin order/)
    expect(() => validateModelSource(`${source}${source}`, model_interface)).toThrow(/exactly one public/)
    expect(() => validateModelSource(`${source}.include other.lib\n`, model_interface)).toThrow(
      /self-contained/,
    )
    expect(() => validateModelSource(`${source}.end\n`, model_interface)).toThrow(/top-level \.END/)
    expect(() => validateModelSource(`V_BYPASS n_dut_1 0 1\n${source}`, model_interface)).toThrow(
      /top-level content/,
    )
    expect(() => validateModelSource(`${source}.op\n`, model_interface)).toThrow(/top-level content/)
    const first = createModelManifest({ model_interface, model_source: source, simulator: "ngspice" })
    const second = createModelManifest({ model_interface, model_source: source, simulator: "ngspice" })
    expect(first.revision).toBe(second.revision)
    expect(first.pins).toEqual([
      { component_pin: "pin1", spice_node: "INPOS" },
      { component_pin: "pin2", spice_node: "INNEG" },
      { component_pin: "pin3", spice_node: "OUT" },
    ])
  })

  test("verifies the compiled SPICE pin map before publication", () => {
    const model_interface = createModelInterface(evidence, component_circuit)
    const source = `.SUBCKT ABC_123 INPOS INNEG OUT\nEOUT OUT 0 INPOS INNEG 2\n.ENDS ABC_123\n`
    const embedded = {
      type: "simulation_spice_subcircuit",
      simulation_spice_subcircuit_id: "simulation_model",
      source_component_id: "component",
      spice_pin_to_source_port_map: Object.fromEntries(
        model_interface.pins.map(({ spice_node, source_port_id }) => [spice_node, source_port_id]),
      ),
      subcircuit_source: source,
    }
    expect(() =>
      assertCircuitEmbedsModel([embedded] as AnyCircuitElement[], source, model_interface),
    ).not.toThrow()
    expect(() =>
      assertCircuitEmbedsModel(
        [
          {
            ...embedded,
            spice_pin_to_source_port_map: { INPOS: "wrong_port" },
          },
        ] as AnyCircuitElement[],
        source,
        model_interface,
      ),
    ).toThrow(/pin mapping/)
  })
})

describe("model characterization contract", () => {
  test("rejects unsupported AC sweep requirements", () => {
    expect(() =>
      parseModelCharacterization({
        version: 1,
        family: "opamp",
        strategy: "equation",
        requirements: [
          {
            requirement_id: "frequency_response",
            title: "Frequency response",
            behavior: "Measure gain across frequency",
            analysis: "ac_sweep",
            support: { status: "modeled" },
            conditions: {},
            expected: { unit: "V/V", target: 1 },
            sources: [],
          },
        ],
        assumptions: [],
        limitations: [],
      }),
    ).toThrow(AggregateError)
  })

  test("accepts modeled and explicitly documented-only behavior", () => {
    const result = parseModelCharacterization({
      version: 1,
      family: "opamp",
      strategy: "equation",
      requirements: [
        {
          requirement_id: "open_loop_gain",
          title: "Open-loop gain",
          behavior: "Amplify the differential input in the linear region",
          analysis: "dc_sweep",
          support: { status: "modeled" },
          conditions: { supply_v: 5 },
          expected: { unit: "V", min: 1 },
          sources: [{ page: 5, locator: "Electrical characteristics, Avol", statement: "Avol >= 100 V/mV" }],
        },
        {
          requirement_id: "i2c_programming",
          title: "Programming protocol",
          behavior: "Accept configuration bytes",
          analysis: "transient",
          support: { status: "documented_only", reason: "Digital protocol behavior is outside analog SPICE" },
          conditions: {},
          expected: { unit: "bit", target: 1 },
          sources: [{ page: 12, locator: "Serial interface", statement: "Configuration uses I2C" }],
        },
      ],
      assumptions: [],
      limitations: ["No transistor-level noise model"],
    })
    expect(result.requirements).toHaveLength(2)
    expect(result.requirements[1]?.support.status).toBe("documented_only")
  })

  test("rejects modeled non-base units and curve axes the simulator cannot bind", () => {
    const base = {
      version: 1,
      family: "opamp",
      strategy: "equation",
      assumptions: [],
      limitations: [],
    }
    expect(() =>
      parseModelCharacterization({
        ...base,
        requirements: [
          {
            requirement_id: "open_loop_gain",
            title: "Open-loop gain",
            behavior: "Amplify a differential input",
            analysis: "dc_sweep",
            support: { status: "modeled" },
            conditions: { supply_v: 5 },
            expected: { unit: "V/V", min: 100000 },
            sources: [{ page: 5, locator: "Avol", statement: "Open-loop gain" }],
          },
        ],
      }),
    ).toThrow(/expected\.unit must be V or A/)
    expect(() =>
      parseModelCharacterization({
        ...base,
        requirements: [
          {
            requirement_id: "response",
            title: "Response",
            behavior: "Output response",
            analysis: "dc_sweep",
            support: { status: "modeled" },
            conditions: {},
            expected: { unit: "V", min: 0 },
            reference_curve: {
              x_quantity: "temperature",
              x_unit: "C",
              y_quantity: "output",
              y_unit: "V",
              points: [
                { x: 0, y: 0 },
                { x: 1, y: 1 },
              ],
            },
            sources: [{ page: 5, locator: "Figure 1", statement: "Response curve" }],
          },
        ],
      }),
    ).toThrow(/reference_curve\.x_unit must be V or A/)
  })

  test("returns all path-specific validation failures together", () => {
    const error = (() => {
      try {
        parseModelCharacterization({
          version: 1,
          family: "unknown",
          strategy: "magic",
          requirements: [
            {
              requirement_id: "Bad ID",
              analysis: "guess",
              support: { status: "modeled" },
              conditions: {},
              expected: { unit: "V", min: 2, max: 1 },
              sources: [],
            },
          ],
          assumptions: "not-an-array",
          limitations: [],
        })
      } catch (caught) {
        return caught
      }
    })()
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors.length).toBeGreaterThan(5)
    expect(String((error as AggregateError).errors.join("\n"))).toContain("requirements[0].title")
    expect(String((error as AggregateError).errors.join("\n"))).toContain("expected.min cannot exceed max")
  })
})
