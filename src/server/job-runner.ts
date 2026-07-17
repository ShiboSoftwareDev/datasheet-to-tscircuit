import { cp, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, relative, resolve } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import type { JobLogStream } from "@/shared/job-types"
import { type TrustedAgentEvent, parseTrustedAgentEvent } from "./agent-event-protocol"
import {
  type ExpectedApplicationConnection,
  type ExpectedFootprintPad,
  type FootprintPlan,
  getFootprintPlanErrors,
  getTypicalApplicationComponentValueErrors,
  getTypicalApplicationConnectivityErrors,
  validateAgentImageReads,
  validateVisualInspection,
  VisualInspectionInconclusiveError,
} from "./job-artifact-validator"
import type { JobStore } from "./job-store"
import { getAllCircuitErrors } from "./model-simulation-validator"

export interface JobRunnerContext {
  job_store: JobStore
  agent_bin: string
  agent_event_runner?: string
  tsci_bin: string
}

interface StreamProcessInput {
  command: string[]
  cwd: string
  signal: AbortSignal
  on_chunk: (stream: JobLogStream, message: string) => Promise<void>
}

class JobCancelledError extends Error {
  constructor() {
    super("Job cancellation was requested")
    this.name = "JobCancelledError"
  }
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new JobCancelledError()
}

function killProcessGroup(child_process: Bun.Subprocess, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32") child_process.kill(signal)
    else process.kill(-child_process.pid, signal)
  } catch {
    if (child_process.exitCode === null) child_process.kill(signal)
  }
}

async function readProcessStream(input: {
  readable: ReadableStream<Uint8Array>
  stream: "stdout" | "stderr"
  on_chunk: StreamProcessInput["on_chunk"]
}): Promise<void> {
  const reader = input.readable.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      const message = decoder.decode(chunk.value, { stream: true })
      if (message) await input.on_chunk(input.stream, message)
    }
    const final_message = decoder.decode()
    if (final_message) await input.on_chunk(input.stream, final_message)
  } finally {
    reader.releaseLock()
  }
}

async function streamProcess(input: StreamProcessInput): Promise<number> {
  throwIfCancelled(input.signal)
  const inherited_path = process.env.PATH ?? ""
  const command_path = input.command[0]?.includes("/")
    ? `${dirname(input.command[0])}${delimiter}${inherited_path}`
    : inherited_path
  const child_process = Bun.spawn(input.command, {
    cwd: input.cwd,
    detached: true,
    env: { ...process.env, PATH: command_path },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })

  let force_kill_timer: ReturnType<typeof setTimeout> | undefined
  const stop_process = () => {
    killProcessGroup(child_process, "SIGTERM")
    force_kill_timer = setTimeout(() => killProcessGroup(child_process, "SIGKILL"), 2_000)
  }
  input.signal.addEventListener("abort", stop_process, { once: true })

  try {
    const [exit_code] = await Promise.all([
      child_process.exited,
      readProcessStream({ readable: child_process.stdout, stream: "stdout", on_chunk: input.on_chunk }),
      readProcessStream({ readable: child_process.stderr, stream: "stderr", on_chunk: input.on_chunk }),
    ])
    throwIfCancelled(input.signal)
    return exit_code
  } finally {
    input.signal.removeEventListener("abort", stop_process)
    if (force_kill_timer) clearTimeout(force_kill_timer)
  }
}

