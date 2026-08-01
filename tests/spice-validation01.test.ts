import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProcessError } from "@/server/infrastructure/process"
import {
  createModelTrainingContract,
  type ModelContract,
  type ModelInterface,
  type ModelRequirement,
} from "@/server/modeling"
import {
  compileValidationCase,
  extractObservationSeries,
  hashValidationInputs,
  MissingRawVectorError,
  parseAgentValidationPlan,
  parseNgspiceAsciiRaw,
  parseValidationPlan,
  runSpiceValidation,
  scoreObservation,
  selectAnalysisPlot,
  type ValidationObservation,
  type ValidationPlan,
  ValidationPlanError,
} from "@/server/spice-validation"
import type { ModelManifest } from "@/shared/job-types"

const manifest: ModelManifest = {
  version: 1,
  part_number: "TEST-GAIN",
  dialect: "portable",
  entry_name: "GAIN",
  model_file: "model.lib",
  revision: "test",
  simulator: "ngspice",
  generated_at: "2026-01-01T00:00:00.000Z",
  pins: [
    { component_pin: "pin1", spice_node: "IN" },
    { component_pin: "pin2", spice_node: "OUT" },
    { component_pin: "pin3", spice_node: "GND" },
  ],
}

const model_source = `.SUBCKT GAIN IN OUT GND
E_GAIN OUT GND IN GND 2
.ENDS GAIN
`

const model_interface: ModelInterface = {
  version: 1,
  part_number: "TEST-GAIN",
  entry_name: "GAIN",
  pins: manifest.pins.map((pin) => ({
    physical_pin: pin.component_pin.slice(3),
    component_pin: pin.component_pin,
    source_port_id: `source_port_${pin.component_pin}`,
    spice_node: pin.spice_node,
    labels: [pin.spice_node],
    role: "test",
  })),
}

const model_requirements: ModelRequirement[] = [
  {
    requirement_id: "dc_gain",
    title: "DC gain",
    behavior: "Output is twice the input",
    analysis: "dc_sweep",
    support: { status: "modeled" },
    conditions: {},
    expected: { unit: "V" },
    reference_curve: {
      x_quantity: "input voltage",
      x_unit: "V",
      y_quantity: "output voltage",
      y_unit: "V",
      tolerance: 1e-6,
      points: [
        { x: 0, y: 0 },
        { x: 0.5, y: 1 },
        { x: 1, y: 2 },
      ],
    },
    sources: [],
  },
  {
    requirement_id: "transient_gain",
    title: "Transient output range",
    behavior: "Output stays within the specified range",
    analysis: "transient",
    support: { status: "modeled" },
    conditions: {},
    expected: { unit: "V", min: -1e-9, max: 2.000001 },
    sources: [],
  },
]

function modelContract(requirements = model_requirements): ModelContract {
  return {
    version: 1,
    interface: model_interface,
    characterization: {
      version: 1,
      family: "other",
      strategy: "behavioral",
      requirements,
      assumptions: [],
      limitations: [],
    },
  }
}

function fixtures(pulse: boolean): ValidationPlan["cases"][number]["fixtures"] {
  return [
    {
      type: "voltage_source",
      id: "vin",
      positive: "dut.IN",
      negative: "gnd",
      dc_volts: 0,
      ...(pulse
        ? {
            pulse: {
              low: 0,
              high: 1,
              delay: 0,
              rise: 1e-6,
              fall: 1e-6,
              width: 1e-3,
              period: 2e-3,
            },
          }
        : {}),
    },
    {
      type: "resistor",
      id: "load",
      positive: "dut.OUT",
      negative: "gnd",
      resistance_ohms: 10_000,
    },
    {
      type: "voltage_source",
      id: "ground_ref",
      positive: "dut.GND",
      negative: "gnd",
      dc_volts: 0,
    },
  ]
}

