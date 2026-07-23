import { expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildAgentPrompt,
  buildComponentPrompt,
  buildTypicalApplicationEvidenceVerificationPrompt,
  buildTypicalApplicationPrompt,
  getForbiddenDatasheetAccesses,
  getTypicalApplicationPlanAgreementErrors,
  parseTypicalApplicationPlan,
  runJob,
} from "@/server/job-runner"
import { JobStore } from "@/server/job-store"

const fakeVisualInspectionHelpers = `
if (!(await Bun.file(dir + "/photon_rs_bg.wasm").exists())) {
  throw new Error("agent image runtime canary is missing")
}
let eventSequence = 0
function emitAgentEvent(event) {
  console.log(JSON.stringify({ protocol: "tsci-agent-event-v1", sequence: ++eventSequence, ...event }))
}
function emitText(text) {
  emitAgentEvent({ type: "text_delta", text })
}
function emitThinking(text) {
  emitAgentEvent({ type: "thinking_delta", text })
}
function finishAgent() {
  emitAgentEvent({ type: "agent_end", failed: false })
}
const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (character) => character.charCodeAt(0))
async function recordVisualInspection(kind, status = "passed", resultHasImage = true, buildFlags = "") {
  const component = kind === "component"
  const pcbDisabled = !component && buildFlags.includes("--disable-pcb")
  const reference = component ? "visual-reference/land-pattern.png" : "visual-reference/typical-application.png"
  const pcb = component ? "dist/index/pcb.png" : "dist/typical-application/pcb.png"
  const schematic = component ? "dist/index/schematic.png" : "dist/typical-application/schematic.png"
  const build = (component ? "tsci build index.circuit.tsx" : "tsci build typical-application.circuit.tsx") + buildFlags
  const { mkdir } = await import("node:fs/promises")
  await mkdir(dir + "/visual-reference", { recursive: true })
  await mkdir(dir + "/" + (component ? "dist/index" : "dist/typical-application"), { recursive: true })
  await Bun.write(dir + "/" + reference, png)
  if (!pcbDisabled) await Bun.write(dir + "/" + pcb, png)
  await Bun.write(dir + "/" + schematic, png)
  emitAgentEvent({ type: "tool_start", tool_call_id: "build", tool_name: "bash", args: { command: build } })
  emitAgentEvent({ type: "tool_end", tool_call_id: "build", tool_name: "bash", is_error: false, result_has_image: false })
  let readIndex = 0
  for (const path of [reference, ...(pcbDisabled ? [] : [pcb]), schematic]) {
    const tool_call_id = "read-" + readIndex++
    emitAgentEvent({ type: "tool_start", tool_call_id, tool_name: "read", args: { path } })
    emitAgentEvent({ type: "tool_end", tool_call_id, tool_name: "read", is_error: false, result_has_image: resultHasImage })
  }
  const report = { version: 1, status, reference_image: reference, ...(pcbDisabled ? {} : { pcb_image: pcb }), schematic_image: schematic }
  await Bun.write(dir + "/" + (component ? "component-visual-inspection.json" : "application-visual-inspection.json"), JSON.stringify(report))
}
async function recordEvidence(plan, options = {}) {
  const { mkdir } = await import("node:fs/promises")
  const reference = "visual-reference/typical-application.png"
  const landReference = "visual-reference/land-pattern.png"
  const applicationPng = options.distinctEvidenceImages ? Uint8Array.from([...png, 1]) : png
  const source = { page: 9, figure: "Land pattern", method: "pdf_visual", confidence: "high", image: landReference, render_dpi: 200 }
  const componentEvidence = {
    version: 1,
    status: options.status ?? "resolved",
    part_number: { value: options.partNumber ?? "SENSOR-1", sources: [source] },
    package: {
      name: { value: "TEST-1", sources: [source] },
      code: { value: options.packageCode ?? "T1", sources: [source] },
      pin_count: { value: 1, sources: [source] },
    },
    pinout: {
      pins: [{ number: "1", labels: ["VCC"], role: "power_input", sources: [source] }],
    },
    footprint: {
      view: "pcb_top",
      units: "mm",
      drawing_orientation: { value: "pcb_top", sources: [source] },
      pads: options.emptyPads ? [] : [{ pin: "1", kind: "smt", x: 0, y: 0, width: options.padWidth ?? 0.6, height: 0.25, sources: [source] }],
    },
    unresolved_ambiguities: options.ambiguities ?? [],
  }
  const availability = plan.availability ?? "documented"
  const currentPlan = options.preserveLegacyPlan || plan.version === 4 ? plan : {
    ...plan,
    version: 4,
    availability,
    ...(availability === "documented" ? { pcb_implementation: "verified" } : {}),
    components: plan.components.map((component) => component.reference.toLowerCase() === "u1"
      ? component
      : {
          ...component,
          manufacturer_part_number: "TEST-" + component.reference.toUpperCase(),
          footprint: "0402",
          source_references: [{ page: plan.source_references[0]?.page ?? 1 }],
          footprint_source_references: [{ page: plan.source_references[0]?.page ?? 1 }],
        }),
  }
  await mkdir(dir + "/visual-reference", { recursive: true })
  await Bun.write(dir + "/" + reference, applicationPng)
  await Bun.write(dir + "/" + landReference, png)
  await Bun.write(dir + "/component-evidence.json", JSON.stringify(componentEvidence))
  await Bun.write(dir + "/typical-application-plan.json", JSON.stringify(currentPlan))
  const evidenceReferences = options.skipLandReferenceRead ? [reference] : [landReference, reference]
  for (const [index, path] of evidenceReferences.entries()) {
    const tool_call_id = "reference-read-" + index
    emitAgentEvent({ type: "tool_start", tool_call_id, tool_name: "read", args: { path } })
    emitAgentEvent({ type: "tool_end", tool_call_id, tool_name: "read", is_error: false, result_has_image: options.resultHasImage ?? true, result_text: options.resultHasImage === false ? "Read image file [image/png]\\n[Image omitted: could not be resized below the inline image size limit.]" : undefined })
  }
}
`

test("prompts separate evidence extraction from build-verified TSX generation", () => {
  const prompt = buildAgentPrompt("Use the QFN package")
  expect(prompt).toContain("datasheet.pdf")
  expect(prompt).toContain("Do not create or modify any")
  expect(prompt).toContain("component-evidence.json")
  expect(prompt).toContain("exactly 200 DPI")
  expect(prompt).toContain('status": "resolved" | "unresolved"')
  expect(prompt).toContain("typical-application-plan.json")
  expect(prompt).toContain('"version": 4')
  expect(prompt).toContain('"pcb_implementation": "verified" | "schematic_only"')
  expect(prompt).toContain("manufacturer_part_number")
  expect(prompt).toContain("footprint_source_references")
  expect(prompt).toContain("Do not write footprint-plan.json")
  expect(prompt).toContain("Always include the target IC as component U1")
  expect(prompt).toContain('description such as "open-drain bidirectional data"')
  expect(prompt).toContain("system-context blocks as external interfaces")
  expect(prompt).toContain("every visibly")
  expect(prompt).toContain("unresolved_ambiguities must be empty")
  expect(prompt).toContain("Use the QFN package")
  expect(buildAgentPrompt(undefined, "footprint schema mismatch")).toContain("footprint schema mismatch")
  const component_prompt = buildComponentPrompt("Use the QFN package")
  expect(component_prompt).toContain("approved evidence")
  expect(component_prompt).toContain("Do not open, extract, render, search")
  expect(component_prompt).toContain("tsci build")
  expect(component_prompt).toContain("placementDrcChecksDisabled")
  expect(component_prompt).toContain("tsci check netlist index.circuit.tsx")
  expect(component_prompt).toContain("tsci check placement index.circuit.tsx")
  expect(component_prompt).toContain("tsci check routing-difficulty index.circuit.tsx")
  expect(component_prompt).toContain("never chain checks")
  expect(component_prompt).toContain("requiresPower")
  expect(component_prompt).toContain("canUseOpenDrain")
  expect(component_prompt).toContain("do not add a rejected punctuation alias")
  expect(component_prompt).toContain("nearby source comment")
  expect(component_prompt).toContain("IN_NEG for IN−")
  expect(component_prompt).toContain('"pcb_image": "dist/index/pcb.png"')
  expect(buildComponentPrompt(undefined, "pinout\u0000 mismatch")).toContain("previous generation attempt")
  expect(buildComponentPrompt(undefined, "pinout\u0000 mismatch")).toContain("pinout mismatch")
  const application_prompt = buildTypicalApplicationPrompt("Use the QFN package")
  expect(application_prompt).toContain("server has independently")
  expect(application_prompt).toContain('"./index.circuit"')
  expect(application_prompt).toContain("PCB and schematic")
  expect(application_prompt).toContain("do not suppress placement DRC")
  expect(application_prompt).toContain("tsci check netlist typical-application.circuit.tsx")
  expect(application_prompt).toContain("tsci check placement typical-application.circuit.tsx")
  expect(application_prompt).toContain("tsci check routing-difficulty typical-application.circuit.tsx")
  expect(application_prompt).toContain("JSX manufacturerPartNumber prop")
  expect(application_prompt).toContain("U1.IN−")
  expect(application_prompt).toContain("IN_POS")
  expect(application_prompt).toContain("Do not modify `visual-reference/typical-application.png`")
  expect(application_prompt).toContain("Use the QFN package")
  expect(buildTypicalApplicationPrompt(undefined, "verified", "wrong net")).toContain(
    "Continue from the existing generated application source",
  )
  const schematic_only_application_prompt = buildTypicalApplicationPrompt(undefined, "schematic_only")
  expect(schematic_only_application_prompt).toContain("--disable-pcb")
  expect(schematic_only_application_prompt).toContain("omit pcb_image")
  expect(schematic_only_application_prompt).toContain("literal JSX manufacturerPartNumber prop")
  expect(schematic_only_application_prompt).toContain("required in both verified and schematic_only modes")
  expect(buildTypicalApplicationEvidenceVerificationPrompt("Use the QFN package")).toContain(
    "Use the QFN package",
  )
  expect(buildTypicalApplicationEvidenceVerificationPrompt()).toContain(
    "distinguish junction dots from bridge arcs",
  )
  expect(
    parseTypicalApplicationPlan({
      version: 2,
      title: "Typical application",
      description: "Datasheet reference circuit",
      source_references: [{ page: 8, figure: "Figure 4" }],
      components: [
        { reference: "U1", kind: "sensor" },
        { reference: "C1", kind: "capacitor", value: "1uF" },
      ],
      connections: [{ net: "VCC", pins: ["U1.VCC", "C1.pin1"] }],
    }).source_references[0]?.page,
  ).toBe(8)
})

