import { mkdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { PipelineError } from "../../pipeline"
import {
  componentPublishedCircuitJsonRelativePath,
  componentValidationResultRelativePath,
} from "../component-footprint-artifacts"
import {
  appendJobLog,
  componentArtifact,
  componentFootprintPreviewsFromCatalog,
  readApprovedComponentFootprintCatalog,
  readCircuitValidationRecord,
  writeJson,
} from "../stage-helpers"
import { defineComponentStage } from "./stage-factory"

export const publishComponentStage = defineComponentStage({
  id: "publish_component",
  depends_on: ["repair_component"],
  async execute({ context, services, dependency_outputs, signal }) {
    if (!dependency_outputs.repair_component.passed) {
      throw new PipelineError({
        code: "validated_component_required",
        message: "Component publication requires a passing validation result.",
        stage_id: "publish_component",
        operation: "publish_component",
      })
    }
    const result = await readCircuitValidationRecord(dependency_outputs.repair_component.result_path)
    if (!result.passed) {
      throw new PipelineError({
        code: "validated_component_required",
        message: "Component publication received a non-passing validation artifact.",
        stage_id: "publish_component",
        operation: "publish_component",
        artifact_refs: [{ path: dependency_outputs.repair_component.result_path }],
      })
    }
    const candidate_path = join(context.job_dir, "index.circuit.tsx")
    const component_path = join(context.job_dir, "component.circuit.tsx")
    const component_circuit_json_path = join(context.job_dir, "component.circuit.json")
    const component_code = await readFile(candidate_path, "utf8")
    const catalog = await readApprovedComponentFootprintCatalog(context.job_dir)
    const variant_publications = await Promise.all(
      catalog.footprints.map(async (footprint) => {
        const validation = await readCircuitValidationRecord(
          join(context.job_dir, componentValidationResultRelativePath(catalog, footprint)),
        )
        if (!validation.passed) {
          throw new Error(`Footprint ${footprint.footprint_id} did not pass component validation`)
        }
        return {
          footprint,
          circuit_json: validation.circuit_json,
          circuit_json_path: join(
            context.job_dir,
            componentPublishedCircuitJsonRelativePath(footprint.footprint_id),
          ),
        }
      }),
    )
    signal.throwIfAborted()
    await rm(join(context.job_dir, "component-variants"), { recursive: true, force: true })
    await mkdir(join(context.job_dir, "component-variants"), { recursive: true })
    await Promise.all([
      Bun.write(component_path, component_code),
      writeJson(component_circuit_json_path, result.circuit_json),
      ...variant_publications.map((publication) =>
        writeJson(publication.circuit_json_path, publication.circuit_json),
      ),
    ])
    const preview_metadata = componentFootprintPreviewsFromCatalog(catalog)
    services.job_store.updateJob(context.job_id, {
      display_status: "agent_running",
      component_ready: true,
      component_code,
      circuit_json: result.circuit_json,
      component_footprints: {
        ...preview_metadata,
        footprints: preview_metadata.footprints.map((footprint) => {
          const publication = variant_publications.find(
            (candidate) => candidate.footprint.footprint_id === footprint.footprint_id,
          )
          return publication
            ? {
                ...footprint,
                circuit_json: publication.circuit_json,
              }
            : footprint
        }),
      },
    })
    await appendJobLog(
      services.job_store,
      context.job_id,
      "system",
      "Component passed source, pinout, footprint, schematic, and board-level checks.\n",
    ).catch(() => undefined)
    return {
      status: "completed",
      commit_state: "committed",
      output: {
        component_ready: true,
        component_path,
        component_circuit_json_path,
      },
      artifacts: [
        await componentArtifact({
          id: "validated_component",
          path: component_path,
          media_type: "text/typescript",
          role: "validated_component",
        }),
        await componentArtifact({
          id: "validated_component_circuit_json",
          path: component_circuit_json_path,
          media_type: "application/json",
          role: "validated_component",
        }),
        ...(await Promise.all(
          variant_publications.map((publication) =>
            componentArtifact({
              id: `validated_component_circuit_json_${publication.footprint.footprint_id}`,
              path: publication.circuit_json_path,
              media_type: "application/json",
              role: "validated_component_variant",
            }),
          ),
        )),
      ],
    }
  },
})
