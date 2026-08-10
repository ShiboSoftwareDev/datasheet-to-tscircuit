import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { type AgentClient, runAgentArtifactStage } from "../infrastructure/agent"
import { createStageWorkspace, promoteStageFile, readBoundedTextArtifact } from "../infrastructure/artifacts"
import type { TypicalApplicationPlan } from "./application-plan"
import {
  applicationEvidenceFilePath,
  type CommittedApplicationEvidenceSnapshot,
} from "./application-evidence-commit"
import type { CommittedEvidenceSnapshot } from "./evidence-commit"
import { applicationPrompt, componentPrompt } from "./prompts"
import {
  readApprovedApplicationEvidenceBundle,
  readApprovedComponentEvidenceBundle,
  readComponentBoundApplicationEvidence,
  validateGeneratedSource,
} from "./stage-helpers"
import {
  APPLICATION_SOURCE_STAGE_INSTRUCTIONS,
  COMPONENT_SOURCE_STAGE_INSTRUCTIONS,
} from "./stage-instructions"

const PROJECT_FILES = [
  "package.json",
  "tsconfig.json",
  "tscircuit.config.json",
  "tscircuit.config.ts",
] as const

const GENERATION_EVIDENCE_FILES = [
  "component-evidence.json",
  "component-schematic-plan.json",
  "footprint-plan.json",
] as const

function committedGenerationFiles(
  snapshot: CommittedEvidenceSnapshot,
): Array<{ relative_path: string; bytes: Uint8Array }> {
  const relative_paths = [
    ...GENERATION_EVIDENCE_FILES,
    ...[...snapshot.files.keys()]
      .filter((relative_path) => relative_path.startsWith("visual-reference/"))
      .sort(),
  ]
  return relative_paths.map((relative_path) => {
    const bytes = snapshot.files.get(relative_path)
    if (!bytes) throw new Error(`Committed evidence snapshot is missing ${relative_path}`)
    return { relative_path, bytes }
  })
}

async function materializeCommittedEvidence(
  workspace: string,
  snapshot: CommittedEvidenceSnapshot,
): Promise<void> {
  for (const file of committedGenerationFiles(snapshot)) {
    const destination = join(workspace, file.relative_path)
    await mkdir(dirname(destination), { recursive: true })
    await Bun.write(destination, file.bytes)
  }
}

async function materializeCommittedApplicationEvidence(
  workspace: string,
  snapshot: CommittedApplicationEvidenceSnapshot,
): Promise<void> {
  const paths = [
    applicationEvidenceFilePath("typical-application-plan.json"),
    ...[...snapshot.files.keys()]
      .filter((relative_path) => relative_path.startsWith("visual-reference/"))
      .sort(),
  ]
  for (const relative_path of paths) {
    const bytes = snapshot.files.get(relative_path)
    if (!bytes) throw new Error(`Committed application evidence is missing ${relative_path}`)
    const destination = join(workspace, relative_path)
    await mkdir(dirname(destination), { recursive: true })
    await Bun.write(destination, bytes)
  }
}

async function createSourceWorkspace(input: {
  prefix: string
  files: Array<{ source: string; required?: boolean }>
  evidence_snapshot: CommittedEvidenceSnapshot
  instructions: string
}) {
  const workspace = await createStageWorkspace({
    prefix: input.prefix,
    files: input.files,
  })
  try {
    await materializeCommittedEvidence(workspace.path, input.evidence_snapshot)
    await Bun.write(join(workspace.path, "AGENTS.md"), input.instructions)
    return workspace
  } catch (error) {
    await workspace.dispose().catch(() => undefined)
    throw error
  }
}