test("application agreement compares electrical semantics instead of agent-authored wording", () => {
  const primary = parseTypicalApplicationPlan({
    version: 3,
    availability: "documented",
    title: "Converter application",
    description: "Reference circuit",
    source_references: [{ page: 8 }],
    components: [
      {
        reference: "U1",
        kind: "buck-boost converter",
        value: "TPS63802DLAR",
        purpose: "Regulates the input to 3.3 V",
      },
      { reference: "C1", kind: "capacitor", value: "10uF", purpose: "input bypass" },
    ],
    connections: [{ net: "VIN", pins: ["U1.VIN", "C1.pin1"] }],
  })
  const independently_cited = parseTypicalApplicationPlan({
    ...primary,
    source_references: [{ page: 9 }],
    components: [
      {
        reference: "U1",
        kind: "integrated_circuit",
        value: "TPS63802",
        purpose: "Non-inverting buck-boost converter",
      },
      { reference: "C1", kind: "capacitor", value: "10 µF", purpose: "VIN bypass capacitor" },
    ],
    connections: [{ net: "VIN_1V3_TO_5V5", pins: ["C1.1", "U1.VIN"] }],
  })
  expect(
    getTypicalApplicationPlanAgreementErrors({
      primary,
      independent: independently_cited,
      target_part_number: "TPS63802",
    }),
  ).toEqual([])
  expect(
    getTypicalApplicationPlanAgreementErrors({
      primary,
      independent: {
        ...independently_cited,
        components: independently_cited.components.map((component) =>
          component.reference === "C1" ? { ...component, kind: "resistor" } : component,
        ),
      },
      target_part_number: "TPS63802",
    }),
  ).toContain('typical-application component C1 kind disagrees: "capacitor" versus "resistor"')
  expect(
    getTypicalApplicationPlanAgreementErrors({
      primary,
      independent: {
        ...independently_cited,
        components: independently_cited.components.map((component) =>
          component.reference === "C1" ? { ...component, value: "22 µF" } : component,
        ),
      },
      target_part_number: "TPS63802",
    }),
  ).toContain('typical-application component C1 value disagrees: "10uF" versus "22 µF"')
  expect(
    getTypicalApplicationPlanAgreementErrors({
      primary,
      independent: {
        ...independently_cited,
        connections: [{ net: "VIN", pins: ["U1.VIN", "C1.2"] }],
      },
      target_part_number: "TPS63802",
    }),
  ).toContain('independent typical application is missing the endpoint group from net "VIN": c1.1, u1.vin')

  const unrelated_ic_variant = {
    ...independently_cited,
    components: independently_cited.components.map((component) =>
      component.reference === "U1" ? { ...component, value: "TPS63803" } : component,
    ),
  }
  expect(
    getTypicalApplicationPlanAgreementErrors({
      primary,
      independent: unrelated_ic_variant,
      target_part_number: "TPS63802",
    }),
  ).toContain('typical-application component U1 value disagrees: "TPS63802DLAR" versus "TPS63803"')

  const omitted_redundant_u1_value = {
    ...independently_cited,
    components: independently_cited.components.map((component) => {
      if (component.reference !== "U1") return component
      const { value: _value, ...without_value } = component
      return without_value
    }),
  }
  expect(
    getTypicalApplicationPlanAgreementErrors({
      primary,
      independent: omitted_redundant_u1_value,
      target_part_number: "TPS63802",
    }),
  ).toEqual([])

  const part_number_designator = parseTypicalApplicationPlan({
    ...independently_cited,
    components: independently_cited.components.map((component) =>
      component.reference === "U1" ? { ...component, reference: "TPS63802" } : component,
    ),
    connections: independently_cited.connections.map((connection) => ({
      ...connection,
      pins: connection.pins.map((endpoint) => endpoint.replace(/^U1\./, "TPS63802.")),
    })),
  })
  expect(
    getTypicalApplicationPlanAgreementErrors({
      primary,
      independent: part_number_designator,
      target_part_number: "TPS63802",
    }),
  ).toEqual([])
})

test("application agreement ignores arbitrary passive reference designators", () => {
  const primary = parseTypicalApplicationPlan(
    {
      version: 4,
      availability: "documented",
      pcb_implementation: "schematic_only",
      title: "INA237 application",
      description: "Semantic component references",
      source_references: [{ page: 32 }],
      components: [
        { reference: "U1", kind: "integrated_circuit", value: "INA237AIDGSR" },
        { reference: "C_BYP", kind: "capacitor", value: "100nF" },
        { reference: "RSHUNT", kind: "resistor", value: "16.2mΩ" },
        { reference: "RPU_SCL", kind: "resistor", value: "10kΩ" },
        { reference: "RPU_SDA", kind: "resistor", value: "10kΩ" },
        { reference: "RPU_ALERT", kind: "resistor", value: "10kΩ" },
      ],
      connections: [
        { net: "VS", pins: ["U1.VS", "C_BYP.1", "RPU_SCL.1", "RPU_SDA.1", "RPU_ALERT.1"] },
        { net: "GND", pins: ["U1.GND", "U1.A0", "C_BYP.2"] },
        { net: "BUS", pins: ["U1.VBUS", "U1.IN+", "RSHUNT.1"] },
        { net: "LOAD", pins: ["U1.IN-", "RSHUNT.2"] },
        { net: "SCL", pins: ["U1.SCL", "RPU_SCL.2"] },
        { net: "SDA", pins: ["U1.SDA", "RPU_SDA.2"] },
        { net: "ALERT", pins: ["U1.ALERT", "RPU_ALERT.2"] },
      ],
    },
    "INA237",
  )
  const independent = parseTypicalApplicationPlan(
    {
      ...primary,
      description: "Sequential component references",
      components: [
        { reference: "U1", kind: "current monitor", value: "INA237" },
        { reference: "C1", kind: "capacitor", value: "100 nF" },
        { reference: "R1", kind: "resistor", value: "16.2 mΩ" },
        { reference: "R2", kind: "resistor", value: "10 kΩ" },
        { reference: "R3", kind: "resistor", value: "10 kΩ" },
        { reference: "R4", kind: "resistor", value: "10 kΩ" },
      ],
      connections: [
        { net: "SUPPLY", pins: ["C1.1", "R2.1", "R3.1", "R4.1", "U1.VS"] },
        { net: "GROUND", pins: ["C1.2", "U1.A0", "U1.GND"] },
        { net: "SOURCE", pins: ["R1.1", "U1.IN+", "U1.VBUS"] },
        { net: "SENSED", pins: ["R1.2", "U1.IN-"] },
        { net: "CLOCK", pins: ["R2.2", "U1.SCL"] },
        { net: "DATA", pins: ["R3.2", "U1.SDA"] },
        { net: "FAULT", pins: ["R4.2", "U1.ALERT"] },
      ],
    },
    "INA237",
  )

  expect(
    getTypicalApplicationPlanAgreementErrors({
      primary,
      independent,
      target_part_number: "INA237",
    }),
  ).toEqual([])
})

test("schematic-only application agreement ignores packaging and optional sourcing detail", () => {
  const primary = parseTypicalApplicationPlan(
    {
      version: 4,
      availability: "documented",
      pcb_implementation: "schematic_only",
      title: "TPS63802 application",
      description: "Primary extraction",
      source_references: [{ page: 17 }],
      components: [
        {
          reference: "U1",
          kind: "buck-boost converter",
          value: "TPS63802DLAT",
          manufacturer_part_number: "TPS63802DLAT",
        },
        { reference: "L1", kind: "inductor", value: "0.47uH" },
        { reference: "C1", kind: "capacitor", value: "10uF" },
        { reference: "C2", kind: "capacitor", value: "22uF" },
      ],
      connections: [
        { net: "SW", pins: ["U1.L1", "L1.1"] },
        { net: "VIN", pins: ["U1.VIN", "C1.1"] },
        { net: "VOUT", pins: ["U1.VOUT", "C2.1"] },
      ],
    },
    "TPS63802",
  )
  const independent = parseTypicalApplicationPlan(
    {
      ...primary,
      description: "Independent extraction",
      components: primary.components.map((component) => {
        if (component.reference === "U1") {
          return {
            ...component,
            value: "TPS63802DLAR",
            manufacturer_part_number: "TPS63802DLAR",
          }
        }
        return {
          ...component,
          manufacturer_part_number: `SOURCED-${component.reference}`,
          footprint: "0603",
        }
      }),
    },
    "TPS63802",
  )

  expect(
    getTypicalApplicationPlanAgreementErrors({
      primary,
      independent,
      target_part_number: "TPS63802",
    }),
  ).toEqual([])
})

test("verified application agreement still requires exact external sourcing detail", () => {
  const base = {
    version: 4,
    availability: "documented",
    pcb_implementation: "verified",
    title: "Verified application",
    description: "Verified PCB",
    source_references: [{ page: 8 }],
    components: [
      { reference: "U1", kind: "integrated_circuit", value: "DEVICE-1-A" },
      {
        reference: "C1",
        kind: "capacitor",
        value: "1uF",
        manufacturer_part_number: "CAP-A",
        footprint: "0402",
        source_references: [{ page: 8 }],
        footprint_source_references: [{ page: 9 }],
      },
    ],
    connections: [{ net: "VCC", pins: ["U1.VCC", "C1.1"] }],
  } as const
  const primary = parseTypicalApplicationPlan(base, "DEVICE-1")
  const independent = parseTypicalApplicationPlan(
    {
      ...base,
      components: base.components.map((component) =>
        component.reference === "C1" ? { ...component, manufacturer_part_number: "CAP-B" } : component,
      ),
    },
    "DEVICE-1",
  )

  expect(
    getTypicalApplicationPlanAgreementErrors({
      primary,
      independent,
      target_part_number: "DEVICE-1",
    }),
  ).toContain('typical-application component C1 manufacturer part number disagrees: "CAP-A" versus "CAP-B"')
})

test("version 4 application evidence requires sourced passives for a verified PCB", () => {
  const base = {
    version: 4,
    availability: "documented",
    title: "Typical application",
    description: "Datasheet circuit",
    source_references: [{ page: 8 }],
    components: [
      { reference: "U1", kind: "device" },
      { reference: "L1", kind: "inductor", value: "0.47uH" },
    ],
    connections: [{ net: "SW", pins: ["U1.SW", "L1.pin1"] }],
  }
  expect(() => parseTypicalApplicationPlan({ ...base, pcb_implementation: "verified" }, "DEVICE-1")).toThrow(
    "verified PCB component L1",
  )
  expect(() => parseTypicalApplicationPlan({ ...base, pcb_implementation: "maybe" })).toThrow(
    "pcb_implementation must be verified or schematic_only",
  )

  const schematic_only = parseTypicalApplicationPlan({
    ...base,
    pcb_implementation: "schematic_only",
  })
  expect(schematic_only.pcb_implementation).toBe("schematic_only")

  const verified = parseTypicalApplicationPlan({
    ...base,
    pcb_implementation: "verified",
    components: [
      { reference: "U1", kind: "device" },
      {
        reference: "L1",
        kind: "inductor",
        value: "0.47uH",
        manufacturer_part_number: "DFE201612E-R47M",
        footprint: "0805",
        source_references: [{ page: 19, figure: "Recommended inductors" }],
        footprint_source_references: [{ page: 20, figure: "DFE201612E land pattern" }],
      },
    ],
  })
  expect(verified.components[1]?.manufacturer_part_number).toBe("DFE201612E-R47M")
})

test("new evidence extraction rejects legacy application plans that bypass PCB sourcing", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-runner-legacy-plan-"))
  await Bun.write(join(job_dir, "datasheet.pdf"), "fake datasheet")
  const agent_path = join(job_dir, "legacy-plan-agent")
  await Bun.write(
    agent_path,
    `#!/usr/bin/env bun
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
const prompt = args[args.indexOf("--prompt") + 1]
${fakeVisualInspectionHelpers}
const plan = { version: 3, availability: "documented", title: "Legacy application", description: "Would bypass sourced part validation", source_references: [{ page: 8 }], components: [{ reference: "U1", kind: "device" }, { reference: "C1", kind: "capacitor", value: "1uF" }], connections: [{ net: "VCC", pins: ["U1.VCC", "C1.pin1"] }] }
if (prompt.includes("evidence-extraction phase")) {
  await recordEvidence(plan, { preserveLegacyPlan: true })
} else {
  await Bun.write(dir + "/unexpected-phase", "reached")
}
finishAgent()
`,
  )
  await chmod(agent_path, 0o755)

  const job_store = new JobStore()
  job_store.createJob({ job_id: "job_legacy_plan", job_dir, file_name: "device.pdf" })
  await runJob({ job_id: "job_legacy_plan" }, { job_store, agent_bin: agent_path, tsci_bin: "unused-tsci" })

  const job = job_store.getJob("job_legacy_plan")
  expect(job?.display_status).toBe("unsupported")
  expect(job?.error_message).toContain("must use typical-application plan schema version 4")
  expect(await Bun.file(join(job_dir, "unexpected-phase")).exists()).toBe(false)

  await rm(job_dir, { recursive: true, force: true })
})

test("application plans discard invented interface-terminal pseudo-components", () => {
  const plan = parseTypicalApplicationPlan({
    version: 3,
    availability: "documented",
    title: "Converter application",
    description: "Reference circuit",
    source_references: [{ page: 8 }],
    components: [
      { reference: "U1", kind: "converter", value: "TPS63802" },
      { reference: "C1", kind: "capacitor", value: "10uF" },
      { reference: "VIN_IN", kind: "power_port", value: "1.3 V to 5.5 V" },
    ],
    connections: [
      { net: "VIN", pins: ["VIN_IN.positive", "U1.VIN", "C1.1"] },
      { net: "GND", pins: ["VIN_IN.ground", "U1.GND", "C1.2"] },
    ],
  })
  expect(plan.components.map((component) => component.reference)).toEqual(["U1", "C1"])
  expect(plan.connections).toEqual([
    { net: "VIN", pins: ["U1.VIN", "C1.1"] },
    { net: "GND", pins: ["U1.GND", "C1.2"] },
  ])
})

