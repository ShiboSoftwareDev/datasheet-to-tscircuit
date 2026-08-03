import { createHash } from "node:crypto"
import { constants, realpathSync } from "node:fs"
import { lstat, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises"
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
import { BunProcessRunner } from "../process"
import {
  checkModelCandidate,
  MODEL_CANDIDATE_CHECK_RECEIPT_FILE,
  ModelCandidateCheckError,
  type ModelCandidateCheckReceipt,
} from "../../model-workflow/model-candidate-check"
import {
  createModelTrainingValidationReport,
  type ModelTrainingValidationReport,
} from "../../model-workflow/model-training-validation"
import {
  createModelTrainingCheckReceipt,
  MODEL_TRAINING_CHECK_RECEIPT_FILE,
  readModelTrainingCheckReceipt,
  type ModelTrainingCheckReceipt,
} from "../../model-workflow/model-training-check"
import {
  createModelTrainingCandidateQuality,
  ModelCandidateSearchSession,
  modelCandidateTopologyFingerprint,
  type ModelCandidateSearchSnapshot,
} from "../../model-workflow/model-candidate-search"
import {
  replaceModelFitParameters,
  scoreModelFitValidation,
  searchModelParameters,
  type ModelFitParameterRange,
  type ModelParameterSearchResult,
} from "../../model-workflow/model-parameter-fit"
import { buildValidationCircuitPreviews } from "../../model-workflow/validation-circuit-previews"
import { parseFreshModelContract } from "../../modeling"
import { executeLocalNgspice, parseValidationPlan, runSpiceValidation } from "../../spice-validation"

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

async function writeTrustedReceipt(root: string, filename: string, content: string): Promise<void> {
  const candidate = resolve(root, filename)
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
  | (ModelCandidateCheckReceipt & {
      readonly training_validation?: ModelTrainingValidationReport
      readonly search_control?: ModelCandidateSearchControlReport
    })
  | {
      readonly version: 1
      readonly status: "failed"
      readonly code: string
      readonly diagnostic: string
      readonly retryable: boolean
      readonly candidate?: ModelCandidateCheckReceipt
      readonly training_validation?: ModelTrainingValidationReport
      readonly search_control?: ModelCandidateSearchControlReport
    }

interface ModelCandidateSearchControlReport {
  readonly disposition: "initial" | "improved" | "retained" | "budget_exhausted"
  readonly diagnostic: string
  readonly checks: number
  readonly fit_calls: number
  readonly fit_evaluations: number
  readonly topology_count: number
  readonly remaining_checks: number
  readonly remaining_fit_calls: number
  readonly remaining_fit_evaluations: number
}

type ModelCandidateToolChecker = (input: {
  workspace: string
  ngspice_path: string
  signal: AbortSignal
}) => Promise<ModelCandidateCheckReceipt>

type ModelTrainingValidator = (input: {
  workspace: string
  ngspice_path: string
  tsci_path: string
  signal: AbortSignal
}) => Promise<ModelTrainingValidationReport>

type ModelParameterFitter = (input: {
  workspace: string
  ngspice_path: string
  parameters: readonly ModelFitParameterRange[]
  max_evaluations: number
  signal: AbortSignal
}) => Promise<ModelParameterSearchResult>

type ModelParameterFitToolResult =
  | ({
      readonly version: 1
      readonly status: "completed"
      readonly search_control?: ModelCandidateSearchControlReport
    } & ModelParameterSearchResult)
  | {
      readonly version: 1
      readonly status: "failed"
      readonly diagnostic: string
      readonly search_control?: ModelCandidateSearchControlReport
    }

function sanitizeCheckDiagnostic(error: unknown, workspace: string): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replaceAll(workspace, "<candidate>")
    .replace(/<candidate>[\\/](model\.lib|model-card\.md|model-interface\.json)/g, "$1")
    .replace(/(?:\/[\w.@+-]+)+\/(model\.lib|model-card\.md|model-interface\.json)/g, "$1")
    .slice(0, MAX_CHECK_DIAGNOSTIC_CHARACTERS)
}

async function readOptionalFreshModelContract(workspace: string) {
  try {
    return parseFreshModelContract(
      JSON.parse(await readFile(resolve(workspace, "model-contract.json"), "utf8")),
    )
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined
    }
    throw error
  }
}