function validPlan(): ValidationPlan {
  return {
    version: 1,
    model: { entry_name: "GAIN", pins: ["IN", "OUT", "GND"] },
    cases: [
      {
        id: "dc_gain",
        requirement_ids: ["dc_gain"],
        nets: [],
        fixtures: fixtures(false),
        analysis: { type: "dc_sweep", source_id: "vin", start: 0, stop: 1, step: 0.25 },
        observations: [
          {
            type: "voltage",
            id: "output_voltage",
            requirement_id: "dc_gain",
            positive: "dut.OUT",
            negative: "gnd",
            unit: "V",
            scale: "linear",
            reference: {
              type: "curve",
              tolerance: 1e-6,
              points: [
                { x: 0, y: 0 },
                { x: 0.5, y: 1 },
                { x: 1, y: 2 },
              ],
            },
          },
        ],
      },
      {
        id: "transient_gain",
        requirement_ids: ["transient_gain"],
        nets: [],
        fixtures: fixtures(true),
        analysis: { type: "transient", step: 1e-4, stop: 3e-3 },
        observations: [
          {
            type: "voltage",
            id: "output_voltage",
            requirement_id: "transient_gain",
            positive: "dut.OUT",
            negative: "gnd",
            unit: "V",
            scale: "linear",
            reference: { type: "bounds", min: -1e-9, max: 2.000001 },
          },
        ],
      },
    ],
  }
}

