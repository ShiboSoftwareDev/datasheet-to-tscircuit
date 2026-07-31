import { runModel, type ModelRunnerContext } from "../model-workflow"

export interface ModelRunApiContext extends ModelRunnerContext {
  run_model?: typeof runModel
}
