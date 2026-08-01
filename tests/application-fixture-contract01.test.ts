import { describe, expect, test } from "bun:test"
import type { AnyCircuitElement } from "circuit-json"
import { mkdtemp, rm } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseTypicalApplicationPlan } from "@/server/component-workflow/application-plan"
import { BunProcessRunner } from "@/server/infrastructure/process"
import { TSCIRCUIT_RUNTIME_CONFIG } from "@/server/job-scaffold/tscircuit-runtime-config"
import { buildValidationCircuitPreviews } from "@/server/model-workflow/validation-circuit-previews"
import {
  ApplicationConditionConflictError,
  compileApplicationFixtureContract,
  parseApplicationFixtureContract,
  recompileApplicationFixtureContractFromSources,
  resolveApplicationFixtureForBinding,
} from "@/server/modeling/application-fixture-contract"
import { renderValidationCaseTsx } from "@/server/modeling/ui-projection"
import { createModelManifest } from "@/server/modeling/model-artifacts"
import type { ModelInterface, ModelReferenceElectricalBinding } from "@/server/modeling/types"
import {
  compileValidationCase,
  parseAgentValidationPlan,
  parseValidationPlan,
  runSpiceValidation,
  ValidationPlanError,
} from "@/server/spice-validation"
import type { ModelManifest } from "@/shared/job-types"

const PLAN_SHA256 = "1".repeat(64)
const PDF_SHA256 = "2".repeat(64)
const tsciPath = Bun.which("tsci")
const ngspicePath = Bun.which("ngspice")
const testWithProductionSimulation = tsciPath && ngspicePath ? test : test.skip

const interface10Pin: ModelInterface = {
  version: 1,
  part_number: "TPS63802",
  entry_name: "TPS63802",
  pins: [
    ["1", "EN", "input"],
    ["2", "MODE", "input"],
    ["3", "AGND", "ground"],
    ["4", "FB", "input"],
    ["5", "PG", "output"],
    ["6", "VOUT", "power_output"],
    ["7", "L2", "passive"],
    ["8", "GND", "ground"],
    ["9", "L1", "passive"],
    ["10", "VIN", "power_input"],
  ].map(([physical_pin, label, role], index) => ({
    physical_pin: physical_pin!,
    component_pin: `pin${physical_pin}`,
    source_port_id: `source_port_${index}`,
    spice_node: label!,
    labels: [label!],
    role: role!,
  })),
}

test("server-owned application fixture contract derives ground from an authoritative DUT ground pin", () => {
  const model_interface: ModelInterface = {
    version: 1,
    part_number: "SOLID-2",
    entry_name: "SOLID_2",
    pins: [
      {
        physical_pin: "1",
        component_pin: "pin1",
        source_port_id: "source_port_1",
        spice_node: "INPUT",
        labels: ["INPUT"],
        role: "input",
      },
      {
        physical_pin: "2",
        component_pin: "pin2",
        source_port_id: "source_port_2",
        spice_node: "RETURN",
        labels: ["RETURN"],
        role: "ground",
      },
    ],
  }
  const plan = parseTypicalApplicationPlan(
    {
      version: 4,
      availability: "documented",
      pcb_implementation: "schematic_only",
      title: "Two-pin bypass application",
      description: "The return pin establishes the reference node.",
      source_references: [
        {
          page: 1,
          figure: "Typical application",
          method: "pdf_visual",
          confidence: "high",
          image: "visual-reference/typical-application.png",
          render_dpi: 200,
        },
      ],
      components: [
        { reference: "U1", kind: "integrated_circuit", value: "SOLID-2" },
        { reference: "C1", kind: "capacitor", value: "100nF" },
      ],
      connections: [
        { net: "INPUT", pins: ["U1.INPUT", "C1.1"] },
        { net: "RETURN", pins: ["U1.RETURN", "C1.2"] },
      ],
    },
    { part_number: "SOLID-2" },
  )
  const contract = compileApplicationFixtureContract({
    plan,
    model_interface,
    source_plan_sha256: PLAN_SHA256,
    source_pdf_sha256: PDF_SHA256,
  })
  expect(contract.node_groups.find(({ is_ground }) => is_ground)?.source_net).toBe("RETURN")
})

