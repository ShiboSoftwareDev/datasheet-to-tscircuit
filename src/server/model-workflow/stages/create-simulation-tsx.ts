import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { type GeneratedModel, renderValidationCaseTsx } from "../../modeling"
import type { ValidationPlan } from "../../spice-validation"
import { modelArtifact, readJson, updateModelProgress } from "../stage-helpers"
import { defineModelStage } from "./stage-factory"

export const createSimulationTsxStage = defineModelStage({
  id: "create_simulation_tsx",
  depends_on: ["infer_spice_model"],
  async execute({ context, services, dependency_outputs, signal }) {
    const inferred = dependency_outputs.infer_spice_model
    const [plan, model_source, model_card, manifest] = await Promise.all([
      readJson(inferred.plan_path) as Promise<ValidationPlan>,
      readFile(inferred.model_path, "utf8"),
      readFile(inferred.model_card_path, "utf8"),
      readJson(inferred.manifest_path) as Promise<GeneratedModel["manifest"]>,
    ])
    updateModelProgress({
      store: services.model_run_store,
      model_run_id: context.model_run_id,
      phase: "generating_model",
      message: "Creating standalone tscircuit simulation sources",
    })
    const source_dir = join(dirname(inferred.model_path), "simulation-tsx")
    await mkdir(source_dir, { recursive: true })
    const artifacts = []
    const cases = []
    for (const validation_case of plan.cases) {
      signal.throwIfAborted()
      const file_name = `${validation_case.id}.circuit.tsx`
      const source = renderValidationCaseTsx({
        validation_case,
        manifest,
        model_source,
        model_card,
      })
      const path = join(source_dir, file_name)
      await writeFile(path, source, "utf8")
      cases.push({
        case_id: validation_case.id,
        path,
        sha256: createHash("sha256").update(source).digest("hex"),
      })
      artifacts.push(
        await modelArtifact({
          id: `simulation_tsx_${validation_case.id}`,
          path,
          media_type: "text/typescript",
          role: "simulation_source",
        }),
      )
    }
    const source_manifest_path = join(source_dir, "manifest.json")
    await writeFile(
      source_manifest_path,
      `${JSON.stringify({ version: 1, model_revision: manifest.revision, cases }, null, 2)}\n`,
      "utf8",
    )
    artifacts.push(
      await modelArtifact({
        id: "simulation_tsx_manifest",
        path: source_manifest_path,
        media_type: "application/json",
        role: "simulation_source_manifest",
      }),
    )
    return {
      status: "completed",
      output: {
        source_dir,
        source_manifest_path,
        model_path: inferred.model_path,
        model_card_path: inferred.model_card_path,
        manifest_path: inferred.manifest_path,
        contract_path: inferred.contract_path,
        plan_path: inferred.plan_path,
        evidence_dir: inferred.evidence_dir,
        revision: inferred.revision,
        case_count: plan.cases.length,
      },
      artifacts,
      metrics: { simulation_sources: plan.cases.length },
    }
  },
})