test("application plans normalize bare interfaces and reconstruct the known target component", () => {
  const plan = parseTypicalApplicationPlan(
    {
      version: 3,
      availability: "documented",
      title: "Converter application",
      description: "Reference circuit",
      source_references: [{ page: 8 }],
      components: [{ reference: "C1", kind: "capacitor", value: "10uF" }],
      connections: [
        { net: "VIN", pins: ["VIN", "U1.VIN", "C1.1"] },
        { net: "VOUT", pins: ["U1.VOUT", "C1.2", "VOUT"] },
      ],
    },
    "TPS63802",
  )
  expect(plan.components[0]).toMatchObject({
    reference: "U1",
    kind: "integrated_circuit",
    value: "TPS63802",
  })
  expect(plan.connections).toEqual([
    { net: "VIN", pins: ["U1.VIN", "C1.1"] },
    { net: "VOUT", pins: ["U1.VOUT", "C1.2"] },
  ])
})

test("generation-phase audit detects direct and shell-based datasheet rereads", () => {
  expect(
    getForbiddenDatasheetAccesses([
      {
        protocol: "tsci-agent-event-v1",
        sequence: 1,
        type: "tool_start",
        tool_call_id: "read-pdf",
        tool_name: "read",
        args: { path: "datasheet.pdf" },
      },
      {
        protocol: "tsci-agent-event-v1",
        sequence: 2,
        type: "tool_start",
        tool_call_id: "extract",
        tool_name: "bash",
        args: { command: "pdftotext datasheet.pdf datasheet.txt" },
      },
    ]),
  ).toHaveLength(2)
  expect(
    getForbiddenDatasheetAccesses([
      {
        protocol: "tsci-agent-event-v1",
        sequence: 1,
        type: "tool_start",
        tool_call_id: "safe-inventory",
        tool_name: "bash",
        args: {
          command: "find . -maxdepth 2 -type f ! -name 'datasheet.pdf' ! -name 'datasheet.txt' | sort",
        },
      },
    ]),
  ).toEqual([])
  expect(
    getForbiddenDatasheetAccesses([
      {
        protocol: "tsci-agent-event-v1",
        sequence: 1,
        type: "tool_start",
        tool_call_id: "safe-grep-inventory",
        tool_name: "bash",
        args: {
          command:
            "grep -RIl 'schPinArrangement' . --exclude='datasheet.pdf' --exclude=\"datasheet.txt\" | head -30",
        },
      },
      {
        protocol: "tsci-agent-event-v1",
        sequence: 2,
        type: "tool_start",
        tool_call_id: "safe-rg-inventory",
        tool_name: "bash",
        args: {
          command: "rg 'schPinArrangement' . --glob '!./datasheet.pdf' -g '!datasheet.txt'",
        },
      },
    ]),
  ).toEqual([])
  expect(
    getForbiddenDatasheetAccesses([
      {
        protocol: "tsci-agent-event-v1",
        sequence: 1,
        type: "tool_start",
        tool_call_id: "safe-path-inventory",
        tool_name: "bash",
        args: {
          command:
            "pwd && find . -maxdepth 2 -type f -not -path './datasheet.pdf' -not -path './datasheet.txt' | sort",
        },
      },
    ]),
  ).toEqual([])
  expect(
    getForbiddenDatasheetAccesses([
      {
        protocol: "tsci-agent-event-v1",
        sequence: 1,
        type: "tool_start",
        tool_call_id: "unsafe-mixed-command",
        tool_name: "bash",
        args: {
          command: "find . -type f -not -path './datasheet.pdf'; pdftotext ./datasheet.pdf ./datasheet.txt",
        },
      },
    ]),
  ).toHaveLength(1)
  expect(
    getForbiddenDatasheetAccesses([
      {
        protocol: "tsci-agent-event-v1",
        sequence: 1,
        type: "tool_start",
        tool_call_id: "unsafe-grep-mixed-command",
        tool_name: "bash",
        args: {
          command: "grep -R foo . --exclude='datasheet.txt'; cat ./datasheet.txt",
        },
      },
      {
        protocol: "tsci-agent-event-v1",
        sequence: 2,
        type: "tool_start",
        tool_call_id: "unsafe-exclude-from",
        tool_name: "bash",
        args: {
          command: "grep -R foo . --exclude-from=./datasheet.txt",
        },
      },
    ]),
  ).toHaveLength(2)
})

test("component readiness releases before the typical application completes", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-runner-phases-"))
  await Bun.write(join(job_dir, "datasheet.pdf"), "fake datasheet")
  const agent_path = join(job_dir, "phased-agent")
  const tsci_path = join(job_dir, "phased-tsci")
  await Promise.all([
    Bun.write(
      agent_path,
      `#!/usr/bin/env bun
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
const prompt = args[args.indexOf("--prompt") + 1]
${fakeVisualInspectionHelpers}
const plan = { version: 2, title: "Typical sensor application", description: "Sensor with supply bypass", source_references: [{ page: 8, figure: "Figure 4" }], components: [{ reference: "U1", kind: "sensor" }, { reference: "C1", kind: "capacitor", value: "1uF" }], connections: [{ net: "VCC", pins: ["U1.VCC", "C1.pin1"] }] }
if (prompt.includes("Independently extract")) {
  await recordEvidence(plan)
} else if (prompt.includes("evidence-extraction phase")) {
  await recordEvidence(plan)
  emitText("evidence phase complete")
} else if (prompt.includes("Generate the reusable")) {
  if (await Bun.file(dir + "/datasheet.pdf").exists()) throw new Error("raw datasheet leaked into component generation")
  if (await Bun.file(dir + "/visual-reference/pages/page-009.png").exists()) throw new Error("raw page render leaked into component generation")
  await Bun.write(dir + "/index.circuit.tsx", 'export default function Part() { return <chip name="U1" footprint="soic8" /> }\\n')
  emitThinking("Checking component ")
  emitThinking("geometry before the final build.\\n")
  await recordVisualInspection("component")
  emitText("component phase complete")
} else {
  if (await Bun.file(dir + "/datasheet.pdf").exists()) throw new Error("raw datasheet leaked into application generation")
  if (await Bun.file(dir + "/visual-reference/land-pattern.png").exists()) throw new Error("component evidence image leaked into application generation")
  if (!(await Bun.file(dir + "/dist/index/circuit.json").exists())) throw new Error("component was not built before application phase")
  if (!(await Bun.file(dir + "/component.circuit.tsx").exists())) throw new Error("component snapshot was not published")
  await Bun.write(dir + "/typical-application.circuit.tsx", 'import Part from "./index.circuit"\\nexport default function TypicalApplication() { return <board><Part name="U1" /><capacitor name="C1" capacitance="1uF" manufacturerPartNumber="TEST-C1" footprint="0402" /></board> }\\n')
  await recordVisualInspection("application")
  emitText("application phase complete")
}
finishAgent()
`,
    ),
    Bun.write(
      tsci_path,
      `#!/usr/bin/env bun
import { appendFile, mkdir } from "node:fs/promises"
const target = Bun.argv.slice(2)[1]
const stem = target.replace(/\\.circuit\\.tsx$/, "")
await appendFile(process.cwd() + "/build-targets.log", target + "\\n")
await mkdir(process.cwd() + "/dist/" + stem, { recursive: true })
const renderPng = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (character) => character.charCodeAt(0))
await Bun.write(process.cwd() + "/dist/" + stem + "/pcb.png", renderPng)
await Bun.write(process.cwd() + "/dist/" + stem + "/schematic.png", renderPng)
const circuit = target === "index.circuit.tsx" || target === "component-validation.circuit.tsx"
  ? [{ type: "source_component", source_component_id: "part", name: "U1", manufacturer_part_number: "SENSOR-1" }, { type: "source_port", source_port_id: "u1_vcc", source_component_id: "part", name: "VCC", pin_number: 1, port_hints: ["1", "VCC"], requires_power: true }, { type: "schematic_component", schematic_component_id: "sch1", source_component_id: "part", center: { x: 0, y: 0 } }, { type: "schematic_port", schematic_port_id: "sp1", schematic_component_id: "sch1", source_port_id: "u1_vcc", side_of_component: "top", center: { x: 0, y: 1 } }, { type: "pcb_smtpad", pcb_smtpad_id: "pad1", pcb_component_id: "pcb1", pcb_port_id: "port1", port_hints: ["1"], x: 0, y: 0, width: 0.6, height: 0.25 }]
  : [
      { type: "source_component", source_component_id: "part", name: "U1" },
      { type: "source_port", source_port_id: "u1_vcc", source_component_id: "part", name: "VCC", subcircuit_connectivity_map_key: "vcc" },
      { type: "source_port", source_port_id: "u1_gnd", source_component_id: "part", name: "GND", subcircuit_connectivity_map_key: "gnd" },
      { type: "source_component", source_component_id: "cap", name: "C1", ftype: "simple_capacitor", capacitance: 0.000001, manufacturer_part_number: "TEST-C1" },
      { type: "cad_component", cad_component_id: "cap-cad", pcb_component_id: "cap-pcb", source_component_id: "cap", footprinter_string: "0402", position: { x: 0, y: 0, z: 0 }, model_object_fit: "contain_within_bounds" },
      { type: "source_port", source_port_id: "c1_1", source_component_id: "cap", name: "pin1", pin_number: 1, subcircuit_connectivity_map_key: "vcc" },
      { type: "source_port", source_port_id: "c1_2", source_component_id: "cap", name: "pin2", pin_number: 2, subcircuit_connectivity_map_key: "gnd" },
      ...Array.from({ length: 7 }, (_, index) => ({ type: "schematic_component", schematic_component_id: "application-sch-" + index, center: { x: index, y: 0 } })),
      { type: "schematic_trace", schematic_trace_id: "long-but-valid", edges: [{ from: { x: 0, y: 0 }, to: { x: 7.13, y: 0 } }] },
    ]
if (target === "component-validation.circuit.tsx") {
  circuit.push({ type: "source_pin_must_be_connected_error", message: "Port VCC on U1 must be connected but is floating" })
}
await Bun.write(process.cwd() + "/dist/" + stem + "/circuit.json", JSON.stringify(circuit))
`,
    ),
  ])
  await Promise.all([chmod(agent_path, 0o755), chmod(tsci_path, 0o755)])

  const job_store = new JobStore()
  const states: Array<{ component_ready?: boolean; is_complete: boolean }> = []
  job_store.createJob({ job_id: "job_phases", job_dir, file_name: "sensor.pdf" })
  job_store.subscribe("job_phases", (event) => {
    if (event.event_type !== "log") {
      states.push({ component_ready: event.job.component_ready, is_complete: event.job.is_complete })
    }
  })

  await runJob({ job_id: "job_phases" }, { job_store, agent_bin: agent_path, tsci_bin: tsci_path })

  const job = job_store.getJob("job_phases")
  expect(states.some((state) => state.component_ready === true && state.is_complete === false)).toBe(true)
  expect(job?.display_status).toBe("complete")
  expect(job?.component_ready).toBe(true)
  expect(job?.component_code).toContain("function Part")
  expect(job?.typical_application_title).toBe("Typical sensor application")
  expect(await Bun.file(join(job_dir, "component.circuit.tsx")).text()).toBe(
    await Bun.file(join(job_dir, "index.circuit.tsx")).text(),
  )
  expect(job?.typical_application_code).toContain('from "./index.circuit"')
  expect(job?.circuit_json?.[0]?.type).toBe("source_component")
  expect(job?.typical_application_circuit_json?.[0]?.type).toBe("source_component")
  for (const path of [
    "dist/index/pcb.png",
    "dist/index/schematic.png",
    "dist/typical-application/pcb.png",
    "dist/typical-application/schematic.png",
  ]) {
    expect(await Bun.file(join(job_dir, path)).exists()).toBe(true)
  }
  expect(await Bun.file(join(job_dir, "typical-application-plan.json")).text()).toContain('"VCC"')
  expect(await Bun.file(join(job_dir, "component-evidence.independent.json")).exists()).toBe(true)
  expect(
    await Bun.file(join(job_dir, "evidence-attempts/independent-1/component-evidence.json")).exists(),
  ).toBe(true)
  expect(job?.validation?.evidence).toBe("passed")
  expect(job?.validation?.pinout).toBe("passed")
  expect(await Bun.file(join(job_dir, "agent-events.jsonl")).text()).toContain('"result_has_image":true')
  const agent_log = await Bun.file(join(job_dir, "agent.log")).text()
  expect(agent_log).toContain("[tool] read")
  expect(agent_log).toContain("Agent phase completed with")
  expect(agent_log).toContain("Checking component geometry before the final build.")
  expect(agent_log).toContain("Schematic layout advisory")
  const persisted_job = JSON.parse(await Bun.file(join(job_dir, "job.json")).text())
  expect(persisted_job.version).toBe(2)
  expect(persisted_job.provenance.source_commit).toHaveLength(40)
  expect(persisted_job.provenance.datasheet_sha256).toHaveLength(64)
  expect(persisted_job.provenance.prompt_sha256.component_generation).toHaveLength(64)
  expect(await Bun.file(join(job_dir, "build-targets.log")).text()).toBe(
    "netlist\nindex.circuit.tsx\ncomponent-validation.circuit.tsx\nnetlist\ntypical-application.circuit.tsx\n",
  )
  expect(await Bun.file(join(job_dir, "photon_rs_bg.wasm")).exists()).toBe(false)

  await rm(job_dir, { recursive: true, force: true })
})

