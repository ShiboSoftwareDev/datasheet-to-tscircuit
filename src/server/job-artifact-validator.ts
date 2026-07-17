import { readFile } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import type { TrustedAgentEvent } from "./agent-event-protocol"

export interface ExpectedApplicationConnection {
  net: string
  pins: string[]
}

export interface ApplicationConnectivityPlan {
  components: Array<{ reference: string; kind?: string; value?: string }>
  connections: ExpectedApplicationConnection[]
}

export interface ExpectedFootprintPad {
  pin: string
  kind: "smt" | "plated_hole"
  x: number
  y: number
  width: number
  height: number
  hole_width?: number
  hole_height?: number
}

export interface FootprintPlan {
  version: 1
  view: "pcb_top"
  source_references: Array<{ page: number; figure?: string }>
  pads: ExpectedFootprintPad[]
}

type CircuitRecord = AnyCircuitElement & Record<string, unknown>

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

function asRecord(element: AnyCircuitElement): CircuitRecord {
  return element as CircuitRecord
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function normalizedPin(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^pin(?=\d+$)/, "")
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

interface ActualFootprintPad {
  pins: string[]
  kind: "smt" | "plated_hole"
  x: number
  y: number
  width: number
  height: number
  hole_width?: number
  hole_height?: number
}

function getActualFootprintPads(circuit_json: AnyCircuitElement[]): ActualFootprintPad[] {
  return circuit_json.flatMap<ActualFootprintPad>((element): ActualFootprintPad[] => {
    const record = asRecord(element)
    if (record.type !== "pcb_smtpad" && record.type !== "pcb_plated_hole") return []
    const hints = asStringArray(record.port_hints)
    if (hints.length === 0) return []
    const x = finiteNumber(record.x)
    const y = finiteNumber(record.y)
    if (x === undefined || y === undefined) return []

    if (record.type === "pcb_smtpad") {
      const width = finiteNumber(record.width)
      const height = finiteNumber(record.height)
      if (width === undefined || height === undefined) return []
      return [{ pins: hints.map(normalizedPin), kind: "smt" as const, x, y, width, height }]
    }

    let width: number | undefined
    let height: number | undefined
    let hole_width: number | undefined
    let hole_height: number | undefined
    if (record.shape === "circle") {
      width = height = finiteNumber(record.outer_diameter)
      hole_width = hole_height = finiteNumber(record.hole_diameter)
    } else if (record.shape === "circular_hole_with_rect_pad") {
      width = finiteNumber(record.rect_pad_width)
      height = finiteNumber(record.rect_pad_height)
      hole_width = hole_height = finiteNumber(record.hole_diameter)
    } else {
      width = finiteNumber(record.rect_pad_width)
      height = finiteNumber(record.rect_pad_height)
      hole_width = finiteNumber(record.hole_width)
      hole_height = finiteNumber(record.hole_height)
    }
    if (
      width === undefined ||
      height === undefined ||
      hole_width === undefined ||
      hole_height === undefined
    ) {
      return []
    }
    return [
      {
        pins: hints.map(normalizedPin),
        kind: "plated_hole" as const,
        x,
        y,
        width,
        height,
        hole_width,
        hole_height,
      },
    ]
  })
}

function closeEnough(actual: number, expected: number, tolerance_mm: number): boolean {
  return Math.abs(actual - expected) <= tolerance_mm
}

export function getFootprintPlanErrors(
  plan: FootprintPlan,
  circuit_json: AnyCircuitElement[],
  tolerance_mm = 0.02,
): string[] {
  const errors: string[] = []
  const actual_pads = getActualFootprintPads(circuit_json)
  if (actual_pads.length !== plan.pads.length) {
    errors.push(`Expected ${plan.pads.length} footprint pads, found ${actual_pads.length}`)
  }
  const unmatched = new Set(actual_pads.map((_, index) => index))
  for (const expected of plan.pads) {
    const candidate_indices = [...unmatched].filter(
      (index) =>
        actual_pads[index]!.pins.includes(normalizedPin(expected.pin)) &&
        actual_pads[index]!.kind === expected.kind,
    )
    if (candidate_indices.length === 0) {
      errors.push(`Expected ${expected.kind} pad for pin ${expected.pin} is missing`)
      continue
    }
    candidate_indices.sort((left, right) => {
      const left_pad = actual_pads[left]!
      const right_pad = actual_pads[right]!
      const distance = (pad: ActualFootprintPad) =>
        Math.abs(pad.x - expected.x) +
        Math.abs(pad.y - expected.y) +
        Math.abs(pad.width - expected.width) +
        Math.abs(pad.height - expected.height)
      return distance(left_pad) - distance(right_pad)
    })
    const selected_index = candidate_indices[0]!
    const actual = actual_pads[selected_index]!
    unmatched.delete(selected_index)
    const mismatches: string[] = []
    for (const [label, actual_value, expected_value] of [
      ["x", actual.x, expected.x],
      ["y", actual.y, expected.y],
      ["width", actual.width, expected.width],
      ["height", actual.height, expected.height],
    ] as const) {
      if (!closeEnough(actual_value, expected_value, tolerance_mm)) {
        mismatches.push(`${label} ${actual_value} mm (expected ${expected_value} mm)`)
      }
    }
    if (expected.kind === "plated_hole") {
      for (const [label, actual_value, expected_value] of [
        ["hole width", actual.hole_width, expected.hole_width],
        ["hole height", actual.hole_height, expected.hole_height],
      ] as const) {
        if (
          actual_value === undefined ||
          expected_value === undefined ||
          !closeEnough(actual_value, expected_value, tolerance_mm)
        ) {
          mismatches.push(
            `${label} ${actual_value ?? "missing"} mm (expected ${expected_value ?? "missing"} mm)`,
          )
        }
      }
    }
    if (mismatches.length > 0) errors.push(`Pin ${expected.pin}: ${mismatches.join(", ")}`)
  }
  for (const index of unmatched) {
    const pad = actual_pads[index]!
    errors.push(`Unexpected ${pad.kind} pad for pin ${pad.pins.join("/")} at (${pad.x}, ${pad.y}) mm`)
  }
  return errors
}

interface ResolvedPort {
  id: string
}

function resolveExpectedPort(
  endpoint: string,
  components_by_name: Map<string, CircuitRecord>,
  ports_by_component_id: Map<string, CircuitRecord[]>,
): ResolvedPort | string {
  const separator = endpoint.indexOf(".")
  if (separator < 1 || separator === endpoint.length - 1) {
    return `Expected pin ${JSON.stringify(endpoint)} must use component.port syntax`
  }
  const component_name = endpoint.slice(0, separator).trim().toLowerCase()
  const port_name = endpoint
    .slice(separator + 1)
    .trim()
    .toLowerCase()
  const component = components_by_name.get(component_name)
  if (!component || typeof component.source_component_id !== "string") {
    return `Expected pin ${JSON.stringify(endpoint)} references missing component ${JSON.stringify(
      endpoint.slice(0, separator),
    )}`
  }
  const matches = (ports_by_component_id.get(component.source_component_id) ?? []).filter((port) => {
    const aliases = new Set<string>()
    if (typeof port.name === "string") aliases.add(port.name.toLowerCase())
    if (typeof port.pin_number === "number") {
      aliases.add(String(port.pin_number))
      aliases.add(`pin${port.pin_number}`)
    }
    for (const hint of asStringArray(port.port_hints)) aliases.add(hint.toLowerCase())
    return aliases.has(port_name)
  })
  if (matches.length !== 1 || typeof matches[0]?.source_port_id !== "string") {
    return `Expected pin ${JSON.stringify(endpoint)} resolved to ${matches.length} source ports`
  }
  return { id: matches[0].source_port_id }
}

class PortConnectivity {
  private readonly parent = new Map<string, string>()

  add(id: string): void {
    if (!this.parent.has(id)) this.parent.set(id, id)
  }

  find(id: string): string {
    this.add(id)
    const parent = this.parent.get(id) as string
    if (parent === id) return id
    const root = this.find(parent)
    this.parent.set(id, root)
    return root
  }

  connect(ids: string[]): void {
    const first = ids[0]
    if (!first) return
    const root = this.find(first)
    for (const id of ids.slice(1)) this.parent.set(this.find(id), root)
  }
}

export function getTypicalApplicationConnectivityErrors(
  plan: ApplicationConnectivityPlan,
  circuit_json: AnyCircuitElement[],
): string[] {
  const errors: string[] = []
  const records = circuit_json.map(asRecord)
  const source_components = records.filter((element) => element.type === "source_component")
  const source_ports = records.filter((element) => element.type === "source_port")
  const components_by_name = new Map<string, CircuitRecord>()
  for (const component of source_components) {
    if (typeof component.name === "string") components_by_name.set(component.name.toLowerCase(), component)
  }
  for (const expected_component of plan.components) {
    if (!components_by_name.has(expected_component.reference.toLowerCase())) {
      errors.push(`Expected application component ${expected_component.reference} is missing`)
    }
  }

  const ports_by_component_id = new Map<string, CircuitRecord[]>()
  const connectivity = new PortConnectivity()
  const ports_by_connectivity_key = new Map<string, string[]>()
  for (const port of source_ports) {
    if (typeof port.source_port_id !== "string" || typeof port.source_component_id !== "string") continue
    connectivity.add(port.source_port_id)
    const component_ports = ports_by_component_id.get(port.source_component_id) ?? []
    component_ports.push(port)
    ports_by_component_id.set(port.source_component_id, component_ports)
    if (typeof port.subcircuit_connectivity_map_key === "string") {
      const connected_ports = ports_by_connectivity_key.get(port.subcircuit_connectivity_map_key) ?? []
      connected_ports.push(port.source_port_id)
      ports_by_connectivity_key.set(port.subcircuit_connectivity_map_key, connected_ports)
    }
  }
  for (const connected_ports of ports_by_connectivity_key.values()) connectivity.connect(connected_ports)
  for (const trace of records.filter((element) => element.type === "source_trace")) {
    connectivity.connect(asStringArray(trace.connected_source_port_ids))
  }

  const actual_root_by_expected_net = new Map<string, string>()
  for (const connection of plan.connections) {
    const resolved_ports: ResolvedPort[] = []
    for (const endpoint of connection.pins) {
      const resolved = resolveExpectedPort(endpoint, components_by_name, ports_by_component_id)
      if (typeof resolved === "string") errors.push(`${connection.net}: ${resolved}`)
      else resolved_ports.push(resolved)
    }
    if (resolved_ports.length !== connection.pins.length) continue
    const roots = new Set(resolved_ports.map((port) => connectivity.find(port.id)))
    if (roots.size !== 1) {
      errors.push(
        `${connection.net}: expected pins are not electrically connected: ${connection.pins.join(", ")}`,
      )
      continue
    }
    const root = [...roots][0] as string
    const collapsed_net = [...actual_root_by_expected_net.entries()].find(
      ([, other_root]) => other_root === root,
    )
    if (collapsed_net) {
      errors.push(`${connection.net}: unexpectedly shorted to expected net ${collapsed_net[0]}`)
    } else {
      actual_root_by_expected_net.set(connection.net, root)
    }
  }
  return errors
}

const SI_PREFIXES: Record<string, number> = {
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  µ: 1e-6,
  m: 1e-3,
  "": 1,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
}

function parseEngineeringValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value !== "string") return undefined
  const normalized = value
    .trim()
    .replace(/\s+/g, "")
    .replace(/ohms?|Ω/gi, "")
  const match = normalized.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)([pnuµmkKMG]?)(?:[FfHh])?$/)
  if (!match) return undefined
  const amount = Number(match[1])
  const multiplier = SI_PREFIXES[match[2] ?? ""]
  return Number.isFinite(amount) && multiplier !== undefined ? amount * multiplier : undefined
}

