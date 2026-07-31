import { join } from "node:path"
import { collectJobProvenance } from "../provenance"
import { appendJobLog, componentArtifact, INITIAL_JOB_VALIDATION, writeJson } from "../stage-helpers"
import { defineComponentStage } from "./stage-factory"

export const prepareStage = defineComponentStage({
  id: "prepare",
  depends_on: [],
  async execute({ context, services }) {
    const provenance = await collectJobProvenance({
      job_dir: context.job_dir,
      additional_instructions: context.additional_instructions,
    })
    const provenance_path = join(context.job_dir, "provenance.json")
    await writeJson(provenance_path, provenance)
    services.job_store.updateJob(context.job_id, {
      display_status: "agent_running",
      validation: INITIAL_JOB_VALIDATION,
      provenance,
      is_complete: false,
      has_errors: false,
      error_message: undefined,
    })
    await appendJobLog(
      services.job_store,
      context.job_id,
      "system",
      `Starting typed component pipeline from workflow source ${provenance.source_commit}.\n`,
    )
    const datasheet_path = join(context.job_dir, "datasheet.pdf")
    return {
      status: "completed",
      output: { job_id: context.job_id, datasheet_path, provenance_path },
      artifacts: [
        await componentArtifact({
          id: "datasheet",
          path: datasheet_path,
          media_type: "application/pdf",
          role: "source",
        }),
        await componentArtifact({
          id: "component_provenance",
          path: provenance_path,
          media_type: "application/json",
          role: "provenance",
        }),
      ],
    }
  },
})
