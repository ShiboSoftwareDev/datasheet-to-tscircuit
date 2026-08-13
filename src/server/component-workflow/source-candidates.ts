import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { type AgentClient, runAgentArtifactStage } from "../infrastructure/agent"
import { createStageWorkspace, promoteStageFile, readBoundedTextArtifact } from "../infrastructure/artifacts"
import { createFootprintPlanFromEvidence, createTscircuitPinMappings } from "../component-evidence"
import { createComponentSchematicPlan } from "../component-schematic-plan"
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
  parseApprovedFootprintCatalogSnapshot,
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
    ...(snapshot.files.has("component-footprint-catalog.json") ? ["component-footprint-catalog.json"] : []),
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
  files: Array<{ source: string; destination?: string; required?: boolean }>
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
  const catalog = parseApprovedFootprintCatalogSnapshot(snapshot)
  const variant_plans = {
    version: 1,
    default_footprint_id: catalog.default_footprint_id,
    footprints: catalog.footprints.map((footprint) => {
      const tscircuit_pins = createTscircuitPinMappings(footprint.component_evidence)
      const tscircuit_pin_number_by_physical_pin = Object.fromEntries(
        tscircuit_pins.map(({ physical_pin, tscircuit_pin_number }) => [
          physical_pin,
          String(tscircuit_pin_number),
        ]),
      )
      const footprint_plan = createFootprintPlanFromEvidence(footprint.component_evidence)
      const schematic_plan = createComponentSchematicPlan(footprint.component_evidence)
      const map_schematic_pins = (pins: string[]) =>
        pins.map((pin) => tscircuit_pin_number_by_physical_pin[pin] ?? pin)
      return {
        footprint_id: footprint.footprint_id,
        ordering_codes: footprint.ordering_codes,
        tscircuit_pins,
        footprint_plan,
        tscircuit_footprint_plan: {
          ...footprint_plan,
          pads: footprint_plan.pads.map((pad) => {
            if (pad.pin === null) return { ...pad, port_hints: [] }
            const mapping = tscircuit_pins.find(({ physical_pin }) => physical_pin === pad.pin)
            if (!mapping) throw new Error(`No tscircuit pin mapping exists for ${pad.pin}`)
            return {
              ...pad,
              port_hints: [String(mapping.tscircuit_pin_number), mapping.physical_pin_hint],
            }
          }),
        },
        schematic_plan,
        tscircuit_schematic_plan: {
          ...schematic_plan,
          schPinArrangement: {
            leftSide: {
              ...schematic_plan.schPinArrangement.leftSide,
              pins: map_schematic_pins(schematic_plan.schPinArrangement.leftSide.pins),
            },
            rightSide: {
              ...schematic_plan.schPinArrangement.rightSide,
              pins: map_schematic_pins(schematic_plan.schPinArrangement.rightSide.pins),
            },
            topSide: {
              ...schematic_plan.schPinArrangement.topSide,
              pins: map_schematic_pins(schematic_plan.schPinArrangement.topSide.pins),
            },
            bottomSide: {
              ...schematic_plan.schPinArrangement.bottomSide,
              pins: map_schematic_pins(schematic_plan.schPinArrangement.bottomSide.pins),
            },
          },
        },
      }
    }),
  }
  const attempt = await runAgentArtifactStage({
    stage_id: input.feedback ? "repair_component" : "generate_component",
    phase_label: input.feedback ? "Component source repair" : "Component source generation",
    max_artifact_attempts: 2,
    signal: input.signal,
    use_openai: input.use_openai,
    agent_client: input.agent_client,
    create_workspace: async () => {
      const workspace = await createSourceWorkspace({
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
      })
      await Bun.write(
        join(workspace.path, "component-footprint-plans.json"),
        `${JSON.stringify(variant_plans, null, 2)}\n`,
      )
      return workspace
    },
    build_prompt: (artifact_feedback) =>
      componentPrompt({
        default_footprint_id: catalog.default_footprint_id,
        footprint_ids: catalog.footprints.map(({ footprint_id }) => footprint_id),
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
  return { attempts: attempt.attempts, agent_duration_ms: attempt.agent_duration_ms }
}

export async function generateApplicationSource(input: {
  job_dir: string
  component_source_path: string
  plan: TypicalApplicationPlan
  plan_origin?: "datasheet_reference" | "ai_generated"
  source_relative_path?: string
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
  if (input.plan_origin !== "ai_generated" && !isDeepStrictEqual(input.plan, application_plan)) {
    throw new Error("Application source plan does not match the committed evidence snapshot")
  }
  const committed_plan = input.plan_origin === "ai_generated" ? input.plan : application_plan
  const source_relative_path = input.source_relative_path ?? "typical-application.circuit.tsx"
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
              source: join(input.job_dir, source_relative_path),
              destination: "typical-application.circuit.tsx",
              required: false,
            },
          ],
        })
        try {
          await materializeCommittedApplicationEvidence(workspace.path, snapshot)
          await Bun.write(
            join(workspace.path, "typical-application-plan.json"),
            `${JSON.stringify(committed_plan, null, 2)}\n`,
          )
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
        origin: input.plan_origin,
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
        destination: source_relative_path,
        max_bytes: 1024 * 1024,
        signal: input.signal,
      }),
  })
}
