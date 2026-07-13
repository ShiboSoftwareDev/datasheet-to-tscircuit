import { readdir, readFile } from "node:fs/promises"
import { delimiter, dirname, join } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import type { JobLogStream } from "@/shared/job-types"
import type { JobStore } from "./job-store"

export interface JobRunnerContext {
  job_store: JobStore
  agent_bin: string
  tsci_bin: string
}

interface StreamProcessInput {
  command: string[]
  cwd: string
  on_chunk: (stream: JobLogStream, message: string) => Promise<void>
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
  const inherited_path = process.env.PATH ?? ""
  const command_path = input.command[0]?.includes("/")
    ? `${dirname(input.command[0])}${delimiter}${inherited_path}`
    : inherited_path
  const child_process = Bun.spawn(input.command, {
    cwd: input.cwd,
    env: { ...process.env, PATH: command_path },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })

  await Promise.all([
    readProcessStream({ readable: child_process.stdout, stream: "stdout", on_chunk: input.on_chunk }),
    readProcessStream({ readable: child_process.stderr, stream: "stderr", on_chunk: input.on_chunk }),
  ])
  return child_process.exited
}

export function buildAgentPrompt(additional_instructions?: string): string {
  const user_context = additional_instructions?.trim()
    ? `\nAdditional context from the user:\n${additional_instructions.trim()}\n`
    : ""

  return `Convert datasheet.pdf into a production-quality tscircuit TSX component.

Read AGENTS.md first and follow it. Inspect the PDF carefully, including the pinout
tables and package mechanical drawings. Replace index.circuit.tsx with the final
default-exported component, then run tsci build index.circuit.tsx and correct any
generation errors. Do not stop at a prose report: the TSX file and a successful
preview build are the deliverables.${user_context}`
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

export async function runJob(
  input: { job_id: string; additional_instructions?: string },
  context: JobRunnerContext,
): Promise<void> {
  const job_dir = context.job_store.getJobDir(input.job_id)
  if (!job_dir) throw new Error(`Job ${input.job_id} was not found`)

  const append = async (stream: JobLogStream, message: string): Promise<void> => {
    await context.job_store.appendLog(input.job_id, stream, message)
  }

  try {
    context.job_store.updateJob(input.job_id, { display_status: "agent_running" })
    await append("system", "Starting tsci agent and streaming its complete process output…\n")

    const agent_exit_code = await streamProcess({
      command: [
        context.agent_bin,
        "do",
        "--prompt",
        buildAgentPrompt(input.additional_instructions),
        "--dir",
        job_dir,
      ],
      cwd: job_dir,
      on_chunk: append,
    })
    if (agent_exit_code !== 0) throw new Error(`tsci-agent exited with code ${agent_exit_code}`)

    const component_path = join(job_dir, "index.circuit.tsx")
    const component_code = await readFile(component_path, "utf8")
    if (!component_code.includes("export default")) {
      throw new Error("The agent did not create a default-exported TSX component")
    }

    context.job_store.updateJob(input.job_id, { display_status: "building" })
    await append("system", "\nAgent finished. Building the generated component with tsci…\n")

    const build_exit_code = await streamProcess({
      command: [context.tsci_bin, "build", "index.circuit.tsx", "--ignore-errors", "--ignore-warnings"],
      cwd: job_dir,
      on_chunk: append,
    })

    const circuit_json_path = await findCircuitJsonFile(join(job_dir, "dist"))
    if (!circuit_json_path) {
      throw new Error(`tsci build exited with code ${build_exit_code} and produced no Circuit JSON`)
    }

    const parsed_json: unknown = JSON.parse(await readFile(circuit_json_path, "utf8"))
    if (!isCircuitJson(parsed_json)) throw new Error("tsci produced invalid Circuit JSON")
    if (build_exit_code !== 0) {
      await append(
        "system",
        `Build exited with code ${build_exit_code}, but a preview artifact was produced.\n`,
      )
    }

    await append("system", "Component ready. Schematic and PCB previews are available.\n")
    context.job_store.updateJob(input.job_id, {
      display_status: "complete",
      is_complete: true,
      has_errors: false,
      completed_at: new Date().toISOString(),
      component_code,
      circuit_json: parsed_json,
    })
  } catch (error) {
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