export async function generateComponentSource(input: {
  job_dir: string
  signal: AbortSignal
  use_openai: boolean
  agent_client: AgentClient
  debug_dir: string
  feedback?: string
  on_output: (stream: "system" | "stdout" | "stderr", message: string) => void | Promise<void>
}) {
  const { snapshot } = await readApprovedComponentEvidenceBundle(input.job_dir)
  return runAgentArtifactStage({
    stage_id: input.feedback ? "repair_component" : "generate_component",
    phase_label: input.feedback ? "Component source repair" : "Component source generation",
    max_artifact_attempts: 2,
    signal: input.signal,
    use_openai: input.use_openai,
    agent_client: input.agent_client,
    create_workspace: () =>
      createSourceWorkspace({
        prefix: "component-source",
        files: [
          ...PROJECT_FILES.map((file_name) => ({ source: join(input.job_dir, file_name) })),
          {
            source: join(input.job_dir, "index.circuit.tsx"),
            required: Boolean(input.feedback),
          },
        ],
        evidence_snapshot: snapshot,
        instructions: COMPONENT_SOURCE_STAGE_INSTRUCTIONS,
      }),
    build_prompt: (artifact_feedback) =>
      componentPrompt({
        feedback: [input.feedback, artifact_feedback].filter(Boolean).join("\n\n"),
      }),
    heartbeat_paths: (workspace) => [join(workspace, "index.circuit.tsx")],
    on_output: input.on_output,
    rejection_debug: {
      debug_dir: input.debug_dir,
      files: ["index.circuit.tsx"],
    },
    validate: async (workspace) => {
      const source = await readBoundedTextArtifact({
        path: join(workspace, "index.circuit.tsx"),
        max_bytes: 512 * 1024,
      })
      validateGeneratedSource(source, "component")
      return source
    },
    promote: (workspace) =>
      promoteStageFile({
        workspace,
        source: "index.circuit.tsx",
        destination_root: input.job_dir,
        max_bytes: 512 * 1024,
        signal: input.signal,
      }),
  })
}

export async function generateApplicationSource(input: {
  job_dir: string
  component_source_path: string
  plan: TypicalApplicationPlan
  signal: AbortSignal
  use_openai: boolean
  agent_client: AgentClient
  debug_dir: string
  feedback?: string
  on_output: (stream: "system" | "stdout" | "stderr", message: string) => void | Promise<void>
}) {
  const [{ snapshot }, application_plan] = await Promise.all([
    readApprovedApplicationEvidenceBundle(input.job_dir),
    readComponentBoundApplicationEvidence(input.job_dir),
  ])
  if (!isDeepStrictEqual(input.plan, application_plan)) {
    throw new Error("Application source plan does not match the committed evidence snapshot")
  }
  const committed_plan = application_plan
  return runAgentArtifactStage({
    stage_id: input.feedback ? "repair_application" : "generate_application",
    phase_label: input.feedback ? "Application source repair" : "Application source generation",
    max_artifact_attempts: 2,
    signal: input.signal,
    use_openai: input.use_openai,
    agent_client: input.agent_client,
    create_workspace: () =>
      (async () => {
        const workspace = await createStageWorkspace({
          prefix: "application-source",
          files: [
            ...PROJECT_FILES.map((file_name) => ({ source: join(input.job_dir, file_name) })),
            { source: input.component_source_path },
            {
              source: join(input.job_dir, "typical-application.circuit.tsx"),
              required: false,
            },
          ],
        })
        try {
          await materializeCommittedApplicationEvidence(workspace.path, snapshot)
          await Bun.write(join(workspace.path, "AGENTS.md"), APPLICATION_SOURCE_STAGE_INSTRUCTIONS)
          return workspace
        } catch (error) {
          await workspace.dispose().catch(() => undefined)
          throw error
        }
      })(),
    build_prompt: (artifact_feedback) =>
      applicationPrompt({
        plan: committed_plan,
        feedback: [input.feedback, artifact_feedback].filter(Boolean).join("\n\n"),
      }),
    heartbeat_paths: (workspace) => [join(workspace, "typical-application.circuit.tsx")],
    on_output: input.on_output,
    rejection_debug: {
      debug_dir: input.debug_dir,
      files: ["typical-application.circuit.tsx"],
    },
    validate: async (workspace) => {
      const source = await readBoundedTextArtifact({
        path: join(workspace, "typical-application.circuit.tsx"),
        max_bytes: 1024 * 1024,
      })
      validateGeneratedSource(source, "application")
      return source
    },
    promote: (workspace) =>
      promoteStageFile({
        workspace,
        source: "typical-application.circuit.tsx",
        destination_root: input.job_dir,
        max_bytes: 1024 * 1024,
        signal: input.signal,
      }),
  })
}
