export type DebugPipelineId = "component_generation" | "typical_application" | "spice_generation"
export type DebugRunMode = "pipeline" | "stage" | "from_stage"

export const PIPELINE_DEBUG_CATALOG = Object.freeze([
  {
    pipeline_id: "component_generation" as const,
    title: "Component",
    description: "Extract evidence, generate and build the component TSX, validate, repair, and publish it.",
    stages: [
      "extract_evidence",
      "generate_component",
      "build_component",
      "validate_component",
      "repair_component",
      "publish_component",
    ],
  },
  {
    pipeline_id: "typical_application" as const,
    title: "Typical application",
    description:
      "Extract application evidence, wait for the component when needed, then generate, validate, repair, and publish it.",
    stages: [
      "extract_application_evidence",
      "wait_for_component",
      "generate_application",
      "build_application",
      "validate_application",
      "repair_application",
      "publish_application",
    ],
  },
  {
    pipeline_id: "spice_generation" as const,
    title: "SPICE",
    description: "Reconstruct and compare datasheet waveforms before publishing a SPICE-backed component.",
    stages: [
      "find_reference_graphs",
      "wait_for_model_evidence",
      "create_comparison_graphs",
      "infer_spice_model",
      "create_simulation_tsx",
      "run_simulations",
      "compare_simulation_outputs",
      "repair_spice_model",
      "wait_for_component",
      "publish",
    ],
  },
] as const)