const temporary_directories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporary_directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe("ValidationPlan contract", () => {
  test("accepts a ModelInterface and enforces requirement coverage", () => {
    const parsed = parseValidationPlan(validPlan(), {
      model_interface,
      model_source,
      model_requirements,
    })
    expect(parsed.cases.map((validation_case) => validation_case.requirement_ids)).toEqual([
      ["dc_gain"],
      ["transient_gain"],
    ])
  })

  test("regulator and power-converter plans must exercise a real operating range", () => {
    const scalar_requirement: ModelRequirement = {
      requirement_id: "output_voltage",
      title: "Output voltage",
      behavior: "Keep output voltage inside datasheet bounds",
      analysis: "operating_point",
      support: { status: "modeled" },
      conditions: { input_voltage_range: "4.5 V to 18 V" },
      expected: { unit: "V", min: 4.8, max: 5.2 },
      sources: [{ page: 3, locator: "Electrical characteristics", statement: "Output bounds" }],
    }
    const swept_plan = structuredClone(validPlan())
    const validation_case = swept_plan.cases[0]!
    validation_case.requirement_ids = ["output_voltage"]
    validation_case.observations = [
      {
        ...validation_case.observations[0]!,
        requirement_id: "output_voltage",
        reference: { type: "bounds", min: 4.8, max: 5.2 },
      },
    ]
    swept_plan.cases = [validation_case]
    const isolated_plan = structuredClone(swept_plan)
    isolated_plan.cases[0]!.analysis = { type: "operating_point" }

    expect(() =>
      parseValidationPlan(isolated_plan, {
        model_interface,
        model_requirements: [scalar_requirement],
        model_family: "power_converter",
      }),
    ).toThrow(/insufficient_operating_range_coverage/)
    expect(() =>
      parseValidationPlan(swept_plan, {
        model_interface,
        model_requirements: [scalar_requirement],
        model_family: "power_converter",
      }),
    ).not.toThrow()
  })

  test("materializes references from the model contract and strictly rejects persisted changes", () => {
    const raw_plan = structuredClone(validPlan())
    const observation = raw_plan.cases[0]?.observations[0]
    if (!observation) throw new Error("Expected a DC observation")
    delete (observation as Partial<ValidationObservation>).reference
    const parsed = parseValidationPlan(raw_plan, {
      model_interface,
      model_source,
      model_requirements,
    })
    expect(parsed.cases[0]?.observations[0]?.reference).toEqual({
      type: "curve",
      tolerance: 1e-6,
      points: [
        { x: 0, y: 0 },
        { x: 0.5, y: 1 },
        { x: 1, y: 2 },
      ],
    })

    const tampered_plan = structuredClone(validPlan())
    const tampered_observation = tampered_plan.cases[0]?.observations[0]
    if (tampered_observation?.reference.type !== "curve") {
      throw new Error("Expected a curve observation")
    }
    tampered_observation.reference.tolerance = 1
    expect(() =>
      parseValidationPlan(tampered_plan, {
        model_interface,
        model_source,
        model_requirements,
      }),
    ).toThrow(ValidationPlanError)

    const wrong_analysis_plan = structuredClone(validPlan())
    const dc_case = wrong_analysis_plan.cases[0]
    if (!dc_case) throw new Error("Expected a DC case")
    dc_case.analysis = { type: "operating_point" }
    try {
      parseValidationPlan(wrong_analysis_plan, {
        model_interface,
        model_source,
        model_requirements,
      })
      throw new Error("Expected ValidationPlanError")
    } catch (error) {
      expect((error as ValidationPlanError).errors.map(({ code }) => code)).toContain(
        "requirement_analysis_mismatch",
      )
    }
  })

  test("binds observation evidence and curve axes to the immutable requirement", () => {
    const requirements = structuredClone(model_requirements)
    const curve_requirement = requirements[0]
    const scalar_requirement = requirements[1]
    if (!curve_requirement?.reference_curve || !scalar_requirement) {
      throw new Error("Expected curve and scalar requirements")
    }
    curve_requirement.reference_curve.image = "evidence/figures/dc-gain.png"
    curve_requirement.sources = [
      {
        page: 8,
        locator: "Figure 4",
        statement: "DC transfer characteristic",
        image: "evidence/figures/dc-gain.png",
      },
    ]
    scalar_requirement.sources = [
      {
        page: 11,
        locator: "Electrical characteristics",
        statement: "Transient output range",
        image: "evidence/tables/output-range.png",
      },
    ]

    const parsed = parseValidationPlan(validPlan(), {
      model_interface,
      model_source,
      model_requirements: requirements,
    })
    expect(parsed.cases[0]?.observations[0]?.evidence).toEqual({
      page: 8,
      image: "evidence/figures/dc-gain.png",
      metadata: {
        figure: "Figure 4",
        x_quantity: "input voltage",
        x_unit: "V",
        y_quantity: "output voltage",
        y_unit: "V",
      },
    })
    expect(parsed.cases[1]?.observations[0]?.evidence).toEqual({
      page: 11,
      image: "evidence/tables/output-range.png",
      metadata: { figure: "Electrical characteristics" },
    })

    const exactly_bound_plan = validPlan()
    const exactly_bound_observation = exactly_bound_plan.cases[0]?.observations[0]
    if (!exactly_bound_observation) throw new Error("Expected a DC observation")
    exactly_bound_observation.evidence = parsed.cases[0]?.observations[0]?.evidence
    expect(
      parseValidationPlan(exactly_bound_plan, {
        model_interface,
        model_source,
        model_requirements: requirements,
      }).cases[0]?.observations[0]?.evidence,
    ).toEqual(parsed.cases[0]?.observations[0]?.evidence)

    const tampered_persisted_plan = structuredClone(exactly_bound_plan)
    const tampered_persisted_observation = tampered_persisted_plan.cases[0]?.observations[0]
    if (!tampered_persisted_observation?.evidence) throw new Error("Expected bound evidence")
    tampered_persisted_observation.evidence.page = 99
    expect(() =>
      parseValidationPlan(tampered_persisted_plan, {
        model_interface,
        model_source,
        model_requirements: requirements,
      }),
    ).toThrow(/requirement_evidence_mismatch/)

    const agent_guessed_plan = structuredClone(exactly_bound_plan) as unknown as {
      cases: Array<{ observations: Array<Record<string, unknown>> }>
    }
    const agent_guessed_observation = agent_guessed_plan.cases[0]?.observations[0]
    if (!agent_guessed_observation) throw new Error("Expected bound evidence")
    agent_guessed_observation.evidence = {
      page: 99,
      image: "evidence/source-page-99.png",
      locator: "Agent-authored locator from production run 92",
      statement: "Agent-authored statement from production run 92",
    }
    expect(
      parseAgentValidationPlan(agent_guessed_plan, {
        model_interface,
        model_source,
        model_requirements: requirements,
      }).cases[0]?.observations[0]?.evidence,
    ).toEqual(parsed.cases[0]?.observations[0]?.evidence)

    agent_guessed_observation.evidence = [{ page: 8, image: "evidence/source-page-8.png" }]
    expect(
      parseAgentValidationPlan(agent_guessed_plan, {
        model_interface,
        model_source,
        model_requirements: requirements,
      }).cases[0]?.observations[0]?.evidence,
    ).toEqual(parsed.cases[0]?.observations[0]?.evidence)
  })

  test("requires each case to use one canonical datasheet evidence page", () => {
    const first_requirement: ModelRequirement = {
      ...structuredClone(model_requirements[0]!),
      sources: [{ page: 4, locator: "Figure 1", statement: "Primary transfer curve" }],
    }
    const second_requirement: ModelRequirement = {
      ...structuredClone(first_requirement),
      requirement_id: "secondary_gain",
      title: "Secondary gain",
      sources: [{ page: 9, locator: "Figure 8", statement: "Secondary transfer curve" }],
    }
    const raw_plan = structuredClone(validPlan())
    const validation_case = raw_plan.cases[0]!
    validation_case.requirement_ids = ["dc_gain", "secondary_gain"]
    validation_case.observations.push({
      ...structuredClone(validation_case.observations[0]!),
      id: "secondary_output_voltage",
      requirement_id: "secondary_gain",
    })
    raw_plan.cases = [validation_case]

    expect(() =>
      parseValidationPlan(raw_plan, {
        model_interface,
        model_source,
        model_requirements: [first_requirement, second_requirement],
      }),
    ).toThrow(/mixed_case_evidence/)
  })

  test("intersects an INA-like typical-current band with its hard maximum", () => {
    const target = 640e-6
    const tolerance = 32e-6
    const maximum = 650e-6
    const requirement: ModelRequirement = {
      requirement_id: "supply_current",
      title: "Supply current",
      behavior: "Draw the documented quiescent supply current",
      analysis: "operating_point",
      support: { status: "modeled" },
      conditions: { supply_voltage: 5 },
      expected: { unit: "A", target, tolerance, max: maximum },
      sources: [],
    }
    const parsed = parseValidationPlan(
      {
        version: 1,
        model: { entry_name: "GAIN", pins: ["IN", "OUT", "GND"] },
        cases: [
          {
            id: "supply_current",
            requirement_ids: ["supply_current"],
            nets: [],
            fixtures: fixtures(false),
            analysis: { type: "operating_point" },
            observations: [
              {
                type: "current",
                id: "supply_current",
                requirement_id: "supply_current",
                element_id: "load",
                unit: "A",
                scale: "linear",
              },
            ],
          },
        ],
      },
      { model_interface, model_source, model_requirements: [requirement] },
    )
    const observation = parsed.cases[0]?.observations[0]
    if (!observation) throw new Error("Expected a supply-current observation")

    expect(observation.reference).toEqual({
      type: "bounds",
      min: target - tolerance,
      max: maximum,
    })
    expect(scoreObservation(observation, [{ x: 0, y: target }]).passed).toBe(true)
    expect(
      scoreObservation(observation, [
        { x: 0, y: target - tolerance - 1e-6 },
        { x: 1, y: maximum + 1e-6 },
      ]).passed,
    ).toBe(false)
  })

  test("rejects an observation on an independent branch that only shares ground with the DUT", () => {
    const bypass_plan = structuredClone(validPlan())
    const dc_case = bypass_plan.cases[0]
    if (!dc_case) throw new Error("Expected a DC case")
    dc_case.nets = ["reference"]
    dc_case.fixtures.push(
      {
        type: "voltage_source",
        id: "reference_source",
        positive: "net.reference",
        negative: "gnd",
        dc_volts: 1,
      },
      {
        type: "resistor",
        id: "reference_load",
        positive: "net.reference",
        negative: "gnd",
        resistance_ohms: 1_000,
      },
    )
    const observation = dc_case.observations[0]
    if (observation?.type !== "voltage") throw new Error("Expected voltage observation")
    observation.positive = "net.reference"
    expect(() =>
      parseValidationPlan(bypass_plan, {
        model_interface,
        model_source,
        model_requirements,
      }),
    ).toThrow(ValidationPlanError)
    try {
      parseValidationPlan(bypass_plan, { model_interface, model_source, model_requirements })
    } catch (error) {
      expect((error as ValidationPlanError).errors.map(({ code }) => code)).toContain(
        "disconnected_observation",
      )
    }
  })

  test("rejects voltage and current observations fixed by ideal fixture sources", () => {
    const clamped_plan = structuredClone(validPlan())
    const clamped_case = clamped_plan.cases[0]
    if (!clamped_case) throw new Error("Expected a DC case")
    clamped_case.fixtures.push({
      type: "voltage_source",
      id: "output_clamp",
      positive: "dut.OUT",
      negative: "gnd",
      dc_volts: 0,
    })
    try {
      parseValidationPlan(clamped_plan, { model_interface, model_source, model_requirements })
      throw new Error("Expected ValidationPlanError")
    } catch (error) {
      expect((error as ValidationPlanError).errors.map(({ code }) => code)).toContain(
        "insensitive_voltage_observation",
      )
    }

    const fixed_current_plan = structuredClone(validPlan())
    const fixed_current_case = fixed_current_plan.cases[0]
    if (!fixed_current_case) throw new Error("Expected a DC case")
    fixed_current_case.fixtures.push({
      type: "current_source",
      id: "fixed_current",
      positive: "dut.OUT",
      negative: "gnd",
      dc_amps: 0.001,
    })
    fixed_current_case.observations = [
      {
        type: "current",
        id: "fixed_current_observation",
        requirement_id: "dc_gain",
        element_id: "fixed_current",
        unit: "A",
        scale: "linear",
        reference: { type: "bounds", min: 0 },
      },
    ]
    try {
      parseValidationPlan(fixed_current_plan, { model_interface, model_source, model_requirements })
      throw new Error("Expected ValidationPlanError")
    } catch (error) {
      expect((error as ValidationPlanError).errors.map(({ code }) => code)).toContain(
        "insensitive_current_observation",
      )
    }
  })

  test("bounds validation case count and simulator point budgets", () => {
    const excessive_points = structuredClone(validPlan())
    const dc_case = excessive_points.cases[0]
    if (!dc_case || dc_case.analysis.type !== "dc_sweep") throw new Error("Expected a DC case")
    dc_case.analysis.step = 1e-9
    try {
      parseValidationPlan(excessive_points, { model_interface, model_source, model_requirements })
      throw new Error("Expected ValidationPlanError")
    } catch (error) {
      expect((error as ValidationPlanError).errors.map(({ code }) => code)).toContain(
        "analysis_point_limit_exceeded",
      )
    }

    const excessive_cases = structuredClone(validPlan())
    excessive_cases.cases = Array.from({ length: 17 }, (_, index) => ({
      ...structuredClone(validPlan().cases[index % 2]!),
      id: `case_${index}`,
    }))
    try {
      parseValidationPlan(excessive_cases, { model_interface, model_source, model_requirements })
      throw new Error("Expected ValidationPlanError")
    } catch (error) {
      expect((error as ValidationPlanError).errors.map(({ code }) => code)).toContain(
        "validation_case_limit_exceeded",
      )
    }
  })

  test("rejects curve validation whose analysis cannot cover the authoritative x range", () => {
    const truncated_sweep = structuredClone(validPlan())
    const dc_case = truncated_sweep.cases[0]
    if (!dc_case || dc_case.analysis.type !== "dc_sweep") throw new Error("Expected a DC case")
    dc_case.analysis.start = 0.25

    try {
      parseValidationPlan(truncated_sweep, { model_interface, model_source, model_requirements })
      throw new Error("Expected ValidationPlanError")
    } catch (error) {
      expect((error as ValidationPlanError).errors.map(({ code }) => code)).toContain(
        "reference_curve_outside_analysis_range",
      )
    }
  })

  test("aggregates precise errors instead of stopping at the first invalid field", () => {
    const invalid_plan: unknown = {
      version: 2,
      model: { entry_name: "OTHER", pins: ["OUT"], extra: true },
      cases: [
        {
          id: "Bad id",
          requirement_ids: ["unknown", "unknown"],
          nets: ["loose", "loose"],
          fixtures: [
            {
              type: "resistor",
              id: "bad-id",
              positive: "dut.NOPE",
              negative: "raw.expression",
              resistance_ohms: -1,
              extra: 5,
            },
            {
              type: "capacitor",
              id: "bad-id",
              positive: "net.loose",
              negative: "net.loose",
              capacitance_farads: 0,
            },
          ],
          analysis: { type: "dc_sweep", source_id: "missing", start: 1, stop: 0, step: 1 },
          observations: [
            {
              type: "current",
              id: "current",
              requirement_id: "unknown",
              element_id: "missing",
              unit: "V",
              scale: "log",
              reference: { type: "target", target: 0, tolerance: -1 },
            },
          ],
        },
      ],
    }
    try {
      parseValidationPlan(invalid_plan, {
        manifest,
        model_source,
        model_requirements,
      })
      throw new Error("Expected ValidationPlanError")
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationPlanError)
      const paths = (error as ValidationPlanError).errors.map((item) => item.path)
      expect(paths.length).toBeGreaterThan(12)
      expect(paths).toContain("version")
      expect(paths).toContain("model.entry_name")
      expect(paths).toContain("cases[0].requirement_ids[0]")
      expect(paths).toContain("cases[0].fixtures[0].negative")
      expect(paths).toContain("cases[0].analysis.source_id")
      expect(paths).toContain("cases[0].observations[0].element_id")
      expect(paths).toContain("modeled_requirement_ids[0]")
    }
  })
})

