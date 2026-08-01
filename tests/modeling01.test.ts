import { describe, expect, test } from "bun:test"
import type { AnyCircuitElement } from "circuit-json"
import type { ComponentEvidence } from "../src/server/component-evidence"
import {
  assertCircuitEmbedsModel,
  buildCharacterizationPrompt,
  buildModelGenerationPrompt,
  buildValidationPlanPrompt,
  buildValidationPlanGuide,
  createModelInterface,
  createModelManifest,
  ModelStrategyRegistry,
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
  test("exposes only strategies backed by server-owned generation paths", () => {
    expect(new ModelStrategyRegistry().strategies.map(({ id }) => id)).toEqual([
      "equation",
      "behavioral",
      "hybrid",
    ])
    expect(buildCharacterizationPrompt()).toContain("typical-application-plan.json")
    expect(buildCharacterizationPrompt()).toContain("Scalar target/bounds apply independently")
    expect(buildCharacterizationPrompt()).not.toContain("strategy: vendor")
    const vendor_characterization = {
      version: 1,
      family: "other",
      strategy: "vendor",
      requirements: [
        {
          requirement_id: "output_voltage",
          title: "Output voltage",
          behavior: "Produce the documented output voltage",
          analysis: "operating_point",
          support: { status: "modeled" },
          conditions: {},
          expected: { unit: "V", target: 1 },
          sources: [{ page: 1, locator: "Table 1", statement: "Output is 1 V" }],
        },
      ],
      assumptions: [],
      limitations: [],
    }
    const legacy_vendor_characterization = parseModelCharacterization(vendor_characterization)
    expect(legacy_vendor_characterization.strategy).toBe("vendor")
    expect(() =>
      new ModelStrategyRegistry().require(
        legacy_vendor_characterization.strategy,
        legacy_vendor_characterization.family,
      ),
    ).toThrow(/Unknown model strategy vendor/)

    const contract = {
      version: 1 as const,
      interface: createModelInterface(evidence, component_circuit),
      characterization: parseModelCharacterization({
        ...vendor_characterization,
        strategy: "equation",
      }),
    }
    expect(buildValidationPlanPrompt({ contract })).toContain("typical-application-plan.json")
    expect(buildValidationPlanPrompt({ contract })).toContain("same scalar target/bounds apply")
    expect(buildValidationPlanGuide(contract)).toContain("[A-Za-z][A-Za-z0-9_]{0,63}")
    expect(buildModelGenerationPrompt({ contract, strategy_guidance: "Use equations." })).toContain(
      "typical-application-plan.json",
    )
    expect(buildModelGenerationPrompt({ contract, strategy_guidance: "Use equations." })).toContain(
      "server has withheld",
    )
  })

  test("rejects characterization tolerances that make validation meaningless", () => {
    const base = {
      version: 1,
      family: "other",
      strategy: "equation",
      assumptions: [],
      limitations: [],
    }
    const source = [{ page: 1, locator: "Electrical characteristics", statement: "Specified value" }]
    const scalar_characterization = {
      ...base,
      requirements: [
        {
          requirement_id: "output_voltage",
          title: "Output voltage",
          behavior: "Produce the documented output voltage",
          analysis: "operating_point",
          support: { status: "modeled" },
          conditions: {},
          expected: { unit: "V", target: 1, tolerance: 1e99 },
          sources: source,
        },
      ],
    }
    // Compatibility reads must not invalidate already-published version-1
    // contracts; only fresh agent artifacts use the current policy.
    expect(() => parseModelCharacterization(scalar_characterization)).not.toThrow()
    expect(() =>
      parseModelCharacterization(scalar_characterization, {
        policy: "fresh",
      }),
    ).toThrow(/expected\.tolerance must not exceed/)
    const curve_characterization = {
      ...base,
      requirements: [
        {
          requirement_id: "transfer_curve",
          title: "Transfer curve",
          behavior: "Follow the documented transfer curve",
          analysis: "dc_sweep",
          support: { status: "modeled" },
          conditions: {},
          expected: { unit: "V", min: 0, max: 1 },
          reference_curve: {
            x_quantity: "input voltage",
            x_unit: "V",
            y_quantity: "output voltage",
            y_unit: "V",
            tolerance: 1e99,
            points: [
              { x: 0, y: 0 },
              { x: 1, y: 1 },
            ],
          },
          sources: source,
        },
      ],
    }
    expect(() => parseModelCharacterization(curve_characterization)).not.toThrow()
    expect(() =>
      parseModelCharacterization(curve_characterization, {
        policy: "fresh",
      }),
    ).toThrow(/reference_curve\.tolerance must not exceed 0\.5/)
  })

  test("rejects contradictory mixed target and hard bounds only for fresh characterization", () => {
    const characterization = {
      version: 1,
      family: "sensor",
      strategy: "behavioral",
      requirements: [
        {
          requirement_id: "supply_current",
          title: "Supply current",
          behavior: "Draw the documented quiescent supply current",
          analysis: "operating_point",
          support: { status: "modeled" },
          conditions: { supply_voltage: 5 },
          expected: { unit: "A", target: 640e-6, max: 600e-6, tolerance: 32e-6 },
          sources: [
            {
              page: 7,
              locator: "Electrical characteristics",
              statement: "Supply current has typical and maximum values.",
            },
          ],
        },
      ],
      assumptions: [],
      limitations: [],
    }

    expect(parseModelCharacterization(characterization).requirements[0]?.expected.target).toBe(640e-6)
    expect(() =>
      parseModelCharacterization(characterization, {
        policy: "fresh",
      }),
    ).toThrow(/expected\.target cannot exceed max when both are declared/)
  })

  test("requires holdout-capable fresh curves while preserving version-1 compatibility reads", () => {
    const sparse_curve_characterization = {
      version: 1,
      family: "other",
      strategy: "equation",
      requirements: [
        {
          requirement_id: "transfer_curve",
          title: "Transfer curve",
          behavior: "Follow the documented transfer curve",
          analysis: "dc_sweep",
          support: { status: "modeled" },
          conditions: {},
          expected: { unit: "V", min: 0, max: 1 },
          reference_curve: {
            x_quantity: "input voltage",
            x_unit: "V",
            y_quantity: "output voltage",
            y_unit: "V",
            tolerance: 0.05,
            points: [
              { x: 0, y: 0 },
              { x: 0.5, y: 0.4 },
              { x: 1, y: 1 },
            ],
          },
          sources: [{ page: 1, locator: "Figure 1", statement: "Transfer response" }],
        },
      ],
      assumptions: [],
      limitations: [],
    }

    expect(() => parseModelCharacterization(sparse_curve_characterization)).not.toThrow()
    expect(() =>
      parseModelCharacterization(sparse_curve_characterization, {
        policy: "fresh",
      }),
    ).toThrow(/needs at least 5 points so server validation can withhold interior samples/)
    expect(buildCharacterizationPrompt()).toContain("must contain at least five points")
  })

  test("requires a response curve for fresh dc_sweep behavior", () => {
    const scalar_sweep_characterization = {
      version: 1,
      family: "sensor",
      strategy: "equation",
      requirements: [
        {
          requirement_id: "input_loading",
          title: "Input loading",
          behavior: "Input current varies with the swept input voltage",
          analysis: "dc_sweep",
          support: { status: "modeled" },
          conditions: { input_start_v: 0, input_stop_v: 48 },
          expected: { unit: "A", min: 40e-6, max: 60e-6 },
          sources: [
            {
              page: 5,
              locator: "Electrical characteristics",
              statement: "The input has a specified impedance.",
            },
          ],
        },
      ],
      assumptions: [],
      limitations: [],
    }

    expect(() => parseModelCharacterization(scalar_sweep_characterization)).not.toThrow()
    expect(() => parseModelCharacterization(scalar_sweep_characterization, { policy: "fresh" })).toThrow(
      /reference_curve is required for modeled dc_sweep behavior/,
    )
  })

  test("fresh characterization reports unsupported fields instead of dropping typos", () => {
    const characterization = {
      version: 1,
      family: "other",
      strategy: "equation",
      requirements: [
        {
          requirement_id: "output_voltage",
          title: "Output voltage",
          behavior: "Produce the documented output voltage",
          analysis: "operating_point",
          support: { status: "modeled" },
          conditions: {},
          expected: { unit: "V", target: 1, tolerence: 0.1 },
          sources: [{ page: 1, locator: "Electrical characteristics", statement: "Output is 1 V" }],
        },
      ],
      assumptions: [],
      limitations: [],
    }

    // Compatibility reads stay lenient for published v1 contracts; fresh
    // artifacts fail while the agent can still correct the misspelled field.
    expect(() => parseModelCharacterization(characterization)).not.toThrow()
    expect(() => parseModelCharacterization(characterization, { reject_unknown_fields: true })).toThrow(
      "expected contains unsupported fields: tolerence",
    )
  })

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
