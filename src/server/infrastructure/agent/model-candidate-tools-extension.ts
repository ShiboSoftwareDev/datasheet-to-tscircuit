import { constants, realpathSync } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path"
import { Type } from "@earendil-works/pi-ai"
import {
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type ExtensionAPI,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent"
import { ProcessError } from "../process"
import {
  checkModelCandidate,
  MODEL_CANDIDATE_CHECK_RECEIPT_FILE,
  ModelCandidateCheckError,
  type ModelCandidateCheckReceipt,
} from "../../model-workflow/model-candidate-check"
import { executeLocalNgspice } from "../../spice-validation"

const ALLOWED_OUTPUTS = new Set(["model.lib", "model-card.md"])
const MAX_DIRECT_IMAGE_BYTES = 3 * 1024 * 1024
const MAX_DIRECT_TEXT_BYTES = 8 * 1024 * 1024
const MAX_CHECK_DIAGNOSTIC_CHARACTERS = 4_000
const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
}

function isWithin(root: string, candidate: string): boolean {
  const path_from_root = relative(root, candidate)
  return (
    path_from_root === "" ||
    (path_from_root !== ".." && !path_from_root.startsWith(`..${sep}`) && !isAbsolute(path_from_root))
  )
}

function assertLexicallyWithin(root: string, requested_path: string): string {
  const candidate = isAbsolute(requested_path) ? resolve(requested_path) : resolve(root, requested_path)
  if (!isWithin(root, candidate)) {
    throw new Error("Model-generation tools may only access files in the isolated candidate workspace")
  }
  return candidate
}

async function openReadableFile(root: string, requested_path: string) {
  const candidate = assertLexicallyWithin(root, requested_path)
  const path_from_root = relative(root, candidate)
  let current = root
  let candidate_metadata: Awaited<ReturnType<typeof lstat>> | undefined
  for (const [index, segment] of path_from_root.split(sep).filter(Boolean).entries()) {
    current = resolve(current, segment)
    const metadata = await lstat(current)
    if (metadata.isSymbolicLink()) {
      throw new Error("Model-generation tools may not read symbolic links")
    }
    const is_final_segment = index === path_from_root.split(sep).filter(Boolean).length - 1
    if (!is_final_segment && !metadata.isDirectory()) {
      throw new Error("Model-generation input path contains a non-directory component")
    }
    if (is_final_segment) candidate_metadata = metadata
  }
  const resolved_candidate = await realpath(candidate)
  if (!isWithin(root, resolved_candidate)) {
    throw new Error("Model-generation tools may not follow links outside the isolated candidate workspace")
  }
  if (!candidate_metadata?.isFile()) {
    throw new Error("Model-generation tools may only read regular files")
  }
  if (candidate_metadata.nlink !== 1) {
    throw new Error("Model-generation tools may not read hard-linked files")
  }
  const max_bytes = IMAGE_MIME_TYPES[extname(candidate).toLowerCase()]
    ? MAX_DIRECT_IMAGE_BYTES
    : MAX_DIRECT_TEXT_BYTES
  if (candidate_metadata.size > max_bytes) {
    throw new Error(`Model-generation file reads are limited to ${max_bytes} bytes`)
  }

  const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== candidate_metadata.dev || opened.ino !== candidate_metadata.ino) {
      throw new Error("Model-generation input changed while it was being opened")
    }
    if (opened.nlink !== 1) {
      throw new Error("Model-generation tools may not read hard-linked files")
    }
    if (opened.size > max_bytes) {
      throw new Error(`Model-generation file reads are limited to ${max_bytes} bytes`)
    }
    return { handle, size: opened.size }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

async function readWorkspaceFile(root: string, requested_path: string): Promise<Buffer> {
  const { handle, size } = await openReadableFile(root, requested_path)
  try {
    const bytes = Buffer.allocUnsafe(size + 1)
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset !== size) {
      throw new Error("Model-generation input changed while it was being read")
    }
    return Buffer.from(bytes.subarray(0, size))
  } finally {
    await handle.close()
  }
}

function resolveAllowedOutput(root: string, requested_path: string): string {
  const candidate = assertLexicallyWithin(root, requested_path)
  if (dirname(candidate) !== root || !ALLOWED_OUTPUTS.has(relative(root, candidate))) {
    throw new Error("Model generation may write only model.lib and model-card.md")
  }
  return candidate
}

