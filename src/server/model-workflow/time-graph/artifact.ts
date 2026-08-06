import {
  deriveTimeGraphLocalConditionReceipt,
  parseGraphLocalConditionReceipt,
  unsupportedFixtureConditions,
} from "./condition-receipt"
import { deriveTimeGraphPrintedExperiment, parseTransientFixtureEvidence } from "./printed-experiment"
import {
  assertOnlyKeys,
  boundedString,
  isRecord,
  MAX_FIXTURE_EVIDENCE_CONTEXT_LENGTH,
  MAX_OPERATING_CONDITION_EVIDENCE_LENGTH,
  MAX_TIME_GRAPH_HINTS,
} from "./shared"
import type { TimeGraphDiscovery, TimeGraphHint } from "./types"

export function parseTimeGraphDiscovery(value: unknown, expected_pdf_sha256: string): TimeGraphDiscovery {
  if (!isRecord(value)) throw new Error("time-graph-hints.json must be an object")
  assertOnlyKeys(value, ["version", "source_pdf_sha256", "page_count", "hints"], "time-graph-hints.json")
  if (value.version !== 1) throw new Error("time-graph-hints.json.version must be 1")
  if (!/^[a-f0-9]{64}$/.test(expected_pdf_sha256)) {
    throw new Error("The canonical datasheet SHA-256 is invalid")
  }
  if (value.source_pdf_sha256 !== expected_pdf_sha256) {
    throw new Error("time-graph-hints.json.source_pdf_sha256 must match the canonical datasheet PDF")
  }
  if (!Number.isSafeInteger(value.page_count) || (value.page_count as number) < 1) {
    throw new Error("time-graph-hints.json.page_count must be a positive safe integer")
  }
  const page_count = value.page_count as number
  if (!Array.isArray(value.hints)) throw new Error("time-graph-hints.json.hints must be an array")
  if (value.hints.length > MAX_TIME_GRAPH_HINTS) {
    throw new Error(`time-graph-hints.json.hints cannot contain more than ${MAX_TIME_GRAPH_HINTS} entries`)
  }
  const hints = value.hints.map((hint, index): TimeGraphHint => {
    const path = `time-graph-hints.json.hints[${index}]`
    if (!isRecord(hint)) throw new Error(`${path} must be an object`)
    assertOnlyKeys(
      hint,
      [
        "hint_id",
        "page",
        "figure",
        "reason",
        "operating_condition_evidence",
        "fixture_evidence_context",
        "summary_fixture_evidence_context",
        "condition_conflicts",
        "graph_local_conditions",
        "unsupported_fixture_conditions",
        "transient_fixture_evidence",
      ],
      path,
    )
    const hint_id = boundedString(hint.hint_id, `${path}.hint_id`, 64)
    if (!/^time_graph_\d{3,6}$/.test(hint_id)) {
      throw new Error(`${path}.hint_id must use the deterministic time_graph_NNN format`)
    }
    if (!Number.isSafeInteger(hint.page) || (hint.page as number) < 1 || (hint.page as number) > page_count) {
      throw new Error(`${path}.page must identify a page in the canonical datasheet PDF`)
    }
    const operating_condition_evidence = boundedString(
      hint.operating_condition_evidence,
      `${path}.operating_condition_evidence`,
      MAX_OPERATING_CONDITION_EVIDENCE_LENGTH,
    )
    const fixture_evidence_context = boundedString(
      hint.fixture_evidence_context,
      `${path}.fixture_evidence_context`,
      MAX_FIXTURE_EVIDENCE_CONTEXT_LENGTH,
    )
    const summary_fixture_evidence_context =
      hint.summary_fixture_evidence_context === null
        ? null
        : boundedString(
            hint.summary_fixture_evidence_context,
            `${path}.summary_fixture_evidence_context`,
            MAX_FIXTURE_EVIDENCE_CONTEXT_LENGTH,
          )
    const independently_derived_local_conditions = deriveTimeGraphLocalConditionReceipt({
      fixture_evidence_context,
      summary_fixture_evidence_context,
    })
    const graph_local_conditions =
      hint.graph_local_conditions === undefined
        ? (() => {
            if (independently_derived_local_conditions.conditions.length > 0) {
              throw new Error(
                `${path}.graph_local_conditions must persist every deterministically extracted graph-local condition`,
              )
            }
            return independently_derived_local_conditions
          })()
        : parseGraphLocalConditionReceipt(
            hint.graph_local_conditions,
            `${path}.graph_local_conditions`,
            fixture_evidence_context,
            summary_fixture_evidence_context,
          )
    if (JSON.stringify(graph_local_conditions) !== JSON.stringify(independently_derived_local_conditions)) {
      throw new Error(`${path}.graph_local_conditions do not match the retained graph-local conditions`)
    }
    if (!Array.isArray(hint.condition_conflicts)) {
      throw new Error(`${path}.condition_conflicts must be an array`)
    }
    const condition_conflicts = hint.condition_conflicts.map((conflict, conflict_index) => {
      const conflict_path = `${path}.condition_conflicts[${conflict_index}]`
      if (!isRecord(conflict)) throw new Error(`${conflict_path} must be an object`)
      assertOnlyKeys(conflict, ["code", "key", "summary_value", "graph_value"], conflict_path)
      if (conflict.code !== "condition_conflict") {
        throw new Error(`${conflict_path}.code must be condition_conflict`)
      }
      return {
        code: "condition_conflict" as const,
        key: boundedString(conflict.key, `${conflict_path}.key`, 64),
        summary_value: boundedString(conflict.summary_value, `${conflict_path}.summary_value`, 128),
        graph_value: boundedString(conflict.graph_value, `${conflict_path}.graph_value`, 128),
      }
    })
    if (new Set(condition_conflicts.map(({ key }) => key)).size !== condition_conflicts.length) {
      throw new Error(`${path}.condition_conflicts must not contain duplicate keys`)
    }
    if (!Array.isArray(hint.unsupported_fixture_conditions)) {
      throw new Error(`${path}.unsupported_fixture_conditions must be an array`)
    }
    const unsupported_fixture_conditions = hint.unsupported_fixture_conditions.map((condition, index) => {
      if (
        condition !== "digital_protocol" &&
        condition !== "register_programming" &&
        condition !== "internal_configuration" &&
        condition !== "temperature_control" &&
        condition !== "frequency_control" &&
        condition !== "unrepresentable_parasitic"
      ) {
        throw new Error(
          `${path}.unsupported_fixture_conditions[${index}] must name a supported deterministic condition`,
        )
      }
      return condition
    })
    if (new Set(unsupported_fixture_conditions).size !== unsupported_fixture_conditions.length) {
      throw new Error(`${path}.unsupported_fixture_conditions must not contain duplicates`)
    }
    const independently_derived_unsupported = unsupportedFixtureConditions(
      operating_condition_evidence,
      graph_local_conditions,
    )
    if (
      JSON.stringify(unsupported_fixture_conditions) !== JSON.stringify(independently_derived_unsupported)
    ) {
      throw new Error(
        `${path}.unsupported_fixture_conditions do not match the retained deterministic conditions`,
      )
    }
    if (!("transient_fixture_evidence" in hint)) {
      throw new Error(
        `${path}.transient_fixture_evidence must be present (use null when no supported printed transient setup is proven)`,
      )
    }
    const transient_fixture_evidence = parseTransientFixtureEvidence(
      hint.transient_fixture_evidence,
      `${path}.transient_fixture_evidence`,
      fixture_evidence_context,
      summary_fixture_evidence_context,
    )
    const independently_derived = deriveTimeGraphPrintedExperiment({
      fixture_evidence_context,
      summary_fixture_evidence_context,
    })
    if (JSON.stringify(condition_conflicts) !== JSON.stringify(independently_derived.condition_conflicts)) {
      throw new Error(`${path}.condition_conflicts do not match the retained printed conditions`)
    }
    if (JSON.stringify(transient_fixture_evidence) !== JSON.stringify(independently_derived.evidence)) {
      throw new Error(`${path}.transient_fixture_evidence does not match the printed experiment conditions`)
    }
    return {
      hint_id,
      page: hint.page as number,
      figure: boundedString(hint.figure, `${path}.figure`, 256),
      reason: boundedString(hint.reason, `${path}.reason`, 1_024),
      operating_condition_evidence,
      fixture_evidence_context,
      summary_fixture_evidence_context,
      condition_conflicts,
      graph_local_conditions,
      unsupported_fixture_conditions,
      transient_fixture_evidence,
    }
  })
  if (new Set(hints.map(({ hint_id }) => hint_id)).size !== hints.length) {
    throw new Error("time-graph-hints.json hint ids must be unique")
  }
  return {
    version: 1,
    source_pdf_sha256: expected_pdf_sha256,
    page_count,
    hints,
  }
}
