import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { type AgentArtifactAttempt, type AgentClient, runAgentArtifactStage } from "../infrastructure/agent"
import { createStageWorkspace, promoteStageFile } from "../infrastructure/artifacts"
import type { GeneratedModel, ModelContract } from "../modeling"
import type { ValidationPlan } from "../spice-validation"
import { checkModelCandidate } from "./model-candidate-check"

export type RepairTarget = "model" | "tsx" | "both"

export interface RepairDiagnosis {
  version: 1
  target: RepairTarget
  affected_case_ids: string[]
  diagnosis: string
  planned_changes: string[]
}

export interface StoredRepairCandidate extends GeneratedModel {
  artifact_dir: string
  source_dir: string
  diagnosis: RepairDiagnosis
}

const MODEL_SOURCE_LINE = /^const modelSource = .*$/m
const MODEL_REVISION_COMMENT = /^ \* Model revision:.*$/m
const MODEL_CARD_COMMENT = /^ \* Model card:.*$/m
const CONTRACT_PREFIX = "const validationCaseContract = "
const CONTRACT_SUFFIX = " as const\n\nexport default function ValidationCasePreview()"

function safeComment(value: string): string {
  return value
    .replace(/\*\//g, "* /")
    .replace(/[\r\n]+/g, " ")
    .trim()
}

function modelCardTitle(card: string): string {
  return (
    card
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find(Boolean) ?? "Generated SPICE model"
  )
}

function validationContractSource(source: string): string {
  const start = source.indexOf(CONTRACT_PREFIX)
  const end = source.indexOf(CONTRACT_SUFFIX)
  if (start < 0 || end < start) {
    throw new Error("A repair TSX is missing its server-generated validationCaseContract")
  }
  const block = source.slice(start, end + " as const".length)
  const uses = source.match(/\bvalidationCaseContract\b/g)?.length ?? 0
  if (uses !== 2 || !source.includes("  void validationCaseContract")) {
    throw new Error(
      "A repair TSX may preserve validationCaseContract only as the server-generated declaration and unused contract guard",
    )
  }
  return block
}

function circuitSourceWithoutModelBinding(source: string): string {
  if (!MODEL_SOURCE_LINE.test(source)) {
    throw new Error("A repair TSX is missing its server-generated modelSource binding")
  }
  validationContractSource(source)
  return source
    .replace(MODEL_SOURCE_LINE, "const modelSource = __SERVER_BOUND_MODEL_SOURCE__")
    .replace(MODEL_REVISION_COMMENT, " * Model revision: __SERVER_BOUND_MODEL_REVISION__")
    .replace(MODEL_CARD_COMMENT, " * Model card: __SERVER_BOUND_MODEL_CARD__")
}

function bindCanonicalModelToCircuit(input: {
  source: string
  model_source: string
  model_card: string
  revision: string
}): string {
  circuitSourceWithoutModelBinding(input.source)
  return input.source
    .replace(MODEL_SOURCE_LINE, `const modelSource = ${JSON.stringify(input.model_source)}`)
    .replace(MODEL_REVISION_COMMENT, ` * Model revision: ${safeComment(input.revision)}`)
    .replace(
      MODEL_CARD_COMMENT,
      ` * Model card: ${safeComment(modelCardTitle(input.model_card)).slice(0, 160)}`,
    )
}

function parseDiagnosis(value: unknown, case_ids: readonly string[]): RepairDiagnosis {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("repair-plan.json must be an object")
  }
  const record = value as Record<string, unknown>
  const expected = ["affected_case_ids", "diagnosis", "planned_changes", "target", "version"]
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expected)) {
    throw new Error("repair-plan.json contains unsupported or missing fields")
  }
  if (
    record.version !== 1 ||
    (record.target !== "model" && record.target !== "tsx" && record.target !== "both")
  ) {
    throw new Error("repair-plan.json does not satisfy the repair diagnosis contract")
  }
  if (typeof record.diagnosis !== "string" || !record.diagnosis.trim() || record.diagnosis.length > 4_000) {
    throw new Error("repair-plan.json does not satisfy the repair diagnosis contract")
  }
  if (!Array.isArray(record.planned_changes) || record.planned_changes.length === 0) {
    throw new Error("repair-plan.json does not satisfy the repair diagnosis contract")
  }
  const planned_changes: string[] = []
  for (const entry of record.planned_changes) {
    if (typeof entry !== "string" || !entry.trim() || entry.length > 1_000) {
      throw new Error("repair-plan.json does not satisfy the repair diagnosis contract")
    }
    planned_changes.push(entry)
  }
  if (!Array.isArray(record.affected_case_ids) || record.affected_case_ids.length === 0) {
    throw new Error("repair-plan.json does not satisfy the repair diagnosis contract")
  }
  const affected_case_ids: string[] = []
  for (const entry of record.affected_case_ids) {
    if (typeof entry !== "string" || !case_ids.includes(entry)) {
      throw new Error("repair-plan.json does not satisfy the repair diagnosis contract")
    }
    affected_case_ids.push(entry)
  }
  if (new Set(affected_case_ids).size !== affected_case_ids.length) {
    throw new Error("repair-plan.json does not satisfy the repair diagnosis contract")
  }
  return {
    version: 1,
    target: record.target,
    affected_case_ids,
    diagnosis: record.diagnosis,
    planned_changes,
  }
}

