import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"
import type { TrustedAgentEvent } from "../agent-event-protocol"

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

export interface VisualInspectionImages {
  reference: string
  pcb?: string
  schematic: string
}

interface VisualInspectionInput {
  job_dir: string
  events: TrustedAgentEvent[]
  report_file: string
  build_command: string
  expected_images: VisualInspectionImages
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

export interface VisualInspectionSnapshot {
  images: Array<{ kind: string; path: string; sha256: string }>
}

function imageEntries(images: VisualInspectionImages): Array<[string, string]> {
  return Object.entries(images).flatMap(([kind, path]) =>
    typeof path === "string" ? [[kind, path] as [string, string]] : [],
  )
}

export async function captureVisualInspectionSnapshot(input: {
  job_dir: string
  expected_images: VisualInspectionImages
}): Promise<VisualInspectionSnapshot> {
  return {
    images: await Promise.all(
      imageEntries(input.expected_images).map(async ([kind, path]) => {
        const absolute_path = resolveInsideJob(input.job_dir, path)
        if (!absolute_path) {
          throw new Error(`Visual inspection image path escapes the job directory: ${path}`)
        }
        const bytes = await readFile(absolute_path)
        return { kind, path, sha256: createHash("sha256").update(bytes).digest("hex") }
      }),
    ),
  }
}

export async function assertVisualInspectionSnapshotMatches(input: {
  job_dir: string
  snapshot: VisualInspectionSnapshot
}): Promise<void> {
  const changed: string[] = []
  for (const image of input.snapshot.images) {
    const absolute_path = resolveInsideJob(input.job_dir, image.path)
    const bytes = absolute_path ? await readFile(absolute_path).catch(() => undefined) : undefined
    const digest = bytes ? createHash("sha256").update(bytes).digest("hex") : undefined
    if (digest !== image.sha256) changed.push(image.path)
  }
  if (changed.length > 0) {
    throw new VisualInspectionInconclusiveError(
      `Authoritative server build did not reproduce the agent-inspected image(s): ${changed.join(", ")}`,
    )
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
  if (/[;&|`$<>]/.test(command)) return false
  const normalized_command = command.replace(
    /^(?:env\s+)?NODE_ENV=(?:development|"development"|'development')\s+/,
    "",
  )
  const local_command = expected_command.replace(/^tsci(?=\s|$)/, "./node_modules/.bin/tsci")
  const unprefixed_local_command = expected_command.replace(/^tsci(?=\s|$)/, "node_modules/.bin/tsci")
  return [
    expected_command,
    `npx ${expected_command}`,
    `bunx ${expected_command}`,
    local_command,
    unprefixed_local_command,
  ].some((candidate) => normalized_command === candidate || normalized_command.startsWith(`${candidate} `))
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
    /image omitted: (?:model does not support images|could not be (?:resized|converted)[^\n]*)|current model does not support images|no pixels present|(?:unable|cannot|can't) to (?:see|inspect|view)|vision (?:is )?unavailable/i,
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
  allow_identical_copies?: boolean
}): Promise<void> {
  const vision_failure = hasVisionFailure(input.events)
  if (vision_failure) {
    throw new VisualInspectionInconclusiveError(`Image inspection was unavailable: ${vision_failure}`)
  }
  const image_read_paths = getSuccessfulImageReadPaths({
    job_dir: input.job_dir,
    events: input.events,
    after_sequence: input.after_sequence,
  })
  const image_reads = new Set(image_read_paths)
  for (const expected_path of input.expected_images) {
    const absolute_expected = resolveInsideJob(input.job_dir, expected_path)
    if (!absolute_expected) {
      throw new Error(`Visual inspection image path escapes the job directory: ${expected_path}`)
    }
    await validatePng(absolute_expected)
    if (image_reads.has(absolute_expected)) continue

    if (!input.allow_identical_copies) {
      throw new VisualInspectionInconclusiveError(`${expected_path} was not successfully inspected as pixels`)
    }

    const expected_bytes = await readFile(absolute_expected)
    let inspected_identical_copy = false
    for (const read_path of image_read_paths) {
      const candidate_path = resolveInsideJob(input.job_dir, read_path)
      if (!candidate_path) continue
      const candidate_bytes = await readFile(candidate_path).catch(() => undefined)
      if (candidate_bytes?.equals(expected_bytes)) {
        inspected_identical_copy = true
        break
      }
    }
    if (!inspected_identical_copy) {
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

  const reportedImagePath = (kind: string): unknown =>
    report[`${kind}_image`] ?? (kind === "pcb" || kind === "schematic" ? report[`${kind}_render`] : undefined)
  if (!input.expected_images.pcb && reportedImagePath("pcb") !== undefined) {
    throw new Error(`${input.report_file} must omit pcb_image when no PCB output is authorized`)
  }
  for (const [kind, expected_path] of imageEntries(input.expected_images)) {
    const reported_path = reportedImagePath(kind)
    if (report.status === "passed" && reported_path !== expected_path) {
      throw new Error(`${input.report_file} must set ${kind}_image to ${expected_path}`)
    }
    if (reported_path !== undefined && reported_path !== expected_path) {
      throw new Error(`${input.report_file} must set ${kind}_image to ${expected_path}`)
    }
    const absolute_expected = resolveInsideJob(input.job_dir, expected_path)
    if (!absolute_expected) {
      throw new Error(`Visual inspection image path escapes the job directory: ${expected_path}`)
    }
    await validatePng(absolute_expected)
  }

  const writeCanonicalReport = async (): Promise<void> => {
    await Bun.write(
      report_path,
      `${JSON.stringify(
        {
          version: 1,
          status: report.status,
          basis: "agent_visual_attestation",
          ...Object.fromEntries(
            imageEntries(input.expected_images).map(([kind, path]) => [`${kind}_image`, path]),
          ),
          ...(typeof report.notes === "string" ? { notes: report.notes } : {}),
        },
        null,
        2,
      )}\n`,
    )
  }

  if (report.status === "inconclusive") {
    await writeCanonicalReport()
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

  try {
    await validateAgentImageReads({
      job_dir: input.job_dir,
      events: input.events,
      expected_images: imageEntries(input.expected_images).map(([, path]) => path),
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
  await writeCanonicalReport()
  return { status: "passed" }
}