function componentValueField(kind: string): "resistance" | "capacitance" | "inductance" | undefined {
  const normalized = kind.toLowerCase()
  if (normalized.includes("resistor")) return "resistance"
  if (normalized.includes("capacitor")) return "capacitance"
  if (normalized.includes("inductor")) return "inductance"
  return undefined
}

export function getTypicalApplicationComponentValueErrors(
  plan: ApplicationConnectivityPlan,
  circuit_json: AnyCircuitElement[],
): string[] {
  const records = circuit_json.map(asRecord)
  const components_by_name = new Map<string, CircuitRecord>()
  for (const component of records.filter((element) => element.type === "source_component")) {
    if (typeof component.name === "string") components_by_name.set(component.name.toLowerCase(), component)
  }
  const errors: string[] = []
  for (const expected of plan.components) {
    if (!expected.kind || !expected.value) continue
    const field = componentValueField(expected.kind)
    if (!field) continue
    const component = components_by_name.get(expected.reference.toLowerCase())
    if (!component) continue
    const expected_value = parseEngineeringValue(expected.value)
    const actual_value = parseEngineeringValue(component[field])
    if (expected_value === undefined) {
      errors.push(`Expected value ${JSON.stringify(expected.value)} for ${expected.reference} is not numeric`)
      continue
    }
    if (actual_value === undefined) {
      errors.push(`Application component ${expected.reference} has no ${field}`)
      continue
    }
    const relative_error = Math.abs(actual_value - expected_value) / Math.max(Math.abs(expected_value), 1e-18)
    if (relative_error > 0.001) {
      errors.push(
        `Application component ${expected.reference} has ${field} ${actual_value}, expected ${expected.value}`,
      )
    }
  }
  return errors
}

