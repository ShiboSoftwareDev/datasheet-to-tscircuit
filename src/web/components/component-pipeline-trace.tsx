import type { Job } from "@/shared/job-types"
import { PipelineTrace } from "./pipeline-trace"

const COMPONENT_STAGE_LABELS: Readonly<Record<string, string>> = {
  prepare: "Prepare workspace",
  extract_evidence: "Extract datasheet evidence",
  generate_component: "Generate component",
  validate_component: "Validate component",
  repair_component: "Repair component",
  generate_application: "Generate typical application",
  validate_application: "Validate typical application",
  repair_application: "Repair typical application",
  publish: "Publish artifacts",
}

export function ComponentPipelineTrace({ job }: { job: Job }) {
  return (
    <PipelineTrace
      pipeline={job.pipeline}
      title="Component execution trace"
      stage_labels={COMPONENT_STAGE_LABELS}
      class_name="component-pipeline-trace"
    />
  )
}