function repairPrompt(input: {
  feedback: string
  case_ids: readonly string[]
  strategy_guidance: string
}): string {
  return `Diagnose and repair the current SPICE candidate using only the files in this isolated workspace.

Before changing model.lib, model-card.md, or simulation-tsx, inspect candidate-diagnostics.json, validation-results.json, model-ui.json, the current model, and every affected TSX circuit. Write repair-plan.json first with exactly:
{"version":1,"target":"model"|"tsx"|"both","affected_case_ids":[...],"diagnosis":"...","planned_changes":["..."]}

Then implement exactly that diagnosis:
- target=model: change model.lib/model-card.md and leave every TSX circuit unchanged. The server owns and will update the embedded modelSource metadata.
- target=tsx: change one or more listed TSX circuits and leave model.lib/model-card.md byte-for-byte unchanged.
- target=both: change the model and one or more listed TSX circuits.
- Never edit the validation plan, model contract, evidence, references, graph crops, or digitized reference values.
- Leave the validationCaseContract declaration and its void guard in every TSX byte-for-byte unchanged.
- Preserve the incumbent's ability to run every tscircuit viewer simulation. A candidate that makes any
  previously available viewer simulation unavailable is worse, regardless of its apparent curve fit.
- The server ranks complete candidates in this order: validation target, non-repairable errors,
  stimulus causality, viewer availability, failed cases, failed series, worst error, then mean error.
  Never trade a higher-priority gate for a lower-priority improvement.
- Model syntax must run in tscircuit's installed simulator. Do not assume that a behavioral function is
  portable merely because another SPICE implementation accepts it; prefer portable circuit primitives
  and syntax already proven by the runnable incumbent.
- TSX may change its executable circuit topology, fixture, or stimulus when the diagnosis shows the circuit is wrong, but it must preserve the named observation and time-domain reference contract and remain a genuine general simulation of its named reference case.
- For a power converter, every private state read by a source that drives the modeled output must itself be driven by the measured output response. Do not add a separate EN/VIN-only soft-start state; express startup through an EN-qualified, output-error-driven controller state.
- Do not add per-sample lookup tables, figure-specific output forcing, hidden reference data, or other curve-fitting hacks.
- Do not run ngspice. The server will run the exact promoted TSX with tscircuit after this artifact is complete.
- Keep all case files present: ${input.case_ids.join(", ")}.

Server diagnosis summary:
${input.feedback}

Strategy guidance:
${input.strategy_guidance}`
}