interface VisualInspectionInput {
  job_dir: string
  events: TrustedAgentEvent[]
  report_file: string
  build_command: string
  expected_images: {
    reference: string
    pcb: string
    schematic: string
  }
}

export interface VisualInspectionResult {
  status: "passed" | "inconclusive"
}

export class VisualInspectionInconclusiveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "VisualInspectionInconclusiveError"
  }
}

function resolveInsideJob(job_dir: string, image_path: string): string | undefined {
  const absolute_path = resolve(job_dir, image_path)
  const relative_path = relative(resolve(job_dir), absolute_path)
  if (
    relative_path === "" ||
    relative_path === ".." ||
    relative_path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    return undefined
  }
  return absolute_path
}

async function validatePng(path: string): Promise<void> {
  const bytes = await readFile(path)
  if (bytes.length < 24 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    throw new Error(`${path} is not a valid PNG image`)
  }
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (width < 1 || height < 1) throw new Error(`${path} has invalid PNG dimensions`)
}

interface CompletedToolCall {
  start: Extract<TrustedAgentEvent, { type: "tool_start" }>
  end: Extract<TrustedAgentEvent, { type: "tool_end" }>
}

function getCompletedToolCalls(events: TrustedAgentEvent[]): CompletedToolCall[] {
  const starts = new Map<string, Extract<TrustedAgentEvent, { type: "tool_start" }>>()
  const calls: CompletedToolCall[] = []
  for (const event of events) {
    if (event.type === "tool_start") starts.set(event.tool_call_id, event)
    if (event.type !== "tool_end") continue
    const start = starts.get(event.tool_call_id)
    if (!start || start.tool_name !== event.tool_name || event.sequence <= start.sequence) continue
    calls.push({ start, end: event })
  }
  return calls
}

