import { appendFile, cp, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, relative, resolve } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import type { JobLogStream, JobValidation } from "@/shared/job-types"
import { type TrustedAgentEvent, parseTrustedAgentEvent } from "./agent-event-protocol"
import {
  type ComponentEvidence,
  getComponentEvidenceBlockingReasons,
  getFootprintEvidenceErrors,
  getIndependentComponentEvidenceErrors,
  getPinoutEvidenceErrors,
  parseComponentEvidence,
} from "./component-evidence"
import { createComponentSchematicPlan, getComponentSchematicPlanErrors } from "./component-schematic-plan"
import {
  type ExpectedApplicationConnection,
  type ExpectedFootprintPad,
  type FootprintPlan,
  getApplicationSchematicErrors,
  getFootprintPlanErrors,
  getTypicalApplicationSourceErrors,
  getTypicalApplicationComponentValueErrors,
  getTypicalApplicationConnectivityErrors,
  validateAgentImageReads,
  validateVisualInspection,
  VisualInspectionInconclusiveError,
} from "./job-artifact-validator"
import type { JobStore } from "./job-store"
import { getAllCircuitErrors } from "./model-simulation-validator"
import { getPinnedTscircuitVersion } from "./runtime-versions"

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
  event_log_file?: string
  event_phase?: string
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
    if (input.event_log_file) {
      await appendFile(
        input.event_log_file,
        `${JSON.stringify({
          recorded_at: new Date().toISOString(),
          phase: input.event_phase ?? "agent",
          event,
        })}\n`,
        "utf8",
      )
    }
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

  return `Complete the evidence-extraction phase for datasheet.pdf. Do not create or modify any
circuit TSX file in this phase. The server will approve and lock the evidence before code generation.

Read AGENTS.md first. Extract text with pdftotext -layout and select candidate pages by matching
general section terms such as pin functions, terminal functions, package information, mechanical
data, recommended land pattern, board layout, and typical application. Sort candidate pages by PDF
page number. Render every selected page at exactly 200 DPI with deterministic filenames under
visual-reference/pages/, then inspect the pixels with the built-in read tool. Page numbers in JSON
are one-based PDF page numbers, not printed document folios.

Write component-evidence.json with this schema:
{ "version": 1, "status": "resolved" | "human_review_required",
  "part_number": evidenceField<string>, "ordering_code": evidenceField<string>?,
  "package": { "name": evidenceField<string>, "code": evidenceField<string>?,
    "pin_count": evidenceField<number> },
  "pinout": { "pins": [{ "number": string, "labels": string[],
      "role": "power_input" | "power_output" | "ground" | "input" | "output" |
        "bidirectional" | "passive" | "no_connect" | "other", "description": string?,
      "sources": evidenceSource[] }] },
  "footprint": { "view": "pcb_top", "units": "mm",
    "drawing_orientation": evidenceField<"pcb_top" | "package_top" |
      "package_bottom" | "side" | "unknown">,
    "pads": [{ "pin": string | null, "kind": "smt" | "plated_hole", "x": number,
      "y": number, "width": number, "height": number, "hole_width": number?,
      "hole_height": number?, "sources": evidenceSource[] }] },
  "unresolved_ambiguities": string[] }
where evidenceField<T> is { "value": T, "sources": evidenceSource[] } and evidenceSource is
{ "page": number, "figure": string?, "method": "pdf_text" | "pdf_visual" | "calculated" |
  "package_standard", "confidence": "high" | "medium" | "low", "image": string?,
  "render_dpi": number?, "note": string? }. Visual sources must name the inspected PNG and record
200 DPI. Every identity, package, pin-table, orientation, and pad field needs a precise source.

Resolve the exact orderable part/package combination. Do not combine pin tables or dimensions from
different order codes. Use only an explicitly identified PCB-top copper land pattern. A package
outline, package-bottom view, stencil aperture, or generic footprint-library name is not equivalent.
Record every copper pad, including repeated pads on one electrical pin. Use null only for a
mechanical copper pad that has no electrical pin. Coordinates and dimensions
are millimeters about the land-pattern origin. Derive center coordinates only from cited dimensions
and record the formula in a source note. Never choose between conflicting dimension leaders by
appearance alone. If the exact package, orientation, pin mapping, a required dimension, or any
conflict cannot be resolved, set status to human_review_required and describe it; do not guess.
Classify each pin role from its cited electrical function. The role describes the pin, not a desired
schematic side; use other only when none of the explicit electrical roles applies.

Also write footprint-plan.json version 1 from the same evidence, and typical-application-plan.json:
{ "version": 3, "availability": "documented" | "not_present", "title": string,
  "description": string, "source_references": [{ "page": number, "figure": string? }],
  "searched_sections": string[]?, "components": [{ "reference": string, "kind": string,
  "value": string?, "purpose": string? }],
  "connections": [{ "net": string, "pins": [string, string, ...] }] }.
Set availability to documented and include cited sources, components, values, and complete
structured nets using exact component.port endpoints when the PDF contains an application. If a
systematic section search finds none, set availability to not_present, keep components and
connections empty, list every searched heading in searched_sections, cite the searched datasheet
pages, and explain the result; never invent a reference circuit. Save the inspected land pattern as
visual-reference/land-pattern.png. For a
documented application, save and read visual-reference/typical-application.png. For not_present,
only the land-pattern image is required. Do not create component-visual-inspection.json or run tsci
in this phase.${user_context}`
}