function stringifyForLog(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

async function renderTrustedAgentEvent(
  event: TrustedAgentEvent,
  append: StreamProcessInput["on_chunk"],
): Promise<void> {
  if (event.type === "text_delta") return append("stdout", event.text)
  if (event.type === "thinking_delta") return append("stderr", event.text)
  if (event.type === "tool_start") {
    return append("stderr", `\n[tool] ${event.tool_name} ${stringifyForLog(event.args)}\n`)
  }
  if (event.type === "tool_end") {
    return append("stderr", `[tool] ${event.tool_name} ${event.is_error ? "failed" : "ok"}\n`)
  }
  if (event.type === "agent_end") {
    return append("stderr", event.failed ? "\n[agent] failed\n" : "\n[agent] done\n")
  }
}

async function runStructuredAgentPhase(input: {
  context: JobRunnerContext
  prompt: string
  cwd: string
  signal: AbortSignal
  append: StreamProcessInput["on_chunk"]
}): Promise<TrustedAgentEvent[]> {
  const events: TrustedAgentEvent[] = []
  let stdout_buffer = ""
  let invalid_stdout = false
  let last_sequence = 0

  const consume_line = async (line: string): Promise<void> => {
    if (!line.trim()) return
    const event = parseTrustedAgentEvent(line)
    if (!event || event.sequence !== last_sequence + 1) {
      invalid_stdout = true
      await input.append("stdout", `${line}\n`)
      return
    }
    last_sequence = event.sequence
    events.push(event)
    await renderTrustedAgentEvent(event, input.append)
  }

  const command_prefix = input.context.agent_event_runner
    ? [process.execPath, input.context.agent_event_runner]
    : [input.context.agent_bin]
  const exit_code = await streamProcess({
    command: [...command_prefix, "do", "--prompt", input.prompt, "--dir", input.cwd],
    cwd: input.cwd,
    signal: input.signal,
    on_chunk: async (stream, message) => {
      if (stream === "stderr") {
        await input.append(stream, message)
        return
      }
      stdout_buffer += message
      const lines = stdout_buffer.split(/\r?\n/)
      stdout_buffer = lines.pop() ?? ""
      for (const line of lines) await consume_line(line)
    },
  })
  if (stdout_buffer) await consume_line(stdout_buffer)
  if (exit_code !== 0) throw new Error(`tsci-agent exited with code ${exit_code}`)
  if (invalid_stdout || events.length === 0) {
    throw new Error("tsci-agent did not provide a valid structured event stream")
  }
  const agent_end = [...events].reverse().find((event) => event.type === "agent_end")
  if (!agent_end || agent_end.failed) throw new Error("tsci-agent did not complete successfully")
  return events
}

export function buildAgentPrompt(additional_instructions?: string): string {
  const user_context = additional_instructions?.trim()
    ? `\nAdditional context from the user:\n${additional_instructions.trim()}\n`
    : ""

  return `Complete phase 1 of the datasheet conversion from datasheet.pdf: create a
production-quality tscircuit TSX component and collect its typical-application evidence.

Read AGENTS.md first and follow it. Inspect the PDF carefully, including the pinout
tables and package mechanical drawings by rendering relevant pages to PNG and
opening them with the \`read\` tool. Replace index.circuit.tsx with the final
default-exported component, then build PCB/footprint and schematic visual outputs
as required by AGENTS.md. Use \`read\` on both PNGs, correct visual defects, and
rerender before finishing. Keep schematic labels and aliases compact and readable;
shorten or remove aliases that overlap, rotate awkwardly, or make the symbol
excessively wide. Run tsci build index.circuit.tsx and correct any generation
errors. Before coding the footprint, record a pad-by-pad dimensional checklist
from the datasheet land-pattern drawing: pad count, pin numbers, width, height,
pitch, side/orientation, and pin-1 marker. Compare the generated PCB render back
to that checklist and the rendered datasheet image. The land-pattern drawing is
the PCB top/copper view; do not mirror it from a package-bottom view. Do not invent exposed-metal
pads or swap dimensions inferred from dimension-leader lines. Do not use
placementDrcChecksDisabled, routingDisabled, --ignore-placement-drc, or similar
settings to hide clearance, placement, or routing defects. Do not stop at a prose report: the TSX file, inspected
footprint and schematic renders, and a successful preview build are the
deliverables. Also write \`footprint-plan.json\` with schema
\`{ "version": 1, "view": "pcb_top", "source_references": [{ "page": number,
"figure": string? }], "pads": [{ "pin": string, "kind": "smt" | "plated_hole",
"x": number, "y": number, "width": number, "height": number,
"hole_width": number?, "hole_height": number? }] }\`. All dimensions and coordinates
are millimeters relative to the package origin in the PCB top view. Include every
copper pad exactly once; for repeated pads on one pin, repeat the pin value.
Save the final land-pattern reference crop as
\`visual-reference/land-pattern.png\`. After the final component build, use \`read\`
on that image, \`dist/index/pcb.png\`, and \`dist/index/schematic.png\`, then write
\`component-visual-inspection.json\` with
\`{ "version": 1, "status": "passed", "reference_image":
"visual-reference/land-pattern.png", "pcb_image": "dist/index/pcb.png",
"schematic_image": "dist/index/schematic.png" }\`. Never record passed if any
image was omitted or its pixels were unavailable; report inconclusive and stop.
Write the inspection JSON with the built-in write tool. After the final build, the
only allowed shell command is the single render-svg-to-png command needed to create
the schematic PNG.

At the same time, locate the datasheet's primary typical application and write
typical-application-plan.json with its cited page/figure, operating context,
external components and values, and exact connections as required by AGENTS.md.
The plan schema version is 2.
Each connection must be a structured net object such as
\`{ "net": "VIN", "pins": ["U1.VIN", "C1.pin1"] }\`; use exact
\`component.port\` endpoints that can be checked against Circuit JSON.
Do not create typical-application.circuit.tsx in this phase. The server must first
build and publish index.circuit.tsx so downstream SPICE generation can safely
import the finalized component.${user_context}`
}

export function buildTypicalApplicationPrompt(additional_instructions?: string): string {
  const user_context = additional_instructions?.trim()
    ? `\nAdditional context from the user:\n${additional_instructions.trim()}\n`
    : ""

  return `Complete phase 2 of the datasheet conversion. The server has independently
built index.circuit.tsx and published it as ready; SPICE generation may now use it.

Read AGENTS.md and typical-application-plan.json first. Treat index.circuit.tsx,
component.circuit.tsx, footprint-plan.json, and typical-application-plan.json as read-only. Create
typical-application.circuit.tsx
as a default-exported tscircuit circuit that imports the generated component from
"./index.circuit" and implements the cited datasheet application faithfully. Use
the recorded external component values, connections, and operating context. Do
not replace the generated component with a generic chip or duplicate its
definition.

Build the application with PCB and schematic visual outputs, render the schematic
SVG to PNG, re-open the cited datasheet application page, and inspect the reference,
PCB, and schematic PNGs with the built-in \`read\` tool. Compare the generated
schematic against the datasheet topology and values, fix visual or connectivity
defects, and do not suppress placement DRC, autorouting, or clearance failures with
placementDrcChecksDisabled, routingDisabled, --ignore-placement-drc, or similar
settings. Save the final reference circuit crop as
\`visual-reference/typical-application.png\`. After the final application build,
use \`read\` on that image, \`dist/typical-application/pcb.png\`, and
\`dist/typical-application/schematic.png\`, then write
\`application-visual-inspection.json\` with version 1, status passed, and those
paths in \`reference_image\`, \`pcb_image\`, and \`schematic_image\`. Never record
passed if any image was omitted or its pixels were unavailable; report
inconclusive and stop. Finish with a successful
\`tsci build typical-application.circuit.tsx\`. The importing application source,
inspected PCB and schematic renders, and successful build are the deliverables.
Write the inspection JSON with the built-in write tool. After the final build, the
only allowed shell command is the single render-svg-to-png command needed to create
the schematic PNG.${user_context}`
}

export function buildTypicalApplicationEvidenceVerificationPrompt(): string {
  return `Independently extract the package land pattern and primary typical-application circuit
from datasheet.pdf. This is an evidence-verification pass: no earlier plan is present, so work
only from the datasheet and the read-only component.circuit.tsx. Extract searchable PDF text,
render the cited datasheet pages to PNG, and use the built-in read tool to inspect their pixels.

Use the PCB top/copper land-pattern or example-board-layout drawing, never a package-bottom or
stencil drawing. Save that exact crop as visual-reference/land-pattern.png. Carefully honor
drawing multipliers such as 4X versus 5X and special or elongated pads. Write footprint-plan.json:
{ "version": 1, "view": "pcb_top",
  "source_references": [{ "page": number, "figure": string? }],
  "pads": [{ "pin": string, "kind": "smt" | "plated_hole", "x": number,
    "y": number, "width": number, "height": number,
    "hole_width": number?, "hole_height": number? }] }.
Coordinates and dimensions are millimeters relative to the package origin. Include every copper
pad exactly once and use the component's exact numbered or named ports.

Save a clear crop of the reference application circuit as
visual-reference/typical-application.png and use read on both exact reference PNGs before finishing.

Write typical-application-plan.json using schema version 2:
{ "version": 2, "title": string, "description": string,
  "source_references": [{ "page": number, "figure": string? }],
  "components": [{ "reference": string, "kind": string, "value": string?,
    "purpose": string? }],
  "connections": [{ "net": string, "pins": [string, string, ...] }] }.
List every component in the cited circuit, including U1. Each connection describes one
complete electrical net and every endpoint uses exact component.port syntax such as U1.VIN
or C1.pin1. Preserve the datasheet reference designators, values, and topology. Do not create
or modify any circuit TSX file.`
}

async function findCircuitJsonFile(directory: string): Promise<string | undefined> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const entry_path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const nested_match = await findCircuitJsonFile(entry_path)
      if (nested_match) return nested_match
    } else if (entry.name.endsWith(".circuit.json") || entry.name === "circuit.json") {
      return entry_path
    }
  }
  return undefined
}

