import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { runJob } from "@/server/component-workflow"
import type { AgentClient } from "@/server/infrastructure/agent"
import {
  ProcessError,
  type ProcessRunner,
  type ProcessRunRequest,
  type ProcessRunResult,
} from "@/server/infrastructure/process"
import { JobStore } from "@/server/job-store"

const temporary_directories: string[] = []
const png_bytes = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
  (character) => character.charCodeAt(0),
)

afterEach(async () => {
  await Promise.all(
    temporary_directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

const text_source = {
  page: 1,
  method: "pdf_text",
  confidence: "high",
}

const visual_source = {
  page: 2,
  figure: "Recommended land pattern",
  method: "pdf_visual",
  confidence: "high",
  image: "visual-reference/land-pattern.png",
  render_dpi: 200,
}

const component_evidence = {
  version: 1,
  status: "resolved",
  part_number: { value: "GENERIC-2", sources: [text_source] },
  package: {
    name: { value: "Two-terminal test package", sources: [text_source] },
    pin_count: { value: 2, sources: [text_source] },
  },
  pinout: {
    pins: [
      { number: "1", labels: ["INPUT"], role: "input", sources: [text_source] },
      { number: "2", labels: ["RETURN"], role: "ground", sources: [text_source] },
    ],
  },
  footprint: {
    view: "pcb_top",
    units: "mm",
    drawing_orientation: { value: "pcb_top", sources: [visual_source] },
    pads: [
      {
        pin: "1",
        kind: "smt",
        x: -0.75,
        y: 0,
        width: 0.55,
        height: 0.8,
        sources: [visual_source],
      },
      {
        pin: "2",
        kind: "smt",
        x: 0.75,
        y: 0,
        width: 0.55,
        height: 0.8,
        sources: [visual_source],
      },
    ],
  },
  unresolved_ambiguities: [],
}

const application_plan = {
  version: 4,
  availability: "documented",
  pcb_implementation: "schematic_only",
  title: "Input bypass",
  description: "The documented application bypasses INPUT to RETURN with 100 nF.",
  source_references: [{ page: 3, figure: "Typical application" }],
  components: [
    { reference: "U1", kind: "integrated_circuit", value: "GENERIC-2" },
    { reference: "C1", kind: "capacitor", value: "100nF" },
  ],
  connections: [
    { net: "INPUT", pins: ["U1.INPUT", "C1.pin1"] },
    { net: "RETURN", pins: ["U1.RETURN", "C1.pin2"] },
  ],
}

const component_source = `export default function Generic2() {
  return <chip name="U1" manufacturerPartNumber="GENERIC-2" />
}
`

const application_source = `import Generic2 from "./index.circuit"

export default function InputBypass() {
  return (
    <>
      <Generic2 name="U1" />
      <capacitor name="C1" capacitance="100nF" />
      <trace from=".U1 > .INPUT" to=".C1 > .pin1" />
      <trace from=".U1 > .RETURN" to=".C1 > .pin2" />
    </>
  )
}
`

const component_circuit_json = [
  {
    type: "source_component",
    source_component_id: "source_component_u1",
    name: "U1",
    manufacturer_part_number: "GENERIC-2",
  },
  {
    type: "source_port",
    source_port_id: "source_port_u1_input",
    source_component_id: "source_component_u1",
    pin_number: "1",
    name: "INPUT",
    port_hints: ["pin1", "INPUT"],
  },
  {
    type: "source_port",
    source_port_id: "source_port_u1_return",
    source_component_id: "source_component_u1",
    pin_number: "2",
    name: "RETURN",
    port_hints: ["pin2", "RETURN"],
    requires_ground: true,
  },
  {
    type: "schematic_component",
    schematic_component_id: "schematic_component_u1",
    source_component_id: "source_component_u1",
  },
  {
    type: "schematic_port",
    schematic_port_id: "schematic_port_u1_input",
    source_port_id: "source_port_u1_input",
    side_of_component: "left",
    center: { x: -1, y: 0 },
  },
  {
    type: "schematic_port",
    schematic_port_id: "schematic_port_u1_return",
    source_port_id: "source_port_u1_return",
    side_of_component: "bottom",
    center: { x: 0, y: -1 },
  },
  {
    type: "pcb_component",
    pcb_component_id: "pcb_component_u1",
    source_component_id: "source_component_u1",
  },
  {
    type: "pcb_smtpad",
    pcb_smtpad_id: "pcb_smtpad_u1_1",
    pcb_component_id: "pcb_component_u1",
    x: -0.75,
    y: 0,
    width: 0.55,
    height: 0.8,
    port_hints: ["pin1"],
  },
  {
    type: "pcb_smtpad",
    pcb_smtpad_id: "pcb_smtpad_u1_2",
    pcb_component_id: "pcb_component_u1",
    x: 0.75,
    y: 0,
    width: 0.55,
    height: 0.8,
    port_hints: ["pin2"],
  },
]

const application_circuit_json = [
  {
    type: "source_component",
    source_component_id: "source_component_application_u1",
    name: "U1",
    manufacturer_part_number: "GENERIC-2",
  },
  {
    type: "source_component",
    source_component_id: "source_component_c1",
    name: "C1",
    capacitance: 1e-7,
  },
  {
    type: "source_port",
    source_port_id: "source_port_application_u1_input",
    source_component_id: "source_component_application_u1",
    pin_number: "1",
    name: "INPUT",
    port_hints: ["pin1", "INPUT"],
  },
  {
    type: "source_port",
    source_port_id: "source_port_application_u1_return",
    source_component_id: "source_component_application_u1",
    pin_number: "2",
    name: "RETURN",
    port_hints: ["pin2", "RETURN"],
    requires_ground: true,
  },
  {
    type: "source_port",
    source_port_id: "source_port_c1_1",
    source_component_id: "source_component_c1",
    pin_number: "1",
    name: "pin1",
    port_hints: ["pin1"],
  },
  {
    type: "source_port",
    source_port_id: "source_port_c1_2",
    source_component_id: "source_component_c1",
    pin_number: "2",
    name: "pin2",
    port_hints: ["pin2"],
  },
  {
    type: "source_trace",
    source_trace_id: "source_trace_input",
    connected_source_port_ids: ["source_port_application_u1_input", "source_port_c1_1"],
  },
  {
    type: "source_trace",
    source_trace_id: "source_trace_return",
    connected_source_port_ids: ["source_port_application_u1_return", "source_port_c1_2"],
  },
  {
    type: "schematic_component",
    schematic_component_id: "schematic_component_application_u1",
    source_component_id: "source_component_application_u1",
  },
  {
    type: "schematic_component",
    schematic_component_id: "schematic_component_c1",
    source_component_id: "source_component_c1",
  },
]

function deterministicAgent(calls: string[]): AgentClient {
  return {
    async run(input) {
      calls.push(input.phase_label)
      if (input.phase_label === "Datasheet evidence extraction") {
        const reference_dir = join(input.workspace, "visual-reference")
        await mkdir(reference_dir, { recursive: true })
        await Promise.all([
          Bun.write(
            join(input.workspace, "component-evidence.json"),
            `${JSON.stringify(component_evidence, null, 2)}\n`,
          ),
          Bun.write(
            join(input.workspace, "typical-application-plan.json"),
            `${JSON.stringify(application_plan, null, 2)}\n`,
          ),
          Bun.write(join(reference_dir, "land-pattern.png"), png_bytes),
          Bun.write(join(reference_dir, "typical-application.png"), png_bytes),
        ])
      } else if (input.phase_label === "Component source generation") {
        await Bun.write(join(input.workspace, "index.circuit.tsx"), component_source)
      } else if (input.phase_label === "Application source generation") {
        await Bun.write(join(input.workspace, "typical-application.circuit.tsx"), application_source)
      } else {
        throw new Error(`Unexpected agent phase: ${input.phase_label}`)
      }
      await input.on_output("stdout", `fixture completed ${input.phase_label}\n`)
      return { attempts: 1, duration_ms: 1, output_tail: "" }
    },
  }
}

class FakeTscircuitRunner implements ProcessRunner {
  readonly calls: ProcessRunRequest[] = []

  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.calls.push(request)
    if (request.command[1] === "check") {
      return { exit_code: 0, duration_ms: 1, output_tail: "" }
    }
    if (request.command[1] === "build") {
      const source_file = request.command[2]
      if (!source_file) throw new Error("Fixture build command omitted its source file")
      const output_stem = basename(source_file).replace(/\.circuit\.tsx$/, "")
      const output_dir = join(request.cwd, "dist", output_stem)
      const circuit_json =
        source_file === "typical-application.circuit.tsx" ? application_circuit_json : component_circuit_json
      await mkdir(output_dir, { recursive: true })
      await Bun.write(join(output_dir, "circuit.json"), `${JSON.stringify(circuit_json, null, 2)}\n`)
      if (request.command.includes("--pcb-png")) {
        await Bun.write(join(output_dir, "pcb.png"), png_bytes)
      }
      if (request.command.includes("--schematic-svgs")) {
        await Bun.write(
          join(output_dir, "schematic.svg"),
          '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" />\n',
        )
      }
      return { exit_code: 0, duration_ms: 1, output_tail: "" }
    }
    if (request.command[1] === "render-svg-to-png.ts") {
      const svg_path = request.command[2]
      if (!svg_path) throw new Error("Fixture render command omitted its SVG path")
      await Bun.write(join(request.cwd, svg_path.replace(/\.svg$/, ".png")), png_bytes)
      return { exit_code: 0, duration_ms: 1, output_tail: "" }
    }
    throw new Error(`Unexpected process command: ${request.command.join(" ")}`)
  }
}

test("COMPONENT_PIPELINE publishes a validated documented application end to end", async () => {
  const root = await mkdtemp(join(tmpdir(), "datasheet-component-pipeline-e2e-"))
  temporary_directories.push(root)
  const job_dir = join(root, "job")
  await mkdir(job_dir, { recursive: true })
  await Promise.all([
    Bun.write(join(job_dir, "datasheet.pdf"), "%PDF-1.4\n% deterministic fixture\n"),
    Bun.write(join(job_dir, "package.json"), '{"private":true}\n'),
    Bun.write(join(job_dir, "tsconfig.json"), "{}\n"),
    Bun.write(join(job_dir, "tscircuit.config.json"), "{}\n"),
    Bun.write(join(job_dir, "tscircuit.config.ts"), "export default {}\n"),
  ])

  const job_store = new JobStore()
  job_store.createJob({
    job_id: "component_e2e",
    job_dir,
    file_name: "generic-2.pdf",
  })
  const agent_calls: string[] = []
  const process_runner = new FakeTscircuitRunner()

  await runJob(
    { job_id: "component_e2e" },
    {
      job_store,
      agent_bin: "unused-agent",
      tsci_bin: "fixture-tsci",
      agent_client: deterministicAgent(agent_calls),
      process_runner,
    },
  )

  const job = job_store.getJob("component_e2e")
  expect(job).toMatchObject({
    display_status: "complete",
    is_complete: true,
    has_errors: false,
    evidence_available: true,
    component_ready: true,
    component_code: component_source,
    circuit_json: component_circuit_json,
    typical_application_title: "Input bypass",
    typical_application_code: application_source,
    typical_application_circuit_json: application_circuit_json,
    pipeline: { pipeline_id: "datasheet_component", status: "completed" },
    validation: {
      evidence: "passed",
      component_build: "passed",
      component_drc: "passed",
      footprint: "passed",
      pinout: "passed",
      component_schematic: "passed",
      component_visual: "inconclusive",
      application_build: "passed",
      application_connectivity: "passed",
      application_schematic: "passed",
      application_visual: "inconclusive",
    },
  })
  const pipeline = job?.pipeline
  expect(pipeline).toBeDefined()
  expect(Object.keys(pipeline?.stage_results ?? {})).toEqual([
    "prepare",
    "extract_evidence",
    "generate_component",
    "validate_component",
    "repair_component",
    "generate_application",
    "validate_application",
    "repair_application",
    "publish",
  ])
  expect(Object.values(pipeline?.stage_results ?? {}).map(({ status }) => status)).toEqual(
    Array(9).fill("completed"),
  )
  expect(agent_calls).toEqual([
    "Datasheet evidence extraction",
    "Component source generation",
    "Application source generation",
  ])

  const component_validation = JSON.parse(await readFile(join(job_dir, "component-validation.json"), "utf8"))
  const application_validation = JSON.parse(
    await readFile(join(job_dir, "application-validation.json"), "utf8"),
  )
  expect(component_validation).toMatchObject({
    version: 1,
    passed: true,
    errors: [],
    circuit_json: component_circuit_json,
  })
  expect(application_validation).toMatchObject({
    version: 1,
    passed: true,
    errors: [],
    circuit_json: application_circuit_json,
  })
  expect(JSON.parse(await readFile(join(job_dir, "component.circuit.json"), "utf8"))).toEqual(
    component_circuit_json,
  )
  expect(await readFile(join(job_dir, "component.circuit.tsx"), "utf8")).toBe(component_source)
  expect(await readFile(join(job_dir, "index.circuit.tsx"), "utf8")).toBe(component_source)
  expect(await readFile(join(job_dir, "typical-application.circuit.tsx"), "utf8")).toBe(application_source)
  expect(await Bun.file(join(job_dir, "visual-reference", "land-pattern.png")).exists()).toBe(true)
  expect(await Bun.file(join(job_dir, "visual-reference", "typical-application.png")).exists()).toBe(true)
  expect(await Bun.file(join(job_dir, "evidence-commit.json")).exists()).toBe(true)
  expect(await Bun.file(join(job_dir, "dist", "index", "pcb.png")).exists()).toBe(true)
  expect(await Bun.file(join(job_dir, "dist", "index", "schematic.png")).exists()).toBe(true)
  expect(await Bun.file(join(job_dir, "dist", "typical-application", "schematic.png")).exists()).toBe(true)

  expect(
    process_runner.calls.some(
      ({ command }) => command[1] === "build" && command[2] === "component-validation.circuit.tsx",
    ),
  ).toBe(true)
  expect(
    process_runner.calls.some(
      ({ command }) =>
        command[1] === "build" &&
        command[2] === "typical-application.circuit.tsx" &&
        command.includes("--disable-pcb"),
    ),
  ).toBe(true)
})

test("component workflow preserves missing-tsci failures and never invokes source repair", async () => {
  const root = await mkdtemp(join(tmpdir(), "datasheet-component-pipeline-missing-tsci-"))
  temporary_directories.push(root)
  const job_dir = join(root, "job")
  await mkdir(job_dir, { recursive: true })
  await Promise.all([
    Bun.write(join(job_dir, "datasheet.pdf"), "%PDF-1.4\n% deterministic fixture\n"),
    Bun.write(join(job_dir, "package.json"), '{"private":true}\n'),
    Bun.write(join(job_dir, "tsconfig.json"), "{}\n"),
    Bun.write(join(job_dir, "tscircuit.config.json"), "{}\n"),
    Bun.write(join(job_dir, "tscircuit.config.ts"), "export default {}\n"),
  ])
  const job_store = new JobStore()
  job_store.createJob({
    job_id: "component_missing_tsci",
    job_dir,
    file_name: "generic-2.pdf",
  })
  const agent_calls: string[] = []
  const process_runner: ProcessRunner = {
    async run(request) {
      throw new ProcessError({
        code: "process_spawn_failed",
        command_label: request.command_label,
        message: "fixture tsci executable was not found",
      })
    },
  }

  await runJob(
    { job_id: "component_missing_tsci" },
    {
      job_store,
      agent_bin: "unused-agent",
      tsci_bin: "missing-tsci",
      agent_client: deterministicAgent(agent_calls),
      process_runner,
    },
  )

  const job = job_store.getJob("component_missing_tsci")
  expect(job).toMatchObject({
    display_status: "failed",
    is_complete: true,
    has_errors: true,
    pipeline: { status: "failed" },
  })
  expect(job?.error_message).toContain("[validate_component/process_spawn_failed]")
  expect(job?.pipeline?.stage_results.validate_component).toMatchObject({
    status: "failed",
    error: { code: "process_spawn_failed", operation: "run_external_process" },
  })
  expect(job?.pipeline?.stage_results.repair_component.status).toBe("skipped")
  expect(agent_calls).toEqual(["Datasheet evidence extraction", "Component source generation"])
})

test("evidence extraction validates every PNG before publishing any canonical evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "datasheet-component-pipeline-invalid-png-"))
  temporary_directories.push(root)
  const job_dir = join(root, "job")
  await mkdir(job_dir, { recursive: true })
  await Promise.all([
    Bun.write(join(job_dir, "datasheet.pdf"), "%PDF-1.4\n% deterministic fixture\n"),
    Bun.write(join(job_dir, "package.json"), '{"private":true}\n'),
    Bun.write(join(job_dir, "tsconfig.json"), "{}\n"),
    Bun.write(join(job_dir, "tscircuit.config.json"), "{}\n"),
    Bun.write(join(job_dir, "tscircuit.config.ts"), "export default {}\n"),
  ])
  const job_store = new JobStore()
  job_store.createJob({
    job_id: "component_invalid_reference_png",
    job_dir,
    file_name: "generic-2.pdf",
  })
  const agent_calls: string[] = []
  const valid_agent = deterministicAgent(agent_calls)
  const invalid_png_agent: AgentClient = {
    async run(input) {
      const result = await valid_agent.run(input)
      if (input.phase_label === "Datasheet evidence extraction") {
        await Bun.write(join(input.workspace, "visual-reference", "typical-application.png"), "not a png")
      }
      return result
    },
  }

  await runJob(
    { job_id: "component_invalid_reference_png" },
    {
      job_store,
      agent_bin: "unused-agent",
      tsci_bin: "unused-tsci",
      agent_client: invalid_png_agent,
      process_runner: new FakeTscircuitRunner(),
    },
  )

  expect(job_store.getJob("component_invalid_reference_png")).toMatchObject({
    display_status: "failed",
    pipeline: {
      status: "failed",
      stage_results: { extract_evidence: { status: "failed" } },
    },
  })
  expect(job_store.getJob("component_invalid_reference_png")?.evidence_available).toBeFalsy()
  expect(agent_calls).toEqual(Array(3).fill("Datasheet evidence extraction"))
  expect(await Bun.file(join(job_dir, "component-evidence.json")).exists()).toBe(false)
  expect(await Bun.file(join(job_dir, "visual-reference")).exists()).toBe(false)
  expect(await Bun.file(join(job_dir, "evidence-commit.json")).exists()).toBe(false)
})
