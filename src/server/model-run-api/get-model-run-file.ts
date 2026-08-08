import { join } from "node:path"
import { readBoundedTextArtifact } from "../infrastructure/artifacts"
import {
  modelCheckpointRequiresPublicationPointer,
  readVerifiedPublicationArtifact,
  resolveAcceptedModelPublication,
} from "../modeling"
import { acceptedPublicationErrorResponse } from "./accepted-publication-error"
import { ModelRunApiContext } from "./model-run-api-context"
import { errorResponse, getJobId } from "./model-run-api-responses"

export async function getModelRunFile(request_url: URL, context: ModelRunApiContext): Promise<Response> {
  const job_id = getJobId(request_url)
  if (!job_id) {
    return errorResponse({ error_code: "job_id_required", message: "job_id is required.", status: 400 })
  }
  const model_run_id = context.model_run_store.getModelRunIdForJob(job_id)
  const model_dir = model_run_id ? context.model_run_store.getModelDir(model_run_id) : undefined
  const model_run = model_run_id ? context.model_run_store.getModelRun(model_run_id) : undefined
  if (!model_run_id || !model_dir || !model_run) {
    return errorResponse({
      error_code: "model_run_not_found",
      message: "This job has no SPICE model run.",
      status: 404,
    })
  }
  const file_kind = request_url.searchParams.get("file")
  const files: Record<string, { name: string; content_type: string; max_bytes: number }> = {
    development_model: {
      name: "model.lib",
      content_type: "text/plain; charset=utf-8",
      max_bytes: 2 * 1024 * 1024,
    },
    model: { name: "model.lib", content_type: "text/plain; charset=utf-8", max_bytes: 2 * 1024 * 1024 },
    manifest: { name: "model-manifest.json", content_type: "application/json", max_bytes: 2 * 1024 * 1024 },
    report: {
      name: "validation-results.json",
      content_type: "application/json",
      max_bytes: 32 * 1024 * 1024,
    },
    contract: { name: "model-contract.json", content_type: "application/json", max_bytes: 4 * 1024 * 1024 },
    plan: { name: "validation-plan.json", content_type: "application/json", max_bytes: 8 * 1024 * 1024 },
    model_card: {
      name: "model-card.md",
      content_type: "text/markdown; charset=utf-8",
      max_bytes: 2 * 1024 * 1024,
    },
    component: {
      name: "component-with-model.circuit.tsx",
      content_type: "text/typescript; charset=utf-8",
      max_bytes: 2 * 1024 * 1024,
    },
    log: { name: "model-agent.log", content_type: "text/plain; charset=utf-8", max_bytes: 16 * 1024 * 1024 },
  }
  const selected = file_kind ? files[file_kind] : undefined
  if (!selected) {
    return errorResponse({ error_code: "invalid_file", message: "Unknown SPICE model file.", status: 400 })
  }
  let body: Bun.BunFile | Uint8Array<ArrayBuffer>
  if (file_kind === "development_model") {
    const source = model_run.development_model?.model_source
    if (!source?.trim() || Buffer.byteLength(source) > selected.max_bytes) {
      return errorResponse({
        error_code: "file_not_ready",
        message: "The development model is not ready.",
        status: 404,
      })
    }
    body = new TextEncoder().encode(source)
  } else if (file_kind !== "log") {
    let publication: Awaited<ReturnType<typeof resolveAcceptedModelPublication>>
    try {
      publication = await resolveAcceptedModelPublication(model_dir, job_id)
    } catch (error) {
      return acceptedPublicationErrorResponse({
        job_id,
        operation: `download_${file_kind}`,
        error,
      })
    }
    if (publication) {
      try {
        body = await readVerifiedPublicationArtifact({
          publication,
          bundle: "accepted_model",
          relative_path: selected.name,
          max_bytes: selected.max_bytes,
        })
      } catch (error) {
        return acceptedPublicationErrorResponse({
          job_id,
          operation: `download_${file_kind}`,
          error,
        })
      }
    } else if (modelCheckpointRequiresPublicationPointer(model_run)) {
      return acceptedPublicationErrorResponse({
        job_id,
        operation: `download_${file_kind}`,
        error: new Error(
          "published-model.json is missing even though the completed spice_generation pipeline crossed the publish commit barrier",
        ),
      })
    } else {
      try {
        body = new TextEncoder().encode(
          await readBoundedTextArtifact({
            path: join(model_dir, selected.name),
            max_bytes: selected.max_bytes,
          }),
        )
      } catch (error) {
        console.error("[model-artifact] legacy_reader_failed", {
          job_id,
          file_kind,
          cause: error instanceof Error ? error.message : String(error),
        })
        return errorResponse({
          error_code: "file_not_ready",
          message: `${selected.name} is not ready or failed its legacy artifact checks.`,
          status: 404,
        })
      }
    }
  } else {
    body = Bun.file(join(model_dir, selected.name))
  }
  const size = body instanceof Uint8Array ? body.byteLength : body.size
  if (size === 0) {
    return errorResponse({
      error_code: "file_not_ready",
      message: `${selected.name} is not ready.`,
      status: 404,
    })
  }
  return new Response(body, {
    headers: {
      "Content-Disposition": `attachment; filename="${selected.name}"`,
      "Content-Type": selected.content_type,
    },
  })
}