test("schematic-only application evidence publishes no application PCB", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-runner-schematic-only-"))
  await Bun.write(join(job_dir, "datasheet.pdf"), "fake datasheet")
  const agent_path = join(job_dir, "schematic-only-agent")
  const tsci_path = join(job_dir, "schematic-only-tsci")
  await Promise.all([
    Bun.write(
      agent_path,
      `#!/usr/bin/env bun
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
const prompt = args[args.indexOf("--prompt") + 1]
${fakeVisualInspectionHelpers}
const plan = { version: 4, availability: "documented", pcb_implementation: "schematic_only", title: "Typical sensor application", description: "No sourced capacitor package", source_references: [{ page: 8 }], components: [{ reference: "U1", kind: "sensor" }, { reference: "C1", kind: "capacitor", value: "1uF", manufacturer_part_number: "TEST-C1", source_references: [{ page: 8 }] }], connections: [{ net: "VCC", pins: ["U1.VCC", "C1.pin1"] }] }
if (prompt.includes("Independently extract") || prompt.includes("evidence-extraction phase")) {
  await recordEvidence(plan)
} else if (prompt.includes("Generate the reusable")) {
  await Bun.write(dir + "/index.circuit.tsx", 'export default function Part() { return <chip name="U1" /> }\\n')
  await recordVisualInspection("component")
} else {
  if (!prompt.includes("--disable-pcb")) throw new Error("schematic-only build instruction missing")
  if (!prompt.includes("required in both verified and schematic_only modes")) throw new Error("schematic-only part identity instruction missing")
  await Bun.write(dir + "/typical-application.circuit.tsx", 'import Part from "./index.circuit"\\nexport default function Application() { return <board><Part name="U1" /><capacitor name="C1" capacitance="1uF" manufacturerPartNumber="TEST-C1" /></board> }\\n')
  await recordVisualInspection("application", "passed", true, " --disable-pcb --schematic-svgs")
}
finishAgent()
`,
    ),
    Bun.write(
      tsci_path,
      `#!/usr/bin/env bun
import { appendFile, mkdir } from "node:fs/promises"
const args = Bun.argv.slice(2)
const target = args[1]
const stem = target.replace(/\\.circuit\\.tsx$/, "")
const pcbDisabled = args.includes("--disable-pcb")
await appendFile(process.cwd() + "/build-targets.log", target + (pcbDisabled ? " --disable-pcb" : "") + "\\n")
await mkdir(process.cwd() + "/dist/" + stem, { recursive: true })
const renderPng = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (character) => character.charCodeAt(0))
if (!pcbDisabled) await Bun.write(process.cwd() + "/dist/" + stem + "/pcb.png", renderPng)
await Bun.write(process.cwd() + "/dist/" + stem + "/schematic.png", renderPng)
const circuit = target === "index.circuit.tsx" || target === "component-validation.circuit.tsx"
  ? [{ type: "source_component", source_component_id: "part", name: "U1", manufacturer_part_number: "SENSOR-1" }, { type: "source_port", source_port_id: "u1_vcc", source_component_id: "part", name: "VCC", pin_number: 1, port_hints: ["1", "VCC"], requires_power: true }, { type: "schematic_component", schematic_component_id: "sch1", source_component_id: "part", center: { x: 0, y: 0 } }, { type: "schematic_port", schematic_port_id: "sp1", schematic_component_id: "sch1", source_port_id: "u1_vcc", side_of_component: "top", center: { x: 0, y: 1 } }, { type: "pcb_smtpad", pcb_smtpad_id: "pad1", pcb_component_id: "pcb1", pcb_port_id: "port1", port_hints: ["1"], x: 0, y: 0, width: 0.6, height: 0.25 }]
  : [{ type: "source_component", source_component_id: "part", name: "U1" }, { type: "source_port", source_port_id: "u1_vcc", source_component_id: "part", name: "VCC", subcircuit_connectivity_map_key: "vcc" }, { type: "source_component", source_component_id: "cap", name: "C1", capacitance: 0.000001, manufacturer_part_number: "TEST-C1" }, { type: "source_port", source_port_id: "c1_1", source_component_id: "cap", name: "pin1", pin_number: 1, subcircuit_connectivity_map_key: "vcc" }, { type: "source_port", source_port_id: "c1_2", source_component_id: "cap", name: "pin2", pin_number: 2 }]
await Bun.write(process.cwd() + "/dist/" + stem + "/circuit.json", JSON.stringify(circuit))
`,
    ),
  ])
  await Promise.all([chmod(agent_path, 0o755), chmod(tsci_path, 0o755)])

  const job_store = new JobStore()
  job_store.createJob({ job_id: "job_schematic_only", job_dir, file_name: "sensor.pdf" })
  await runJob({ job_id: "job_schematic_only" }, { job_store, agent_bin: agent_path, tsci_bin: tsci_path })

  const job = job_store.getJob("job_schematic_only")
  expect(job?.display_status).toBe("complete")
  expect(job?.validation?.application_build).toBe("passed")
  expect(job?.validation?.application_visual).toBe("passed")
  expect(await Bun.file(join(job_dir, "dist/typical-application/schematic.png")).exists()).toBe(true)
  expect(await Bun.file(join(job_dir, "dist/typical-application/pcb.png")).exists()).toBe(false)
  expect(await Bun.file(join(job_dir, "build-targets.log")).text()).toContain(
    "typical-application.circuit.tsx --disable-pcb",
  )

  await rm(job_dir, { recursive: true, force: true })
})

test("typical-application generation repairs a semantic build failure from server feedback", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-runner-clean-gate-"))
  await Bun.write(join(job_dir, "datasheet.pdf"), "fake datasheet")
  const agent_path = join(job_dir, "clean-gate-agent")
  const tsci_path = join(job_dir, "clean-gate-tsci")
  await Promise.all([
    Bun.write(
      agent_path,
      `#!/usr/bin/env bun
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
const prompt = args[args.indexOf("--prompt") + 1]
${fakeVisualInspectionHelpers}
const plan = { version: 2, title: "Typical application", description: "Datasheet circuit", source_references: [{ page: 8 }], components: [{ reference: "U1", kind: "sensor" }, { reference: "C1", kind: "capacitor", value: "1uF" }], connections: [{ net: "VCC", pins: ["U1.VCC", "C1.pin1"] }] }
if (prompt.includes("Independently extract") || prompt.includes("evidence-extraction phase")) {
  await recordEvidence(plan)
} else if (prompt.includes("Generate the reusable")) {
  await Bun.write(dir + "/index.circuit.tsx", 'export default function Part() { return <chip name="U1" footprint="soic8" /> }\\n')
  await recordVisualInspection("component")
} else {
  const corrected = prompt.includes("previous generation attempt")
  if (corrected && !(await Bun.file(dir + "/typical-application.circuit.tsx").text()).includes("first-attempt")) {
    throw new Error("application source checkpoint was not retained")
  }
  await Bun.write(dir + "/typical-application.circuit.tsx", 'import Part from "./index.circuit"\\n/* ' + (corrected ? 'corrected-after-feedback' : 'first-attempt') + ' */\\nexport default function Application() { return <board><Part name="U1" /><capacitor name="C1" capacitance="1uF" manufacturerPartNumber="TEST-C1" footprint="0402" /></board> }\\n')
  await recordVisualInspection("application")
}
finishAgent()
`,
    ),
    Bun.write(
      tsci_path,
      `#!/usr/bin/env bun
import { mkdir } from "node:fs/promises"
const target = Bun.argv.slice(2)[1]
const stem = target.replace(/\\.circuit\\.tsx$/, "")
await mkdir(process.cwd() + "/dist/" + stem, { recursive: true })
const renderPng = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (character) => character.charCodeAt(0))
await Bun.write(process.cwd() + "/dist/" + stem + "/pcb.png", renderPng)
await Bun.write(process.cwd() + "/dist/" + stem + "/schematic.png", renderPng)
const source = target.endsWith(".tsx") ? await Bun.file(process.cwd() + "/" + target).text() : ""
const circuit = target === "index.circuit.tsx" || target === "component-validation.circuit.tsx"
  ? [{ type: "source_component", source_component_id: "part", name: "U1", manufacturer_part_number: "SENSOR-1" }, { type: "source_port", source_port_id: "u1_vcc", source_component_id: "part", name: "VCC", pin_number: 1, port_hints: ["1", "VCC"], requires_power: true }, { type: "schematic_component", schematic_component_id: "sch1", source_component_id: "part", center: { x: 0, y: 0 } }, { type: "schematic_port", schematic_port_id: "sp1", schematic_component_id: "sch1", source_port_id: "u1_vcc", side_of_component: "top", center: { x: 0, y: 1 } }, { type: "pcb_smtpad", pcb_smtpad_id: "pad1", pcb_component_id: "pcb1", pcb_port_id: "port1", port_hints: ["1"], x: 0, y: 0, width: 0.6, height: 0.25 }]
  : source.includes("corrected-after-feedback")
    ? [
      { type: "source_component", source_component_id: "part", name: "U1" },
      { type: "source_port", source_port_id: "u1_vcc", source_component_id: "part", name: "VCC", subcircuit_connectivity_map_key: "vcc" },
      { type: "source_component", source_component_id: "cap", name: "C1", ftype: "simple_capacitor", capacitance: 0.000001, manufacturer_part_number: "TEST-C1" },
      { type: "cad_component", cad_component_id: "cap-cad", pcb_component_id: "cap-pcb", source_component_id: "cap", footprinter_string: "0402", position: { x: 0, y: 0, z: 0 }, model_object_fit: "contain_within_bounds" },
      { type: "source_port", source_port_id: "c1_1", source_component_id: "cap", name: "pin1", pin_number: 1, subcircuit_connectivity_map_key: "vcc" },
      { type: "source_port", source_port_id: "c1_2", source_component_id: "cap", name: "pin2", pin_number: 2 },
    ]
    : [
      { type: "source_component", source_component_id: "application", name: "APP" },
      { type: "pcb_pad_pad_clearance_error", message: "C1 overlaps U1" },
    ]
await Bun.write(process.cwd() + "/dist/" + stem + "/circuit.json", JSON.stringify(circuit))
`,
    ),
  ])
  await Promise.all([chmod(agent_path, 0o755), chmod(tsci_path, 0o755)])

  const job_store = new JobStore()
  job_store.createJob({ job_id: "job_clean_gate", job_dir, file_name: "sensor.pdf" })

  await runJob({ job_id: "job_clean_gate" }, { job_store, agent_bin: agent_path, tsci_bin: tsci_path })

  const job = job_store.getJob("job_clean_gate")
  expect(job?.display_status).toBe("complete")
  expect(job?.is_complete).toBe(true)
  expect(job?.component_ready).toBe(true)
  expect(job?.typical_application_code).toContain("corrected-after-feedback")
  expect(job?.typical_application_circuit_json?.some((element) => element.type.endsWith("_error"))).toBe(
    false,
  )
  expect(job?.validation?.application_build).toBe("passed")
  const logs = await Bun.file(join(job_dir, "agent.log")).text()
  expect(logs).toContain("Typical-application generation attempt 1 did not pass server validation")
  expect(logs).toContain("Retrying automatically (2/3)")
  expect(
    await Bun.file(join(job_dir, "generation-attempts/application-1/typical-application.circuit.tsx")).text(),
  ).toContain("first-attempt")
  expect(await Bun.file(join(job_dir, "generation-attempts/application-1/error.json")).text()).toContain(
    "pcb_pad_pad_clearance_error",
  )

  await rm(job_dir, { recursive: true, force: true })
})