export async function generateRepairCandidate(input: {
  model_dir: string
  contract: ModelContract
  plan: ValidationPlan
  evidence_dir: string
  previous: {
    model_path: string
    model_card_path: string
    source_dir: string
    result_path: string
  }
  strategy_guidance: string
  feedback: string
  signal: AbortSignal
  use_openai: boolean
  agent_client: AgentClient
  max_artifact_attempts: number
  debug_dir: string
  phase_label: string
  on_output: (stream: "system" | "stdout" | "stderr", message: string) => void | Promise<void>
}): Promise<AgentArtifactAttempt<StoredRepairCandidate>> {
  const case_ids = input.plan.cases.map(({ id }) => id)
  return runAgentArtifactStage({
    stage_id: "repair_spice_model",
    phase_label: input.phase_label,
    max_artifact_attempts: input.max_artifact_attempts,
    signal: input.signal,
    use_openai: input.use_openai,
    agent_client: input.agent_client,
    create_workspace: async () => {
      const validation_dir = dirname(input.previous.result_path)
      return createStageWorkspace({
        prefix: "repair-spice-model",
        files: [
          { source: join(input.model_dir, "AGENTS.md") },
          { source: join(input.model_dir, "model-interface.json") },
          { source: join(input.model_dir, "model-contract.json"), required: false },
          { source: input.previous.model_path, destination: "model.lib" },
          { source: input.previous.model_card_path, destination: "model-card.md" },
          {
            source: input.plan ? join(validation_dir, "validation-plan.json") : "",
            destination: "validation-plan.json",
          },
          { source: input.previous.result_path, destination: "validation-results.json" },
          {
            source: join(validation_dir, "candidate-diagnostics.json"),
            destination: "candidate-diagnostics.json",
          },
          { source: join(validation_dir, "model-ui.json"), destination: "model-ui.json" },
          { source: join(input.model_dir, "package.json"), required: false },
          { source: join(input.model_dir, "tsconfig.json"), required: false },
          { source: join(input.model_dir, "tscircuit.config.json"), required: false },
        ],
        directories: [
          { source: input.previous.source_dir, destination: "simulation-tsx" },
          { source: input.evidence_dir, destination: "evidence", required: false },
        ],
      })
    },
    build_prompt: (artifact_feedback) =>
      repairPrompt({
        feedback: [input.feedback, artifact_feedback].filter(Boolean).join("\n\n"),
        case_ids,
        strategy_guidance: input.strategy_guidance,
      }),
    heartbeat_paths: (workspace) => [
      join(workspace, "repair-plan.json"),
      join(workspace, "model.lib"),
      ...case_ids.map((case_id) => join(workspace, "simulation-tsx", `${case_id}.circuit.tsx`)),
    ],
    rejection_debug: {
      debug_dir: input.debug_dir,
      files: ["repair-plan.json", "model.lib", "model-card.md"],
      directories: ["simulation-tsx"],
    },
    on_output: input.on_output,
    validate: async (workspace) => {
      const diagnosis = parseDiagnosis(
        JSON.parse(await readFile(join(workspace, "repair-plan.json"), "utf8")),
        case_ids,
      )
      const checked = await checkModelCandidate({
        workspace,
        model_interface: input.contract.interface,
        model_contract: input.contract,
        signal: input.signal,
      })
      const [old_source, old_card] = await Promise.all([
        readFile(input.previous.model_path, "utf8"),
        readFile(input.previous.model_card_path, "utf8"),
      ])
      const model_changed = checked.generated.source !== old_source
      const card_changed = checked.generated.card !== old_card
      const changed_cases: string[] = []
      for (const case_id of case_ids) {
        const [before, after] = await Promise.all([
          readFile(join(input.previous.source_dir, `${case_id}.circuit.tsx`), "utf8"),
          readFile(join(workspace, "simulation-tsx", `${case_id}.circuit.tsx`), "utf8"),
        ])
        if (validationContractSource(before) !== validationContractSource(after)) {
          throw new Error(`The immutable validationCaseContract changed in ${case_id}.circuit.tsx`)
        }
        if (circuitSourceWithoutModelBinding(before) !== circuitSourceWithoutModelBinding(after)) {
          changed_cases.push(case_id)
        }
      }
      const tsx_changed = changed_cases.length > 0
      if (diagnosis.target === "model" && (!model_changed || tsx_changed)) {
        throw new Error("The implemented changes do not match target=model")
      }
      if (diagnosis.target === "tsx" && (model_changed || card_changed || !tsx_changed)) {
        throw new Error("The implemented changes do not match target=tsx")
      }
      if (diagnosis.target === "both" && (!model_changed || !tsx_changed)) {
        throw new Error("The implemented changes do not match target=both")
      }
      if (changed_cases.some((case_id) => !diagnosis.affected_case_ids.includes(case_id))) {
        throw new Error("A TSX circuit changed without being named in affected_case_ids")
      }
      await Promise.all(
        case_ids.map(async (case_id) => {
          const path = join(workspace, "simulation-tsx", `${case_id}.circuit.tsx`)
          const source = await readFile(path, "utf8")
          await writeFile(
            path,
            bindCanonicalModelToCircuit({
              source,
              model_source: checked.generated.source,
              model_card: checked.generated.card,
              revision: checked.generated.manifest.revision,
            }),
            "utf8",
          )
        }),
      )
      const artifact_dir = join(
        input.model_dir,
        "candidates",
        `${checked.generated.manifest.revision}-${crypto.randomUUID()}`,
      )
      return {
        ...checked.generated,
        artifact_dir,
        source_dir: join(artifact_dir, "simulation-tsx"),
        diagnosis,
      }
    },
    promote: async (workspace, candidate, signal) => {
      await Promise.all([
        mkdir(candidate.artifact_dir, { recursive: true }),
        mkdir(candidate.source_dir, { recursive: true }),
      ])
      await Promise.all([
        promoteStageFile({
          workspace,
          source: "model.lib",
          destination_root: candidate.artifact_dir,
          max_bytes: 2 * 1024 * 1024,
          signal,
        }),
        promoteStageFile({
          workspace,
          source: "model-card.md",
          destination_root: candidate.artifact_dir,
          max_bytes: 512 * 1024,
          signal,
        }),
        promoteStageFile({
          workspace,
          source: "repair-plan.json",
          destination_root: candidate.artifact_dir,
          max_bytes: 32 * 1024,
          signal,
        }),
        ...case_ids.map((case_id) =>
          promoteStageFile({
            workspace,
            source: join("simulation-tsx", `${case_id}.circuit.tsx`),
            destination_root: candidate.artifact_dir,
            destination: join("simulation-tsx", `${case_id}.circuit.tsx`),
            max_bytes: 2 * 1024 * 1024,
            signal,
          }),
        ),
      ])
      await Bun.write(
        join(candidate.artifact_dir, "model-manifest.json"),
        `${JSON.stringify(candidate.manifest, null, 2)}\n`,
      )
    },
  })
}
