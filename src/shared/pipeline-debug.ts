export type DebugPipelineId = "component_generation" | "typical_application" | "spice_generation"
export type DebugRunMode = "pipeline" | "stage" | "from_stage"

export const PIPELINE_DEBUG_CATALOG = Object.freeze([
  {
    pipeline_id: "component_generation" as const,
    title: "Component",
    description: "Extract evidence, generate the component TSX, validate it, and repair it.",
    stages: ["prepare", "extract_evidence", "generate_component", "validate_component", "repair_component"],
  },
  {
    pipeline_id: "typical_application" as const,
    title: "Typical application",
    description: "Generate and validate a documented application around the accepted component.",
    stages: [
      "prepare_application",
      "generate_application",
      "validate_application",
      "repair_application",
      "publish",
    ],
  },
  {
    pipeline_id: "spice_generation" as const,
    title: "SPICE",
    description: "Reconstruct and compare datasheet waveforms before publishing a SPICE-backed component.",
    stages: [
      "wait_for_component",
      "prepare_workspace",
      "find_reference_graphs",
      "create_comparison_graphs",
      "infer_spice_model",
      "create_simulation_tsx",
      "run_simulations",
      "compare_simulation_outputs",
      "repair_spice_model",
      "publish",
    ],
  },
] as const)