test("compiler emits canonical pins and vectors without executable measures", () => {
  const plan = parseValidationPlan(validPlan(), {
    manifest,
    model_source,
    model_requirements,
  })
  const dc_case = plan.cases[0]
  if (!dc_case) throw new Error("Expected a parsed DC case")
  const compiled = compileValidationCase(dc_case, manifest)
  expect(compiled.source).toContain(".include ../model.lib")
  expect(compiled.source).toContain("X_DUT n_dut_1 n_dut_2 n_dut_3 GAIN")
  expect(compiled.source).toContain(".dc V_vin 0 1 0.25")
  expect(compiled.source).toContain(".save v(n_dut_2)")
  expect(compiled.source.toLowerCase()).not.toContain(".measure")
  expect(compiled.source.match(/^\.(?:op|dc|tran)\b/gm)).toHaveLength(1)
})

const dc_raw = `Title: raw parser test
Date: Thu Jan  1 00:00:00 2026
Plotname: DC transfer characteristic
Flags: real
No. Variables: 3
No. Points: 2
Variables:
  0 v-sweep voltage
  1 v(n_out) voltage
  2 @r_load[i] current
Values:
0 0
  0
  0.001
1 1
  2
  0.002
`

function dcRawWithCurrentVector(vector_name: string): string {
  return dc_raw.replace("@r_load[i]", vector_name)
}

