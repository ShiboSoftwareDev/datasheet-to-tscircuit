import type { ModelCharacterization } from "../../modeling"
import { PipelineError } from "../../pipeline"
import { eligibleObservedGraphs, type ReferenceGraphObservation } from "../reference-graph-observation"

function boundedDiagnosticText(value: string, max_length: number): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  return normalized.length <= max_length ? normalized : `${normalized.slice(0, max_length - 1)}…`
}

function noEligibleTimeDomainGraphError(graph_diagnostics: readonly string[] = []): PipelineError {
  const graph_detail =
    graph_diagnostics.length > 0
      ? ` Reviewed graph diagnostics: ${graph_diagnostics.slice(0, 4).join(" | ")}`
      : ""
  return new PipelineError({
    code: "no_eligible_time_domain_graph",
    message:
      "The complete PDF scan and independent source observer found no eligible printed elapsed-time voltage graph for a fresh executable SPICE model." +
      graph_detail,
    stage_id: "characterize",
    operation: "validate_model_characterization",
    hint: "Only a public-pin transient voltage waveform with a supported reproducible fixture and an independently matched cited-page graph crop can start model generation; scalar, operating-point, DC-only, current-only, and protocol-dependent specifications remain documented-only.",
    retryable: false,
  })
}

export function assertHasEligibleTimeDomainGraph(characterization: ModelCharacterization): void {
  if (characterization.requirements.some(({ support }) => support.status === "modeled")) return
  throw noEligibleTimeDomainGraphError()
}

export function assertObserverFoundEligibleTimeDomainGraph(observation: ReferenceGraphObservation): void {
  if (eligibleObservedGraphs(observation).length > 0) return
  throw noEligibleTimeDomainGraphError(
    [...observation.graphs]
      .sort((left, right) => {
        const priority = (graph: (typeof observation.graphs)[number]) =>
          graph.response_quantity === "voltage" && graph.public_pin_observable
            ? 0
            : graph.response_quantity === "voltage"
              ? 1
              : 2
        return priority(left) - priority(right)
      })
      .map(
        ({ page, locator, reason }) =>
          `PDF page ${page} ${boundedDiagnosticText(locator, 80)}: ${boundedDiagnosticText(reason, 240)}`,
      ),
  )
}