test("component generation repairs a pinout failure from a retained source checkpoint", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-runner-component-recovery-"))
  await Bun.write(join(job_dir, "datasheet.pdf"), "fake datasheet")
  const agent_path = join(job_dir, "component-recovery-agent")
  const tsci_path = join(job_dir, "component-recovery-tsci")
  await Promise.all([
    Bun.write(
      agent_path,
      `#!/usr/bin/env bun
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
const prompt = args[args.indexOf("--prompt") + 1]
${fakeVisualInspectionHelpers}
const plan = { version: 3, availability: "not_present", title: "No documented application", description: "No application circuit is present", source_references: [{ page: 1 }], searched_sections: ["Applications"], components: [], connections: [] }
if (prompt.includes("Independently extract") || prompt.includes("evidence-extraction phase")) {
  await recordEvidence(plan)
} else if (prompt.includes("Generate the reusable")) {
  const corrected = prompt.includes("previous generation attempt")
  if (corrected && !(await Bun.file(dir + "/index.circuit.tsx").text()).includes("wrong-pinout")) {
    throw new Error("component source checkpoint was not retained")
  }
  await Bun.write(dir + "/index.circuit.tsx", '/* ' + (corrected ? 'corrected-pinout' : 'wrong-pinout') + ' */\\nexport default function Part() { return <chip name="U1" footprint="soic8" /> }\\n')
  await recordVisualInspection("component")
}
finishAgent()
`,
    ),
    Bun.write(
      tsci_path,
      `#!/usr/bin/env bun
import { mkdir } from "node:fs/promises"
const args = Bun.argv.slice(2)
const target = args[0] === "check" ? args[2] : args[1]
const stem = target.replace(/\\.circuit\\.tsx$/, "")
await mkdir(process.cwd() + "/dist/" + stem, { recursive: true })
const renderPng = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (character) => character.charCodeAt(0))
await Bun.write(process.cwd() + "/dist/" + stem + "/pcb.png", renderPng)
await Bun.write(process.cwd() + "/dist/" + stem + "/schematic.png", renderPng)
const candidatePath = target === "component-validation.circuit.tsx" ? "index.circuit.tsx" : target
const source = await Bun.file(process.cwd() + "/" + candidatePath).text()
const corrected = source.includes("corrected-pinout")
const circuit = [
  { type: "source_component", source_component_id: "part", name: "U1", manufacturer_part_number: "SENSOR-1" },
  { type: "source_port", source_port_id: "u1_vcc", source_component_id: "part", name: corrected ? "VCC" : "WRONG", pin_number: 1, port_hints: ["1", corrected ? "VCC" : "WRONG"], requires_power: true },
  { type: "schematic_component", schematic_component_id: "sch1", source_component_id: "part", center: { x: 0, y: 0 } },
  { type: "schematic_port", schematic_port_id: "sp1", schematic_component_id: "sch1", source_port_id: "u1_vcc", side_of_component: "top", center: { x: 0, y: 1 } },
  { type: "pcb_smtpad", pcb_smtpad_id: "pad1", pcb_component_id: "pcb1", pcb_port_id: "port1", port_hints: ["1"], x: 0, y: 0, width: 0.6, height: 0.25 },
]
await Bun.write(process.cwd() + "/dist/" + stem + "/circuit.json", JSON.stringify(circuit))
`,
    ),
  ])
  await Promise.all([chmod(agent_path, 0o755), chmod(tsci_path, 0o755)])

  const job_store = new JobStore()
  job_store.createJob({ job_id: "job_component_recovery", job_dir, file_name: "sensor.pdf" })
  await runJob(
    { job_id: "job_component_recovery" },
    { job_store, agent_bin: agent_path, tsci_bin: tsci_path },
  )

  const job = job_store.getJob("job_component_recovery")
  expect(job?.display_status).toBe("complete")
  expect(job?.component_ready).toBe(true)
  expect(job?.component_code).toContain("corrected-pinout")
  expect(job?.validation?.pinout).toBe("passed")
  const logs = await Bun.file(join(job_dir, "agent.log")).text()
  expect(logs).toContain("Component generation attempt 1 did not pass server validation")
  expect(logs).toContain("pin 1 labels VCC are absent")
  expect(logs).toContain("Retrying automatically (2/3)")
  expect(await Bun.file(join(job_dir, "generation-attempts/component-1/index.circuit.tsx")).text()).toContain(
    "wrong-pinout",
  )
  expect(await Bun.file(join(job_dir, "generation-attempts/component-1/error.json")).text()).toContain(
    "failed datasheet pin-table validation",
  )

  await rm(job_dir, { recursive: true, force: true })
})

test("server-owned tsci board validation catches overlapping pads before component readiness", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-runner-footprint-gate-"))
  await Bun.write(join(job_dir, "datasheet.pdf"), "fake datasheet")
  const agent_path = join(job_dir, "footprint-gate-agent")
  const tsci_path = join(job_dir, "footprint-gate-tsci")
  await Promise.all([
    Bun.write(
      agent_path,
      `#!/usr/bin/env bun
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
const prompt = args[args.indexOf("--prompt") + 1]
${fakeVisualInspectionHelpers}
const plan = { version: 2, title: "Typical application", description: "Datasheet circuit", source_references: [{ page: 8 }], components: [{ reference: "U1", kind: "sensor" }, { reference: "C1", kind: "capacitor" }], connections: [{ net: "VCC", pins: ["U1.VCC", "C1.pin1"] }] }
if (prompt.includes("Independently extract") || prompt.includes("evidence-extraction phase")) {
  await recordEvidence(plan)
} else if (prompt.includes("Generate the reusable")) {
  await Bun.write(dir + "/index.circuit.tsx", 'export default function Part() { return <chip name="U1" footprint="soic8" /> }\\n')
  await recordVisualInspection("component")
}
finishAgent()
`,
    ),
    Bun.write(
      tsci_path,
      `#!/usr/bin/env bun
import { mkdir } from "node:fs/promises"
const target = Bun.argv.slice(2)[1]
const stem = target.replace(/\\.circuit\\.tsx$/, "")
await mkdir(process.cwd() + "/dist/" + stem, { recursive: true })
const renderPng = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (character) => character.charCodeAt(0))
await Bun.write(process.cwd() + "/dist/" + stem + "/pcb.png", renderPng)
await Bun.write(process.cwd() + "/dist/" + stem + "/schematic.png", renderPng)
const circuit = target === "component-validation.circuit.tsx"
  ? [
      { type: "source_component", source_component_id: "part", name: "U1", manufacturer_part_number: "SENSOR-1" },
      { type: "source_port", source_port_id: "u1_vcc", source_component_id: "part", name: "VCC", pin_number: 1, port_hints: ["1", "VCC"], requires_power: true },
      { type: "pcb_smtpad", pcb_smtpad_id: "pad1", pcb_component_id: "pcb1", pcb_port_id: "port1", port_hints: ["1"], x: 0, y: 0, width: 0.6, height: 0.25 },
      { type: "pcb_pad_pad_clearance_error", message: "U1.GND overlaps U1.L1" },
    ]
  : [{ type: "source_component", source_component_id: "part", name: "U1", manufacturer_part_number: "SENSOR-1" }, { type: "source_port", source_port_id: "u1_vcc", source_component_id: "part", name: "VCC", pin_number: 1, port_hints: ["1", "VCC"], requires_power: true }, { type: "schematic_component", schematic_component_id: "sch1", source_component_id: "part", center: { x: 0, y: 0 } }, { type: "schematic_port", schematic_port_id: "sp1", schematic_component_id: "sch1", source_port_id: "u1_vcc", side_of_component: "top", center: { x: 0, y: 1 } }, { type: "pcb_smtpad", pcb_smtpad_id: "pad1", pcb_component_id: "pcb1", pcb_port_id: "port1", port_hints: ["1"], x: 0, y: 0, width: 0.6, height: 0.25 }]
await Bun.write(process.cwd() + "/dist/" + stem + "/circuit.json", JSON.stringify(circuit))
`,
    ),
  ])
  await Promise.all([chmod(agent_path, 0o755), chmod(tsci_path, 0o755)])

  const job_store = new JobStore()
  job_store.createJob({ job_id: "job_footprint_gate", job_dir, file_name: "sensor.pdf" })
  await runJob({ job_id: "job_footprint_gate" }, { job_store, agent_bin: agent_path, tsci_bin: tsci_path })

  const job = job_store.getJob("job_footprint_gate")
  expect(job?.display_status).toBe("failed")
  expect(job?.component_ready).not.toBe(true)
  expect(job?.validation?.component_drc).toBe("failed")
  expect(job?.error_message).toContain("failed board-level tsci validation")
  expect(job?.error_message).toContain("pcb_pad_pad_clearance_error")
  const logs = await Bun.file(join(job_dir, "agent.log")).text()
  expect(logs).toContain("Component generation attempt 1 did not pass server validation")
  expect(logs).toContain("Component generation attempt 2 did not pass server validation")
  for (const attempt of [1, 2, 3]) {
    expect(
      await Bun.file(join(job_dir, `generation-attempts/component-${attempt}/error.json`)).text(),
    ).toContain("failed board-level tsci validation")
  }

  await rm(job_dir, { recursive: true, force: true })
})

test("two agreeing independent geometry extractions override an incorrect primary", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-runner-evidence-disagreement-"))
  await Bun.write(join(job_dir, "datasheet.pdf"), "fake datasheet")
  const agent_path = join(job_dir, "disagreement-agent")
  await Bun.write(
    agent_path,
    `#!/usr/bin/env bun
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
const prompt = args[args.indexOf("--prompt") + 1]
${fakeVisualInspectionHelpers}
const plan = { version: 2, title: "Typical application", description: "Datasheet circuit", source_references: [{ page: 8 }], components: [{ reference: "U1", kind: "device" }, { reference: "C1", kind: "capacitor", value: "1uF" }], connections: [{ net: "VCC", pins: ["U1.VCC", "C1.pin1"] }] }
if (prompt.includes("Independently extract")) {
  await recordEvidence({ ...plan, title: prompt.includes("pin 1 width") ? "comparison leaked" : "fresh verification" }, { padWidth: 0.9 })
} else if (prompt.includes("evidence-extraction phase")) {
  await recordEvidence(plan, { padWidth: 0.6 })
} else {
  await Bun.write(dir + "/tsx-generation-reached", "unexpected")
}
finishAgent()
`,
  )
  await chmod(agent_path, 0o755)

  const job_store = new JobStore()
  job_store.createJob({ job_id: "job_disagreement", job_dir, file_name: "device.pdf" })
  await runJob({ job_id: "job_disagreement" }, { job_store, agent_bin: agent_path, tsci_bin: "unused-tsci" })

  const job = job_store.getJob("job_disagreement")
  expect(job?.display_status).toBe("failed")
  expect(job?.validation?.evidence).toBe("passed")
  expect(job?.logs.map((log) => log.message).join("\n")).toContain(
    "Independent evidence consensus overrode the primary extraction",
  )
  expect(job?.logs.map((log) => log.message).join("\n")).toContain(
    "Generating the component from approved evidence only",
  )
  expect(
    JSON.parse(await Bun.file(join(job_dir, "component-evidence.json")).text()).footprint.pads[0].width,
  ).toBe(0.9)
  expect(await Bun.file(join(job_dir, "component-evidence.independent.json")).exists()).toBe(true)
  expect(
    await Bun.file(join(job_dir, "evidence-attempts/independent-1/component-evidence.json")).exists(),
  ).toBe(true)
  expect(
    await Bun.file(join(job_dir, "evidence-attempts/independent-2/component-evidence.json")).exists(),
  ).toBe(true)
  expect(
    await Bun.file(join(job_dir, "evidence-attempts/independent-2/typical-application-plan.json")).text(),
  ).toContain('"title": "fresh verification"')

  await rm(job_dir, { recursive: true, force: true })
})