function isCircuitJson(parsed_json: unknown): parsed_json is AnyCircuitElement[] {
  return (
    Array.isArray(parsed_json) &&
    parsed_json.every(
      (element) => typeof element === "object" && element !== null && typeof element.type === "string",
    )
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export interface TypicalApplicationPlan {
  version: 2
  title: string
  description: string
  source_references: Array<{ page: number; figure?: string }>
  components: Array<{ reference: string; kind: string; value?: string; purpose?: string }>
  connections: ExpectedApplicationConnection[]
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function requiredFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number in millimeters`)
  }
  return value
}

export function parseFootprintPlan(value: unknown): FootprintPlan {
  if (!isRecord(value) || value.version !== 1 || value.view !== "pcb_top") {
    throw new Error('footprint-plan.json must have version 1 and view "pcb_top"')
  }
  if (!Array.isArray(value.source_references) || value.source_references.length === 0) {
    throw new Error("footprint-plan.json must cite at least one datasheet page")
  }
  const source_references = value.source_references.map((source, index) => {
    if (!isRecord(source) || !Number.isInteger(source.page) || (source.page as number) < 1) {
      throw new Error(`footprint source_references[${index}].page must be a positive integer`)
    }
    return {
      page: source.page as number,
      ...(source.figure === undefined
        ? {}
        : { figure: requiredText(source.figure, `source_references[${index}].figure`) }),
    }
  })
  if (!Array.isArray(value.pads) || value.pads.length === 0) {
    throw new Error("footprint-plan.json must list every copper pad")
  }
  const pads: ExpectedFootprintPad[] = value.pads.map((pad, index) => {
    if (!isRecord(pad) || (pad.kind !== "smt" && pad.kind !== "plated_hole")) {
      throw new Error(`footprint pads[${index}] must have kind smt or plated_hole`)
    }
    const parsed = {
      pin: requiredText(pad.pin, `pads[${index}].pin`),
      kind: pad.kind as ExpectedFootprintPad["kind"],
      x: requiredFiniteNumber(pad.x, `pads[${index}].x`),
      y: requiredFiniteNumber(pad.y, `pads[${index}].y`),
      width: requiredFiniteNumber(pad.width, `pads[${index}].width`),
      height: requiredFiniteNumber(pad.height, `pads[${index}].height`),
      ...(pad.hole_width === undefined
        ? {}
        : { hole_width: requiredFiniteNumber(pad.hole_width, `pads[${index}].hole_width`) }),
      ...(pad.hole_height === undefined
        ? {}
        : { hole_height: requiredFiniteNumber(pad.hole_height, `pads[${index}].hole_height`) }),
    }
    if (parsed.width <= 0 || parsed.height <= 0) {
      throw new Error(`footprint pads[${index}] dimensions must be positive`)
    }
    if (
      parsed.kind === "plated_hole" &&
      (!("hole_width" in parsed) ||
        !("hole_height" in parsed) ||
        parsed.hole_width! <= 0 ||
        parsed.hole_height! <= 0)
    ) {
      throw new Error(`footprint plated-hole pad ${parsed.pin} must include positive hole dimensions`)
    }
    return parsed
  })
  return { version: 1, view: "pcb_top", source_references, pads }
}

export function parseTypicalApplicationPlan(value: unknown): TypicalApplicationPlan {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2)) {
    throw new Error("typical-application-plan.json must have version 2")
  }
  if (!Array.isArray(value.source_references) || value.source_references.length === 0) {
    throw new Error("typical-application-plan.json must cite at least one datasheet page")
  }
  const source_references = value.source_references.map((source, index) => {
    if (!isRecord(source) || !Number.isInteger(source.page) || (source.page as number) < 1) {
      throw new Error(`typical application source_references[${index}].page must be a positive integer`)
    }
    return {
      page: source.page as number,
      ...(source.figure === undefined
        ? {}
        : { figure: requiredText(source.figure, `source_references[${index}].figure`) }),
    }
  })
  if (!Array.isArray(value.components) || value.components.length === 0) {
    throw new Error("typical-application-plan.json must list the application components")
  }
  const seen_components = new Set<string>()
  const components = value.components.map((component, index) => {
    if (!isRecord(component)) {
      throw new Error(`typical application components[${index}] must be an object`)
    }
    const reference = requiredText(component.reference, `components[${index}].reference`)
    if (seen_components.has(reference.toLowerCase())) {
      throw new Error(`typical application component ${reference} is listed more than once`)
    }
    seen_components.add(reference.toLowerCase())
    return {
      reference,
      kind: requiredText(component.kind, `components[${index}].kind`),
      ...(component.value === undefined
        ? {}
        : { value: requiredText(component.value, `components[${index}].value`) }),
      ...(component.purpose === undefined
        ? {}
        : { purpose: requiredText(component.purpose, `components[${index}].purpose`) }),
    }
  })
  if (!Array.isArray(value.connections) || value.connections.length === 0) {
    throw new Error("typical-application-plan.json must list the application connections")
  }
  const seen_nets = new Set<string>()
  const seen_endpoints = new Map<string, string>()
  const connections = value.connections.map((connection, index) => {
    if (!isRecord(connection)) {
      throw new Error(`typical application connections[${index}] must be a structured net object`)
    }
    const net = requiredText(connection.net, `connections[${index}].net`)
    if (seen_nets.has(net.toLowerCase())) {
      throw new Error(`typical application net ${net} is listed more than once`)
    }
    seen_nets.add(net.toLowerCase())
    if (!Array.isArray(connection.pins) || connection.pins.length < 2) {
      throw new Error(`typical application connections[${index}].pins must list at least two pins`)
    }
    const pins = connection.pins.map((pin, pin_index) => {
      const endpoint = requiredText(pin, `connections[${index}].pins[${pin_index}]`)
      if (!/^[^.\s]+\.[^.\s]+$/.test(endpoint)) {
        throw new Error(`connections[${index}].pins[${pin_index}] must use component.port syntax`)
      }
      const endpoint_key = endpoint.toLowerCase()
      const earlier_net = seen_endpoints.get(endpoint_key)
      if (earlier_net) {
        throw new Error(
          `typical application endpoint ${endpoint} is listed on both ${earlier_net} and ${net}`,
        )
      }
      seen_endpoints.set(endpoint_key, net)
      return endpoint
    })
    return { net, pins }
  })
  const component_names = new Set(components.map((component) => component.reference.toLowerCase()))
  for (const connection of connections) {
    for (const endpoint of connection.pins) {
      const component_name = endpoint.slice(0, endpoint.indexOf(".")).toLowerCase()
      if (!component_names.has(component_name)) {
        throw new Error(`typical application endpoint ${endpoint} references an unlisted component`)
      }
    }
  }
  return {
    version: 2,
    title: requiredText(value.title, "typical application title"),
    description: requiredText(value.description, "typical application description"),
    source_references,
    components,
    connections,
  }
}

async function buildCircuitArtifact(input: {
  source_file: string
  output_stem: string
  job_dir: string
  tsci_bin: string
  signal: AbortSignal
  append: StreamProcessInput["on_chunk"]
  render_outputs?: boolean
}): Promise<{ circuit_json: AnyCircuitElement[]; errors: string[] }> {
  const output_directory = join(input.job_dir, "dist", input.output_stem)
  const pcb_png_path = join(output_directory, "pcb.png")
  const schematic_svg_path = join(output_directory, "schematic.svg")
  const schematic_png_path = join(output_directory, "schematic.png")
  const preserved_visuals = input.render_outputs
    ? await Promise.all(
        [pcb_png_path, schematic_svg_path, schematic_png_path].map((path) =>
          readFile(path).catch(() => undefined),
        ),
      )
    : []
  await rm(output_directory, { recursive: true, force: true })
  const build_command = [
    input.tsci_bin,
    "build",
    input.source_file,
    "--ignore-errors",
    "--ignore-warnings",
    ...(input.render_outputs ? ["--pcb-png", "--schematic-svgs"] : []),
  ]
  const build_exit_code = await streamProcess({
    command: build_command,
    cwd: input.job_dir,
    signal: input.signal,
    on_chunk: input.append,
  })
  throwIfCancelled(input.signal)
  const circuit_json_path = await findCircuitJsonFile(join(input.job_dir, "dist", input.output_stem))
  if (!circuit_json_path) {
    throw new Error(`tsci build exited with code ${build_exit_code} and produced no Circuit JSON`)
  }
  const parsed_json: unknown = JSON.parse(await readFile(circuit_json_path, "utf8"))
  if (!isCircuitJson(parsed_json)) throw new Error("tsci produced invalid Circuit JSON")
  const render_errors: string[] = []
  if (input.render_outputs) {
    await mkdir(output_directory, { recursive: true })
    if (!(await Bun.file(pcb_png_path).exists()) && preserved_visuals[0]) {
      await Bun.write(pcb_png_path, preserved_visuals[0])
    }
    if (!(await Bun.file(schematic_svg_path).exists()) && preserved_visuals[1]) {
      await Bun.write(schematic_svg_path, preserved_visuals[1])
    }
    if (await Bun.file(schematic_svg_path).exists()) {
      const render_exit_code = await streamProcess({
        command: [process.execPath, "render-svg-to-png.ts", relative(input.job_dir, schematic_svg_path)],
        cwd: input.job_dir,
        signal: input.signal,
        on_chunk: input.append,
      })
      if (render_exit_code !== 0) {
        render_errors.push(`schematic PNG renderer exited with code ${render_exit_code}`)
      }
    }
    if (!(await Bun.file(schematic_png_path).exists()) && preserved_visuals[2]) {
      await Bun.write(schematic_png_path, preserved_visuals[2])
    }
    if (!(await Bun.file(pcb_png_path).exists())) render_errors.push("final PCB PNG was not produced")
    if (!(await Bun.file(schematic_png_path).exists())) {
      render_errors.push("final schematic PNG was not produced")
    }
  }
  const errors = [
    ...(build_exit_code === 0 ? [] : [`tsci build exited with code ${build_exit_code}`]),
    ...render_errors,
    ...getAllCircuitErrors(parsed_json),
  ]
  const unique_errors = [...new Set(errors)]
  if (unique_errors.length > 0) {
    await input.append(
      "system",
      `Preview artifact contains ${unique_errors.length} blocking build error(s).\n`,
    )
  }
  return { circuit_json: parsed_json, errors: unique_errors }
}

async function buildComponentValidationBoard(input: {
  job_dir: string
  tsci_bin: string
  signal: AbortSignal
  append: StreamProcessInput["on_chunk"]
}): Promise<{ circuit_json: AnyCircuitElement[]; errors: string[] }> {
  const source_file = "component-validation.circuit.tsx"
  const source_path = join(input.job_dir, source_file)
  await Bun.write(
    source_path,
    `import GeneratedComponent from "./index.circuit"

export default function ComponentValidationBoard() {
  return (
    <board>
      <GeneratedComponent />
    </board>
  )
}
`,
  )
  try {
    return await buildCircuitArtifact({
      source_file,
      output_stem: "component-validation",
      ...input,
    })
  } finally {
    await rm(source_path, { force: true })
  }
}

async function extractIndependentComponentEvidence(input: {
  context: JobRunnerContext
  job_dir: string
  signal: AbortSignal
  append: StreamProcessInput["on_chunk"]
}): Promise<{
  application_plan: TypicalApplicationPlan
  application_text: string
  footprint_plan: FootprintPlan
  footprint_text: string
}> {
  const verification_dir = await mkdtemp(join(tmpdir(), "datasheet-component-evidence-"))
  try {
    await Promise.all([
      cp(join(input.job_dir, "datasheet.pdf"), join(verification_dir, "datasheet.pdf")),
      cp(join(input.job_dir, "index.circuit.tsx"), join(verification_dir, "component.circuit.tsx")),
    ])
    const events = await runStructuredAgentPhase({
      context: input.context,
      prompt: buildTypicalApplicationEvidenceVerificationPrompt(),
      cwd: verification_dir,
      signal: input.signal,
      append: input.append,
    })
    try {
      await validateAgentImageReads({
        job_dir: verification_dir,
        events,
        expected_images: ["visual-reference/land-pattern.png", "visual-reference/typical-application.png"],
      })
    } catch (error) {
      if (!(error instanceof VisualInspectionInconclusiveError)) throw error
      await input.append(
        "system",
        "Independent reference pixel inspection was inconclusive; continuing with structured evidence and server validation.\n",
      )
    }
    const [application_raw_text, footprint_raw_text] = await Promise.all([
      readFile(join(verification_dir, "typical-application-plan.json"), "utf8"),
      readFile(join(verification_dir, "footprint-plan.json"), "utf8"),
    ])
    const application_plan = parseTypicalApplicationPlan(JSON.parse(application_raw_text) as unknown)
    const footprint_plan = parseFootprintPlan(JSON.parse(footprint_raw_text) as unknown)
    if (JSON.parse(application_raw_text).version !== 2) {
      throw new Error("Independent typical-application evidence must use plan schema version 2")
    }
    await mkdir(join(input.job_dir, "visual-reference"), { recursive: true })
    await Promise.all([
      cp(
        join(verification_dir, "visual-reference", "typical-application.png"),
        join(input.job_dir, "visual-reference", "typical-application.png"),
      ),
      cp(
        join(verification_dir, "visual-reference", "land-pattern.png"),
        join(input.job_dir, "visual-reference", "land-pattern.png"),
      ),
    ])
    return {
      application_plan,
      application_text: `${JSON.stringify(application_plan, null, 2)}\n`,
      footprint_plan,
      footprint_text: `${JSON.stringify(footprint_plan, null, 2)}\n`,
    }
  } finally {
    await rm(verification_dir, { recursive: true, force: true })
  }
}

function importsGeneratedComponent(source: string): boolean {
  return /\bfrom\s*["']\.\/index\.circuit(?:\.tsx)?["']/.test(source)
}

export async function runJob(
  input: { job_id: string; additional_instructions?: string },
  context: JobRunnerContext,
): Promise<void> {
  const job_dir = context.job_store.getJobDir(input.job_id)
  if (!job_dir) throw new Error(`Job ${input.job_id} was not found`)
  const cancellation_signal = context.job_store.getCancellationSignal(input.job_id)
  if (!cancellation_signal) throw new Error(`Job ${input.job_id} has no cancellation signal`)

  const append = async (stream: JobLogStream, message: string): Promise<void> => {
    await context.job_store.appendLog(input.job_id, stream, message)
  }

  try {
    throwIfCancelled(cancellation_signal)
    context.job_store.updateJob(input.job_id, { display_status: "agent_running" })
    await append(
      "system",
      "Starting component and typical-application evidence phase; streaming its complete process output…\n",
    )

    const component_events = await runStructuredAgentPhase({
      context,
      prompt: buildAgentPrompt(input.additional_instructions),
      cwd: job_dir,
      signal: cancellation_signal,
      append,
    })
    throwIfCancelled(cancellation_signal)

    const component_visual_inspection = await validateVisualInspection({
      job_dir,
      events: component_events,
      report_file: "component-visual-inspection.json",
      build_command: "tsci build index.circuit.tsx",
      expected_images: {
        reference: "visual-reference/land-pattern.png",
        pcb: "dist/index/pcb.png",
        schematic: "dist/index/schematic.png",
      },
    })
    if (component_visual_inspection.status === "inconclusive") {
      await append(
        "system",
        "Component pixel inspection was inconclusive; continuing with the server-owned build and DRC validation.\n",
      )
    }

    const component_path = join(job_dir, "index.circuit.tsx")
    const component_code = await readFile(component_path, "utf8")
    if (!component_code.includes("export default")) {
      throw new Error("The agent did not create a default-exported TSX component")
    }
    if (await Bun.file(join(job_dir, "typical-application.circuit.tsx")).exists()) {
      throw new Error(
        "The agent created typical-application.circuit.tsx before the component-ready milestone",
      )
    }
    const typical_application_plan_path = join(job_dir, "typical-application-plan.json")
    const footprint_plan_path = join(job_dir, "footprint-plan.json")
    let typical_application_plan_text = await readFile(typical_application_plan_path, "utf8")
    let typical_application_plan = parseTypicalApplicationPlan(
      JSON.parse(typical_application_plan_text) as unknown,
    )
    let footprint_plan_text = await readFile(footprint_plan_path, "utf8")
    let footprint_plan = parseFootprintPlan(JSON.parse(footprint_plan_text) as unknown)

    throwIfCancelled(cancellation_signal)
    await append(
      "system",
      "\nIndependently extracting the datasheet land pattern and typical-application netlist before component validation…\n",
    )
    const independently_verified = await extractIndependentComponentEvidence({
      context,
      job_dir,
      signal: cancellation_signal,
      append,
    })
    await Promise.all([
      Bun.write(join(job_dir, "typical-application-plan.draft.json"), typical_application_plan_text),
      Bun.write(join(job_dir, "footprint-plan.draft.json"), footprint_plan_text),
    ])
    typical_application_plan = independently_verified.application_plan
    typical_application_plan_text = independently_verified.application_text
    footprint_plan = independently_verified.footprint_plan
    footprint_plan_text = independently_verified.footprint_text
    await Promise.all([
      Bun.write(typical_application_plan_path, typical_application_plan_text),
      Bun.write(footprint_plan_path, footprint_plan_text),
    ])
    await append(
      "system",
      "Independent datasheet evidence is now authoritative for footprint dimensions and application connectivity.\n",
    )

    throwIfCancelled(cancellation_signal)
    context.job_store.updateJob(input.job_id, { display_status: "building" })
    await append("system", "\nComponent phase finished. Building the generated component with tsci…\n")
    const component_build = await buildCircuitArtifact({
      source_file: "index.circuit.tsx",
      output_stem: "index",
      job_dir,
      tsci_bin: context.tsci_bin,
      signal: cancellation_signal,
      append,
      render_outputs: true,
    })
    if (component_build.errors.length > 0) {
      context.job_store.updateJob(input.job_id, {
        component_code,
        circuit_json: component_build.circuit_json,
      })
      throw new Error(
        `Generated component failed clean build validation: ${component_build.errors.join("; ")}`,
      )
    }
    const component_circuit_json = component_build.circuit_json
    const footprint_errors = getFootprintPlanErrors(footprint_plan, component_circuit_json)
    if (footprint_errors.length > 0) {
      context.job_store.updateJob(input.job_id, {
        component_code,
        circuit_json: component_circuit_json,
      })
      throw new Error(
        `Generated component failed datasheet footprint validation: ${footprint_errors.join("; ")}`,
      )
    }
    await append(
      "system",
      "Validating the reusable component on a server-owned board with tsci placement DRC…\n",
    )
    const component_validation_build = await buildComponentValidationBoard({
      job_dir,
      tsci_bin: context.tsci_bin,
      signal: cancellation_signal,
      append,
    })
    if (component_validation_build.errors.length > 0) {
      context.job_store.updateJob(input.job_id, {
        component_code,
        circuit_json: component_circuit_json,
      })
      throw new Error(
        `Generated component failed board-level tsci validation: ${component_validation_build.errors.join(
          "; ",
        )}`,
      )
    }
    const component_snapshot_path = join(job_dir, "component.circuit.tsx")
    await Bun.write(component_snapshot_path, component_code)

    await append(
      "system",
      "Component ready. Its code, schematic, and PCB are available; SPICE generation may proceed while the typical application is created.\n",
    )
    context.job_store.updateJob(input.job_id, {
      display_status: "agent_running",
      is_complete: false,
      has_errors: false,
      component_ready: true,
      component_code,
      circuit_json: component_circuit_json,
    })

    throwIfCancelled(cancellation_signal)
    await append("system", "\nStarting the typical-application phase after the component-ready milestone…\n")
    let protected_files_modified = false
    let application_events: TrustedAgentEvent[] = []
    try {
      application_events = await runStructuredAgentPhase({
        context,
        prompt: buildTypicalApplicationPrompt(input.additional_instructions),
        cwd: job_dir,
        signal: cancellation_signal,
        append,
      })
    } finally {
      const [current_component_code, current_component_snapshot, current_plan_text, current_footprint_text] =
        await Promise.all([
          readFile(component_path, "utf8").catch(() => undefined),
          readFile(component_snapshot_path, "utf8").catch(() => undefined),
          readFile(typical_application_plan_path, "utf8").catch(() => undefined),
          readFile(footprint_plan_path, "utf8").catch(() => undefined),
        ])
      if (current_component_code !== component_code) {
        const server_published_component = context.job_store.getJob(input.job_id)?.component_code
        if (current_component_code !== server_published_component) protected_files_modified = true
        await Bun.write(component_path, component_code)
      }
      if (current_component_snapshot !== component_code) {
        protected_files_modified = true
        await Bun.write(component_snapshot_path, component_code)
      }
      if (current_plan_text !== typical_application_plan_text) {
        protected_files_modified = true
        await Bun.write(typical_application_plan_path, typical_application_plan_text)
      }
      if (current_footprint_text !== footprint_plan_text) {
        protected_files_modified = true
        await Bun.write(footprint_plan_path, footprint_plan_text)
      }
    }
    if (protected_files_modified) {
      throw new Error(
        "The typical-application phase modified a read-only component or evidence plan; the server restored it",
      )
    }
    throwIfCancelled(cancellation_signal)

    const application_visual_inspection = await validateVisualInspection({
      job_dir,
      events: application_events,
      report_file: "application-visual-inspection.json",
      build_command: "tsci build typical-application.circuit.tsx",
      expected_images: {
        reference: "visual-reference/typical-application.png",
        pcb: "dist/typical-application/pcb.png",
        schematic: "dist/typical-application/schematic.png",
      },
    })
    if (application_visual_inspection.status === "inconclusive") {
      await append(
        "system",
        "Application pixel inspection was inconclusive; continuing with the server-owned build and connectivity validation.\n",
      )
    }

    const typical_application_path = join(job_dir, "typical-application.circuit.tsx")
    const typical_application_code = await readFile(typical_application_path, "utf8")
    if (
      !typical_application_code.includes("export default") ||
      !importsGeneratedComponent(typical_application_code)
    ) {
      throw new Error(
        "The agent did not create a default-exported typical application importing ./index.circuit",
      )
    }

    context.job_store.updateJob(input.job_id, { display_status: "building" })
    await append("system", "\nBuilding the typical application with tsci…\n")
    const typical_application_build = await buildCircuitArtifact({
      source_file: "typical-application.circuit.tsx",
      output_stem: "typical-application",
      job_dir,
      tsci_bin: context.tsci_bin,
      signal: cancellation_signal,
      append,
      render_outputs: true,
    })
    if (typical_application_build.errors.length > 0) {
      context.job_store.updateJob(input.job_id, {
        typical_application_code,
        typical_application_circuit_json: typical_application_build.circuit_json,
      })
      throw new Error(
        `Typical application failed clean build validation: ${typical_application_build.errors.join("; ")}`,
      )
    }
    const typical_application_circuit_json = typical_application_build.circuit_json
    const connectivity_errors = [
      ...getTypicalApplicationConnectivityErrors(typical_application_plan, typical_application_circuit_json),
      ...getTypicalApplicationComponentValueErrors(
        typical_application_plan,
        typical_application_circuit_json,
      ),
    ]
    if (connectivity_errors.length > 0) {
      context.job_store.updateJob(input.job_id, {
        typical_application_code,
        typical_application_circuit_json,
      })
      throw new Error(
        `Typical application failed datasheet netlist validation: ${connectivity_errors.join("; ")}`,
      )
    }
    const latest_component_job = context.job_store.getJob(input.job_id)
    const published_component_code = latest_component_job?.component_code ?? component_code
    if (published_component_code !== component_code) {
      await Bun.write(component_path, published_component_code)
    }

    await append(
      "system",
      "Typical application ready. Component and application code, schematic, and PCB previews are available.\n",
    )
    context.job_store.updateJob(input.job_id, {
      display_status: "complete",
      is_complete: true,
      has_errors: false,
      completed_at: new Date().toISOString(),
      component_ready: true,
      typical_application_code,
      typical_application_circuit_json,
    })
  } catch (error) {
    if (error instanceof JobCancelledError || cancellation_signal.aborted) {
      await append("system", "\nCancellation requested. The active job process was stopped.\n").catch(
        () => undefined,
      )
      context.job_store.updateJob(input.job_id, {
        display_status: "cancelled",
        is_complete: true,
        has_errors: false,
        completed_at: new Date().toISOString(),
        error_message: undefined,
      })
      return
    }
    const error_message = error instanceof Error ? error.message : String(error)
    await append("system", `\nConversion failed: ${error_message}\n`).catch(() => undefined)
    context.job_store.updateJob(input.job_id, {
      display_status: "failed",
      is_complete: true,
      has_errors: true,
      completed_at: new Date().toISOString(),
      error_message,
    })
  }
}