test("ASCII raw parser extracts DC differential voltages and reports missing vectors", () => {
  const raw = parseNgspiceAsciiRaw(dc_raw)
  const plot = selectAnalysisPlot(raw, {
    type: "dc_sweep",
    source_id: "vin",
    start: 0,
    stop: 1,
    step: 1,
  })
  const observation: ValidationObservation = {
    type: "voltage",
    id: "output",
    requirement_id: "dc_gain",
    positive: "dut.OUT",
    negative: "gnd",
    unit: "V",
    scale: "linear",
    reference: { type: "target", target: 0, tolerance: 1 },
  }
  const points = extractObservationSeries({
    plot,
    analysis: { type: "dc_sweep", source_id: "vin", start: 0, stop: 1, step: 1 },
    compiled_observation: {
      observation,
      positive_node: "n_out",
      negative_node: "0",
      saved_vectors: ["v(n_out)"],
    },
  })
  expect(points).toEqual([
    { x: 0, y: 0 },
    { x: 1, y: 2 },
  ])
  const current_points = extractObservationSeries({
    plot,
    analysis: { type: "dc_sweep", source_id: "vin", start: 0, stop: 1, step: 1 },
    compiled_observation: {
      observation: {
        type: "current",
        id: "load_current",
        requirement_id: "dc_gain",
        element_id: "load",
        unit: "A",
        scale: "linear",
        reference: { type: "bounds", min: 0 },
      },
      element_name: "R_load",
      saved_vectors: ["@R_load[i]"],
    },
  })
  expect(current_points.map((point) => point.y)).toEqual([0.001, 0.002])
  expect(() =>
    extractObservationSeries({
      plot,
      analysis: { type: "dc_sweep", source_id: "vin", start: 0, stop: 1, step: 1 },
      compiled_observation: {
        observation: { ...observation, positive: "dut.MISSING" },
        positive_node: "missing",
        negative_node: "0",
        saved_vectors: ["v(missing)"],
      },
    }),
  ).toThrow(MissingRawVectorError)
})