function run93Plan() {
  return parseTypicalApplicationPlan(
    {
      version: 4,
      availability: "documented",
      pcb_implementation: "schematic_only",
      title: "3.3 VOUT Typical Application",
      description: "TPS63802 buck-boost converter application from Figure 10-1.",
      source_references: [
        {
          page: 17,
          figure: "Figure 10-1. 3.3 VOUT Typical Application",
          method: "pdf_visual",
          confidence: "high",
          image: "visual-reference/typical-application.png",
          render_dpi: 200,
        },
      ],
      components: [
        {
          reference: "U1",
          kind: "integrated_circuit",
          value: "TPS63802",
          manufacturer_part_number: "TPS63802DLAR",
        },
        { reference: "L1", kind: "inductor", value: "0.47 µH" },
        { reference: "C1", kind: "capacitor", value: "10 µF" },
        { reference: "C2", kind: "capacitor", value: "22 µF" },
        { reference: "R1", kind: "resistor", value: "511 kΩ" },
        { reference: "R2", kind: "resistor", value: "91 kΩ" },
        { reference: "R3", kind: "resistor", value: "100 kΩ" },
      ],
      connections: [
        { net: "VIN", pins: ["U1.VIN", "U1.EN", "C1.1", "R3.1", "VIN"] },
        { net: "L1", pins: ["U1.L1", "L1.1"] },
        { net: "L2", pins: ["U1.L2", "L1.2"] },
        { net: "VOUT", pins: ["U1.VOUT", "C2.1", "R1.1", "VOUT"] },
        { net: "PG", pins: ["U1.PG", "R3.2"] },
        { net: "FB", pins: ["U1.FB", "R1.2", "R2.1"] },
        {
          net: "GND",
          pins: ["U1.MODE", "U1.GND", "U1.AGND", "C1.2", "C2.2", "R2.2", "GND"],
        },
      ],
    },
    { part_number: "TPS63802", ordering_code: "TPS63802DLAR" },
  )
}

function binding(
  mode: "low" | "high",
  contract_sha256: string,
): ModelReferenceElectricalBinding & {
  application_fixture_sha256: string
} {
  return {
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
        low: 0.05,
        high: 1.5,
        delay: 20e-6,
        rise: 1e-6,
        fall: 1e-6,
        width: 180e-6,
        period: 400e-6,
      },
    },
    auxiliary_fixtures: [
      {
        type: "dc_voltage",
        positive: "dut.VIN",
        negative: "gnd",
        dc_volts: 3.6,
      },
      {
        type: "logic_state",
        endpoint: "dut.MODE",
        reference: mode === "low" ? "gnd" : "dut.VIN",
        state: mode,
      },
    ],
    application_fixture_sha256: contract_sha256,
  }
}

function exactBoundBinding(
  mode: "low" | "high",
  contract: ReturnType<typeof compileApplicationFixtureContract>,
): ModelReferenceElectricalBinding {
  const base = binding(mode, contract.contract_sha256)
  const resolved = resolveApplicationFixtureForBinding({ contract, binding: base })
  return { ...base, application_topology_sha256: resolved.topology_sha256 }
}

const manifest10Pin: ModelManifest = {
  version: 1,
  part_number: "TPS63802",
  dialect: "portable",
  entry_name: "TPS63802",
  model_file: "model.lib",
  revision: "application-fixture-test",
  simulator: "ngspice",
  generated_at: "2026-08-01T00:00:00.000Z",
  pins: interface10Pin.pins.map(({ component_pin, spice_node }) => ({ component_pin, spice_node })),
}

function applicationRequirement(binding: ModelReferenceElectricalBinding) {
  return {
    requirement_id: "load_transient",
    title: "Load transient",
    behavior: "VOUT follows the printed load transient",
    analysis: "transient" as const,
    support: { status: "modeled" as const },
    conditions: {},
    expected: { unit: "V", target: 3.3 },
    reference_curve: {
      x_quantity: "time",
      x_unit: "s",
      y_quantity: "voltage",
      y_unit: "V",
      tolerance: 0.05,
      points: [
        { x: 0, y: 3.3 },
        { x: 20e-6, y: 3.3 },
        { x: 40e-6, y: 3.22 },
        { x: 60e-6, y: 3.27 },
        { x: 100e-6, y: 3.3 },
        { x: 140e-6, y: 3.3 },
        { x: 180e-6, y: 3.3 },
        { x: 200e-6, y: 3.3 },
      ],
      electrical_binding: binding,
    },
    sources: [{ page: 24, locator: "Figure 10-24", statement: "Load transient" }],
  }
}