async function writeOutputFile(root: string, requested_path: string, content: string): Promise<void> {
  const candidate = resolveAllowedOutput(root, requested_path)
  const parent = await realpath(dirname(candidate))
  if (parent !== root) throw new Error("Model output directory escaped the isolated candidate workspace")
  const existing = await lstat(candidate).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) {
    throw new Error("Model output must be a regular file, not a link or special file")
  }

  const handle = await open(candidate, constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.nlink !== 1) {
      throw new Error("Model output must be a single-link regular file")
    }
    await handle.truncate(0)
    await handle.writeFile(content, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeCheckReceipt(root: string, content: string): Promise<void> {
  const candidate = resolve(root, MODEL_CANDIDATE_CHECK_RECEIPT_FILE)
  const existing = await lstat(candidate).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) {
    throw new Error("Candidate check receipt must be a regular file")
  }
  const handle = await open(candidate, constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.nlink !== 1) {
      throw new Error("Candidate check receipt must be a single-link regular file")
    }
    await handle.truncate(0)
    await handle.writeFile(content, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export type ModelCandidateToolCheckResult =
  | ModelCandidateCheckReceipt
  | {
      readonly version: 1
      readonly status: "failed"
      readonly code: string
      readonly diagnostic: string
      readonly retryable: boolean
    }

type ModelCandidateToolChecker = (input: {
  workspace: string
  ngspice_path: string
  signal: AbortSignal
}) => Promise<ModelCandidateCheckReceipt>

function sanitizeCheckDiagnostic(error: unknown, workspace: string): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replaceAll(workspace, "<candidate>")
    .replace(/(?:\/[\w.@+-]+)+\/(model\.lib|model-card\.md|model-interface\.json)/g, "$1")
    .slice(0, MAX_CHECK_DIAGNOSTIC_CHARACTERS)
}

async function runProductionCandidateCheck(input: {
  workspace: string
  ngspice_path: string
  signal: AbortSignal
}): Promise<ModelCandidateCheckReceipt> {
  return (
    await checkModelCandidate({
      workspace: input.workspace,
      ngspice: executeLocalNgspice,
      ngspice_path: input.ngspice_path,
      signal: input.signal,
    })
  ).receipt
}

export function createModelCandidateFileTools(
  workspace: string,
  options: {
    ngspice_path?: string
    check_candidate?: ModelCandidateToolChecker
  } = {},
) {
  const root = realpathSync(workspace)
  const read_operations: ReadOperations = {
    access: async (requested_path) => {
      const { handle } = await openReadableFile(root, requested_path)
      await handle.close()
    },
    readFile: (requested_path) => readWorkspaceFile(root, requested_path),
    detectImageMimeType: async (requested_path) => {
      const candidate = assertLexicallyWithin(root, requested_path)
      const { handle } = await openReadableFile(root, candidate)
      await handle.close()
      return IMAGE_MIME_TYPES[extname(candidate).toLowerCase()]
    },
  }
  const write_operations: WriteOperations = {
    mkdir: async (requested_path) => {
      const candidate = assertLexicallyWithin(root, requested_path)
      if (candidate !== root) throw new Error("Model generation may not create directories")
    },
    writeFile: (requested_path, content) => writeOutputFile(root, requested_path, content),
  }
  const read_tool = createReadToolDefinition(root, {
    autoResizeImages: false,
    operations: read_operations,
  })
  const write_tool = createWriteToolDefinition(root, { operations: write_operations })
  const scoped_read_tool = {
    ...read_tool,
    name: "workspace_read" as const,
    label: "workspace_read",
    description:
      "Read a text or image file from the isolated model-candidate workspace. Paths outside the workspace and linked files are rejected.",
    promptSnippet: "Read declared inputs from the isolated model-candidate workspace",
    promptGuidelines: ["Use workspace_read to inspect declared candidate-workspace inputs."],
    execute: (...args: Parameters<typeof read_tool.execute>) => {
      // Pi normalizes convenient filename variants before delegating to custom
      // operations. Reject an out-of-workspace request lexically first so even
      // that normalization cannot probe ambient host paths.
      assertLexicallyWithin(root, args[1].path)
      return read_tool.execute(...args)
    },
  }
  const scoped_write_tool = {
    ...write_tool,
    name: "model_output_write" as const,
    label: "model_output_write",
    description:
      "Create or replace one declared model candidate output: model.lib or model-card.md. No other path is writable.",
    promptSnippet: "Write model.lib or model-card.md in the isolated candidate workspace",
    promptGuidelines: ["Use model_output_write only for model.lib and model-card.md."],
  }
  const check_candidate = options.check_candidate ?? runProductionCandidateCheck
  const candidate_check_tool = defineTool({
    name: "check_model_candidate",
    label: "check_model_candidate",
    description:
      "Validate the current model.lib and model-card.md against the public model interface and run the server's real ngspice candidate smoke harness. Takes no paths or commands and never reveals held-out validation data.",
    promptSnippet: "Check the current model candidate with the production contract and ngspice smoke gate",
    promptGuidelines: [
      "After writing model.lib and model-card.md, call check_model_candidate and correct any failed diagnostic before finishing.",
    ],
    parameters: Type.Object({}, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_tool_call_id, _parameters, signal) {
      const check_signal = signal ?? new AbortController().signal
      let result: ModelCandidateToolCheckResult
      try {
        result = await check_candidate({
          workspace: root,
          ngspice_path: options.ngspice_path ?? process.env.DATASHEET_MODEL_CHECK_NGSPICE_BIN ?? "ngspice",
          signal: check_signal,
        })
      } catch (error) {
        result = {
          version: 1,
          status: "failed",
          code:
            error instanceof ModelCandidateCheckError
              ? error.code
              : error instanceof ProcessError
                ? "candidate_check_unavailable"
                : "candidate_check_failed",
          diagnostic: sanitizeCheckDiagnostic(error, root),
          retryable: !(error instanceof ProcessError),
        }
      }
      await writeCheckReceipt(root, `${JSON.stringify(result, null, 2)}\n`)
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: result,
      }
    },
  })
  return [scoped_read_tool, scoped_write_tool, candidate_check_tool] as const
}

export default function registerModelCandidateTools(agent: ExtensionAPI): void {
  const [read_tool, write_tool, check_tool] = createModelCandidateFileTools(process.cwd())
  agent.registerTool(read_tool)
  agent.registerTool(write_tool)
  agent.registerTool(check_tool)
}