async function runProductionCandidateCheck(input: {
  workspace: string
  ngspice_path: string
  signal: AbortSignal
}): Promise<ModelCandidateCheckReceipt> {
  const contract = await readOptionalFreshModelContract(input.workspace)
  return (
    await checkModelCandidate({
      workspace: input.workspace,
      ...(contract ? { model_contract: contract } : {}),
      ngspice: executeLocalNgspice,
      ngspice_path: input.ngspice_path,
      signal: input.signal,
    })
  ).receipt
}

async function runProductionTrainingValidation(input: {
  workspace: string
  ngspice_path: string
  tsci_path: string
  signal: AbortSignal
}): Promise<ModelTrainingValidationReport> {
  const contract = parseFreshModelContract(
    JSON.parse(await readFile(resolve(input.workspace, "model-contract.json"), "utf8")),
  )
  const checked = await checkModelCandidate({
    workspace: input.workspace,
    model_contract: contract,
    ngspice: executeLocalNgspice,
    ngspice_path: input.ngspice_path,
    signal: input.signal,
  })
  const plan = parseValidationPlan(
    JSON.parse(await readFile(resolve(input.workspace, "model-training-plan.json"), "utf8")),
    {
      manifest: checked.generated.manifest,
      model_requirements: contract.characterization.requirements,
      model_source: checked.generated.source,
      model_family: contract.characterization.family,
      application_fixture: contract.application_fixture,
    },
  )
  const artifact_directory = await mkdtemp(resolve(input.workspace, ".candidate-training-"))
  try {
    const server = await runSpiceValidation({
      plan,
      manifest: checked.generated.manifest,
      model_source: checked.generated.source,
      model_dir: input.workspace,
      model_contract: contract,
      artifact_directory,
      signal: input.signal,
      ngspice: executeLocalNgspice,
      ngspice_path: input.ngspice_path,
    })
    const viewer = await buildValidationCircuitPreviews({
      model_dir: input.workspace,
      plan,
      generated: checked.generated,
      tsci_bin: input.tsci_path,
      process_runner: new BunProcessRunner(),
      signal: input.signal,
      append: () => undefined,
    })
    return createModelTrainingValidationReport({
      plan,
      server_cases: server.cases,
      server_passed: server.passed,
      server_error_codes: server.errors.map(({ code }) => code),
      viewer_validation_by_case: viewer.viewer_validation_by_case,
      viewer_errors_by_case: viewer.errors_by_case,
      viewer_model_errors_by_case: viewer.viewer_model_errors_by_case,
    })
  } finally {
    await rm(artifact_directory, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function runProductionParameterFit(input: {
  workspace: string
  ngspice_path: string
  parameters: readonly ModelFitParameterRange[]
  max_evaluations: number
  signal: AbortSignal
}): Promise<ModelParameterSearchResult> {
  const contract = parseFreshModelContract(
    JSON.parse(await readFile(resolve(input.workspace, "model-contract.json"), "utf8")),
  )
  const checked = await checkModelCandidate({
    workspace: input.workspace,
    model_contract: contract,
    ngspice: executeLocalNgspice,
    ngspice_path: input.ngspice_path,
    signal: input.signal,
  })
  const plan = parseValidationPlan(
    JSON.parse(await readFile(resolve(input.workspace, "model-training-plan.json"), "utf8")),
    {
      manifest: checked.generated.manifest,
      model_requirements: contract.characterization.requirements,
      model_source: checked.generated.source,
      model_family: contract.characterization.family,
      application_fixture: contract.application_fixture,
    },
  )
  const artifact_directory = await mkdtemp(resolve(input.workspace, ".candidate-fit-"))
  const original_source = checked.generated.source
  try {
    const result = await searchModelParameters({
      source: original_source,
      ranges: input.parameters,
      max_evaluations: input.max_evaluations,
      signal: input.signal,
      evaluate: async (model_source) => {
        const validation = await runSpiceValidation({
          plan,
          manifest: checked.generated.manifest,
          model_source,
          model_dir: input.workspace,
          model_contract: contract,
          artifact_directory,
          signal: input.signal,
          ngspice: executeLocalNgspice,
          ngspice_path: input.ngspice_path,
        })
        return scoreModelFitValidation(validation)
      },
    })
    const best_source = replaceModelFitParameters(original_source, result.best.values)
    await writeOutputFile(input.workspace, "model.lib", best_source)
    try {
      await checkModelCandidate({
        workspace: input.workspace,
        model_contract: contract,
        ngspice: executeLocalNgspice,
        ngspice_path: input.ngspice_path,
        signal: input.signal,
      })
    } catch (error) {
      await writeOutputFile(input.workspace, "model.lib", original_source)
      throw error
    }
    return result
  } finally {
    await Promise.all([
      rm(artifact_directory, { recursive: true, force: true }).catch(() => undefined),
      rm(resolve(input.workspace, MODEL_CANDIDATE_CHECK_RECEIPT_FILE), { force: true }).catch(
        () => undefined,
      ),
      rm(resolve(input.workspace, MODEL_TRAINING_CHECK_RECEIPT_FILE), { force: true }).catch(() => undefined),
    ])
  }
}

function sourceRevision(source: string): string {
  return createHash("sha256").update(source.replace(/\r\n?/g, "\n").trim()).digest("hex").slice(0, 16)
}

function textSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function searchControlReport(input: {
  search: ModelCandidateSearchSession
  disposition: ModelCandidateSearchControlReport["disposition"]
  diagnostic: string
}): ModelCandidateSearchControlReport {
  return { disposition: input.disposition, diagnostic: input.diagnostic, ...input.search.summary }
}

function resultFromSnapshot(
  snapshot: ModelCandidateSearchSnapshot,
  search_control: ModelCandidateSearchControlReport,
): ModelCandidateToolCheckResult {
  const receipt = JSON.parse(snapshot.training_receipt) as ModelTrainingCheckReceipt
  return receipt.status === "passed"
    ? { ...receipt.candidate, training_validation: receipt.training_validation, search_control }
    : {
        version: 1,
        status: "failed",
        code: "visible_training_validation_failed",
        diagnostic:
          "The retained best candidate still exceeds one or more public comparison tolerances. " +
          "Finish honestly so authoritative validation can render the full TSX/reference comparison and drive bounded repair.",
        retryable: true,
        candidate: receipt.candidate,
        training_validation: receipt.training_validation,
        search_control,
      }
}

export function createModelCandidateFileTools(
  workspace: string,
  options: {
    ngspice_path?: string
    tsci_path?: string
    check_candidate?: ModelCandidateToolChecker
    check_training?: ModelTrainingValidator
    fit_parameters?: ModelParameterFitter
  } = {},
) {
  const root = realpathSync(workspace)
  const search = new ModelCandidateSearchSession()
  let initialize_search: Promise<void> | undefined
  const ensureSearchInitialized = async (): Promise<void> => {
    initialize_search ??= (async () => {
      try {
        const [source, card, receipt] = await Promise.all([
          readFile(resolve(root, "model.lib"), "utf8"),
          readFile(resolve(root, "model-card.md"), "utf8"),
          readModelTrainingCheckReceipt(root),
        ])
        if (
          sourceRevision(source) !== receipt.candidate.revision ||
          textSha256(card) !== receipt.candidate.model_card_sha256
        ) {
          return
        }
        search.seed({
          source,
          card,
          quality: createModelTrainingCandidateQuality(receipt.training_validation),
          topology_fingerprint: modelCandidateTopologyFingerprint(source),
          candidate_receipt: `${JSON.stringify(receipt.candidate, null, 2)}\n`,
          training_receipt: `${JSON.stringify(receipt, null, 2)}\n`,
        })
      } catch {
        // A fresh first attempt has no retained candidate. Invalid retained
        // receipts are ignored here and will still fail the authoritative gate.
      }
    })()
    await initialize_search
  }
  const invalidateReceipts = async (): Promise<void> => {
    await Promise.all([
      rm(resolve(root, MODEL_CANDIDATE_CHECK_RECEIPT_FILE), { force: true }),
      rm(resolve(root, MODEL_TRAINING_CHECK_RECEIPT_FILE), { force: true }),
    ])
  }
  const restoreBest = async (): Promise<ModelCandidateSearchSnapshot | undefined> => {
    const best = search.best
    if (!best) return undefined
    await Promise.all([
      writeOutputFile(root, "model.lib", best.source),
      writeOutputFile(root, "model-card.md", best.card),
    ])
    await Promise.all([
      writeTrustedReceipt(root, MODEL_CANDIDATE_CHECK_RECEIPT_FILE, best.candidate_receipt),
      writeTrustedReceipt(root, MODEL_TRAINING_CHECK_RECEIPT_FILE, best.training_receipt),
    ])
    return best
  }
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
    writeFile: async (requested_path, content) => {
      await ensureSearchInitialized()
      await writeOutputFile(root, requested_path, content)
      await invalidateReceipts()
    },
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
  const check_training = options.check_training ?? runProductionTrainingValidation
  const fit_parameters = options.fit_parameters ?? runProductionParameterFit
  const candidate_check_tool = defineTool({
    name: "check_model_candidate",
    label: "check_model_candidate",
    description:
      "Validate model.lib and model-card.md, run the real ngspice smoke harness, then run the exact agent-visible training fixtures through ngspice and the tscircuit viewer. Takes no paths or commands. Returns residuals only at reference samples already visible in model-contract.json; held-out samples and the private causality gate remain unavailable.",
    promptSnippet:
      "Check the current model with the production smoke gate and real public-training simulations",
    promptGuidelines: [
      "After writing model.lib and model-card.md, call check_model_candidate and correct any failed diagnostic before finishing.",
    ],
    parameters: Type.Object({}, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_tool_call_id, _parameters, signal) {
      const check_signal = signal ?? new AbortController().signal
      let result: ModelCandidateToolCheckResult
      let restored_after_error = false
      try {
        await ensureSearchInitialized()
        const source_before_check = await readFile(resolve(root, "model.lib"), "utf8").catch(() => "")
        const budget = search.reserveCheck(source_before_check)
        if (!budget.allowed) {
          const best = await restoreBest()
          const search_control = searchControlReport({
            search,
            disposition: "budget_exhausted",
            diagnostic: budget.diagnostic ?? "The bounded candidate-search budget is exhausted.",
          })
          result = best
            ? resultFromSnapshot(best, search_control)
            : {
                version: 1,
                status: "failed",
                code: "candidate_search_budget_exhausted",
                diagnostic: search_control.diagnostic,
                retryable: false,
                search_control,
              }
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          }
        }
        await invalidateReceipts()
        const candidate = await check_candidate({
          workspace: root,
          ngspice_path: options.ngspice_path ?? process.env.DATASHEET_MODEL_CHECK_NGSPICE_BIN ?? "ngspice",
          signal: check_signal,
        })
        await writeTrustedReceipt(
          root,
          MODEL_CANDIDATE_CHECK_RECEIPT_FILE,
          `${JSON.stringify(candidate, null, 2)}\n`,
        )
        const training_plan_exists = await lstat(resolve(root, "model-training-plan.json"))
          .then((metadata) => metadata.isFile() && !metadata.isSymbolicLink())
          .catch(() => false)
        if (!training_plan_exists) {
          result = candidate
        } else {
          const training_validation = await check_training({
            workspace: root,
            ngspice_path: options.ngspice_path ?? process.env.DATASHEET_MODEL_CHECK_NGSPICE_BIN ?? "ngspice",
            tsci_path: options.tsci_path ?? process.env.DATASHEET_MODEL_CHECK_TSCI_BIN ?? "tsci",
            signal: check_signal,
          })
          const training_receipt = await createModelTrainingCheckReceipt({
            workspace: root,
            candidate,
            training_validation,
          })
          await writeTrustedReceipt(
            root,
            MODEL_TRAINING_CHECK_RECEIPT_FILE,
            `${JSON.stringify(training_receipt, null, 2)}\n`,
          )
          const [source, card] = await Promise.all([
            readFile(resolve(root, "model.lib"), "utf8").catch(() => source_before_check),
            readFile(resolve(root, "model-card.md"), "utf8").catch(() => ""),
          ])
          const disposition = search.consider({
            source,
            card,
            quality: createModelTrainingCandidateQuality(training_validation),
            topology_fingerprint: budget.topology_fingerprint,
            candidate_receipt: `${JSON.stringify(candidate, null, 2)}\n`,
            training_receipt: `${JSON.stringify(training_receipt, null, 2)}\n`,
          })
          if (disposition === "retained") {
            const best = await restoreBest()
            if (!best) throw new Error("Candidate search lost its retained best snapshot")
            result = resultFromSnapshot(
              best,
              searchControlReport({
                search,
                disposition,
                diagnostic:
                  "This edit did not improve complete direct-and-viewer candidate quality. " +
                  "The previous best source, card, and integrity receipts were restored.",
              }),
            )
          } else {
            const search_control = searchControlReport({
              search,
              disposition,
              diagnostic:
                disposition === "initial"
                  ? "Stored the first complete direct-and-viewer candidate as the repair seed."
                  : "This candidate improved complete direct-and-viewer quality and replaced the retained seed.",
            })
            result =
              training_validation.status === "passed"
                ? { ...candidate, training_validation, search_control }
                : {
                    version: 1,
                    status: "failed",
                    code: "visible_training_validation_failed",
                    diagnostic:
                      "The candidate is runnable in ngspice and the tscircuit viewer but exceeds one or more visible comparison tolerances. Use the reported residual shape for a bounded, evidence-driven repair; do not repeat manual bound guessing.",
                    retryable: true,
                    candidate,
                    training_validation,
                    search_control,
                  }
          }
        }
      } catch (error) {
        const best = await restoreBest().catch(() => undefined)
        restored_after_error = Boolean(best)
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
          ...(best
            ? {
                search_control: searchControlReport({
                  search,
                  disposition: "retained",
                  diagnostic:
                    "The attempted candidate was not executable. The previous best source, card, and integrity receipts were restored.",
                }),
              }
            : {}),
        }
      }
      if (result.status === "failed" && !result.candidate && !restored_after_error) {
        await writeTrustedReceipt(
          root,
          MODEL_CANDIDATE_CHECK_RECEIPT_FILE,
          `${JSON.stringify(result, null, 2)}\n`,
        )
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: result,
      }
    },
  })
  const fit_parameters_tool = defineTool({
    name: "fit_model_parameters",
    label: "fit_model_parameters",
    description:
      "Deterministically fit 1-6 numeric .param declarations in model.lib against the exact agent-visible public training samples using real ngspice. The bounded search updates model.lib to the best direct-simulation candidate and returns its traceable values and scores. It takes no paths or commands, never sees held-out samples, and does not replace the required final check_model_candidate viewer validation.",
    promptSnippet: "Fit declared numeric SPICE parameters with bounded real-ngspice search",
    promptGuidelines: [
      "Use fit_model_parameters for numeric calibration after a structurally valid causal model exists, then rerun check_model_candidate.",
    ],
    parameters: Type.Object(
      {
        parameters: Type.Array(
          Type.Object(
            {
              name: Type.String(),
              min: Type.Number(),
              max: Type.Number(),
              scale: Type.Union([Type.Literal("linear"), Type.Literal("log")]),
            },
            { additionalProperties: false },
          ),
          { minItems: 1, maxItems: 6 },
        ),
        max_evaluations: Type.Optional(Type.Integer({ minimum: 3, maximum: 64 })),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_tool_call_id, parameters, signal) {
      const fit_signal = signal ?? new AbortController().signal
      let details: ModelParameterFitToolResult
      try {
        await ensureSearchInitialized()
        const source = await readFile(resolve(root, "model.lib"), "utf8").catch(() => "")
        const budget = search.reserveFit(source, parameters.max_evaluations ?? 32)
        if (!budget.allowed) {
          await restoreBest()
          const search_control = searchControlReport({
            search,
            disposition: "budget_exhausted",
            diagnostic: budget.diagnostic ?? "The bounded parameter-search budget is exhausted.",
          })
          details = {
            version: 1,
            status: "failed",
            diagnostic: search_control.diagnostic,
            search_control,
          }
          return {
            content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
            details,
          }
        }
        const result = await fit_parameters({
          workspace: root,
          ngspice_path: options.ngspice_path ?? process.env.DATASHEET_MODEL_CHECK_NGSPICE_BIN ?? "ngspice",
          parameters: parameters.parameters as readonly ModelFitParameterRange[],
          max_evaluations: budget.granted_fit_evaluations!,
          signal: fit_signal,
        })
        details = {
          version: 1,
          status: "completed",
          ...result,
          search_control: searchControlReport({
            search,
            disposition: search.best ? "improved" : "initial",
            diagnostic:
              "The fitter completed within the shared simulation budget. Run one complete candidate check before deciding whether this direct-only result improves the retained direct-and-viewer seed.",
          }),
        }
      } catch (error) {
        details = {
          version: 1,
          status: "failed",
          diagnostic: sanitizeCheckDiagnostic(error, root),
        }
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
        details,
      }
    },
  })
  return [scoped_read_tool, scoped_write_tool, candidate_check_tool, fit_parameters_tool] as const
}

export default function registerModelCandidateTools(agent: ExtensionAPI): void {
  const [read_tool, write_tool, check_tool, fit_tool] = createModelCandidateFileTools(process.cwd())
  agent.registerTool(read_tool)
  agent.registerTool(write_tool)
  agent.registerTool(check_tool)
  agent.registerTool(fit_tool)
}