test("a recovery tie-breaker resolves an initial three-way geometry split", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-runner-evidence-tiebreak-"))
  await Bun.write(join(job_dir, "datasheet.pdf"), "fake datasheet")
  const agent_path = join(job_dir, "tiebreak-agent")
  await Bun.write(
    agent_path,
    `#!/usr/bin/env bun
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
const prompt = args[args.indexOf("--prompt") + 1]
${fakeVisualInspectionHelpers}
const plan = { version: 2, title: "Typical application", description: "Datasheet circuit", source_references: [{ page: 8 }], components: [{ reference: "U1", kind: "device" }, { reference: "C1", kind: "capacitor", value: "1uF" }], connections: [{ net: "VCC", pins: ["U1.VCC", "C1.pin1"] }] }
if (prompt.includes("Independently extract")) {
  const padWidth = prompt.includes("recovery tie-breaker") ? 0.9 : prompt.includes("prior independent extraction") ? 0.8 : 0.9
  await recordEvidence(plan, { padWidth })
} else if (prompt.includes("evidence-extraction phase")) {
  await recordEvidence(plan, { padWidth: 0.6 })
} else {
  await Bun.write(dir + "/tsx-generation-reached", "expected after recovered evidence")
}
finishAgent()
`,
  )
  await chmod(agent_path, 0o755)

  const job_store = new JobStore()
  job_store.createJob({ job_id: "job_tiebreak", job_dir, file_name: "device.pdf" })
  await runJob({ job_id: "job_tiebreak" }, { job_store, agent_bin: agent_path, tsci_bin: "unused-tsci" })

  const job = job_store.getJob("job_tiebreak")
  const logs = job?.logs.map((log) => log.message).join("\n") ?? ""
  expect(job?.validation?.evidence).toBe("passed")
  expect(logs).toContain("Running a recovery tie-breaker verification")
  expect(logs).toContain("Recovery matched independent attempts 1 and 3")
  expect(
    JSON.parse(await Bun.file(join(job_dir, "component-evidence.json")).text()).footprint.pads[0].width,
  ).toBe(0.9)
  expect(
    await Bun.file(join(job_dir, "evidence-attempts/independent-3/component-evidence.json")).exists(),
  ).toBe(true)
  expect(logs).toContain("Generating the component from approved evidence only")

  await rm(job_dir, { recursive: true, force: true })
})

test("domain-level consensus recovers when component and application voters differ", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-runner-domain-consensus-"))
  await Bun.write(join(job_dir, "datasheet.pdf"), "fake datasheet")
  const agent_path = join(job_dir, "domain-consensus-agent")
  await Bun.write(
    agent_path,
    `#!/usr/bin/env bun
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
const prompt = args[args.indexOf("--prompt") + 1]
${fakeVisualInspectionHelpers}
const primaryPlan = { version: 2, title: "Documented application", description: "Datasheet circuit", source_references: [{ page: 8 }], components: [{ reference: "U1", kind: "device" }, { reference: "C1", kind: "capacitor", value: "1uF" }], connections: [{ net: "VCC", pins: ["U1.VCC", "C1.pin1"] }] }
const alternatePlan = { ...primaryPlan, title: "Incorrect application", components: [{ reference: "U1", kind: "device" }, { reference: "C1", kind: "capacitor", value: "2uF" }] }
if (prompt.includes("Independently extract")) {
  await recordEvidence(prompt.includes("prior independent extraction") ? primaryPlan : alternatePlan, { padWidth: 0.9 })
} else if (prompt.includes("evidence-extraction phase")) {
  await recordEvidence(primaryPlan, { padWidth: 0.6 })
} else {
  await Bun.write(dir + "/tsx-generation-reached", "expected after recovered evidence")
}
finishAgent()
`,
  )
  await chmod(agent_path, 0o755)

  const job_store = new JobStore()
  job_store.createJob({ job_id: "job_domain_consensus", job_dir, file_name: "device.pdf" })
  await runJob(
    { job_id: "job_domain_consensus" },
    { job_store, agent_bin: agent_path, tsci_bin: "unused-tsci" },
  )

  const job = job_store.getJob("job_domain_consensus")
  const logs = job?.logs.map((log) => log.message).join("\n") ?? ""
  expect(job?.validation?.evidence).toBe("passed")
  expect(logs).toContain("Domain-level evidence consensus recovered on independent attempt 2")
  expect(logs).toContain("Independent attempt 2 is retained")
  expect(
    JSON.parse(await Bun.file(join(job_dir, "component-evidence.json")).text()).footprint.pads[0].width,
  ).toBe(0.9)
  expect(JSON.parse(await Bun.file(join(job_dir, "typical-application-plan.json")).text()).title).toBe(
    "Documented application",
  )
  expect(
    await Bun.file(join(job_dir, "evidence-attempts/independent-3/component-evidence.json")).exists(),
  ).toBe(false)
  expect(logs).toContain("Generating the component from approved evidence only")

  await rm(job_dir, { recursive: true, force: true })
})

test("a fourth targeted adjudication resolves exact evidence facts instead of failing wholesale", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-runner-targeted-adjudication-"))
  await Bun.write(join(job_dir, "datasheet.pdf"), "fake datasheet")
  const agent_path = join(job_dir, "targeted-adjudication-agent")
  await Bun.write(
    agent_path,
    `#!/usr/bin/env bun
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
const prompt = args[args.indexOf("--prompt") + 1]
${fakeVisualInspectionHelpers}
const common = { version: 2, title: "Documented application", description: "Datasheet circuit", source_references: [{ page: 8 }], components: [{ reference: "U1", kind: "device", value: "SENSOR-1" }, { reference: "C1", kind: "capacitor", value: "1uF" }] }
const makePlan = (mode) => ({ ...common, connections: [{ net: "VCC", pins: ["U1.VCC", "C1.pin1", "U1." + mode] }] })
if (prompt.includes("Independently extract")) {
  const plan = prompt.includes("final targeted adjudication") && prompt.includes("Exact unresolved differences")
    ? makePlan("MODE_B")
    : prompt.includes("recovery tie-breaker")
      ? makePlan("MODE_C")
      : prompt.includes("prior independent extraction")
        ? makePlan("MODE_B")
        : makePlan("MODE_A")
  await recordEvidence(plan, { padWidth: 0.9 })
} else if (prompt.includes("evidence-extraction phase")) {
  await recordEvidence(makePlan("MODE_PRIMARY"), { padWidth: 0.6 })
} else {
  await Bun.write(dir + "/tsx-generation-reached", "expected after recovered evidence")
}
finishAgent()
`,
  )
  await chmod(agent_path, 0o755)

  const job_store = new JobStore()
  job_store.createJob({ job_id: "job_targeted_adjudication", job_dir, file_name: "device.pdf" })
  await runJob(
    { job_id: "job_targeted_adjudication" },
    { job_store, agent_bin: agent_path, tsci_bin: "unused-tsci" },
  )

  const job = job_store.getJob("job_targeted_adjudication")
  const logs = job?.logs.map((log) => log.message).join("\n") ?? ""
  expect(job?.validation?.evidence).toBe("passed")
  expect(logs).toContain("Running one final targeted adjudication")
  expect(logs).toContain("Recovery matched independent attempts 2 and 4")
  expect(
    JSON.parse(await Bun.file(join(job_dir, "typical-application-plan.json")).text()).connections[0].pins,
  ).toContain("U1.MODE_B")
  expect(
    await Bun.file(join(job_dir, "evidence-attempts/independent-4/component-evidence.json")).exists(),
  ).toBe(true)

  await rm(job_dir, { recursive: true, force: true })
})

test("an invalid independent inspection does not consume a consensus vote", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-runner-evidence-invalid-vote-"))
  await Bun.write(join(job_dir, "datasheet.pdf"), "fake datasheet")
  const agent_path = join(job_dir, "invalid-vote-agent")
  await Bun.write(
    agent_path,
    `#!/usr/bin/env bun
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
const prompt = args[args.indexOf("--prompt") + 1]
${fakeVisualInspectionHelpers}
const plan = { version: 2, title: "Typical application", description: "Datasheet circuit", source_references: [{ page: 8 }], components: [{ reference: "U1", kind: "device" }, { reference: "C1", kind: "capacitor", value: "1uF" }], connections: [{ net: "VCC", pins: ["U1.VCC", "C1.pin1"] }] }
if (prompt.includes("Independently extract")) {
  await recordEvidence(plan, { padWidth: 0.9, skipLandReferenceRead: !prompt.includes("Server validation feedback"), distinctEvidenceImages: true })
} else if (prompt.includes("evidence-extraction phase")) {
  await recordEvidence(plan, { padWidth: 0.6 })
} else {
  await Bun.write(dir + "/tsx-generation-reached", "expected after recovered evidence")
}
finishAgent()
`,
  )
  await chmod(agent_path, 0o755)

  const job_store = new JobStore()
  job_store.createJob({ job_id: "job_invalid_vote", job_dir, file_name: "device.pdf" })
  await runJob({ job_id: "job_invalid_vote" }, { job_store, agent_bin: agent_path, tsci_bin: "unused-tsci" })

  const job = job_store.getJob("job_invalid_vote")
  const logs = job?.logs.map((log) => log.message).join("\n") ?? ""
  expect(job?.validation?.evidence).toBe("passed")
  expect(logs).toContain("without consuming a consensus vote")
  expect(logs).toContain("Recovery matched independent attempts 2 and 3")
  expect(await Bun.file(join(job_dir, "evidence-attempts/independent-1/error.json")).text()).toContain(
    "was not successfully inspected as pixels",
  )
  expect(
    JSON.parse(await Bun.file(join(job_dir, "component-evidence.json")).text()).footprint.pads[0].width,
  ).toBe(0.9)
  expect(logs).toContain("Generating the component from approved evidence only")

  await rm(job_dir, { recursive: true, force: true })
})

test("evidence recovery survives a pixel-delivery failure after a valid disagreement", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-runner-evidence-read-recovery-"))
  await Bun.write(join(job_dir, "datasheet.pdf"), "fake datasheet")
  const agent_path = join(job_dir, "read-recovery-agent")
  await Bun.write(
    agent_path,
    `#!/usr/bin/env bun
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
const prompt = args[args.indexOf("--prompt") + 1]
${fakeVisualInspectionHelpers}
const plan = { version: 2, title: "Typical application", description: "Datasheet circuit", source_references: [{ page: 8 }], components: [{ reference: "U1", kind: "device" }, { reference: "C1", kind: "capacitor", value: "1uF" }], connections: [{ net: "VCC", pins: ["U1.VCC", "C1.pin1"] }] }
if (prompt.includes("Independently extract")) {
  if (!prompt.includes("Server validation feedback")) {
    await recordEvidence(plan, { padWidth: 0.9 })
  } else if (prompt.includes("prior independent extraction")) {
    await recordEvidence(plan, { padWidth: 0.6, skipLandReferenceRead: true, distinctEvidenceImages: true })
  } else {
    await recordEvidence(plan, { padWidth: 0.6 })
  }
} else if (prompt.includes("evidence-extraction phase")) {
  await recordEvidence(plan, { padWidth: 0.6 })
} else {
  await Bun.write(dir + "/tsx-generation-reached", "expected after recovered evidence")
}
finishAgent()
`,
  )
  await chmod(agent_path, 0o755)

  const job_store = new JobStore()
  job_store.createJob({ job_id: "job_read_recovery", job_dir, file_name: "device.pdf" })
  await runJob({ job_id: "job_read_recovery" }, { job_store, agent_bin: agent_path, tsci_bin: "unused-tsci" })

  const job = job_store.getJob("job_read_recovery")
  const logs = job?.logs.map((log) => log.message).join("\n") ?? ""
  expect(job?.validation?.evidence).toBe("passed")
  expect(logs).toContain("attempt 1 disagreed with the primary extraction")
  expect(logs).toContain("attempt 2 could not complete")
  expect(logs).toContain("without consuming a consensus vote")
  expect(logs).toContain("Evidence consensus recovered on independent attempt 3")
  expect(await Bun.file(join(job_dir, "evidence-attempts/independent-2/error.json")).text()).toContain(
    "was not successfully inspected as pixels",
  )
  expect(
    await Bun.file(join(job_dir, "evidence-attempts/independent-3/component-evidence.json")).exists(),
  ).toBe(true)
  expect(
    await Bun.file(join(job_dir, "evidence-attempts/independent-4/component-evidence.json")).exists(),
  ).toBe(false)
  expect(logs).toContain("Generating the component from approved evidence only")

  await rm(job_dir, { recursive: true, force: true })
})

