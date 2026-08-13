import { join } from "node:path"
import { runAgentArtifactStage, type AgentClient } from "../infrastructure/agent"
import { createStageWorkspace, promoteStageFile, readBoundedJsonArtifact } from "../infrastructure/artifacts"
import { parseApprovedEvidenceSnapshot } from "./stage-helpers"
import {
  createApplicationPlanCatalog,
  parseGeneratedApplicationPlanSet,
  type ApplicationPlanCatalog,
} from "./application-plan-catalog"
import {
  applicationEvidenceFilePath,
  readCommittedApplicationEvidenceSnapshot,
} from "./application-evidence-commit"
import { parseApplicationDesignEvidence } from "./application-design-evidence"
import { parseTypicalApplicationPlan } from "./application-plan"
import { readCommittedEvidenceSnapshot } from "./evidence-commit"
import { applicationPlanningPrompt } from "./prompts"

const APPLICATION_PLANNER_INSTRUCTIONS = `# Application planning stage

Work only inside this isolated directory. All JSON and component.circuit.tsx are
immutable inputs. Do not access datasheet.pdf, create TSX, run builds, or edit
input artifacts. Write only generated-application-plans.json.
`

function parseSnapshotJson(
  files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>,
  relative_path: string,
): unknown {
  const bytes = files.get(relative_path)
  if (!bytes) throw new Error(`Committed snapshot is missing ${relative_path}`)
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  return value
}

export async function planGeneratedApplications(input: {
  job_dir: string
  signal: AbortSignal
  use_openai: boolean
  agent_client: AgentClient
  debug_dir: string
  on_output: (stream: "system" | "stdout" | "stderr", message: string) => void | Promise<void>
}): Promise<{ catalog: ApplicationPlanCatalog; attempts: number }> {
  const [application_snapshot, component_snapshot] = await Promise.all([
    readCommittedApplicationEvidenceSnapshot(input.job_dir),
    readCommittedEvidenceSnapshot(input.job_dir),
  ])
  if (!application_snapshot || !component_snapshot) {
    throw new Error("Application planning requires committed application and component evidence")
  }
  const reference_plan = parseTypicalApplicationPlan(
    parseSnapshotJson(
      application_snapshot.files,
      applicationEvidenceFilePath("typical-application-plan.json"),
    ),
  )
  const design_evidence = parseApplicationDesignEvidence(
    parseSnapshotJson(
      application_snapshot.files,
      applicationEvidenceFilePath("application-design-evidence.json"),
    ),
  )
  const component_evidence = parseApprovedEvidenceSnapshot(component_snapshot).component_evidence
  const attempt = await runAgentArtifactStage({
    stage_id: "plan_applications",
    phase_label: "Application planning",
    max_artifact_attempts: 3,
    signal: input.signal,
    use_openai: input.use_openai,
    agent_client: input.agent_client,
    contract_id: "generated-application-plans/v1",
    create_workspace: async () => {
      const workspace = await createStageWorkspace({
        prefix: "application-planning",
        files: [
          { source: join(input.job_dir, "component.circuit.tsx") },
          {
            source: join(application_snapshot.evidence_dir, "typical-application-plan.json"),
          },
          {
            source: join(application_snapshot.evidence_dir, "application-design-evidence.json"),
          },
        ],
      })
      await Promise.all([
        Bun.write(join(workspace.path, "AGENTS.md"), APPLICATION_PLANNER_INSTRUCTIONS),
        Bun.write(
          join(workspace.path, "component-evidence.json"),
          `${JSON.stringify(component_evidence, null, 2)}\n`,
        ),
      ])
      return workspace
    },
    build_prompt: (feedback) => applicationPlanningPrompt(feedback),
    heartbeat_paths: (workspace) => [join(workspace, "generated-application-plans.json")],
    rejection_debug: { debug_dir: input.debug_dir, files: ["generated-application-plans.json"] },
    on_output: input.on_output,
    validate: async (workspace) =>
      parseGeneratedApplicationPlanSet({
        value: await readBoundedJsonArtifact({
          path: join(workspace, "generated-application-plans.json"),
          max_bytes: 4 * 1024 * 1024,
          max_depth: 48,
          max_nodes: 100_000,
        }),
        component_evidence,
        design_evidence,
        reference_plan,
      }),
    promote: (workspace) =>
      promoteStageFile({
        workspace,
        source: "generated-application-plans.json",
        destination_root: input.job_dir,
        max_bytes: 4 * 1024 * 1024,
        signal: input.signal,
      }),
  })
  const catalog = createApplicationPlanCatalog({ reference_plan, generated: attempt.value })
  await Bun.write(
    join(input.job_dir, "application-plan-catalog.json"),
    `${JSON.stringify(catalog, null, 2)}\n`,
  )
  return { catalog, attempts: attempt.attempts }
}