function recordString(value: unknown, key: string): string | undefined {
  return typeof value === "object" &&
    value !== null &&
    key in value &&
    typeof (value as Record<string, unknown>)[key] === "string"
    ? ((value as Record<string, unknown>)[key] as string)
    : undefined
}

function commandText(args: unknown): string {
  const command = recordString(args, "command")
  if (command) return command
  return JSON.stringify(args)
}

function isExpectedBuildCommand(args: unknown, expected_command: string): boolean {
  const command = commandText(args).trim()
  if (command !== expected_command && !command.startsWith(`${expected_command} `)) return false
  return !/[;&|`$<>]/.test(command)
}

function isAllowedSchematicRender(input: {
  args: unknown
  job_dir: string
  expected_schematic_png: string
}): boolean {
  const command = commandText(input.args).trim()
  const match = command.match(/^bun\s+(?:\.\/)?render-svg-to-png\.ts\s+(["']?)([^\s;&|`$<>]+\.svg)\1$/)
  if (!match) return false
  const svg_path = resolveToolPath(input.job_dir, match[2] as string)
  const png_path = resolveToolPath(input.job_dir, input.expected_schematic_png)
  return dirname(svg_path) === dirname(png_path)
}

function hasVisionFailure(events: TrustedAgentEvent[]): string | undefined {
  const text = events
    .flatMap((event) => {
      if (event.type === "text_delta" || event.type === "thinking_delta") return [event.text]
      if (event.type === "tool_end" && event.result_text) return [event.result_text]
      return []
    })
    .join("\n")
  return text.match(
    /image omitted: model does not support images|current model does not support images|no pixels present|(?:unable|cannot|can't) to (?:see|inspect|view)|vision (?:is )?unavailable/i,
  )?.[0]
}

function resolveToolPath(job_dir: string, path: string): string {
  return resolve(job_dir, path)
}

export function getSuccessfulImageReadPaths(input: {
  job_dir: string
  events: TrustedAgentEvent[]
  after_sequence?: number
}): string[] {
  return getCompletedToolCalls(input.events).flatMap(({ start, end }) => {
    if (
      start.tool_name !== "read" ||
      end.is_error ||
      !end.result_has_image ||
      start.sequence <= (input.after_sequence ?? 0)
    ) {
      return []
    }
    const path = recordString(start.args, "path")
    return path ? [resolveToolPath(input.job_dir, path)] : []
  })
}

export async function validateAgentImageReads(input: {
  job_dir: string
  events: TrustedAgentEvent[]
  expected_images: string[]
  after_sequence?: number
}): Promise<void> {
  const vision_failure = hasVisionFailure(input.events)
  if (vision_failure) {
    throw new VisualInspectionInconclusiveError(`Visual inspection was inconclusive: ${vision_failure}`)
  }
  const image_reads = new Set(
    getSuccessfulImageReadPaths({
      job_dir: input.job_dir,
      events: input.events,
      after_sequence: input.after_sequence,
    }),
  )
  for (const expected_path of input.expected_images) {
    const absolute_expected = resolveInsideJob(input.job_dir, expected_path)
    if (!absolute_expected) {
      throw new Error(`Visual inspection image path escapes the job directory: ${expected_path}`)
    }
    await validatePng(absolute_expected)
    if (!image_reads.has(absolute_expected)) {
      throw new VisualInspectionInconclusiveError(`${expected_path} was not successfully inspected as pixels`)
    }
  }
}

export async function validateVisualInspection(
  input: VisualInspectionInput,
): Promise<VisualInspectionResult> {
  const report_path = resolveInsideJob(input.job_dir, input.report_file)
  if (!report_path) throw new Error(`Visual inspection report path escapes the job directory`)
  const report_value: unknown = JSON.parse(await readFile(report_path, "utf8"))
  if (typeof report_value !== "object" || report_value === null || Array.isArray(report_value)) {
    throw new Error(`${input.report_file} must contain a JSON object`)
  }
  const report = report_value as Record<string, unknown>
  if (report.version !== 1 || (report.status !== "passed" && report.status !== "inconclusive")) {
    throw new Error(`${input.report_file} must record version 1 with a valid inspection status`)
  }

  for (const [kind, expected_path] of Object.entries(input.expected_images)) {
    const reported_path = report[`${kind}_image`]
    if (reported_path !== undefined && reported_path !== expected_path) {
      throw new Error(`${input.report_file} must set ${kind}_image to ${expected_path}`)
    }
    const absolute_expected = resolveInsideJob(input.job_dir, expected_path)
    if (!absolute_expected) {
      throw new Error(`Visual inspection image path escapes the job directory: ${expected_path}`)
    }
    await validatePng(absolute_expected)
  }

  if (report.status === "inconclusive") {
    return { status: "inconclusive" }
  }

  const calls = getCompletedToolCalls(input.events)
  const successful_builds = calls.filter(
    ({ start, end }) =>
      start.tool_name === "bash" && !end.is_error && isExpectedBuildCommand(start.args, input.build_command),
  )
  const final_build = successful_builds.at(-1)
  if (!final_build) {
    throw new Error(`Visual inspection evidence is missing final build command: ${input.build_command}`)
  }
  const final_build_sequence = final_build.end.sequence
  const disallowed_after_build = calls.find(({ start, end }) => {
    if (end.sequence <= final_build_sequence || end.is_error) return false
    if (start.tool_name === "bash") {
      return !isAllowedSchematicRender({
        args: start.args,
        job_dir: input.job_dir,
        expected_schematic_png: input.expected_images.schematic,
      })
    }
    if (start.tool_name !== "write" && start.tool_name !== "edit") return false
    const path = recordString(start.args, "path")
    return !path || resolveToolPath(input.job_dir, path) !== resolve(input.job_dir, input.report_file)
  })
  if (disallowed_after_build) {
    throw new Error(
      `Visual inspection is stale because ${disallowed_after_build.start.tool_name} modified the workspace after the final build`,
    )
  }

  for (const [kind, expected_path] of Object.entries(input.expected_images)) {
    if (report[`${kind}_image`] !== expected_path) {
      throw new Error(`${input.report_file} must set ${kind}_image to ${expected_path}`)
    }
  }
  try {
    await validateAgentImageReads({
      job_dir: input.job_dir,
      events: input.events,
      expected_images: Object.values(input.expected_images),
      after_sequence: final_build_sequence,
    })
  } catch (error) {
    if (error instanceof VisualInspectionInconclusiveError) {
      throw new Error(
        `${input.report_file} claimed passed without conclusive pixel inspection: ${error.message}`,
      )
    }
    throw error
  }
  return { status: "passed" }
}