test("current extraction accepts ngspice-wrapped device currents and branch aliases", () => {
  const observation: ValidationObservation = {
    type: "current",
    id: "load_current",
    requirement_id: "dc_gain",
    element_id: "load",
    unit: "A",
    scale: "linear",
    reference: { type: "bounds", min: 0 },
  }
  const compiled_observation = {
    observation,
    element_name: "R_load",
    saved_vectors: ["@R_load[i]"],
  }

  for (const vector_name of ["i(@r_load[i])", "r_load#branch"]) {
    const raw = parseNgspiceAsciiRaw(dcRawWithCurrentVector(vector_name))
    const plot = selectAnalysisPlot(raw, {
      type: "dc_sweep",
      source_id: "vin",
      start: 0,
      stop: 1,
      step: 1,
    })
    const points = extractObservationSeries({
      plot,
      analysis: { type: "dc_sweep", source_id: "vin", start: 0, stop: 1, step: 1 },
      compiled_observation,
    })
    expect(points.map((point) => point.y)).toEqual([0.001, 0.002])
  }
})

test("scoring checks every scalar sample and interpolates curve references deterministically", () => {
  const target: ValidationObservation = {
    type: "voltage",
    id: "target",
    requirement_id: "dc_gain",
    positive: "dut.OUT",
    negative: "gnd",
    unit: "V",
    scale: "linear",
    reference: { type: "target", target: 1, tolerance: 0.1 },
  }
  const target_result = scoreObservation(target, [
    { x: 0, y: 1 },
    { x: 1, y: 1.11 },
  ])
  expect(target_result.passed).toBe(false)
  expect(target_result.metrics.sample_count).toBe(2)

  const curve: ValidationObservation = {
    ...target,
    id: "curve",
    reference: {
      type: "curve",
      tolerance: 0.001,
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 2 },
        { x: 2, y: 4 },
      ],
    },
  }
  const curve_result = scoreObservation(curve, [
    { x: 2, y: 4 },
    { x: 0, y: 0 },
  ])
  expect(curve_result.passed).toBe(true)
  expect(curve_result.metrics.normalized_rmse).toBe(0)
  expect(curve_result.metrics.normalized_max_error).toBe(0)
})