export function buildComponentPrompt(additional_instructions?: string): string {
  const user_context = additional_instructions?.trim()
    ? `\nAdditional context from the user:\n${additional_instructions.trim()}\n`
    : ""

  return `Generate the reusable tscircuit component from the server-approved evidence. Read AGENTS.md,
component-evidence.json, component-schematic-plan.json, and footprint-plan.json. Treat those files,
typical-application-plan.json,
and all existing files under visual-reference/ as read-only. Do not open, extract, render, search,
or otherwise access datasheet.pdf or datasheet.txt;
the approved JSON and reference PNG are the only allowed datasheet inputs in this phase.

Replace index.circuit.tsx with a production-quality, default-exported component. Implement the exact
part number, complete pin table, PCB-top pad geometry, and orientation from component-evidence.json.
Implement component-schematic-plan.json.schPinArrangement exactly; it is a server-derived,
deterministic layout contract based on independently agreed pin roles.
Do not substitute a generic library footprint unless its generated pad geometry exactly matches the
approved evidence. Keep schematic labels and aliases compact and readable. Do not use
placementDrcChecksDisabled, routingDisabled, --ignore-placement-drc, or similar suppression.

Run tsci build index.circuit.tsx --ignore-warnings --pcb-png --schematic-svgs, render the schematic
SVG, and inspect visual-reference/land-pattern.png, dist/index/pcb.png, and
dist/index/schematic.png with read after the final build. Correct defects and rebuild as needed.
Finally write component-visual-inspection.json version 1 with status passed and those exact paths.
If pixels are unavailable or the render conflicts with the evidence, record inconclusive and stop.
After the final build, run no shell command except the one schematic SVG-to-PNG render command. Do
not create typical-application.circuit.tsx.${user_context}`
}

