import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { prepareModelWorkspace } from "../../modeling"
import { modelArtifact, updateModelProgress } from "../stage-helpers"
import { defineModelStage } from "./stage-factory"

export const prepareWorkspaceStage = defineModelStage({
  id: "prepare_workspace",
  depends_on: ["wait_for_component"],
  async execute({ context, services }) {
    services.model_run_store.updateModelRun(context.model_run_id, {
      status: "setting_up",
      is_complete: false,
      has_errors: false,
    })
    updateModelProgress({
      store: services.model_run_store,
      model_run_id: context.model_run_id,
      phase: "preparing_workspace",
      message: "Preparing the canonical model interface and isolated workspace",
    })
    const model_interface = await prepareModelWorkspace({
      job_dir: context.job_dir,
      model_dir: context.model_dir,
    })
    const interface_path = join(context.model_dir, "model-interface.json")
    const attempt_dir = join(context.model_dir, "attempts", context.invocation_id)
    await mkdir(join(attempt_dir, "evidence"), { recursive: true })
    return {
      status: "completed",
      output: {
        part_number: model_interface.part_number,
        entry_name: model_interface.entry_name,
        pin_count: model_interface.pins.length,
        interface_path,
        attempt_dir,
      },
      artifacts: [
        await modelArtifact({
          id: "model_interface",
          path: interface_path,
          media_type: "application/json",
          role: "model_contract",
        }),
      ],
      metrics: { pin_count: model_interface.pins.length },
    }
  },
})