test("full server scoring includes curve samples withheld from model generation", () => {
  const full_points = [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: 2, y: 4 },
    { x: 3, y: 9 },
    { x: 4, y: 16 },
  ]
  const contract: ModelContract = {
    version: 1,
    interface: model_interface,
    characterization: {
      version: 1,
      family: "other",
      strategy: "behavioral",
      requirements: [
        {
          requirement_id: "nonlinear_curve",
          title: "Nonlinear curve",
          behavior: "Follow the nonlinear response",
          analysis: "dc_sweep",
          support: { status: "modeled" },
          conditions: {},
          expected: { unit: "V", min: 0, max: 16 },
          reference_curve: {
            x_quantity: "input voltage",
            x_unit: "V",
            y_quantity: "output voltage",
            y_unit: "V",
            tolerance: 0.01,
            points: full_points,
          },
          sources: [{ page: 1, locator: "Figure 1", statement: "Nonlinear response" }],
        },
      ],
      assumptions: [],
      limitations: [],
    },
  }
  const training_curve =
    createModelTrainingContract(contract).characterization.requirements[0]?.reference_curve
  expect(training_curve?.points).toEqual(full_points.filter(({ x }) => x !== 2))

  const simulated_points = full_points.map((point) => (point.x === 2 ? { x: point.x, y: 0 } : { ...point }))
  const full_result = scoreObservation(
    {
      type: "voltage",
      id: "full_curve",
      requirement_id: "nonlinear_curve",
      positive: "dut.OUT",
      negative: "gnd",
      unit: "V",
      scale: "linear",
      reference: { type: "curve", tolerance: 0.01, points: full_points },
    },
    simulated_points,
  )
  const training_only_result = scoreObservation(
    {
      type: "voltage",
      id: "training_curve",
      requirement_id: "nonlinear_curve",
      positive: "dut.OUT",
      negative: "gnd",
      unit: "V",
      scale: "linear",
      reference: { type: "curve", tolerance: 0.01, points: training_curve?.points ?? [] },
    },
    simulated_points,
  )

  expect(training_only_result.passed).toBe(true)
  expect(full_result.passed).toBe(false)
  expect(full_result.metrics.sample_count).toBe(5)
})

test("log-scale curves are interpolated and compared in logarithmic space", () => {
  const observation: ValidationObservation = {
    type: "voltage",
    id: "log_curve",
    requirement_id: "dc_gain",
    positive: "dut.OUT",
    negative: "gnd",
    unit: "V",
    scale: "log",
    reference: {
      type: "curve",
      tolerance: 0.05,
      points: [
        { x: 0, y: 1e-9 },
        { x: 1, y: 1e-3 },
      ],
    },
  }
  const result = scoreObservation(observation, [
    { x: 0, y: 1e-6 },
    { x: 1, y: 1e-3 },
  ])
  expect(result.passed).toBe(false)
  expect(result.metrics.normalized_max_error).toBeCloseTo(0.5)
})