function applicationAgentProposal(mode: "low" | "high", exact_binding: ModelReferenceElectricalBinding) {
  return {
    version: 1,
    model: { entry_name: "TPS63802", pins: interface10Pin.pins.map(({ spice_node }) => spice_node) },
    cases: [
      {
        id: `load_transient_mode_${mode}`,
        requirement_ids: ["load_transient"],
        nets: [],
        fixtures: [
          {
            id: "load_step",
            type: "current_source",
            positive: "dut.VOUT",
            negative: "gnd",
            dc_amps: exact_binding.stimulus.pulse.low,
            pulse: structuredClone(exact_binding.stimulus.pulse),
          },
          {
            id: "vin_supply",
            type: "voltage_source",
            positive: "dut.VIN",
            negative: "gnd",
            dc_volts: 3.6,
          },
        ],
        analysis: { type: "transient", step: 1e-6, stop: 200e-6 },
        observations: [
          {
            id: "vout",
            requirement_id: "load_transient",
            type: "voltage",
            positive: "dut.VOUT",
            negative: "gnd",
            unit: "V",
            scale: "linear",
          },
        ],
      },
    ],
  }
}

describe("server-owned application fixture contract", () => {
  test("publication recompiles retained plan and PDF bytes instead of trusting matching declarations", () => {
    const source = { page: 1, method: "pdf_text", confidence: "high" }
    const visual_source = {
      page: 1,
      figure: "Package",
      method: "pdf_visual",
      confidence: "high",
      image: "visual-reference/package.png",
      render_dpi: 200,
    }
    const source_evidence_bytes = new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        status: "resolved",
        part_number: { value: "TPS63802", sources: [source] },
        ordering_code: { value: "TPS63802DLAR", sources: [source] },
        package: {
          name: { value: "Test package", sources: [source] },
          pin_count: { value: 1, sources: [source] },
        },
        pinout: {
          pins: [{ number: "1", labels: ["EN"], role: "input", sources: [source] }],
        },
        footprint: {
          view: "pcb_top",
          units: "mm",
          drawing_orientation: { value: "pcb_top", sources: [visual_source] },
          pads: [
            {
              pin: "1",
              kind: "smt",
              x: 0,
              y: 0,
              width: 1,
              height: 1,
              sources: [visual_source],
            },
          ],
        },
        unresolved_ambiguities: [],
      }),
    )
    const source_plan_bytes = new TextEncoder().encode(
      JSON.stringify({
        version: 4,
        availability: "not_present",
        title: "No application",
        description: "No typical application was printed.",
        source_references: [source],
        searched_sections: ["application information"],
        components: [],
        connections: [],
      }),
    )
    const source_pdf_bytes = new TextEncoder().encode("%PDF-1.4\nfixture\n")
    const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
    const standalone = compileApplicationFixtureContract({
      plan: parseTypicalApplicationPlan(JSON.parse(new TextDecoder().decode(source_plan_bytes))),
      model_interface: interface10Pin,
      source_plan_sha256: sha256(source_plan_bytes),
      source_pdf_sha256: sha256(source_pdf_bytes),
    })

    expect(
      recompileApplicationFixtureContractFromSources({
        source_plan_bytes,
        source_pdf_bytes,
        source_evidence_bytes,
        model_interface: interface10Pin,
        standalone_contract: standalone,
        embedded_contract: structuredClone(standalone),
      }),
    ).toEqual(standalone)
    expect(() =>
      recompileApplicationFixtureContractFromSources({
        source_plan_bytes,
        source_pdf_bytes: new TextEncoder().encode("%PDF-1.4\ntampered\n"),
        source_evidence_bytes,
        model_interface: interface10Pin,
        standalone_contract: standalone,
        embedded_contract: structuredClone(standalone),
      }),
    ).toThrow("does not exactly recompile from retained plan/PDF sources")
  })

  test("compiles the exact run93 10-pin application into SI node groups and passives", () => {
    const contract = compileApplicationFixtureContract({
      plan: run93Plan(),
      model_interface: interface10Pin,
      source_plan_sha256: PLAN_SHA256,
      source_pdf_sha256: PDF_SHA256,
    })

    expect(contract.availability).toBe("documented")
    expect(contract.node_groups).toHaveLength(7)
    expect(contract.ground_node_group_id).toBe("app_net_007")
    expect(contract.node_groups.map(({ source_net }) => source_net)).toEqual([
      "VIN",
      "L1",
      "L2",
      "VOUT",
      "PG",
      "FB",
      "GND",
    ])
    expect(contract.node_groups[0]).toEqual({
      id: "app_net_001",
      source_net: "VIN",
      is_ground: false,
      source_endpoints: ["U1.VIN", "U1.EN", "C1.1", "R3.1", "VIN"],
      dut_endpoints: ["dut.VIN", "dut.EN"],
      external_terminals: ["VIN"],
    })
    expect(contract.node_groups[6]).toEqual({
      id: "app_net_007",
      source_net: "GND",
      is_ground: true,
      source_endpoints: ["U1.MODE", "U1.GND", "U1.AGND", "C1.2", "C2.2", "R2.2", "GND"],
      dut_endpoints: ["dut.MODE", "dut.GND", "dut.AGND"],
      external_terminals: ["GND"],
    })
    expect(contract.node_groups.flatMap(({ dut_endpoints }) => dut_endpoints)).toHaveLength(10)
    expect(contract.fixtures).toEqual([
      {
        id: "app_l1",
        reference: "L1",
        source_terminals: ["L1.1", "L1.2"],
        type: "inductor",
        positive: "net.app_net_002",
        negative: "net.app_net_003",
        inductance_henries: 0.47e-6,
      },
      {
        id: "app_c1",
        reference: "C1",
        source_terminals: ["C1.1", "C1.2"],
        type: "capacitor",
        positive: "net.app_net_001",
        negative: "gnd",
        capacitance_farads: 10e-6,
      },
      {
        id: "app_c2",
        reference: "C2",
        source_terminals: ["C2.1", "C2.2"],
        type: "capacitor",
        positive: "net.app_net_004",
        negative: "gnd",
        capacitance_farads: 22e-6,
      },
      {
        id: "app_r1",
        reference: "R1",
        source_terminals: ["R1.1", "R1.2"],
        type: "resistor",
        positive: "net.app_net_004",
        negative: "net.app_net_006",
        resistance_ohms: 511e3,
      },
      {
        id: "app_r2",
        reference: "R2",
        source_terminals: ["R2.1", "R2.2"],
        type: "resistor",
        positive: "net.app_net_006",
        negative: "gnd",
        resistance_ohms: 91e3,
      },
      {
        id: "app_r3",
        reference: "R3",
        source_terminals: ["R3.1", "R3.2"],
        type: "resistor",
        positive: "net.app_net_001",
        negative: "net.app_net_005",
        resistance_ohms: 100e3,
      },
    ])
    expect(parseApplicationFixtureContract(JSON.parse(JSON.stringify(contract)))).toEqual(contract)
    expect(
      compileApplicationFixtureContract({
        plan: run93Plan(),
        model_interface: interface10Pin,
        source_plan_sha256: PLAN_SHA256,
        source_pdf_sha256: PDF_SHA256,
      }).contract_sha256,
    ).toBe(contract.contract_sha256)
  })

  test.each(["low", "high"] as const)("detaches only MODE for a printed MODE-%s experiment", (mode) => {
    const contract = compileApplicationFixtureContract({
      plan: run93Plan(),
      model_interface: interface10Pin,
      source_plan_sha256: PLAN_SHA256,
      source_pdf_sha256: PDF_SHA256,
    })
    const resolved = resolveApplicationFixtureForBinding({
      contract,
      binding: binding(mode, contract.contract_sha256),
    })

    const ground = resolved.node_groups.find(({ is_ground }) => is_ground)!
    expect(ground.dut_endpoints).toEqual(["dut.GND", "dut.AGND"])
    expect(resolved.node_groups[0]!.dut_endpoints).toEqual(["dut.VIN", "dut.EN"])
    expect(resolved.condition_overlays).toEqual([
      {
        type: "logic_state",
        endpoint: "dut.MODE",
        reference: mode === "low" ? "gnd" : "dut.VIN",
        state: mode,
        detached_from_node_group_id: "app_net_007",
      },
    ])
    expect(resolved.fixtures).toEqual(contract.fixtures)
    expect(resolved.topology_sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  test("reports a typed conflict instead of guessing an overlay topology", () => {
    const contract = compileApplicationFixtureContract({
      plan: run93Plan(),
      model_interface: interface10Pin,
      source_plan_sha256: PLAN_SHA256,
      source_pdf_sha256: PDF_SHA256,
    })
    const invalid = binding("high", contract.contract_sha256)
    invalid.auxiliary_fixtures![1] = {
      type: "logic_state",
      endpoint: "dut.NOT_A_PIN",
      reference: "dut.VIN",
      state: "high",
    }

    try {
      resolveApplicationFixtureForBinding({ contract, binding: invalid })
      throw new Error("expected resolveApplicationFixtureForBinding to reject")
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationConditionConflictError)
      expect((error as ApplicationConditionConflictError).code).toBe("application_condition_conflict")
      expect((error as Error).message).toContain("uniquely detachable U1 leaf")
    }
  })

  test("rejects detaching the only U1 anchor from a non-ground passive branch", () => {
    const contract = compileApplicationFixtureContract({
      plan: run93Plan(),
      model_interface: interface10Pin,
      source_plan_sha256: PLAN_SHA256,
      source_pdf_sha256: PDF_SHA256,
    })
    const invalid = binding("high", contract.contract_sha256)
    invalid.auxiliary_fixtures = [
      {
        type: "logic_state",
        endpoint: "dut.PG",
        reference: "dut.VIN",
        state: "high",
      },
    ]

    try {
      resolveApplicationFixtureForBinding({ contract, binding: invalid })
      throw new Error("expected resolveApplicationFixtureForBinding to reject")
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationConditionConflictError)
      expect((error as ApplicationConditionConflictError).code).toBe("application_condition_conflict")
      expect((error as Error).message).toContain("only electrical anchor")
      expect((error as Error).message).toContain("orphan a required passive/network")
    }
  })

  test("rejects changed topology even when the JSON shape remains valid", () => {
    const contract = compileApplicationFixtureContract({
      plan: run93Plan(),
      model_interface: interface10Pin,
      source_plan_sha256: PLAN_SHA256,
      source_pdf_sha256: PDF_SHA256,
    })
    const changed = structuredClone(contract)
    const r1 = changed.fixtures.find(({ id }) => id === "app_r1")
    if (!r1 || r1.type !== "resistor") throw new Error("test fixture lost R1")
    r1.resistance_ohms = 510e3

    expect(() => parseApplicationFixtureContract(changed)).toThrow(
      "contract_sha256 does not match the exact application topology",
    )
  })

  test("rejects an application that silently drops a public U1 pin", () => {
    const plan = run93Plan()
    plan.connections.find(({ net }) => net === "GND")!.pins = plan.connections
      .find(({ net }) => net === "GND")!
      .pins.filter((endpoint) => endpoint !== "U1.AGND")

    expect(() =>
      compileApplicationFixtureContract({
        plan,
        model_interface: interface10Pin,
        source_plan_sha256: PLAN_SHA256,
        source_pdf_sha256: PDF_SHA256,
      }),
    ).toThrow("omits public U1 endpoints: dut.AGND")
  })

  test.each(["low", "high"] as const)(
    "injects and electrically compiles the exact MODE-%s application in ngspice and TSX",
    (mode) => {
      const contract = compileApplicationFixtureContract({
        plan: run93Plan(),
        model_interface: interface10Pin,
        source_plan_sha256: PLAN_SHA256,
        source_pdf_sha256: PDF_SHA256,
      })
      const exact_binding = exactBoundBinding(mode, contract)
      const requirement = applicationRequirement(exact_binding)
      const context = {
        model_interface: interface10Pin,
        model_requirements: [requirement],
        model_family: "power_converter" as const,
        application_fixture: contract,
      }
      const plan = parseAgentValidationPlan(applicationAgentProposal(mode, exact_binding), context)
      const validation_case = plan.cases[0]!

      expect(validation_case.nets).toEqual([
        "app_net_001",
        "app_net_002",
        "app_net_003",
        "app_net_004",
        "app_net_005",
        "app_net_006",
      ])
      expect(validation_case.fixtures.map(({ id }) => id)).toEqual([
        "load_step",
        "vin_supply",
        "app_l1",
        "app_c1",
        "app_c2",
        "app_r1",
        "app_r2",
        "app_r3",
      ])
      expect(validation_case.application_fixture?.topology_sha256).toBe(
        exact_binding.application_topology_sha256,
      )
      expect(() => parseValidationPlan(JSON.parse(JSON.stringify(plan)), context)).not.toThrow()

      const compiled = compileValidationCase(validation_case, manifest10Pin)
      expect(compiled.source).toContain(
        mode === "low"
          ? "X_DUT n_net_app_net_001 0 0 n_net_app_net_006 n_net_app_net_005 n_net_app_net_004 n_net_app_net_003 0 n_net_app_net_002 n_net_app_net_001 TPS63802"
          : "X_DUT n_net_app_net_001 n_net_app_net_001 0 n_net_app_net_006 n_net_app_net_005 n_net_app_net_004 n_net_app_net_003 0 n_net_app_net_002 n_net_app_net_001 TPS63802",
      )
      expect(compiled.source).toContain("L_app_l1 n_net_app_net_002 n_net_app_net_003 4.7e-7")
      expect(compiled.source).toContain("C_app_c1 n_net_app_net_001 0 0.00001")
      expect(compiled.source).toContain("R_app_r1 n_net_app_net_004 n_net_app_net_006 511000")
      expect(compiled.source).toContain("R_app_r3 n_net_app_net_001 n_net_app_net_005 100000")
      expect(compiled.source).not.toContain("V_mode_state")

      const source = renderValidationCaseTsx({
        validation_case,
        manifest: manifest10Pin,
        model_source:
          ".SUBCKT TPS63802 EN MODE AGND FB PG VOUT L2 GND L1 VIN\nR_DUMMY VOUT GND 1G\n.ENDS TPS63802\n",
        model_card: "# TPS63802 application test",
      })
      expect(source).toContain('<trace from=".DUT > .pin10" to="net.app_net_001" />')
      expect(source).toContain('<trace from=".DUT > .pin1" to="net.app_net_001" />')
      expect(source).toContain('<trace from=".DUT > .pin3" to="net.GND" />')
      expect(source).toContain('<trace from=".DUT > .pin8" to="net.GND" />')
      expect(source).toContain(
        mode === "low"
          ? '<trace from=".DUT > .pin2" to="net.GND" />'
          : '<trace from=".DUT > .pin2" to=".DUT > .pin10" />',
      )
      expect(source).not.toContain('<trace from=".DUT > .pin2" to="net.app_net_001" />')
      expect(source).toContain('<trace from=".app_c1 > .pin1" to="net.app_net_001" />')
      expect(source).toContain('<trace from=".app_r3 > .pin2" to="net.app_net_005" />')
      expect(source).not.toContain('<voltagesource name="mode_state"')
      expect(() => new Bun.Transpiler({ loader: "tsx" }).transformSync(source)).not.toThrow()
    },
  )

  test("strict persisted parsing rejects missing, changed, duplicate, and extra application topology", () => {
    const contract = compileApplicationFixtureContract({
      plan: run93Plan(),
      model_interface: interface10Pin,
      source_plan_sha256: PLAN_SHA256,
      source_pdf_sha256: PDF_SHA256,
    })
    const exact_binding = exactBoundBinding("high", contract)
    const context = {
      model_interface: interface10Pin,
      model_requirements: [applicationRequirement(exact_binding)],
      model_family: "power_converter" as const,
      application_fixture: contract,
    }
    const canonical = parseAgentValidationPlan(applicationAgentProposal("high", exact_binding), context)
    const errorCodes = (plan: unknown): string[] => {
      try {
        parseValidationPlan(plan, context)
        throw new Error("expected strict persisted plan rejection")
      } catch (error) {
        if (!(error instanceof ValidationPlanError)) throw error
        return error.errors.map(({ code }) => code)
      }
    }

    const missing = structuredClone(canonical)
    missing.cases[0]!.fixtures = missing.cases[0]!.fixtures.filter(({ id }) => id !== "app_r1")
    expect(errorCodes(missing)).toContain("application_fixture_passive_count")

    const changed = structuredClone(canonical)
    const changed_r1 = changed.cases[0]!.fixtures.find(({ id }) => id === "app_r1")
    if (!changed_r1 || changed_r1.type !== "resistor") throw new Error("test plan lost R1")
    changed_r1.resistance_ohms = 510_000
    expect(errorCodes(changed)).toEqual(
      expect.arrayContaining(["application_fixture_changed_passive", "application_fixture_passive_count"]),
    )

    const duplicate = structuredClone(canonical)
    duplicate.cases[0]!.fixtures.push(structuredClone(duplicate.cases[0]!.fixtures[0]!))
    expect(errorCodes(duplicate)).toEqual(
      expect.arrayContaining(["duplicate_id", "requirement_stimulus_mismatch"]),
    )

    const extra = structuredClone(canonical)
    extra.cases[0]!.fixtures.push({
      id: "hidden_hack",
      type: "resistor",
      positive: "dut.VOUT",
      negative: "gnd",
      resistance_ohms: 1,
    })
    expect(errorCodes(extra)).toContain("application_fixture_extra_passive")

    const parallel_source = structuredClone(canonical)
    parallel_source.cases[0]!.fixtures.push({
      id: "parallel_mode",
      type: "voltage_source",
      positive: "dut.MODE",
      negative: "dut.VIN",
      dc_volts: 0,
    })
    expect(errorCodes(parallel_source)).toEqual(
      expect.arrayContaining(["unbound_bound_condition_source", "application_fixture_extra_source"]),
    )

    const topology = structuredClone(canonical)
    topology.cases[0]!.application_fixture!.node_groups[6]!.dut_endpoints.push("dut.MODE")
    expect(errorCodes(topology)).toContain("application_fixture_topology_mismatch")
  })

  for (const runtime_mode of ["low", "high"] as const) {
    testWithProductionSimulation(
      `runs the exact MODE-${runtime_mode} application through real ngspice and installed tscircuit Circuit JSON`,
      async () => {
        const contract = compileApplicationFixtureContract({
          plan: run93Plan(),
          model_interface: interface10Pin,
          source_plan_sha256: PLAN_SHA256,
          source_pdf_sha256: PDF_SHA256,
        })
        const exact_binding = exactBoundBinding(runtime_mode, contract)
        const requirement = applicationRequirement(exact_binding)
        // Analytic response of the model's 50 mohms Thevenin regulator into the
        // canonical 22 uF output capacitor and the exact 50 mA -> 1.5 A ramp.
        requirement.reference_curve.points = [
          { x: 11e-6, y: 3.2975 },
          { x: 20e-6, y: 3.2975 },
          { x: 21e-6, y: 3.27263 },
          { x: 22e-6, y: 3.24419 },
          { x: 23e-6, y: 3.23273 },
          { x: 24e-6, y: 3.22812 },
          { x: 25e-6, y: 3.22625 },
          { x: 26e-6, y: 3.2255 },
          { x: 30e-6, y: 3.22501 },
          { x: 40e-6, y: 3.225 },
          { x: 100e-6, y: 3.225 },
          { x: 200e-6, y: 3.225 },
        ]
        const proposal = applicationAgentProposal(runtime_mode, exact_binding)
        ;(proposal.cases[0]!.analysis as { start?: number }).start = 10e-6
        const plan = parseAgentValidationPlan(proposal, {
          model_interface: interface10Pin,
          model_requirements: [requirement],
          model_family: "power_converter",
          application_fixture: contract,
        })
        const model_source = `.SUBCKT TPS63802 EN MODE AGND FB PG VOUT L2 GND L1 VIN
R_EN EN GND 1G
R_MODE MODE GND 1G
R_AGND AGND GND 1G
R_FB FB GND 1G
R_PG PG GND 1G
B_REG NREG GND V=3.3
R_REG NREG VOUT 0.05
R_L2 L2 GND 1G
R_L1 L1 GND 1G
R_VIN VIN GND 1G
.ENDS TPS63802
`
        const generated = {
          source: model_source,
          card: "# Exact application boundary fixture",
          manifest: createModelManifest({
            model_interface: interface10Pin,
            model_source,
            simulator: "ngspice",
          }),
        }
        const model_dir = await mkdtemp(join(tmpdir(), "application-fixture-real-"))
        try {
          await Promise.all([
            Bun.write(join(model_dir, "tscircuit.config.ts"), TSCIRCUIT_RUNTIME_CONFIG),
            Bun.write(join(model_dir, "tscircuit.config.json"), "{}\n"),
          ])
          const result = await runSpiceValidation({
            plan,
            manifest: generated.manifest,
            model_source,
            model_dir,
            model_contract: {
              version: 1,
              interface: interface10Pin,
              characterization: {
                version: 1,
                family: "power_converter",
                strategy: "behavioral",
                requirements: [requirement],
                assumptions: [],
                limitations: [],
              },
              application_fixture: contract,
            },
            ngspice_path: ngspicePath!,
          })
          if (!result.passed) {
            throw new Error(
              `Server ngspice did not reproduce the analytic curve:\n${JSON.stringify(result, null, 2)}`,
            )
          }
          expect(result.cases[0]?.status).toBe("passed")

          const preview = await buildValidationCircuitPreviews({
            model_dir,
            plan,
            generated,
            tsci_bin: tsciPath!,
            process_runner: new BunProcessRunner(),
            signal: new AbortController().signal,
            append: () => undefined,
          })
          const case_id = plan.cases[0]!.id
          if (preview.circuit_build_errors_by_case[case_id]) {
            const source_only_plan = structuredClone(plan)
            source_only_plan.cases[0]!.analysis = { type: "operating_point" }
            const source_only = await buildValidationCircuitPreviews({
              model_dir,
              plan: source_only_plan,
              generated,
              tsci_bin: tsciPath!,
              process_runner: new BunProcessRunner(),
              signal: new AbortController().signal,
              append: () => undefined,
            })
            const topology = source_only.circuit_json_by_case[case_id] as
              | Array<AnyCircuitElement & Record<string, unknown>>
              | undefined
            const relevant = topology?.filter(({ type }) =>
              ["source_component", "source_port", "source_net", "source_trace"].includes(type),
            )
            throw new Error(
              `${preview.circuit_build_errors_by_case[case_id]}\nSource-only topology:\n${JSON.stringify(relevant, null, 2)}`,
            )
          }
          if (preview.errors_by_case[case_id]) {
            throw new Error(preview.errors_by_case[case_id])
          }
          expect(preview.viewer_validation_by_case[case_id]).toMatchObject({
            simulation_valid: true,
            passed: true,
          })
          const circuit_json = preview.circuit_json_by_case[case_id]
          expect(circuit_json).toBeDefined()
          if (!circuit_json) throw new Error("installed tsci produced no Circuit JSON")
          const records = circuit_json as Array<AnyCircuitElement & Record<string, unknown>>
          const sourceNet = (name: string) =>
            records.find((record) => record.type === "source_net" && record.name === name)
          const component = (name: string) =>
            records.find((record) => record.type === "source_component" && record.name === name)
          const port = (component_id: unknown, hint: string) =>
            records.find(
              (record) =>
                record.type === "source_port" &&
                record.source_component_id === component_id &&
                Array.isArray(record.port_hints) &&
                record.port_hints.includes(hint),
            )
          const netIdsForPort = (source_port_id: unknown): string[] => {
            if (typeof source_port_id !== "string") return []
            return records.flatMap((record) =>
              record.type === "source_trace" &&
              Array.isArray(record.connected_source_port_ids) &&
              record.connected_source_port_ids.includes(source_port_id) &&
              Array.isArray(record.connected_source_net_ids)
                ? (record.connected_source_net_ids as string[])
                : [],
            )
          }

          const vin_net_id = sourceNet("app_net_001")?.source_net_id
          const ground_net_id = sourceNet("GND")?.source_net_id
          const dut = component("DUT")
          const vin = port(dut?.source_component_id, "VIN")
          const en = port(dut?.source_component_id, "EN")
          const mode = port(dut?.source_component_id, "MODE")
          expect(vin_net_id).toBeString()
          expect(ground_net_id).toBeString()
          if (typeof vin_net_id !== "string") throw new Error("application VIN net has no string id")
          if (typeof ground_net_id !== "string") throw new Error("application ground net has no string id")
          expect(netIdsForPort(vin?.source_port_id)).toEqual([vin_net_id])
          expect(netIdsForPort(en?.source_port_id)).toEqual([vin_net_id])
          expect(netIdsForPort(mode?.source_port_id)).toEqual(runtime_mode === "low" ? [ground_net_id] : [])

          const c1 = component("app_c1")
          const r3 = component("app_r3")
          expect(netIdsForPort(port(c1?.source_component_id, "pin1")?.source_port_id)).toEqual([vin_net_id])
          expect(netIdsForPort(port(r3?.source_component_id, "pin1")?.source_port_id)).toEqual([vin_net_id])
          expect(
            records.filter((record) => record.type === "source_component" && record.name === "mode_state"),
          ).toHaveLength(0)
        } finally {
          await rm(model_dir, { recursive: true, force: true })
        }
      },
      45_000,
    )
  }
})