export function buildTypicalApplicationPrompt(additional_instructions?: string): string {
  const user_context = additional_instructions?.trim()
    ? `\nAdditional context from the user:\n${additional_instructions.trim()}\n`
    : ""

  return `Complete phase 2 of the datasheet conversion. The server has independently
built index.circuit.tsx and published it as ready; SPICE generation may now use it.

Read AGENTS.md and typical-application-plan.json first. Treat index.circuit.tsx,
component.circuit.tsx, component-evidence.json, component-schematic-plan.json,
footprint-plan.json, and
typical-application-plan.json as read-only. Do not open, extract, render, search, or otherwise access
datasheet.pdf or datasheet.txt; the approved JSON and reference PNG are the only allowed datasheet
inputs in this phase. Create
typical-application.circuit.tsx
as a default-exported tscircuit circuit that imports the generated component from
"./index.circuit" and implements the cited datasheet application faithfully. Use
the recorded external component values, connections, and operating context. Do
not replace the generated component with a generic chip or duplicate its
definition.

Never instantiate a standalone <netlabel> element. Net selectors such as "net.*" and "sel.net.*",
net-connected traces, trace schDisplayLabel props, and compiled schematic net-label records are
allowed. Arrange components compactly by signal flow, keep individual trace segments short, and
avoid large empty schematic regions.

Build the application with PCB and schematic visual outputs, render the schematic
SVG to PNG, and inspect the locked reference,
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
  return `Independently extract the evidence. You have no earlier plan and must not infer what another
agent selected.\n\n${buildAgentPrompt()}`
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
  version: 3
  availability: "documented" | "not_present"
  title: string
  description: string
  source_references: Array<{ page: number; figure?: string }>
  searched_sections?: string[]
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

function optionalTextArray(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((item, index) => requiredText(item, `${label}[${index}]`))
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
      pin: pad.pin === null ? null : requiredText(pad.pin, `pads[${index}].pin`),
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
      throw new Error(
        `footprint plated-hole pad ${parsed.pin ?? "mechanical"} must include positive hole dimensions`,
      )
    }
    return parsed
  })
  return { version: 1, view: "pcb_top", source_references, pads }
}

export function parseTypicalApplicationPlan(value: unknown): TypicalApplicationPlan {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2 && value.version !== 3)) {
    throw new Error("typical-application-plan.json must have version 3")
  }
  const availability = value.version === 3 ? value.availability : "documented"
  if (availability !== "documented" && availability !== "not_present") {
    throw new Error("typical-application-plan.json must declare documented or not_present")
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
  if (!Array.isArray(value.components) || (availability === "documented" && value.components.length === 0)) {
    throw new Error("documented typical-application evidence must list the application components")
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
  if (
    !Array.isArray(value.connections) ||
    (availability === "documented" && value.connections.length === 0)
  ) {
    throw new Error("documented typical-application evidence must list the application connections")
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
  if (availability === "not_present" && (components.length > 0 || connections.length > 0)) {
    throw new Error("not_present typical-application evidence must have empty components and connections")
  }
  const searched_sections = optionalTextArray(
    value.searched_sections,
    "typical-application searched_sections",
  )
  if (availability === "not_present" && searched_sections.length === 0) {
    throw new Error("not_present typical-application evidence must list searched_sections")
  }
  return {
    version: 3,
    availability,
    title: requiredText(value.title, "typical application title"),
    description: requiredText(value.description, "typical application description"),
    source_references,
    ...(searched_sections.length > 0 ? { searched_sections } : {}),
    components,
    connections,
  }
}

function normalizedText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ")
}

export function getTypicalApplicationPlanAgreementErrors(
  primary: TypicalApplicationPlan,
  independent: TypicalApplicationPlan,
): string[] {
  const errors: string[] = []
  if (primary.availability !== independent.availability) {
    errors.push(
      `typical-application availability disagrees: ${primary.availability} versus ${independent.availability}`,
    )
    return errors
  }
  if (primary.availability === "not_present") {
    const primary_sections = (primary.searched_sections ?? []).map(normalizedText).sort()
    const independent_sections = (independent.searched_sections ?? []).map(normalizedText).sort()
    if (JSON.stringify(primary_sections) !== JSON.stringify(independent_sections)) {
      errors.push("typical-application searched sections disagree")
    }
  }
  const primary_pages = [...new Set(primary.source_references.map((source) => source.page))].sort(
    (left, right) => left - right,
  )
  const independent_pages = [...new Set(independent.source_references.map((source) => source.page))].sort(
    (left, right) => left - right,
  )
  if (JSON.stringify(primary_pages) !== JSON.stringify(independent_pages)) {
    errors.push(
      `typical-application source pages disagree: ${primary_pages.join(", ")} versus ${independent_pages.join(", ")}`,
    )
  }
  const component_signature = (plan: TypicalApplicationPlan) =>
    plan.components
      .map((component) => ({
        reference: normalizedText(component.reference),
        value: normalizedText(component.value),
      }))
      .sort((left, right) => left.reference.localeCompare(right.reference))
  if (JSON.stringify(component_signature(primary)) !== JSON.stringify(component_signature(independent))) {
    errors.push("typical-application component references or values disagree")
  }
  const connection_signature = (plan: TypicalApplicationPlan) =>
    plan.connections
      .map((connection) => ({
        net: normalizedText(connection.net),
        pins: connection.pins.map(normalizedText).sort(),
      }))
      .sort((left, right) => left.net.localeCompare(right.net))
  if (JSON.stringify(connection_signature(primary)) !== JSON.stringify(connection_signature(independent))) {
    errors.push("typical-application net names or endpoints disagree")
  }
  return errors
}

export function getForbiddenDatasheetAccesses(events: TrustedAgentEvent[]): string[] {
  const blocked = /(?:^|["'/\\])datasheet\.(?:pdf|txt)\b|\b(?:pdftotext|pdfinfo|pdftoppm|mutool|qpdf)\b/i
  return events.flatMap((event) => {
    if (event.type !== "tool_start") return []
    const args = stringifyForLog(event.args)
    return blocked.test(args) ? [`${event.tool_name} ${args}`] : []
  })
}

function assertNoDatasheetAccess(events: TrustedAgentEvent[], phase: string): void {
  const accesses = getForbiddenDatasheetAccesses(events)
  if (accesses.length > 0) {
    throw new Error(
      `${phase} accessed locked datasheet inputs after evidence approval: ${accesses.join("; ")}`,
    )
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
  component_evidence: ComponentEvidence
  application_plan: TypicalApplicationPlan
  footprint_plan: FootprintPlan
}> {
  const verification_dir = await mkdtemp(join(tmpdir(), "datasheet-component-evidence-"))
  try {
    await cp(join(input.job_dir, "datasheet.pdf"), join(verification_dir, "datasheet.pdf"))
    const events = await runStructuredAgentPhase({
      context: input.context,
      prompt: buildTypicalApplicationEvidenceVerificationPrompt(),
      cwd: verification_dir,
      signal: input.signal,
      append: input.append,
      event_log_file: join(input.job_dir, "agent-events.jsonl"),
      event_phase: "independent_evidence",
    })
    const [component_evidence_raw_text, application_raw_text, footprint_raw_text] = await Promise.all([
      readFile(join(verification_dir, "component-evidence.json"), "utf8"),
      readFile(join(verification_dir, "typical-application-plan.json"), "utf8"),
      readFile(join(verification_dir, "footprint-plan.json"), "utf8"),
    ])
    const component_evidence = parseComponentEvidence(JSON.parse(component_evidence_raw_text) as unknown)
    const application_plan = parseTypicalApplicationPlan(JSON.parse(application_raw_text) as unknown)
    const footprint_plan = parseFootprintPlan(JSON.parse(footprint_raw_text) as unknown)
    await validateAgentImageReads({
      job_dir: verification_dir,
      events,
      expected_images: [
        "visual-reference/land-pattern.png",
        ...(application_plan.availability === "documented"
          ? ["visual-reference/typical-application.png"]
          : []),
      ],
    })
    await mkdir(join(input.job_dir, "visual-reference"), { recursive: true })
    await Promise.all([
      ...(application_plan.availability === "documented"
        ? [
            cp(
              join(verification_dir, "visual-reference", "typical-application.png"),
              join(input.job_dir, "visual-reference", "typical-application.independent.png"),
            ),
          ]
        : []),
      cp(
        join(verification_dir, "visual-reference", "land-pattern.png"),
        join(input.job_dir, "visual-reference", "land-pattern.independent.png"),
      ),
      Bun.write(
        join(input.job_dir, "component-evidence.independent.json"),
        `${JSON.stringify(component_evidence, null, 2)}\n`,
      ),
      Bun.write(
        join(input.job_dir, "footprint-plan.independent.json"),
        `${JSON.stringify(footprint_plan, null, 2)}\n`,
      ),
      Bun.write(
        join(input.job_dir, "typical-application-plan.independent.json"),
        `${JSON.stringify(application_plan, null, 2)}\n`,
      ),
    ])
    return {
      component_evidence,
      application_plan,
      footprint_plan,
    }
  } finally {
    await rm(verification_dir, { recursive: true, force: true })
  }
}

function importsGeneratedComponent(source: string): boolean {
  return /\bfrom\s*["']\.\/index\.circuit(?:\.tsx)?["']/.test(source)
}

async function restoreProtectedBytes(path: string, expected: Buffer | undefined): Promise<boolean> {
  const current = await readFile(path).catch(() => undefined)
  const unchanged =
    current === undefined ? expected === undefined : expected !== undefined && current.equals(expected)
  if (unchanged) return false
  if (expected === undefined) await rm(path, { force: true })
  else await Bun.write(path, expected)
  return true
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

async function readInstalledPackageVersion(package_name: string): Promise<string> {
  const package_path = resolve(import.meta.dir, "../..", "node_modules", package_name, "package.json")
  const value: unknown = JSON.parse(await readFile(package_path, "utf8"))
  return isRecord(value) && typeof value.version === "string" ? value.version : "unknown"
}

async function collectJobProvenance(input: {
  job_dir: string
  additional_instructions?: string
}): Promise<import("@/shared/job-types").JobProvenance> {
  const [datasheet, dependency_lock, tsci_agent_version, tscircuit_version] = await Promise.all([
    readFile(join(input.job_dir, "datasheet.pdf")),
    readFile(resolve(import.meta.dir, "../..", "bun.lock")).catch(() => undefined),
    readInstalledPackageVersion("tsci-agent").catch(() => "unknown"),
    getPinnedTscircuitVersion(),
  ])
  return {
    source_commit: process.env.SOURCE_COMMIT ?? process.env.GIT_COMMIT ?? "unavailable",
    bun_version: Bun.version,
    tscircuit_version,
    tsci_agent_version,
    agent_model: process.env.TSCI_AGENT_MODEL ?? "agent-default",
    agent_settings: process.env.TSCI_AGENT_SETTINGS ?? "agent-default",
    datasheet_sha256: sha256(datasheet),
    ...(dependency_lock ? { dependency_lock_sha256: sha256(dependency_lock) } : {}),
    prompt_sha256: {
      primary_evidence: sha256(buildAgentPrompt(input.additional_instructions)),
      independent_evidence: sha256(buildTypicalApplicationEvidenceVerificationPrompt()),
      component_generation: sha256(buildComponentPrompt(input.additional_instructions)),
      typical_application: sha256(buildTypicalApplicationPrompt(input.additional_instructions)),
    },
  }
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
  let validation: JobValidation = {
    evidence: "pending",
    component_build: "pending",
    component_drc: "pending",
    footprint: "pending",
    pinout: "pending",
    component_schematic: "pending",
    component_visual: "pending",
    application_build: "pending",
    application_connectivity: "pending",
    application_schematic: "pending",
    application_visual: "pending",
  }
  const updateValidation = (update: Partial<typeof validation>): void => {
    validation = { ...validation, ...update }
    context.job_store.updateJob(input.job_id, { validation })
  }
  let active_validation_phase: "evidence" | "component_generation" | "application_generation" = "evidence"

  try {
    throwIfCancelled(cancellation_signal)
    const provenance = await collectJobProvenance({
      job_dir,
      additional_instructions: input.additional_instructions,
    })
    context.job_store.updateJob(input.job_id, {
      display_status: "agent_running",
      validation,
      provenance,
    })
    await append(
      "system",
      "Starting the evidence-only extraction phase; no circuit code will be generated until the evidence agrees…\n",
    )

    const component_path = join(job_dir, "index.circuit.tsx")
    const starter_component_code = await readFile(component_path, "utf8").catch(() => undefined)
    const evidence_events = await runStructuredAgentPhase({
      context,
      prompt: buildAgentPrompt(input.additional_instructions),
      cwd: job_dir,
      signal: cancellation_signal,
      append,
      event_log_file: join(job_dir, "agent-events.jsonl"),
      event_phase: "primary_evidence",
    })
    throwIfCancelled(cancellation_signal)
    const component_after_evidence = await readFile(component_path, "utf8").catch(() => undefined)
    if (component_after_evidence !== starter_component_code) {
      if (starter_component_code === undefined) await rm(component_path, { force: true })
      else await Bun.write(component_path, starter_component_code)
      throw new Error("The evidence phase modified index.circuit.tsx before evidence approval")
    }
    if (await Bun.file(join(job_dir, "typical-application.circuit.tsx")).exists()) {
      throw new Error("The evidence phase created circuit TSX before evidence approval")
    }
    const component_evidence_path = join(job_dir, "component-evidence.json")
    const component_schematic_plan_path = join(job_dir, "component-schematic-plan.json")
    const typical_application_plan_path = join(job_dir, "typical-application-plan.json")
    const footprint_plan_path = join(job_dir, "footprint-plan.json")
    const component_evidence_text = await readFile(component_evidence_path, "utf8")
    const component_evidence = parseComponentEvidence(JSON.parse(component_evidence_text) as unknown)
    const typical_application_plan_text = await readFile(typical_application_plan_path, "utf8")
    const typical_application_plan = parseTypicalApplicationPlan(
      JSON.parse(typical_application_plan_text) as unknown,
    )
    await validateAgentImageReads({
      job_dir,
      events: evidence_events,
      expected_images: [
        "visual-reference/land-pattern.png",
        ...(typical_application_plan.availability === "documented"
          ? ["visual-reference/typical-application.png"]
          : []),
      ],
    })
    const land_pattern_reference_path = join(job_dir, "visual-reference/land-pattern.png")
    const application_reference_path = join(job_dir, "visual-reference/typical-application.png")
    const [land_pattern_reference, application_reference] = await Promise.all([
      readFile(land_pattern_reference_path),
      readFile(application_reference_path).catch(() => undefined),
    ])
    const footprint_plan_text = await readFile(footprint_plan_path, "utf8")
    const footprint_plan = parseFootprintPlan(JSON.parse(footprint_plan_text) as unknown)
    const primary_evidence_errors = [
      ...getComponentEvidenceBlockingReasons(component_evidence),
      ...getFootprintEvidenceErrors(component_evidence, footprint_plan),
    ]
    if (primary_evidence_errors.length > 0) {
      updateValidation({ evidence: "human_review_required" })
      throw new Error(`Primary datasheet evidence requires review: ${primary_evidence_errors.join("; ")}`)
    }

    throwIfCancelled(cancellation_signal)
    await append(
      "system",
      "\nRunning an independent extraction pass; critical evidence must agree before code generation…\n",
    )
    const independently_verified = await extractIndependentComponentEvidence({
      context,
      job_dir,
      signal: cancellation_signal,
      append,
    })
    const agreement_errors = [
      ...getComponentEvidenceBlockingReasons(independently_verified.component_evidence),
      ...getFootprintEvidenceErrors(
        independently_verified.component_evidence,
        independently_verified.footprint_plan,
      ),
      ...getIndependentComponentEvidenceErrors(component_evidence, independently_verified.component_evidence),
      ...getTypicalApplicationPlanAgreementErrors(
        typical_application_plan,
        independently_verified.application_plan,
      ),
    ]
    if (agreement_errors.length > 0) {
      updateValidation({ evidence: "human_review_required" })
      throw new Error(`Independent datasheet evidence disagrees: ${agreement_errors.join("; ")}`)
    }
    const component_schematic_plan = createComponentSchematicPlan(component_evidence)
    const component_schematic_plan_text = `${JSON.stringify(component_schematic_plan, null, 2)}\n`
    await Bun.write(component_schematic_plan_path, component_schematic_plan_text)
    updateValidation({ evidence: "passed" })
    await append(
      "system",
      "Evidence approved. The primary evidence is locked; the independent artifacts are retained for audit.\n",
    )

    throwIfCancelled(cancellation_signal)
    active_validation_phase = "component_generation"
    await append("system", "\nGenerating the component from approved evidence only…\n")
    let evidence_files_modified = false
    let component_events: TrustedAgentEvent[] = []
    try {
      component_events = await runStructuredAgentPhase({
        context,
        prompt: buildComponentPrompt(input.additional_instructions),
        cwd: job_dir,
        signal: cancellation_signal,
        append,
        event_log_file: join(job_dir, "agent-events.jsonl"),
        event_phase: "component_generation",
      })
    } finally {
      const [
        current_evidence,
        current_schematic_plan,
        current_footprint,
        current_application_plan,
        land_reference_modified,
        application_reference_modified,
      ] = await Promise.all([
        readFile(component_evidence_path, "utf8").catch(() => undefined),
        readFile(component_schematic_plan_path, "utf8").catch(() => undefined),
        readFile(footprint_plan_path, "utf8").catch(() => undefined),
        readFile(typical_application_plan_path, "utf8").catch(() => undefined),
        restoreProtectedBytes(land_pattern_reference_path, land_pattern_reference),
        restoreProtectedBytes(application_reference_path, application_reference),
      ])
      if (land_reference_modified || application_reference_modified) evidence_files_modified = true
      if (current_evidence !== component_evidence_text) {
        evidence_files_modified = true
        await Bun.write(component_evidence_path, component_evidence_text)
      }
      if (current_schematic_plan !== component_schematic_plan_text) {
        evidence_files_modified = true
        await Bun.write(component_schematic_plan_path, component_schematic_plan_text)
      }
      if (current_footprint !== footprint_plan_text) {
        evidence_files_modified = true
        await Bun.write(footprint_plan_path, footprint_plan_text)
      }
      if (current_application_plan !== typical_application_plan_text) {
        evidence_files_modified = true
        await Bun.write(typical_application_plan_path, typical_application_plan_text)
      }
    }
    if (evidence_files_modified) {
      throw new Error("The component generation phase modified locked evidence; the server restored it")
    }
    assertNoDatasheetAccess(component_events, "Component generation")
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
    if (component_visual_inspection.status !== "passed") {
      updateValidation({ component_visual: "inconclusive" })
      throw new Error("Component visual inspection is inconclusive and requires review")
    }
    updateValidation({ component_visual: "passed" })
    const component_code = await readFile(component_path, "utf8")
    if (!component_code.includes("export default")) {
      throw new Error("The agent did not create a default-exported TSX component")
    }

    context.job_store.updateJob(input.job_id, { display_status: "building" })
    await append("system", "\nBuilding the generated component with tsci…\n")
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
      updateValidation({ component_build: "failed" })
      context.job_store.updateJob(input.job_id, {
        component_code,
        circuit_json: component_build.circuit_json,
      })
      throw new Error(
        `Generated component failed clean build validation: ${component_build.errors.join("; ")}`,
      )
    }
    updateValidation({ component_build: "passed" })
    const component_circuit_json = component_build.circuit_json
    const footprint_errors = getFootprintPlanErrors(footprint_plan, component_circuit_json)
    if (footprint_errors.length > 0) {
      updateValidation({ footprint: "failed" })
      context.job_store.updateJob(input.job_id, {
        component_code,
        circuit_json: component_circuit_json,
      })
      throw new Error(
        `Generated component failed datasheet footprint validation: ${footprint_errors.join("; ")}`,
      )
    }
    updateValidation({ footprint: "passed" })
    const pinout_errors = getPinoutEvidenceErrors(component_evidence, component_circuit_json)
    if (pinout_errors.length > 0) {
      updateValidation({ pinout: "failed" })
      context.job_store.updateJob(input.job_id, {
        component_code,
        circuit_json: component_circuit_json,
      })
      throw new Error(
        `Generated component failed datasheet pin-table validation: ${pinout_errors.join("; ")}`,
      )
    }
    updateValidation({ pinout: "passed" })
    const component_schematic_errors = getComponentSchematicPlanErrors(
      component_schematic_plan,
      component_circuit_json,
    )
    if (component_schematic_errors.length > 0) {
      updateValidation({ component_schematic: "failed" })
      context.job_store.updateJob(input.job_id, {
        component_code,
        circuit_json: component_circuit_json,
      })
      throw new Error(
        `Generated component failed deterministic schematic validation: ${component_schematic_errors.join("; ")}`,
      )
    }
    updateValidation({ component_schematic: "passed" })
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
      updateValidation({ component_drc: "failed" })
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
    updateValidation({ component_drc: "passed" })
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

    if (typical_application_plan.availability === "not_present") {
      updateValidation({
        application_build: "not_applicable",
        application_connectivity: "not_applicable",
        application_schematic: "not_applicable",
        application_visual: "not_applicable",
      })
      await append(
        "system",
        "No datasheet typical application was found by either evidence pass. Completing with the validated component only.\n",
      )
      context.job_store.updateJob(input.job_id, {
        display_status: "complete",
        is_complete: true,
        has_errors: false,
        completed_at: new Date().toISOString(),
        component_ready: true,
      })
      return
    }

    throwIfCancelled(cancellation_signal)
    active_validation_phase = "application_generation"
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
        event_log_file: join(job_dir, "agent-events.jsonl"),
        event_phase: "typical_application_generation",
      })
    } finally {
      const [
        current_component_code,
        current_component_snapshot,
        current_evidence_text,
        current_schematic_plan_text,
        current_plan_text,
        current_footprint_text,
        land_reference_modified,
        application_reference_modified,
      ] = await Promise.all([
        readFile(component_path, "utf8").catch(() => undefined),
        readFile(component_snapshot_path, "utf8").catch(() => undefined),
        readFile(component_evidence_path, "utf8").catch(() => undefined),
        readFile(component_schematic_plan_path, "utf8").catch(() => undefined),
        readFile(typical_application_plan_path, "utf8").catch(() => undefined),
        readFile(footprint_plan_path, "utf8").catch(() => undefined),
        restoreProtectedBytes(land_pattern_reference_path, land_pattern_reference),
        restoreProtectedBytes(application_reference_path, application_reference),
      ])
      if (land_reference_modified || application_reference_modified) protected_files_modified = true
      if (current_component_code !== component_code) {
        const server_published_component = context.job_store.getJob(input.job_id)?.component_code
        if (current_component_code !== server_published_component) protected_files_modified = true
        await Bun.write(component_path, component_code)
      }
      if (current_component_snapshot !== component_code) {
        protected_files_modified = true
        await Bun.write(component_snapshot_path, component_code)
      }
      if (current_evidence_text !== component_evidence_text) {
        protected_files_modified = true
        await Bun.write(component_evidence_path, component_evidence_text)
      }
      if (current_schematic_plan_text !== component_schematic_plan_text) {
        protected_files_modified = true
        await Bun.write(component_schematic_plan_path, component_schematic_plan_text)
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
    assertNoDatasheetAccess(application_events, "Typical-application generation")

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
    const source_schematic_errors = getTypicalApplicationSourceErrors(typical_application_code)
    if (source_schematic_errors.length > 0) {
      updateValidation({ application_schematic: "failed" })
      context.job_store.updateJob(input.job_id, { typical_application_code })
      throw new Error(
        `Typical application failed schematic source validation: ${source_schematic_errors.join("; ")}`,
      )
    }

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
    if (application_visual_inspection.status !== "passed") {
      updateValidation({ application_visual: "inconclusive" })
      throw new Error("Typical-application visual inspection is inconclusive and requires review")
    }
    updateValidation({ application_visual: "passed" })

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
      updateValidation({ application_build: "failed" })
      context.job_store.updateJob(input.job_id, {
        typical_application_code,
        typical_application_circuit_json: typical_application_build.circuit_json,
      })
      throw new Error(
        `Typical application failed clean build validation: ${typical_application_build.errors.join("; ")}`,
      )
    }
    updateValidation({ application_build: "passed" })
    const typical_application_circuit_json = typical_application_build.circuit_json
    const application_schematic_errors = getApplicationSchematicErrors(typical_application_circuit_json)
    if (application_schematic_errors.length > 0) {
      updateValidation({ application_schematic: "failed" })
      context.job_store.updateJob(input.job_id, {
        typical_application_code,
        typical_application_circuit_json,
      })
      throw new Error(
        `Typical application failed schematic layout validation: ${application_schematic_errors.join("; ")}`,
      )
    }
    updateValidation({ application_schematic: "passed" })
    const connectivity_errors = [
      ...getTypicalApplicationConnectivityErrors(typical_application_plan, typical_application_circuit_json),
      ...getTypicalApplicationComponentValueErrors(
        typical_application_plan,
        typical_application_circuit_json,
      ),
    ]
    if (connectivity_errors.length > 0) {
      updateValidation({ application_connectivity: "failed" })
      context.job_store.updateJob(input.job_id, {
        typical_application_code,
        typical_application_circuit_json,
      })
      throw new Error(
        `Typical application failed datasheet netlist validation: ${connectivity_errors.join("; ")}`,
      )
    }
    updateValidation({ application_connectivity: "passed" })
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
    const failed_status = error instanceof VisualInspectionInconclusiveError ? "inconclusive" : "failed"
    if (active_validation_phase === "evidence" && validation.evidence === "pending") {
      updateValidation({ evidence: failed_status })
    } else if (
      active_validation_phase === "component_generation" &&
      validation.component_visual === "pending" &&
      validation.component_build === "pending"
    ) {
      updateValidation({ component_visual: failed_status })
    } else if (
      active_validation_phase === "application_generation" &&
      validation.application_visual === "pending" &&
      validation.application_build === "pending"
    ) {
      updateValidation({ application_visual: failed_status })
    }
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