test("validation hashes are stable across object-key order", () => {
  const first = hashValidationInputs({
    plan: { version: 1, model: { entry_name: "GAIN", pins: ["IN"] } },
    model_source,
    manifest,
  })
  const second = hashValidationInputs({
    plan: { model: { pins: ["IN"], entry_name: "GAIN" }, version: 1 },
    model_source,
    manifest: { ...manifest, pins: [...manifest.pins] },
  })
  expect(second).toEqual(first)
})

test("runner deletes stale raw output before an injected simulator run", async () => {
  const model_dir = await mkdtemp(join(tmpdir(), "spice-validation-stale-"))
  temporary_directories.push(model_dir)
  const raw_path = join(model_dir, "validation", "generated", "dc_gain", "result.raw")
  await mkdir(join(model_dir, "validation", "generated", "dc_gain"), { recursive: true })
  await writeFile(raw_path, dc_raw, "utf8")
  const dc_case = validPlan().cases[0]
  if (!dc_case) throw new Error("Expected a DC case")
  const result = await runSpiceValidation({
    plan: { ...validPlan(), cases: [dc_case] },
    manifest,
    model_source,
    model_dir,
    model_contract: modelContract(model_requirements.slice(0, 1)),
    ngspice: async () => ({ exit_code: 0, stdout: "", stderr: "", cancelled: false }),
  })
  expect(result.passed).toBe(false)
  expect(result.cases[0]?.errors[0]?.code).toBe("raw_file_missing")
  await expect(readFile(raw_path, "utf8")).rejects.toThrow()
})

test("simulator spawn failures propagate without spending a model-repair attempt", async () => {
  const model_dir = await mkdtemp(join(tmpdir(), "spice-validation-spawn-"))
  temporary_directories.push(model_dir)
  const dc_case = validPlan().cases[0]
  if (!dc_case) throw new Error("Expected a DC case")
  const failure = new ProcessError({
    code: "process_spawn_failed",
    command_label: "ngspice validation",
    message: "ngspice executable was not found",
  })

  await expect(
    runSpiceValidation({
      plan: { ...validPlan(), cases: [dc_case] },
      manifest,
      model_source,
      model_dir,
      model_contract: modelContract(model_requirements.slice(0, 1)),
      ngspice: async () => {
        throw failure
      },
    }),
  ).rejects.toBe(failure)
})

test("simulator timeouts propagate as infrastructure failures", async () => {
  const model_dir = await mkdtemp(join(tmpdir(), "spice-validation-timeout-"))
  temporary_directories.push(model_dir)
  const dc_case = validPlan().cases[0]
  if (!dc_case) throw new Error("Expected a DC case")
  const failure = new ProcessError({
    code: "process_wall_timeout",
    command_label: "ngspice validation",
    message: "ngspice validation exceeded its absolute time limit",
  })

  await expect(
    runSpiceValidation({
      plan: { ...validPlan(), cases: [dc_case] },
      manifest,
      model_source,
      model_dir,
      model_contract: modelContract(model_requirements.slice(0, 1)),
      ngspice: async () => {
        throw failure
      },
    }),
  ).rejects.toBe(failure)
})

const ngspice_path = Bun.which("ngspice")
const testWithNgspice = ngspice_path ? test : test.skip

testWithNgspice("runs real ngspice DC and transient cases and persists replay artifacts", async () => {
  const model_dir = await mkdtemp(join(tmpdir(), "spice-validation-real-"))
  temporary_directories.push(model_dir)
  const result = await runSpiceValidation({
    plan: validPlan(),
    manifest,
    model_source,
    model_dir,
    model_contract: modelContract(),
    ngspice_path: ngspice_path ?? undefined,
  })
  expect(result.passed).toBe(true)
  expect(result.cases.map((validation_case) => validation_case.status)).toEqual(["passed", "passed"])
  expect(result.hashes.model_sha256).toHaveLength(64)
  for (const case_id of ["dc_gain", "transient_gain"]) {
    const case_dir = join(model_dir, "validation", "generated", case_id)
    expect((await readFile(join(case_dir, "circuit.cir"), "utf8")).length).toBeGreaterThan(20)
    expect((await readFile(join(case_dir, "result.raw"), "utf8")).length).toBeGreaterThan(20)
    expect(JSON.parse(await readFile(join(case_dir, "result.json"), "utf8"))).toMatchObject({
      case_id,
      status: "passed",
    })
  }
})
