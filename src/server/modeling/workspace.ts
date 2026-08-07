import { createHash } from "node:crypto"
import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { parseComponentEvidence } from "../component-evidence"
import { readCommittedEvidenceSnapshot } from "../component-workflow/evidence-commit"
import {
  applicationTargetIdentityFromEvidence,
  parseTypicalApplicationPlan,
} from "../component-workflow/application-plan"
import { compileApplicationFixtureContract } from "./application-fixture-contract"
import { createEvidenceModelInterface } from "./model-interface"
import { parseModelContract } from "./parse-model-contract"
import type { ModelContract, ModelInterface } from "./types"

const MODEL_WORKSPACE_GUIDE = `# SPICE model workspace

This workspace is controlled by the server pipeline.

- Read only the inputs named by the current prompt.
- Write only the declared output artifacts for the current stage.
- Never modify model-interface.json, model-contract.json, validation-plan.json,
  component-evidence.json, typical-application-plan.json,
  application-fixture-contract.json, or datasheet.pdf.
- Validation plans are declarative JSON. Never create raw .cir or .measure files.
- The server compiles fixtures, runs ngspice, records hashes, and owns pass/fail.
- model.lib must expose exactly one public subcircuit with the exact server-owned
  entry and pin order. Self-contained private helpers are allowed. model-card.md
  must state supported behavior and limits.
- Do not claim that an artifact is validated; only server results can do that.
`

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/**
 * Materializes only the committed evidence inputs required by Find Reference
 * Graphs and its downstream model-characterization work. It deliberately does
 * not read or wait for a generated component artifact.
 */
export async function prepareReferenceGraphInputs(input: {
  job_dir: string
  model_dir: string
  invocation_id: string
}): Promise<{
  model_interface: ModelInterface
  application_fixture: ReturnType<typeof compileApplicationFixtureContract>
  attempt_dir: string
  interface_path: string
  application_fixture_path: string
}> {
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
  const model_interface = createEvidenceModelInterface(evidence)
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
  const attempt_dir = join(input.model_dir, "attempts", input.invocation_id)
  const interface_path = join(input.model_dir, "model-interface.json")
  const workspace_application_fixture_path = join(input.model_dir, "application-fixture-contract.json")
  const application_fixture_text = `${JSON.stringify(application_fixture, null, 2)}\n`
  await mkdir(input.model_dir, { recursive: true })
  await Promise.all([
    Bun.write(join(input.model_dir, "datasheet.pdf"), datasheet_bytes),
    Bun.write(join(input.model_dir, "component-evidence.json"), evidence_bytes),
    Bun.write(join(input.model_dir, "typical-application-plan.json"), application_plan_bytes),
    Bun.write(workspace_application_fixture_path, application_fixture_text),
    Bun.write(interface_path, `${JSON.stringify(model_interface, null, 2)}\n`),
    Bun.write(join(input.model_dir, "AGENTS.md"), MODEL_WORKSPACE_GUIDE),
    mkdir(join(attempt_dir, "evidence"), { recursive: true }),
  ])
  const application_fixture_path = join(attempt_dir, "application-fixture-contract.json")
  await Bun.write(application_fixture_path, application_fixture_text)
  return {
    model_interface,
    application_fixture,
    attempt_dir,
    interface_path,
    application_fixture_path,
  }
}

export async function writeModelContract(model_dir: string, contract: ModelContract): Promise<void> {
  await Bun.write(join(model_dir, "model-contract.json"), `${JSON.stringify(contract, null, 2)}\n`)
}

export async function readModelContract(model_dir: string): Promise<ModelContract> {
  const value: unknown = JSON.parse(await readFile(join(model_dir, "model-contract.json"), "utf8"))
  return parseModelContract(value)
}
