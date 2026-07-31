import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { runAgentArtifactStage, type AgentClient } from "../infrastructure/agent"
import { createStageWorkspace, promoteStageFile } from "../infrastructure/artifacts"
import type { TypicalApplicationPlan } from "./application-plan"
import { applicationPrompt, componentPrompt } from "./prompts"
import { validateGeneratedSource } from "./stage-helpers"
import {
  APPLICATION_SOURCE_STAGE_INSTRUCTIONS,
  COMPONENT_SOURCE_STAGE_INSTRUCTIONS,
} from "./stage-instructions"

const COMMON_FILES = [
  "package.json",
  "tsconfig.json",
  "tscircuit.config.json",
  "tscircuit.config.ts",
  "component-evidence.json",
  "component-schematic-plan.json",
  "footprint-plan.json",
  "typical-application-plan.json",
]

async function createSourceWorkspace(input: {
  prefix: string
  job_dir: string
  files: Array<{ source: string; required?: boolean }>
  instructions: string
}) {
  const workspace = await createStageWorkspace({
    prefix: input.prefix,
    files: input.files,
    directories: [{ source: join(input.job_dir, "visual-reference"), required: false }],
  })
  await Bun.write(join(workspace.path, "AGENTS.md"), input.instructions)
  return workspace
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
        job_dir: input.job_dir,
        files: [
          ...COMMON_FILES.map((file_name) => ({ source: join(input.job_dir, file_name) })),
          {
            source: join(input.job_dir, "index.circuit.tsx"),
            required: Boolean(input.feedback),
          },
        ],
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
      const path = join(workspace, "index.circuit.tsx")
      const [source, metadata] = await Promise.all([readFile(path, "utf8"), stat(path)])
      if (metadata.size > 512 * 1024) throw new Error("Component source exceeds 512 KiB")
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
  plan: TypicalApplicationPlan
  signal: AbortSignal
  use_openai: boolean
  agent_client: AgentClient
  debug_dir: string
  feedback?: string
  on_output: (stream: "system" | "stdout" | "stderr", message: string) => void | Promise<void>
}) {
  return runAgentArtifactStage({
    stage_id: input.feedback ? "repair_application" : "generate_application",
    phase_label: input.feedback ? "Application source repair" : "Application source generation",
    max_artifact_attempts: 2,
    signal: input.signal,
    use_openai: input.use_openai,
    agent_client: input.agent_client,
    create_workspace: () =>
      createSourceWorkspace({
        prefix: "application-source",
        job_dir: input.job_dir,
        files: [
          ...COMMON_FILES,
          "index.circuit.tsx",
          "component.circuit.tsx",
          "typical-application.circuit.tsx",
        ].map((file_name) => ({
          source: join(input.job_dir, file_name),
          required: file_name !== "typical-application.circuit.tsx",
        })),
        instructions: APPLICATION_SOURCE_STAGE_INSTRUCTIONS,
      }),
    build_prompt: (artifact_feedback) =>
      applicationPrompt({
        plan: input.plan,
        feedback: [input.feedback, artifact_feedback].filter(Boolean).join("\n\n"),
      }),
    heartbeat_paths: (workspace) => [join(workspace, "typical-application.circuit.tsx")],
    on_output: input.on_output,
    rejection_debug: {
      debug_dir: input.debug_dir,
      files: ["typical-application.circuit.tsx"],
    },
    validate: async (workspace) => {
      const path = join(workspace, "typical-application.circuit.tsx")
      const [source, metadata] = await Promise.all([readFile(path, "utf8"), stat(path)])
      if (metadata.size > 1024 * 1024) throw new Error("Application source exceeds 1 MiB")
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
