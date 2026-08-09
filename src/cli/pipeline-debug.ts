export { type DebugCliOptions, runDebugCli } from "./pipeline-debug-command"
export { projectDebugCliStdout } from "./pipeline-debug-output"
import { runPipelineDebugMain } from "./pipeline-debug-main"

if (import.meta.main) await runPipelineDebugMain()