test("evidence recovery accepts package drawing codes and semantic passive references", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-runner-semantic-recovery-"))
  await Bun.write(join(job_dir, "datasheet.pdf"), "fake datasheet")
  const agent_path = join(job_dir, "semantic-recovery-agent")
  await Bun.write(
    agent_path,
    `#!/usr/bin/env bun
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
const prompt = args[args.indexOf("--prompt") + 1]
${fakeVisualInspectionHelpers}
const common = { version: 4, availability: "documented", pcb_implementation: "schematic_only", title: "Current monitor application", description: "Reference circuit", source_references: [{ page: 32 }] }
const primaryPlan = { ...common, components: [{ reference: "U1", kind: "device", value: "SENSOR-1" }, { reference: "C_BYP", kind: "capacitor", value: "100nF" }, { reference: "RSHUNT", kind: "resistor", value: "16.2mOhm" }, { reference: "RPU_SCL", kind: "resistor", value: "10kOhm" }, { reference: "RPU_ALERT", kind: "resistor", value: "10kOhm" }], connections: [{ net: "VS", pins: ["U1.VS", "C_BYP.1", "RPU_SCL.1", "RPU_ALERT.1"] }, { net: "GND", pins: ["U1.GND", "C_BYP.2"] }, { net: "BUS", pins: ["U1.IN+", "RSHUNT.1"] }, { net: "LOAD", pins: ["U1.IN-", "RSHUNT.2"] }, { net: "SCL", pins: ["U1.SCL", "RPU_SCL.2"] }, { net: "ALERT", pins: ["U1.ALERT", "RPU_ALERT.2"] }] }
const incompletePlan = { ...common, components: [{ reference: "U1", kind: "device", value: "SENSOR-1" }, { reference: "C1", kind: "capacitor", value: "100nF" }, { reference: "R1", kind: "resistor", value: "10kOhm" }, { reference: "R2", kind: "resistor", value: "10kOhm" }], connections: [{ net: "VS", pins: ["U1.VS", "C1.1", "R1.1", "R2.1"] }, { net: "GND", pins: ["U1.GND", "C1.2"] }, { net: "SCL", pins: ["U1.SCL", "R1.2"] }, { net: "ALERT", pins: ["U1.ALERT", "R2.2"] }] }
const sequentialPlan = { ...common, components: [{ reference: "U1", kind: "device", value: "SENSOR-1" }, { reference: "C1", kind: "capacitor", value: "100 nF" }, { reference: "R1", kind: "resistor", value: "16.2 mOhm" }, { reference: "R2", kind: "resistor", value: "10 kOhm" }, { reference: "R3", kind: "resistor", value: "10 kOhm" }], connections: [{ net: "SUPPLY", pins: ["C1.1", "R2.1", "R3.1", "U1.VS"] }, { net: "GROUND", pins: ["C1.2", "U1.GND"] }, { net: "SOURCE", pins: ["R1.1", "U1.IN+"] }, { net: "SENSED", pins: ["R1.2", "U1.IN-"] }, { net: "CLOCK", pins: ["R2.2", "U1.SCL"] }, { net: "FAULT", pins: ["R3.2", "U1.ALERT"] }] }
if (prompt.includes("Independently extract")) {
  await recordEvidence(prompt.includes("prior independent extraction") ? sequentialPlan : incompletePlan, { packageCode: "DGS" })
} else if (prompt.includes("evidence-extraction phase")) {
  await recordEvidence(primaryPlan, { packageCode: "DGS0001A" })
} else {
  await Bun.write(dir + "/tsx-generation-reached", "expected after recovered evidence")
}
finishAgent()
`,
  )
  await chmod(agent_path, 0o755)

  const job_store = new JobStore()
  job_store.createJob({ job_id: "job_semantic_recovery", job_dir, file_name: "device.pdf" })
  await runJob(
    { job_id: "job_semantic_recovery" },
    { job_store, agent_bin: agent_path, tsci_bin: "unused-tsci" },
  )

  const job = job_store.getJob("job_semantic_recovery")
  const logs = job?.logs.map((log) => log.message).join("\n") ?? ""
  expect(job?.validation?.evidence).toBe("passed")
  expect(logs).toContain("Evidence consensus recovered on independent attempt 2")
  expect(logs).toContain("base code versus full drawing identifier")
  expect(
    await Bun.file(join(job_dir, "evidence-attempts/independent-2/component-evidence.json")).exists(),
  ).toBe(true)
  expect(
    await Bun.file(join(job_dir, "evidence-attempts/independent-3/component-evidence.json")).exists(),
  ).toBe(false)
  expect(logs).toContain("Generating the component from approved evidence only")

  await rm(job_dir, { recursive: true, force: true })
})

test("an unresolved independent extraction can recover on an equivalent package code", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-runner-package-recovery-"))
  await Bun.write(join(job_dir, "datasheet.pdf"), "fake datasheet")
  const agent_path = join(job_dir, "package-recovery-agent")
  await Bun.write(
    agent_path,
    `#!/usr/bin/env bun
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
const prompt = args[args.indexOf("--prompt") + 1]
${fakeVisualInspectionHelpers}
const plan = { version: 3, availability: "documented", title: "Current monitor application", description: "Reference circuit", source_references: [{ page: 32 }], components: [{ reference: "U1", kind: "device", value: "SENSOR-1" }, { reference: "C1", kind: "capacitor", value: "100nF" }], connections: [{ net: "VS", pins: ["U1.VCC", "C1.1"] }, { net: "GND", pins: ["U1.GND", "C1.2"] }] }
if (prompt.includes("Independently extract")) {
  if (prompt.includes("Server validation feedback")) {
    await recordEvidence(plan, { packageCode: "DGS" })
  } else {
    await recordEvidence(plan, { packageCode: "DGS0001A", status: "unresolved", ambiguities: ["Exact ordering code was not resolved"] })
  }
} else if (prompt.includes("evidence-extraction phase")) {
  await recordEvidence(plan, { packageCode: "DGS0001A" })
} else {
  await Bun.write(dir + "/tsx-generation-reached", "expected after recovered evidence")
}
finishAgent()
`,
  )
  await chmod(agent_path, 0o755)

  const job_store = new JobStore()
  job_store.createJob({ job_id: "job_package_recovery", job_dir, file_name: "device.pdf" })
  await runJob(
    { job_id: "job_package_recovery" },
    { job_store, agent_bin: agent_path, tsci_bin: "unused-tsci" },
  )

  const job = job_store.getJob("job_package_recovery")
  const logs = job?.logs.map((log) => log.message).join("\n") ?? ""
  expect(job?.validation?.evidence).toBe("passed")
  expect(logs).toContain("attempt 1 was incomplete")
  expect(logs).toContain("Evidence verification recovered on independent attempt 2")
  expect(logs).toContain("base code versus full drawing identifier")
  expect(
    await Bun.file(join(job_dir, "evidence-attempts/independent-2/component-evidence.json")).exists(),
  ).toBe(true)
  expect(
    await Bun.file(join(job_dir, "evidence-attempts/independent-3/component-evidence.json")).exists(),
  ).toBe(false)
  expect(logs).toContain("Generating the component from approved evidence only")

  await rm(job_dir, { recursive: true, force: true })
})

test("three-way geometry disagreement remains unsupported", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-runner-no-consensus-"))
  await Bun.write(join(job_dir, "datasheet.pdf"), "fake datasheet")
  const agent_path = join(job_dir, "no-consensus-agent")
  await Bun.write(
    agent_path,
    `#!/usr/bin/env bun
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
const prompt = args[args.indexOf("--prompt") + 1]
${fakeVisualInspectionHelpers}
const plan = { version: 2, title: "Typical application", description: "Datasheet circuit", source_references: [{ page: 8 }], components: [{ reference: "U1", kind: "device" }, { reference: "C1", kind: "capacitor", value: "1uF" }], connections: [{ net: "VCC", pins: ["U1.VCC", "C1.pin1"] }] }
if (prompt.includes("Independently extract")) {
  await recordEvidence(plan, { padWidth: prompt.includes("final targeted adjudication") ? 0.65 : prompt.includes("recovery tie-breaker") ? 0.7 : prompt.includes("prior independent extraction") ? 0.8 : 0.9 })
} else if (prompt.includes("evidence-extraction phase")) {
  await recordEvidence(plan, { padWidth: 0.6 })
} else {
  await Bun.write(dir + "/tsx-generation-reached", "unexpected")
}
finishAgent()
`,
  )
  await chmod(agent_path, 0o755)

  const job_store = new JobStore()
  job_store.createJob({ job_id: "job_no_consensus", job_dir, file_name: "device.pdf" })
  await runJob({ job_id: "job_no_consensus" }, { job_store, agent_bin: agent_path, tsci_bin: "unused-tsci" })

  const job = job_store.getJob("job_no_consensus")
  expect(job?.display_status).toBe("unsupported")
  expect(job?.validation?.evidence).toBe("unresolved")
  expect(job?.error_message).toContain("did not reach consensus")
  expect(job?.error_message).toContain("independent-1 versus independent-2")
  expect(job?.error_message).toContain("independent-2 versus independent-3")
  expect(job?.error_message).toContain("independent-3 versus independent-4")
  expect(
    await Bun.file(join(job_dir, "evidence-attempts/independent-4/component-evidence.json")).exists(),
  ).toBe(true)
  expect(await Bun.file(join(job_dir, "tsx-generation-reached")).exists()).toBe(false)

  await rm(job_dir, { recursive: true, force: true })
})

test("invalid independent attempts retain their raw artifacts and parser errors", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-runner-invalid-independent-"))
  await Bun.write(join(job_dir, "datasheet.pdf"), "fake datasheet")
  const agent_path = join(job_dir, "invalid-independent-agent")
  await Bun.write(
    agent_path,
    `#!/usr/bin/env bun
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
const prompt = args[args.indexOf("--prompt") + 1]
${fakeVisualInspectionHelpers}
const validPlan = { version: 3, availability: "documented", title: "Application", description: "Reference circuit", source_references: [{ page: 8 }], components: [{ reference: "U1", kind: "device" }, { reference: "C1", kind: "capacitor", value: "1uF" }], connections: [{ net: "VCC", pins: ["U1.VCC", "C1.1"] }] }
const invalidPlan = { ...validPlan, connections: [{ net: "VCC", pins: ["U1.VCC", "VIN_IN.positive"] }] }
if (prompt.includes("Independently extract")) await recordEvidence(invalidPlan)
else if (prompt.includes("evidence-extraction phase")) await recordEvidence(validPlan)
finishAgent()
`,
  )
  await chmod(agent_path, 0o755)

  const job_store = new JobStore()
  job_store.createJob({ job_id: "job_invalid_independent", job_dir, file_name: "device.pdf" })
  await runJob(
    { job_id: "job_invalid_independent" },
    { job_store, agent_bin: agent_path, tsci_bin: "unused-tsci" },
  )

  const job = job_store.getJob("job_invalid_independent")
  expect(job?.display_status).toBe("unsupported")
  expect(job?.error_message).toContain("references an unlisted component")
  for (const attempt of [1, 2, 3, 4]) {
    const attempt_dir = join(job_dir, `evidence-attempts/independent-${attempt}`)
    expect(await Bun.file(join(attempt_dir, "typical-application-plan.json")).exists()).toBe(true)
    expect(await Bun.file(join(attempt_dir, "error.json")).text()).toContain(
      "references an unlisted component",
    )
  }

  await rm(job_dir, { recursive: true, force: true })
})

