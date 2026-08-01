export interface TimeGraphHint {
  hint_id: string
  page: number
  figure: string
  reason: string
  /** Server-extracted source context used to ground the graph's operating conditions. */
  operating_condition_evidence: string
  /** Layout-preserving text from only the graph's own visual column/section. */
  fixture_evidence_context: string
  /** Summary-table conditions for this same figure, retained independently from the graph caption. */
  summary_fixture_evidence_context: string | null
  /** Same-key disagreements make the experiment ineligible; neither source silently wins. */
  condition_conflicts: TimeGraphConditionConflict[]
  /**
   * Immutable server extraction of non-source graph conditions. Fresh
   * discoveries always persist this receipt. The method id freezes the parser
   * semantics so publication revalidation cannot reinterpret retained text
   * after a future heuristic change.
   */
  graph_local_conditions?: TimeGraphLocalConditionReceipt
  /** Conditions an ordinary public-pin analog pulse fixture cannot establish. */
  unsupported_fixture_conditions: UnsupportedFixtureCondition[]
  /**
   * A pulse identity extracted by server code from printed test-condition text.
   * `null` is authoritative: an observer is not allowed to invent a fixture for
   * a waveform whose non-flat stimulus is not stated in the PDF text layer.
   */
  transient_fixture_evidence: TimeGraphTransientFixtureEvidence | null
}

export interface TimeGraphTransientFixtureEvidence {
  method: "printed_experiment_conditions_v2"
  source_excerpts: Array<{ scope: "summary_row" | "graph_caption"; text: string }>
  response: { signal: string; quantity: "voltage"; nominal_volts: number }
  stimulus: {
    signal: string
    type: "voltage_step" | "current_step"
    low: number
    high: number
    rise: number
    fall: number
  }
  auxiliary_conditions: TimeGraphAuxiliaryCondition[]
}

export type TimeGraphAuxiliaryCondition =
  | { kind: "dc_voltage"; signal: string; value: number }
  | { kind: "dc_current"; signal: string; value: number }
  | { kind: "logic_state"; signal: string; state: "low" | "high" }

export interface TimeGraphConditionConflict {
  code: "condition_conflict"
  key: string
  summary_value: string
  graph_value: string
}

export const TIME_GRAPH_LOCAL_CONDITION_METHOD = "graph_local_fixture_conditions_v1" as const

export type TimeGraphPassiveType = "resistor" | "capacitor" | "inductor"

interface TimeGraphLocalConditionSource {
  source_scope: "summary_row" | "graph_caption"
  source_text: string
  label: string
}

export type TimeGraphLocalCondition =
  | (TimeGraphLocalConditionSource & {
      kind: "passive_value"
      passive_type: TimeGraphPassiveType
      value_si: number
    })
  | (TimeGraphLocalConditionSource & {
      kind: "temperature"
      degrees_celsius: number
    })
  | (TimeGraphLocalConditionSource & {
      kind: "frequency"
      hertz: number
    })
  | (TimeGraphLocalConditionSource & {
      kind: "parasitic"
      parameter: "esr" | "dcr" | "parasitic_capacitance" | "parasitic_inductance"
      dimension: TimeGraphPassiveType
      value_si: number | null
    })

export interface TimeGraphLocalConditionReceipt {
  method: typeof TIME_GRAPH_LOCAL_CONDITION_METHOD
  conditions: TimeGraphLocalCondition[]
}

export type UnsupportedFixtureCondition =
  | "digital_protocol"
  | "register_programming"
  | "internal_configuration"
  | "temperature_control"
  | "frequency_control"
  | "unrepresentable_parasitic"

export interface TimeGraphDiscovery {
  version: 1
  source_pdf_sha256: string
  page_count: number
  hints: TimeGraphHint[]
}
