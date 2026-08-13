import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { APPLICATION_PIPELINE, COMPONENT_PIPELINE, runJob } from "@/server/component-workflow"
import type { AgentClient } from "@/server/infrastructure/agent"
import {
  ProcessError,
  type ProcessRunner,
  type ProcessRunRequest,
  type ProcessRunResult,
} from "@/server/infrastructure/process"
import { JobStore } from "@/server/job-store"
import { runPipeline } from "@/server/pipeline"

const temporary_directories: string[] = []
setDefaultTimeout(20_000)
const png_bytes = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
  (character) => character.charCodeAt(0),
)

afterEach(async () => {
  await Promise.all(
    temporary_directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

test("typical-application evidence extraction runs without a component artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "datasheet-application-evidence-independent-"))
  temporary_directories.push(root)
  const job_dir = join(root, "job")
  const run_dir = join(job_dir, "runs", "typical_application", "independent")
  await mkdir(run_dir, { recursive: true })
  await Bun.write(join(job_dir, "datasheet.pdf"), "%PDF-1.4\n% deterministic fixture\n")
  const job_store = new JobStore()
  job_store.createJob({ job_id: "application_evidence_only", job_dir, file_name: "generic-2.pdf" })
  const calls: string[] = []
  const result = await runPipeline({
    definition: APPLICATION_PIPELINE,
    run_id: "application_evidence_only",
    workspace_dir: run_dir,
    context: {
      job_id: "application_evidence_only",
      job_dir,
      use_openai: false,
      invocation_id: "independent",
    },
    services: {
      job_store,
      agent_client: deterministicAgent(calls),
      process_runner: new FakeTscircuitRunner(),
      tsci_bin: "fixture-tsci",
    },
    target: {
      mode: "stage",
      stage_id: "extract_application_evidence",
      dependency_outputs: {},
    },
  })

  expect(result.status).toBe("completed")
  expect(result.stage_results.extract_application_evidence.status).toBe("completed")
  expect(await Bun.file(join(job_dir, "application-evidence-commit.json")).exists()).toBe(true)
  expect(await Bun.file(join(job_dir, "component.circuit.tsx")).exists()).toBe(false)
  expect(calls).toEqual([
    "Typical-application evidence extraction",
    "Independent application connectivity verification",
  ])
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

const wider_visual_source = {
  ...visual_source,
  page: 4,
  image: "visual-reference/wider-land-pattern.png",
}

const wider_component_evidence = structuredClone(component_evidence)
wider_component_evidence.package.name.value = "Wider two-terminal test package"
wider_component_evidence.package.name.sources = [wider_visual_source]
wider_component_evidence.package.pin_count.sources = [wider_visual_source]
wider_component_evidence.footprint.drawing_orientation.sources = [wider_visual_source]
wider_component_evidence.footprint.pads = wider_component_evidence.footprint.pads.map((pad, index) => ({
  ...pad,
  x: index === 0 ? -1 : 1,
  sources: [wider_visual_source],
}))

const component_footprint_catalog = {
  version: 1,
  default_footprint_id: "standard",
  footprints: [
    { footprint_id: "standard", component_evidence },
    { footprint_id: "wide", component_evidence: wider_component_evidence },
  ],
}

const application_plan = {
  version: 4,
  availability: "documented",
  pcb_implementation: "schematic_only",
  title: "Input bypass",
  description: "The documented application bypasses INPUT to RETURN with 100 nF.",
  source_references: [
    {
      page: 3,
      figure: "Typical application",
      method: "pdf_visual",
      confidence: "high",
      image: "visual-reference/typical-application.png",
      render_dpi: 200,
    },
  ],
  components: [
    { reference: "U1", kind: "integrated_circuit", value: "GENERIC-2" },
    { reference: "C1", kind: "capacitor", value: "100nF" },
  ],
  connections: [
    { net: "INPUT", pins: ["U1.INPUT", "C1.pin1", "INPUT"] },
    { net: "RETURN", pins: ["U1.RETURN", "C1.pin2", "RETURN"] },
  ],
}

const application_design_evidence = {
  version: 1,
  capabilities: [
    {
      evidence_id: "input-bypass",
      statement: "The target supports the documented input bypass function.",
      source_references: [{ page: 3, method: "pdf_text", confidence: "high" }],
    },
  ],
  constraints: [
    {
      evidence_id: "bypass-capacitor",
      statement: "The bypass application requires its documented capacitor.",
      source_references: [{ page: 3, method: "pdf_text", confidence: "high" }],
    },
  ],
  prohibited_uses: [],
}

const application_connectivity_review = {
  version: 1,
  availability: "documented",
  source: {
    page: 3,
    figure: "Typical application",
    method: "pdf_visual",
    confidence: "high",
    image: "visual-reference/typical-application.png",
    render_dpi: 200,
  },
  components: application_plan.components.map(({ reference, kind, value }) => ({
    reference,
    kind,
    value,
  })),
  connections: application_plan.connections.map(({ pins }) => ({ pins })),
}

const application_connectivity_observation_review = {
  ...application_connectivity_review,
  source: {
    page: 3,
    figure: "Typical application",
    method: "pdf_visual",
    confidence: "high",
  },
}

const footprint_geometry_review = {
  version: 1,
  source: visual_source,
  view: "pcb_top",
  units: "mm",
  pads: component_evidence.footprint.pads.map(({ sources: _sources, ...pad }) => pad),
}

const wider_footprint_geometry_review = {
  version: 1,
  source: {
    ...wider_visual_source,
    image: "visual-reference/land-pattern.png",
  },
  view: "pcb_top",
  units: "mm",
  pads: wider_component_evidence.footprint.pads.map(({ sources: _sources, ...pad }) => pad),
}

const component_source = `export default function Generic2() {
  return (
    <chip
      name="U1"
      manufacturerPartNumber="GENERIC-2"
      footprint={
        <footprint>
          <smtpad shape="rect" pcbX={-0.75} pcbY={0} width={0.55} height={0.8} portHints={["pin1"]} />
          <smtpad shape="rect" pcbX={0.75} pcbY={0} width={0.55} height={0.8} portHints={["pin2"]} />
        </footprint>
      }
    />
  )
}
`

const multi_footprint_component_source = `import type { ChipProps } from "tscircuit"

const pinLabels = { pin1: "INPUT", pin2: "RETURN" } as const
type Props = ChipProps<typeof pinLabels> & { footprintVariant?: "standard" | "wide" }

export default function Generic2({ footprintVariant = "standard", ...props }: Props) {
  const padX = footprintVariant === "wide" ? 1 : 0.75
  return (
    <chip
      {...props}
      manufacturerPartNumber="GENERIC-2"
      pinLabels={pinLabels}
      footprint={
        <footprint>
          <smtpad shape="rect" layer="top" pcbX={-padX} pcbY={0} width={0.55} height={0.8} portHints={["pin1"]} />
          <smtpad shape="rect" layer="top" pcbX={padX} pcbY={0} width={0.55} height={0.8} portHints={["pin2"]} />
        </footprint>
      }
    />
  )
}
`

const application_source = `import Generic2 from "./component.circuit"

export default function InputBypass() {
  return (
    <>
      <Generic2 name="U1" />
      <capacitor name="C1" capacitance="100nF" />
      <trace from=".U1 > .INPUT" to=".C1 > .pin1" />
      <trace from=".U1 > .INPUT" to="net.INPUT" />
      <trace from=".U1 > .RETURN" to=".C1 > .pin2" />
      <trace from=".U1 > .RETURN" to="net.RETURN" />
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

const wider_component_circuit_json = component_circuit_json.map((element) =>
  "pcb_smtpad_id" in element && typeof element.pcb_smtpad_id === "string"
    ? {
        ...element,
        x: element.pcb_smtpad_id.endsWith("_1") ? -1 : 1,
      }
    : { ...element },
)

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
    type: "source_net",
    source_net_id: "source_net_input",
    name: "INPUT",
  },
  {
    type: "source_net",
    source_net_id: "source_net_return",
    name: "RETURN",
  },
  {
    type: "source_trace",
    source_trace_id: "source_trace_input",
    connected_source_port_ids: ["source_port_application_u1_input", "source_port_c1_1"],
    connected_source_net_ids: ["source_net_input"],
  },
  {
    type: "source_trace",
    source_trace_id: "source_trace_return",
    connected_source_port_ids: ["source_port_application_u1_return", "source_port_c1_2"],
    connected_source_net_ids: ["source_net_return"],
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
        const footprints_dir = join(input.workspace, "component-footprints")
        await mkdir(reference_dir, { recursive: true })
        await mkdir(footprints_dir, { recursive: true })
        await Promise.all([
          Bun.write(
            join(input.workspace, "component-footprint-catalog.json"),
            `${JSON.stringify(
              {
                version: 1,
                default_footprint_id: "default",
                footprint_files: ["component-footprints/default.json"],
              },
              null,
              2,
            )}\n`,
          ),
          Bun.write(
            join(footprints_dir, "default.json"),
            `${JSON.stringify({ footprint_id: "default", component_evidence }, null, 2)}\n`,
          ),
          Bun.write(join(reference_dir, "land-pattern.png"), png_bytes),
        ])
      } else if (input.phase_label === "Typical-application evidence extraction") {
        const reference_dir = join(input.workspace, "visual-reference")
        await mkdir(reference_dir, { recursive: true })
        await Promise.all([
          Bun.write(
            join(input.workspace, "typical-application-plan.json"),
            `${JSON.stringify(application_plan, null, 2)}\n`,
          ),
          Bun.write(
            join(input.workspace, "application-design-evidence.json"),
            `${JSON.stringify(application_design_evidence, null, 2)}\n`,
          ),
          Bun.write(join(reference_dir, "typical-application.png"), png_bytes),
        ])
      } else if (input.phase_label === "Application planning") {
        await Bun.write(
          join(input.workspace, "generated-application-plans.json"),
          `${JSON.stringify({ version: 1, applications: [] }, null, 2)}\n`,
        )
      } else if (input.phase_label === "Independent footprint geometry verification") {
        await Bun.write(
          join(input.workspace, "footprint-geometry-review.json"),
          `${JSON.stringify(footprint_geometry_review, null, 2)}\n`,
        )
      } else if (input.phase_label === "Independent application connectivity verification") {
        await Bun.write(
          join(input.workspace, "application-connectivity-review.json"),
          `${JSON.stringify(application_connectivity_observation_review, null, 2)}\n`,
        )
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

function multiFootprintAgent(calls: string[]): AgentClient {
  const single_footprint_agent = deterministicAgent(calls)
  return {
    async run(input) {
      if (input.phase_label === "Datasheet evidence extraction") {
        calls.push(input.phase_label)
        const footprints_dir = join(input.workspace, "component-footprints")
        await mkdir(footprints_dir, { recursive: true })
        await Promise.all([
          Bun.write(
            join(input.workspace, "component-footprint-catalog.json"),
            `${JSON.stringify(
              {
                version: 1,
                default_footprint_id: component_footprint_catalog.default_footprint_id,
                footprint_files: component_footprint_catalog.footprints.map(
                  ({ footprint_id }) => `component-footprints/${footprint_id}.json`,
                ),
              },
              null,
              2,
            )}\n`,
          ),
          ...component_footprint_catalog.footprints.map((footprint) =>
            Bun.write(
              join(footprints_dir, `${footprint.footprint_id}.json`),
              `${JSON.stringify(footprint, null, 2)}\n`,
            ),
          ),
        ])
        await input.on_output("stdout", "fixture completed multi-footprint evidence extraction\n")
        return { attempts: 1, duration_ms: 1, output_tail: "" }
      }
      if (input.phase_label === "Component source generation") {
        calls.push(input.phase_label)
        await Bun.write(join(input.workspace, "index.circuit.tsx"), multi_footprint_component_source)
        await input.on_output("stdout", `fixture completed ${input.phase_label}\n`)
        return { attempts: 1, duration_ms: 1, output_tail: "" }
      }
      if (
        input.phase_label === "Independent footprint geometry verification" &&
        input.prompt.includes("(wide)")
      ) {
        calls.push(input.phase_label)
        await Bun.write(
          join(input.workspace, "footprint-geometry-review.json"),
          `${JSON.stringify(wider_footprint_geometry_review, null, 2)}\n`,
        )
        return { attempts: 1, duration_ms: 1, output_tail: "" }
      }
      return single_footprint_agent.run(input)
    },
  }
}

class FakeTscircuitRunner implements ProcessRunner {
  readonly calls: ProcessRunRequest[] = []

  constructor(
    private readonly componentCircuitJsonForSource: (source_file: string) => unknown[] = () =>
      component_circuit_json,
  ) {}

  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.calls.push(request)
    if (request.command[0] === "pdftotext") {
      const output_path = request.command.at(-1)
      if (!output_path) throw new Error("Fixture pdftotext command omitted its output path")
      await Bun.write(output_path, "")
      return { exit_code: 0, duration_ms: 1, output_tail: "" }
    }
    if (request.command[0] === "pdftoppm") {
      const output_prefix = request.command.at(-1)
      if (!output_prefix) throw new Error("Fixture pdftoppm command omitted its output prefix")
      await Bun.write(`${output_prefix}.png`, png_bytes)
      return { exit_code: 0, duration_ms: 1, output_tail: "" }
    }
    if (request.command[1] === "check") {
      return { exit_code: 0, duration_ms: 1, output_tail: "" }
    }
    if (request.command[1] === "build") {
      const source_file = request.command[2]
      if (!source_file) throw new Error("Fixture build command omitted its source file")
      const output_stem = basename(source_file).replace(/\.circuit\.tsx$/, "")
      const output_dir = join(request.cwd, "dist", output_stem)
      const circuit_json =
        source_file === "typical-application.circuit.tsx"
          ? application_circuit_json
          : this.componentCircuitJsonForSource(source_file)
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
    pipeline: { pipeline_id: "component_generation", status: "completed" },
    pipelines: {
      component_generation: { pipeline_id: "component_generation", status: "completed" },
      typical_application: { pipeline_id: "typical_application", status: "completed" },
    },
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
    "extract_evidence",
    "generate_component",
    "build_component",
    "validate_component",
    "repair_component",
    "publish_component",
  ])
  expect(Object.values(pipeline?.stage_results ?? {}).map(({ status }) => status)).toEqual(
    Array(6).fill("completed"),
  )
  const application_pipeline = job?.pipelines?.typical_application
  expect(Object.keys(application_pipeline?.stage_results ?? {})).toEqual([
    "extract_application_evidence",
    "wait_for_component",
    "plan_applications",
    "generate_application",
    "build_application",
    "validate_application",
    "repair_application",
    "publish_application",
  ])
  expect(Object.values(application_pipeline?.stage_results ?? {}).map(({ status }) => status)).toEqual(
    Array(8).fill("completed"),
  )
  expect([...agent_calls].sort()).toEqual(
    [
      "Datasheet evidence extraction",
      "Independent footprint geometry verification",
      "Component source generation",
      "Typical-application evidence extraction",
      "Independent application connectivity verification",
      "Application planning",
      "Application source generation",
    ].sort(),
  )
  expect(agent_calls.indexOf("Component source generation")).toBeLessThan(
    agent_calls.indexOf("Application source generation"),
  )
  expect(Date.parse(application_pipeline?.started_at ?? "")).toBeLessThan(
    Date.parse(pipeline?.stage_results.publish_component.completed_at ?? ""),
  )

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
  expect(await Bun.file(join(job_dir, "evidence-commit.json")).exists()).toBe(true)
  const evidence_pointer = (await Bun.file(join(job_dir, "evidence-commit.json")).json()) as {
    version: number
    evidence_directory: string
  }
  expect(evidence_pointer.version).toBe(3)
  const evidence_dir = join(job_dir, evidence_pointer.evidence_directory)
  expect(await Bun.file(join(evidence_dir, "visual-reference", "land-pattern.png")).exists()).toBe(true)
  expect(await Bun.file(join(evidence_dir, "visual-reference", "typical-application.png")).exists()).toBe(
    false,
  )
  expect(await Bun.file(join(evidence_dir, "footprint-geometry-verification.json")).json()).toMatchObject({
    version: 1,
    status: "verified",
  })
  const application_pointer = (await Bun.file(join(job_dir, "application-evidence-commit.json")).json()) as {
    evidence_directory: string
  }
  const application_evidence_dir = join(job_dir, application_pointer.evidence_directory)
  expect(
    await Bun.file(join(application_evidence_dir, "application-connectivity-verification.json")).json(),
  ).toMatchObject({
    version: 1,
    status: "verified",
  })
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

test("COMPONENT_PIPELINE publishes every distinct physical footprint without changing its default", async () => {
  const root = await mkdtemp(join(tmpdir(), "datasheet-component-multi-footprint-e2e-"))
  temporary_directories.push(root)
  const job_dir = join(root, "job")
  const run_dir = join(job_dir, "runs", "component_generation", "multi-footprint")
  await mkdir(run_dir, { recursive: true })
  await Promise.all([
    Bun.write(join(job_dir, "datasheet.pdf"), "%PDF-1.4\n% deterministic fixture\n"),
    Bun.write(join(job_dir, "package.json"), '{"private":true}\n'),
    Bun.write(join(job_dir, "tsconfig.json"), "{}\n"),
    Bun.write(join(job_dir, "tscircuit.config.json"), "{}\n"),
    Bun.write(join(job_dir, "tscircuit.config.ts"), "export default {}\n"),
  ])
  await Promise.all([
    mkdir(join(job_dir, "component-variant-builds"), { recursive: true }),
    mkdir(join(job_dir, "component-variant-validations"), { recursive: true }),
    mkdir(join(job_dir, "dist", "component-variant-obsolete"), { recursive: true }),
  ])
  await Promise.all([
    Bun.write(join(job_dir, "component-variant-obsolete.circuit.tsx"), "export default () => null\n"),
    Bun.write(join(job_dir, "component-variant-builds", "obsolete.json"), "{}\n"),
    Bun.write(join(job_dir, "component-variant-validations", "obsolete.json"), "{}\n"),
    Bun.write(join(job_dir, "dist", "component-variant-obsolete", "circuit.json"), "[]\n"),
  ])
  const job_store = new JobStore()
  job_store.createJob({ job_id: "component_multi", job_dir, file_name: "generic-2.pdf" })
  const agent_calls: string[] = []
  const process_runner = new FakeTscircuitRunner((source_file) =>
    source_file.includes("wide") ? wider_component_circuit_json : component_circuit_json,
  )

  const result = await runPipeline({
    definition: COMPONENT_PIPELINE,
    run_id: "component_multi",
    workspace_dir: run_dir,
    context: {
      job_id: "component_multi",
      job_dir,
      use_openai: false,
      invocation_id: "multi-footprint",
    },
    services: {
      job_store,
      agent_client: multiFootprintAgent(agent_calls),
      process_runner,
      tsci_bin: "fixture-tsci",
    },
  })

  expect(result).toMatchObject({ status: "completed" })
  expect(job_store.getJob("component_multi")?.component_footprints).toMatchObject({
    default_footprint_id: "standard",
    footprints: [
      { footprint_id: "standard", package_name: "Two-terminal test package" },
      { footprint_id: "wide", package_name: "Wider two-terminal test package" },
    ],
  })
  expect(
    JSON.stringify(
      job_store
        .getJob("component_multi")
        ?.component_footprints?.footprints.find(({ footprint_id }) => footprint_id === "wide")?.circuit_json,
    ),
  ).toBe(JSON.stringify(wider_component_circuit_json))
  expect(job_store.getJob("component_multi")?.component_code).toBe(multi_footprint_component_source)
  expect(await readFile(join(job_dir, "component.circuit.tsx"), "utf8")).toBe(
    multi_footprint_component_source,
  )
  expect(await Bun.file(join(job_dir, "component-variants", "standard.circuit.tsx")).exists()).toBe(false)
  expect(await Bun.file(join(job_dir, "component-variants", "wide.circuit.tsx")).exists()).toBe(false)
  expect(await Bun.file(join(job_dir, "component-variants", "wide.circuit.json")).json()).toEqual(
    wider_component_circuit_json,
  )
  expect(await Bun.file(join(job_dir, "component-variant-obsolete.circuit.tsx")).exists()).toBe(false)
  expect(await Bun.file(join(job_dir, "component-variant-builds", "obsolete.json")).exists()).toBe(false)
  expect(await Bun.file(join(job_dir, "component-variant-validations", "obsolete.json")).exists()).toBe(false)
  expect(await Bun.file(join(job_dir, "dist", "component-variant-obsolete")).exists()).toBe(false)
  expect(await Bun.file(join(job_dir, "component-validation.json")).json()).toMatchObject({
    passed: true,
    errors: [],
  })
  expect(
    await Bun.file(
      join(
        job_dir,
        (await Bun.file(join(job_dir, "evidence-commit.json")).json()).evidence_directory,
        "footprint-geometry-verification-catalog.json",
      ),
    ).json(),
  ).toMatchObject({
    version: 1,
    footprints: [{ footprint_id: "standard" }, { footprint_id: "wide" }],
  })
  expect(
    process_runner.calls.some(
      ({ command }) => command[1] === "build" && command[2] === "component-variant-wide.circuit.tsx",
    ),
  ).toBe(true)
  expect(
    process_runner.calls.some(
      ({ command }) =>
        command[1] === "build" && command[2] === "component-variant-wide-validation.circuit.tsx",
    ),
  ).toBe(true)
  expect(agent_calls.filter((phase) => phase === "Component source generation")).toHaveLength(1)
  expect(agent_calls.filter((phase) => phase === "Independent footprint geometry verification")).toHaveLength(
    2,
  )
})

test("evidence correction repairs a retained agent-71-shaped candidate without re-extraction", async () => {
  const root = await mkdtemp(join(tmpdir(), "datasheet-component-pipeline-retained-repair-"))
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
    job_id: "component_retained_repair",
    job_dir,
    file_name: "generic-2.pdf",
  })
  const agent_calls: string[] = []
  const base_agent = deterministicAgent(agent_calls)
  let extraction_attempt = 0
  let repaired_retained_candidate = false
  const repair_agent: AgentClient = {
    async run(input) {
      if (input.phase_label !== "Datasheet evidence extraction") return base_agent.run(input)
      extraction_attempt += 1
      if (extraction_attempt === 1) {
        const result = await base_agent.run(input)
        const variant_path = join(input.workspace, "component-footprints", "default.json")
        const variant_artifact = JSON.parse(await Bun.file(variant_path).text())
        const variant = variant_artifact.component_evidence
        Reflect.deleteProperty(variant, "version")
        for (const pin of variant.pinout.pins) pin.number = Number(pin.number)
        for (const pad of variant.footprint.pads) {
          pad.pin = Number(pad.pin)
          pad.kind = "smd"
        }
        variant.footprint.drawing_orientation.value = "PCB-top land-pattern view; pin 1 is upper-left."
        await Bun.write(
          variant_path,
          `${JSON.stringify({ ...variant_artifact, component_evidence: variant }, null, 2)}\n`,
        )
        return result
      }

      agent_calls.push(input.phase_label)
      const variant_path = join(input.workspace, "component-footprints", "default.json")
      const variant_artifact = await Bun.file(variant_path).json()
      const retained = variant_artifact.component_evidence
      repaired_retained_candidate = retained.version === undefined && retained.pinout.pins[0].number === 1
      retained.version = 1
      retained.footprint.drawing_orientation.value = "pcb_top"
      await Bun.write(
        variant_path,
        `${JSON.stringify({ ...variant_artifact, component_evidence: retained }, null, 2)}\n`,
      )
      await input.on_output("stdout", "fixture repaired the retained contract fields\n")
      return { attempts: 1, duration_ms: 1, output_tail: "" }
    },
  }

  await runJob(
    { job_id: "component_retained_repair" },
    {
      job_store,
      agent_bin: "unused-agent",
      tsci_bin: "fixture-tsci",
      agent_client: repair_agent,
      process_runner: new FakeTscircuitRunner(),
    },
  )

  expect(repaired_retained_candidate).toBe(true)
  expect(job_store.getJob("component_retained_repair")).toMatchObject({
    display_status: "complete",
    validation: { evidence: "passed" },
  })
  expect(agent_calls.filter((phase) => phase === "Datasheet evidence extraction")).toHaveLength(2)
  expect(agent_calls.filter((phase) => phase === "Independent footprint geometry verification")).toHaveLength(
    1,
  )
  expect(
    agent_calls.filter((phase) => phase === "Independent application connectivity verification"),
  ).toHaveLength(1)
})

test("application evidence correction catches an incomplete U1 graph before generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "datasheet-component-pipeline-pin-coverage-"))
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
    job_id: "component_pin_coverage",
    job_dir,
    file_name: "generic-2.pdf",
  })
  const agent_calls: string[] = []
  const base_agent = deterministicAgent(agent_calls)
  let extraction_attempt = 0
  const correction_agent: AgentClient = {
    async run(input) {
      if (input.phase_label !== "Typical-application evidence extraction") return base_agent.run(input)
      extraction_attempt += 1
      const result = await base_agent.run(input)
      if (extraction_attempt === 1) {
        const incomplete_plan = structuredClone(application_plan)
        incomplete_plan.connections[1]!.pins = incomplete_plan.connections[1]!.pins.filter(
          (endpoint) => endpoint !== "U1.RETURN",
        )
        await Bun.write(
          join(input.workspace, "typical-application-plan.json"),
          `${JSON.stringify(incomplete_plan, null, 2)}\n`,
        )
      } else {
        expect(input.prompt).toContain("Independent application connectivity does not match")
      }
      return result
    },
  }

  await runJob(
    { job_id: "component_pin_coverage" },
    {
      job_store,
      agent_bin: "unused-agent",
      tsci_bin: "fixture-tsci",
      agent_client: correction_agent,
      process_runner: new FakeTscircuitRunner(),
    },
  )

  expect(job_store.getJob("component_pin_coverage")).toMatchObject({
    display_status: "complete",
    validation: { evidence: "passed" },
  })
  expect(agent_calls.filter((phase) => phase === "Datasheet evidence extraction")).toHaveLength(1)
  expect(agent_calls.filter((phase) => phase === "Typical-application evidence extraction")).toHaveLength(2)
  expect(
    agent_calls.filter((phase) => phase === "Independent application connectivity verification"),
  ).toHaveLength(1)
})

test("application evidence correction reuses its immutable reviewer observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "datasheet-component-pipeline-reviewer-reuse-"))
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
    job_id: "component_reviewer_reuse",
    job_dir,
    file_name: "generic-2.pdf",
  })
  const agent_calls: string[] = []
  const base_agent = deterministicAgent(agent_calls)
  let extraction_attempt = 0
  let retained_incomplete_plan: unknown
  let retained_application_review: unknown
  let deleted_seeded_review = false
  const correction_agent: AgentClient = {
    async run(input) {
      if (input.phase_label !== "Typical-application evidence extraction") return base_agent.run(input)
      extraction_attempt += 1

      if (extraction_attempt === 1) {
        const result = await base_agent.run(input)
        const incomplete_plan = {
          ...application_plan,
          components: application_plan.components.filter(({ reference }) => reference !== "C1"),
          connections: application_plan.connections.map(({ net, pins }) => ({
            net,
            pins: pins.filter((endpoint) => !endpoint.startsWith("C1.")),
          })),
        }
        await Bun.write(
          join(input.workspace, "typical-application-plan.json"),
          `${JSON.stringify(incomplete_plan, null, 2)}\n`,
        )
        return result
      }

      agent_calls.push(input.phase_label)
      retained_incomplete_plan = await Bun.file(join(input.workspace, "typical-application-plan.json")).json()
      retained_application_review = await Bun.file(
        join(input.workspace, "application-connectivity-review.json"),
      ).json()
      await Bun.write(
        join(input.workspace, "typical-application-plan.json"),
        `${JSON.stringify(application_plan, null, 2)}\n`,
      )
      const seeded_review_path = join(input.workspace, "application-connectivity-review.json")
      await rm(seeded_review_path, { force: true })
      deleted_seeded_review = !(await Bun.file(seeded_review_path).exists())
      await input.on_output("stdout", "fixture repaired the retained plan and deleted its copied review\n")
      return { attempts: 1, duration_ms: 1, output_tail: "" }
    },
  }

  await runJob(
    { job_id: "component_reviewer_reuse" },
    {
      job_store,
      agent_bin: "unused-agent",
      tsci_bin: "fixture-tsci",
      agent_client: correction_agent,
      process_runner: new FakeTscircuitRunner(),
    },
  )

  expect(retained_incomplete_plan).toMatchObject({
    components: [{ reference: "U1" }],
    connections: [{ pins: ["U1.INPUT", "INPUT"] }, { pins: ["U1.RETURN", "RETURN"] }],
  })
  expect(retained_application_review).toEqual(application_connectivity_review)
  expect(deleted_seeded_review).toBe(true)

  const job = job_store.getJob("component_reviewer_reuse")
  expect(job).toMatchObject({
    display_status: "complete",
    is_complete: true,
    has_errors: false,
    validation: { evidence: "passed" },
    pipeline: { pipeline_id: "component_generation", status: "completed" },
  })
  expect(agent_calls.filter((phase) => phase === "Datasheet evidence extraction")).toHaveLength(1)
  expect(agent_calls.filter((phase) => phase === "Typical-application evidence extraction")).toHaveLength(2)
  expect(agent_calls.filter((phase) => phase === "Independent footprint geometry verification")).toHaveLength(
    1,
  )
  expect(
    agent_calls.filter((phase) => phase === "Independent application connectivity verification"),
  ).toHaveLength(1)

  const system_logs = job?.logs
    .filter(({ stream }) => stream === "system")
    .map(({ message }) => message)
    .join("")
  expect(system_logs).not.toContain("Reusing immutable footprint observation")

  const evidence_pointer = (await Bun.file(join(job_dir, "application-evidence-commit.json")).json()) as {
    evidence_directory: string
  }
  const evidence_dir = join(job_dir, evidence_pointer.evidence_directory)
  expect(await Bun.file(join(evidence_dir, "application-connectivity-review.json")).json()).toEqual(
    application_connectivity_review,
  )
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
      if (request.command[0] === "pdftotext") {
        const output_path = request.command.at(-1)
        if (!output_path) throw new Error("Fixture pdftotext command omitted its output path")
        await Bun.write(output_path, "")
        return { exit_code: 0, duration_ms: 1, output_tail: "" }
      }
      if (request.command[0] === "pdftoppm") {
        const output_prefix = request.command.at(-1)
        if (!output_prefix) throw new Error("Fixture pdftoppm command omitted its output prefix")
        await Bun.write(`${output_prefix}.png`, png_bytes)
        return { exit_code: 0, duration_ms: 1, output_tail: "" }
      }
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
  expect(job?.error_message).toContain("[build_component/process_spawn_failed]")
  expect(job?.pipeline?.stage_results.build_component).toMatchObject({
    status: "failed",
    error: { code: "process_spawn_failed", operation: "run_external_process" },
  })
  expect(job?.pipeline?.stage_results.repair_component.status).toBe("skipped")
  expect([...agent_calls].sort()).toEqual(
    [
      "Datasheet evidence extraction",
      "Independent footprint geometry verification",
      "Component source generation",
      "Typical-application evidence extraction",
      "Independent application connectivity verification",
    ].sort(),
  )
})

test("evidence extraction rejects an invalid server-rendered PNG before publication", async () => {
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
  const valid_runner = new FakeTscircuitRunner()
  const invalid_png_renderer: ProcessRunner = {
    async run(request) {
      if (request.command[0] === "pdftoppm") {
        const output_prefix = request.command.at(-1)
        if (!output_prefix) throw new Error("Fixture pdftoppm command omitted its output prefix")
        await Bun.write(`${output_prefix}.png`, "not a png")
        return { exit_code: 0, duration_ms: 1, output_tail: "" }
      }
      return valid_runner.run(request)
    },
  }

  await runJob(
    { job_id: "component_invalid_reference_png" },
    {
      job_store,
      agent_bin: "unused-agent",
      tsci_bin: "unused-tsci",
      agent_client: deterministicAgent(agent_calls),
      process_runner: invalid_png_renderer,
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
  expect(job_store.getJob("component_invalid_reference_png")?.validation?.evidence).toBe("failed")
  expect([...agent_calls].sort()).toEqual(
    [
      ...Array(4).fill("Datasheet evidence extraction"),
      ...Array(4).fill("Typical-application evidence extraction"),
    ].sort(),
  )
  expect(await Bun.file(join(job_dir, "component-evidence.json")).exists()).toBe(false)
  expect(await Bun.file(join(job_dir, "visual-reference")).exists()).toBe(false)
  expect(await Bun.file(join(job_dir, "evidence-commit.json")).exists()).toBe(false)
})