test("unresolved primary evidence retries automatically and stops without crashing", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-runner-unresolved-evidence-"))
  await Bun.write(join(job_dir, "datasheet.pdf"), "fake datasheet")
  const agent_path = join(job_dir, "unresolved-agent")
  await Bun.write(
    agent_path,
    `#!/usr/bin/env bun
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
const prompt = args[args.indexOf("--prompt") + 1]
${fakeVisualInspectionHelpers}
const plan = { version: 3, availability: "documented", title: "Typical application", description: "Datasheet circuit", source_references: [{ page: 8 }], components: [{ reference: "U1", kind: "device" }, { reference: "C1", kind: "capacitor", value: "1uF" }], connections: [{ net: "VCC", pins: ["U1.VCC", "C1.pin1"] }] }
if (prompt.includes("evidence-extraction phase")) {
  const promptLog = dir + "/retry-prompts.log"
  const previous = await Bun.file(promptLog).exists() ? await Bun.file(promptLog).text() : ""
  await Bun.write(promptLog, previous + prompt + "\\n--- attempt ---\\n")
  if (prompt.includes("Server validation feedback from the previous attempt")) {
    await (await import("node:fs/promises")).rm(dir + "/agent-events.jsonl", { force: true })
  }
  await recordEvidence(plan, { status: "unresolved", emptyPads: true, ambiguities: ["Pad dimensions could not be resolved automatically"] })
} else {
  await Bun.write(dir + "/tsx-generation-reached", "unexpected")
}
finishAgent()
`,
  )
  await chmod(agent_path, 0o755)

  const job_store = new JobStore()
  job_store.createJob({ job_id: "job_unresolved", job_dir, file_name: "device.pdf" })
  await runJob({ job_id: "job_unresolved" }, { job_store, agent_bin: agent_path, tsci_bin: "unused-tsci" })

  const job = job_store.getJob("job_unresolved")
  expect(job?.display_status).toBe("unsupported")
  expect(job?.has_errors).toBe(false)
  expect(job?.validation?.evidence).toBe("unresolved")
  expect(job?.evidence_available).toBe(true)
  expect(job?.error_message).toContain("Evidence extraction remained unresolved")
  expect(job?.logs.map((log) => log.message).join("\n")).toContain("Retrying automatically")
  expect(job?.logs.map((log) => log.message).join("\n")).toContain("stopped safely")
  const retry_prompts = await Bun.file(join(job_dir, "retry-prompts.log")).text()
  expect(retry_prompts).toContain("Server validation feedback from the previous attempt")
  expect(retry_prompts).toContain("Pad dimensions could not be resolved automatically")
  const agent_events = await Bun.file(join(job_dir, "agent-events.jsonl")).text()
  expect(agent_events).toContain('"phase":"primary_evidence_attempt_1"')
  expect(agent_events).toContain('"phase":"primary_evidence_attempt_2"')
  expect(await Bun.file(join(job_dir, "evidence-attempts/primary-1/component-evidence.json")).exists()).toBe(
    true,
  )
  expect(await Bun.file(join(job_dir, "evidence-attempts/primary-1/error.json")).text()).toContain(
    "Evidence extraction remained unresolved",
  )
  expect(await Bun.file(join(job_dir, "evidence-attempts/primary-2/component-evidence.json")).exists()).toBe(
    true,
  )
  expect(await Bun.file(join(job_dir, "tsx-generation-reached")).exists()).toBe(false)
  expect(await Bun.file(join(job_dir, "photon_rs_bg.wasm")).exists()).toBe(false)

  await rm(job_dir, { recursive: true, force: true })
})

test("an exhausted agent transport outage does not consume evidence-quality attempts", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-runner-transport-outage-"))
  await Bun.write(join(job_dir, "datasheet.pdf"), "fake datasheet")
  const agent_path = join(job_dir, "transport-outage-agent")
  await Bun.write(
    agent_path,
    `#!/usr/bin/env bun
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
const countPath = dir + "/transport-call-count"
const count = Number(await Bun.file(countPath).text().catch(() => "0")) + 1
await Bun.write(countPath, String(count))
console.error("error: Was there a typo in the url or port?")
process.exit(1)
`,
  )
  await chmod(agent_path, 0o755)

  const job_store = new JobStore()
  job_store.createJob({ job_id: "job_transport_outage", job_dir, file_name: "device.pdf" })
  await runJob(
    { job_id: "job_transport_outage" },
    {
      job_store,
      agent_bin: agent_path,
      tsci_bin: "unused-tsci",
      agent_transport_retry_limit: 2,
      agent_transport_retry_base_delay_ms: 0,
    },
  )

  const job = job_store.getJob("job_transport_outage")
  const logs = await Bun.file(join(job_dir, "agent.log")).text()
  expect(job?.display_status).toBe("unsupported")
  expect(job?.error_message).toContain("Agent transport remained unavailable after 3 connection attempt(s)")
  expect(await Bun.file(join(job_dir, "transport-call-count")).text()).toBe("3")
  expect(logs).not.toContain("Evidence attempt 1 was incomplete")
  expect(logs).toContain("Agent transport was unavailable")

  await rm(job_dir, { recursive: true, force: true })
})

test("inconclusive component vision cannot pass the completion gate", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-runner-inconclusive-vision-"))
  await Bun.write(join(job_dir, "datasheet.pdf"), "fake datasheet")
  const agent_path = join(job_dir, "inconclusive-agent")
  await Bun.write(
    agent_path,
    `#!/usr/bin/env bun
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
const prompt = args[args.indexOf("--prompt") + 1]
${fakeVisualInspectionHelpers}
const plan = { version: 2, title: "Typical application", description: "Datasheet circuit", source_references: [{ page: 8 }], components: [{ reference: "U1", kind: "device" }, { reference: "C1", kind: "capacitor", value: "1uF" }], connections: [{ net: "VCC", pins: ["U1.VCC", "C1.pin1"] }] }
if (prompt.includes("Independently extract") || prompt.includes("evidence-extraction phase")) {
  await recordEvidence(plan)
} else if (prompt.includes("Generate the reusable")) {
  await Bun.write(dir + "/index.circuit.tsx", 'export default function Part() { return <chip name="U1" /> }\\n')
  await recordVisualInspection("component", "inconclusive", false)
}
finishAgent()
`,
  )
  await chmod(agent_path, 0o755)

  const job_store = new JobStore()
  job_store.createJob({ job_id: "job_inconclusive", job_dir, file_name: "device.pdf" })
  await runJob({ job_id: "job_inconclusive" }, { job_store, agent_bin: agent_path, tsci_bin: "unused-tsci" })

  const job = job_store.getJob("job_inconclusive")
  expect(job?.display_status).toBe("unsupported")
  expect(job?.component_ready).not.toBe(true)
  expect(job?.validation?.component_visual).toBe("inconclusive")
  expect(job?.error_message).toContain("image inspection could not be completed automatically")

  await rm(job_dir, { recursive: true, force: true })
})

test("component generation cannot replace a locked visual reference", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-runner-reference-lock-"))
  await Bun.write(join(job_dir, "datasheet.pdf"), "fake datasheet")
  const agent_path = join(job_dir, "reference-lock-agent")
  await Bun.write(
    agent_path,
    `#!/usr/bin/env bun
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
const prompt = args[args.indexOf("--prompt") + 1]
${fakeVisualInspectionHelpers}
const plan = { version: 2, title: "Typical application", description: "Datasheet circuit", source_references: [{ page: 8 }], components: [{ reference: "U1", kind: "device" }, { reference: "C1", kind: "capacitor", value: "1uF" }], connections: [{ net: "VCC", pins: ["U1.VCC", "C1.pin1"] }] }
if (prompt.includes("Independently extract") || prompt.includes("evidence-extraction phase")) {
  await recordEvidence(plan)
} else if (prompt.includes("Generate the reusable")) {
  await Bun.write(dir + "/index.circuit.tsx", 'export default function Part() { return <chip name="U1" /> }\\n')
  await recordVisualInspection("component")
  await Bun.write(dir + "/visual-reference/pages/page-009.png", "tampered")
}
finishAgent()
`,
  )
  await chmod(agent_path, 0o755)

  const job_store = new JobStore()
  job_store.createJob({ job_id: "job_reference_lock", job_dir, file_name: "device.pdf" })
  await runJob(
    { job_id: "job_reference_lock" },
    { job_store, agent_bin: agent_path, tsci_bin: "unused-tsci" },
  )

  const job = job_store.getJob("job_reference_lock")
  expect(job?.display_status).toBe("failed")
  expect(job?.error_message).toContain("modified locked evidence")
  expect(await Bun.file(join(job_dir, "visual-reference/pages/page-009.png")).exists()).toBe(false)

  await rm(job_dir, { recursive: true, force: true })
})

test("component-only datasheets complete without inventing a typical application", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-runner-no-application-"))
  await Bun.write(join(job_dir, "datasheet.pdf"), "fake datasheet")
  const agent_path = join(job_dir, "no-application-agent")
  const tsci_path = join(job_dir, "no-application-tsci")
  await Promise.all([
    Bun.write(
      agent_path,
      `#!/usr/bin/env bun
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
const prompt = args[args.indexOf("--prompt") + 1]
${fakeVisualInspectionHelpers}
const plan = { version: 3, availability: "not_present", title: "No documented application", description: "Application-related sections were searched without a reference circuit", source_references: [{ page: 1 }], searched_sections: ["Applications", "Reference designs"], components: [], connections: [] }
if (prompt.includes("Independently extract") || prompt.includes("evidence-extraction phase")) {
  await recordEvidence(plan)
} else if (prompt.includes("Generate the reusable")) {
  await Bun.write(dir + "/index.circuit.tsx", 'export default function Part() { return <chip name="U1" /> }\\n')
  await recordVisualInspection("component")
} else {
  await Bun.write(dir + "/application-generation-reached", "unexpected")
}
finishAgent()
`,
    ),
    Bun.write(
      tsci_path,
      `#!/usr/bin/env bun
import { mkdir } from "node:fs/promises"
const target = Bun.argv.slice(2)[1]
const stem = target.replace(/\\.circuit\\.tsx$/, "")
await mkdir(process.cwd() + "/dist/" + stem, { recursive: true })
const renderPng = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (character) => character.charCodeAt(0))
await Bun.write(process.cwd() + "/dist/" + stem + "/pcb.png", renderPng)
await Bun.write(process.cwd() + "/dist/" + stem + "/schematic.png", renderPng)
const circuit = [{ type: "source_component", source_component_id: "part", name: "U1", manufacturer_part_number: "SENSOR-1" }, { type: "source_port", source_port_id: "u1_vcc", source_component_id: "part", name: "VCC", pin_number: 1, port_hints: ["1", "VCC"], requires_power: true }, { type: "schematic_component", schematic_component_id: "sch1", source_component_id: "part", center: { x: 0, y: 0 } }, { type: "schematic_port", schematic_port_id: "sp1", schematic_component_id: "sch1", source_port_id: "u1_vcc", side_of_component: "top", center: { x: 0, y: 1 } }, { type: "pcb_smtpad", port_hints: ["1"], x: 0, y: 0, width: 0.6, height: 0.25 }]
await Bun.write(process.cwd() + "/dist/" + stem + "/circuit.json", JSON.stringify(circuit))
`,
    ),
  ])
  await Promise.all([chmod(agent_path, 0o755), chmod(tsci_path, 0o755)])

  const job_store = new JobStore()
  job_store.createJob({ job_id: "job_no_application", job_dir, file_name: "device.pdf" })
  await runJob({ job_id: "job_no_application" }, { job_store, agent_bin: agent_path, tsci_bin: tsci_path })

  const job = job_store.getJob("job_no_application")
  expect(job?.display_status).toBe("complete")
  expect(job?.component_ready).toBe(true)
  expect(job?.typical_application_code).toBeUndefined()
  expect(job?.validation?.application_build).toBe("not_applicable")
  expect(await Bun.file(join(job_dir, "application-generation-reached")).exists()).toBe(false)

  await rm(job_dir, { recursive: true, force: true })
})

test("cancelling a running job terminates its agent process", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-runner-cancel-"))
  const agent_path = join(job_dir, "slow-agent")
  await Bun.write(join(job_dir, "datasheet.pdf"), "fake datasheet")
  await Bun.write(
    agent_path,
    `#!/usr/bin/env bun
console.log("slow agent started")
await Bun.sleep(30_000)
`,
  )
  await chmod(agent_path, 0o755)

  const job_store = new JobStore()
  job_store.createJob({ job_id: "job_cancel", job_dir, file_name: "sensor.pdf" })
  const run_promise = runJob(
    { job_id: "job_cancel" },
    { job_store, agent_bin: agent_path, tsci_bin: "unused-tsci" },
  )

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Agent did not start")), 2_000)
    const unsubscribe = job_store.subscribe("job_cancel", (job_event) => {
      if (job_event.event_type === "log" && job_event.log.message.includes("slow agent started")) {
        clearTimeout(timeout)
        unsubscribe?.()
        resolve()
      }
    })
  })

  expect(job_store.requestCancellation("job_cancel")).toBe("requested")
  await Promise.race([
    run_promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Cancellation timed out")), 4_000)),
  ])

  const job = job_store.getJob("job_cancel")
  expect(job?.display_status).toBe("cancelled")
  expect(job?.is_complete).toBe(true)
  expect(job?.has_errors).toBe(false)
  expect(job?.logs.at(-1)?.message).toContain("active job process was stopped")

  await rm(job_dir, { recursive: true, force: true })
})
