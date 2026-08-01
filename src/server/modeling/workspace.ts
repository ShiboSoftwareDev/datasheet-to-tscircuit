import { createHash } from "node:crypto"
import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { isCircuitJson } from "../component-circuit-json"
import { parseComponentEvidence } from "../component-evidence"
import { readCommittedEvidenceSnapshot } from "../component-workflow/evidence-commit"
import {
  applicationTargetIdentityFromEvidence,
  parseTypicalApplicationPlan,
} from "../component-workflow/application-plan"
import { compileApplicationFixtureContract } from "./application-fixture-contract"
import { createModelInterface } from "./model-interface"
import { parseModelContract } from "./parse-model-contract"
import type { ModelContract, ModelInterface } from "./types"

const MODEL_WORKSPACE_GUIDE = `# SPICE model workspace

This workspace is controlled by the server pipeline.

- Read only the inputs named by the current prompt.
- Write only the declared output artifacts for the current stage.
- Never modify model-interface.json, model-contract.json, validation-plan.json,
  component.circuit.tsx, component-evidence.json,
  typical-application-plan.json, application-fixture-contract.json, or datasheet.pdf.
- Validation plans are declarative JSON. Never create raw .cir or .measure files.
- The server compiles fixtures, runs ngspice, records hashes, and owns pass/fail.
- model.lib must expose exactly one public subcircuit with the exact server-owned
  entry and pin order. Self-contained private helpers are allowed. model-card.md
  must state supported behavior and limits.
- Do not claim that an artifact is validated; only server results can do that.
`

async function copyCanonical(source: string, destination: string): Promise<void> {
  const bytes = await readFile(source)
  await Bun.write(destination, bytes)
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

export async function prepareModelWorkspace(input: {
  job_dir: string
  model_dir: string
}): Promise<ModelInterface> {
  const evidence_snapshot = await readCommittedEvidenceSnapshot(input.job_dir)
  if (!evidence_snapshot) {
    throw new Error(
      "Model workspace requires approved evidence, but evidence-commit.json has not been published",
    )
  }
  if (evidence_snapshot.version === 1) {
    throw new Error(
      "Model workspace requires PDF-bound evidence version 2 or newer; retry component generation to replace the legacy version-1 evidence commit",
    )
  }
  const evidence_bytes = evidence_snapshot.files.get("component-evidence.json")
  const application_plan_bytes = evidence_snapshot.files.get("typical-application-plan.json")
  if (!evidence_bytes || !application_plan_bytes) {
    throw new Error("Committed evidence snapshot is missing a required model-workspace input")
  }
  let evidence_value: unknown
  try {
    evidence_value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(evidence_bytes)) as unknown
  } catch (error) {
    throw new Error("Committed component-evidence.json is not valid UTF-8 JSON", { cause: error })
  }
  const evidence = parseComponentEvidence(evidence_value)
  const datasheet_bytes = evidence_snapshot.source_pdf
  let application_plan_value: unknown
  try {
    application_plan_value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(application_plan_bytes),
    ) as unknown
  } catch (error) {
    throw new Error("Committed typical-application-plan.json is not valid UTF-8 JSON", {
      cause: error,
    })
  }

  await mkdir(input.model_dir, { recursive: true })
  const component_circuit_json: unknown = JSON.parse(
    await readFile(join(input.job_dir, "component.circuit.json"), "utf8"),
  )
  if (!isCircuitJson(component_circuit_json)) {
    throw new Error("component.circuit.json must contain validated Circuit JSON")
  }
  const model_interface = createModelInterface(evidence, component_circuit_json)
  const application_plan = parseTypicalApplicationPlan(
    application_plan_value,
    applicationTargetIdentityFromEvidence(evidence),
  )
  const application_fixture = compileApplicationFixtureContract({
    plan: application_plan,
    model_interface,
    source_plan_sha256: sha256Bytes(application_plan_bytes),
    source_pdf_sha256: sha256Bytes(datasheet_bytes),
  })
  const preserved_component = join(input.job_dir, "component.circuit.tsx")
  const component_source = (await Bun.file(preserved_component).exists())
    ? preserved_component
    : join(input.job_dir, "index.circuit.tsx")
  await Promise.all([
    Bun.write(join(input.model_dir, "datasheet.pdf"), datasheet_bytes),
    copyCanonical(component_source, join(input.model_dir, "component.circuit.tsx")),
    Bun.write(join(input.model_dir, "component-evidence.json"), evidence_bytes),
    Bun.write(join(input.model_dir, "typical-application-plan.json"), application_plan_bytes),
    Bun.write(
      join(input.model_dir, "application-fixture-contract.json"),
      `${JSON.stringify(application_fixture, null, 2)}\n`,
    ),
    Bun.write(
      join(input.model_dir, "component.circuit.json"),
      `${JSON.stringify(component_circuit_json, null, 2)}\n`,
    ),
    Bun.write(join(input.model_dir, "model-interface.json"), `${JSON.stringify(model_interface, null, 2)}\n`),
    Bun.write(join(input.model_dir, "AGENTS.md"), MODEL_WORKSPACE_GUIDE),
    mkdir(join(input.model_dir, "evidence"), { recursive: true }),
    mkdir(join(input.model_dir, "validation"), { recursive: true }),
    ...[
      "package.json",
      "tsconfig.json",
      "tscircuit.config.json",
      "tscircuit.config.ts",
      "typical-application.circuit.tsx",
    ].map(async (file_name) => {
      const source = join(input.job_dir, file_name)
      if (await Bun.file(source).exists()) {
        await copyCanonical(source, join(input.model_dir, file_name))
      }
    }),
  ])
  return model_interface
}

export async function writeModelContract(model_dir: string, contract: ModelContract): Promise<void> {
  await Bun.write(join(model_dir, "model-contract.json"), `${JSON.stringify(contract, null, 2)}\n`)
}

export async function readModelContract(model_dir: string): Promise<ModelContract> {
  const value: unknown = JSON.parse(await readFile(join(model_dir, "model-contract.json"), "utf8"))
  return parseModelContract(value)
}
