import { cp, rm } from "node:fs/promises"
import { join } from "node:path"
import type { ComponentEvidence } from "../component-evidence"
import {
  getComponentEvidenceBlockingReasons,
  getFootprintEvidenceErrors,
  getIndependentComponentEvidenceAcceptedDifferences,
  getIndependentComponentEvidenceErrors,
} from "../component-evidence"
import { type ComponentSchematicPlan, createComponentSchematicPlan } from "../component-schematic-plan"
import type { FootprintPlan } from "../job-artifact-validator"
import {
  extractIndependentComponentEvidence,
  retainEvidenceAttemptArtifacts,
} from "./extract-independent-component-evidence"
import {
  canRetryEvidenceFailure,
  extractPrimaryEvidenceAttempt,
  type PrimaryEvidenceExtraction,
} from "./extract-primary-evidence-attempt"
import { snapshotProtectedTree } from "./generation-workspace"
import { getTypicalApplicationPlanAgreementErrors } from "./get-typical-application-plan-agreement-errors"
import type { JobExecution } from "./job-execution"
import type { TypicalApplicationPlan } from "./parse-typical-application-plan"
import { AutomatedConversionUnavailableError, throwIfCancelled } from "./stream-job-process"

export interface ApprovedJobEvidence {
  component_evidence: ComponentEvidence
  component_evidence_text: string
  component_schematic_plan: ComponentSchematicPlan
  component_schematic_plan_text: string
  footprint_plan: FootprintPlan
  footprint_plan_text: string
  typical_application_plan: TypicalApplicationPlan
  typical_application_plan_text: string
  locked_visual_references: Map<string, Buffer>
}

async function extractPrimaryEvidence(execution: JobExecution): Promise<PrimaryEvidenceExtraction> {
  const component_evidence_path = join(execution.job_dir, "component-evidence.json")
  const component_path = join(execution.job_dir, "index.circuit.tsx")
  const starter_component_code = await Bun.file(component_path)
    .text()
    .catch(() => undefined)
  let primary_retry_feedback: string | undefined

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const primary_evidence = await extractPrimaryEvidenceAttempt({
        context: execution.context,
        job_dir: execution.job_dir,
        signal: execution.cancellation_signal,
        append: execution.append.bind(execution),
        additional_instructions: execution.additional_instructions,
        retry_feedback: primary_retry_feedback,
        protected_event_log_file: execution.protected_event_log_file,
        published_event_log_file: execution.published_event_log_file,
        starter_component_code,
        attempt,
      })
      await retainEvidenceAttemptArtifacts({
        source_dir: execution.job_dir,
        job_dir: execution.job_dir,
        kind: "primary",
        attempt,
      })
      return primary_evidence
    } catch (error) {
      await retainEvidenceAttemptArtifacts({
        source_dir: execution.job_dir,
        job_dir: execution.job_dir,
        kind: "primary",
        attempt,
        error,
      })
      const evidence_available = await Bun.file(component_evidence_path).exists()
      execution.context.job_store.updateJob(execution.job_id, { evidence_available })
      if (attempt < 2 && canRetryEvidenceFailure(error)) {
        const reason = error instanceof Error ? error.message : String(error)
        primary_retry_feedback = reason
        await execution.append(
          "system",
          `Evidence attempt ${attempt} was incomplete (${reason}). Retrying automatically with a clean evidence workspace…\n`,
        )
        continue
      }
      if (canRetryEvidenceFailure(error) && !(error instanceof AutomatedConversionUnavailableError)) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new AutomatedConversionUnavailableError(
          `Automatic evidence extraction could not complete after ${attempt} attempt(s): ${reason}`,
        )
      }
      throw error
    }
  }
  throw new AutomatedConversionUnavailableError("Automatic evidence extraction produced no usable result")
}

async function verifyEvidenceIndependently(
  primary_evidence: PrimaryEvidenceExtraction,
  execution: JobExecution,
): Promise<PrimaryEvidenceExtraction> {
  type IndependentEvidence = Awaited<ReturnType<typeof extractIndependentComponentEvidence>>
  type ValidDisagreement = {
    attempt: number
    evidence: IndependentEvidence
    primary_component_errors: string[]
    primary_application_errors: string[]
    primary_errors: string[]
  }

  const max_extraction_attempts = 4
  const max_valid_disagreements = max_extraction_attempts
  let independent_retry_feedback: string | undefined
  let last_retryable_error: string | undefined
  const valid_disagreements: ValidDisagreement[] = []

  const getComponentErrors = (left: IndependentEvidence, right: IndependentEvidence): string[] =>
    getIndependentComponentEvidenceErrors(left.component_evidence, right.component_evidence)

  const getApplicationErrors = (left: IndependentEvidence, right: IndependentEvidence): string[] =>
    getTypicalApplicationPlanAgreementErrors({
      primary: left.application_plan,
      independent: right.application_plan,
      target_part_number: right.component_evidence.part_number.value,
    })

  const getPairwiseErrors = (left: IndependentEvidence, right: IndependentEvidence): string[] => [
    ...getComponentErrors(left, right),
    ...getApplicationErrors(left, right),
  ]

  const getDomainConsensusCandidate = (): ValidDisagreement | undefined => {
    const candidates = valid_disagreements.filter((candidate) => {
      const component_supported =
        candidate.primary_component_errors.length === 0 ||
        valid_disagreements.some(
          (other) =>
            other.attempt !== candidate.attempt &&
            getComponentErrors(candidate.evidence, other.evidence).length === 0,
        )
      const application_supported =
        candidate.primary_application_errors.length === 0 ||
        valid_disagreements.some(
          (other) =>
            other.attempt !== candidate.attempt &&
            getApplicationErrors(candidate.evidence, other.evidence).length === 0,
        )
      return component_supported && application_supported
    })
    const first = candidates[0]
    if (!first) return undefined
    if (candidates.some((candidate) => getPairwiseErrors(first.evidence, candidate.evidence).length > 0)) {
      return undefined
    }
    return first
  }

  const getConsensusFailureAudit = (): { details: string; disputed_checks: string[] } => {
    const comparisons: Array<{ label: string; errors: string[] }> = valid_disagreements.map(
      ({ attempt, primary_errors }) => ({
        label: `primary versus independent-${attempt}`,
        errors: primary_errors,
      }),
    )
    for (let left_index = 0; left_index < valid_disagreements.length; left_index += 1) {
      for (let right_index = left_index + 1; right_index < valid_disagreements.length; right_index += 1) {
        const left = valid_disagreements.at(left_index)
        const right = valid_disagreements.at(right_index)
        if (!left || !right) continue
        const errors = getPairwiseErrors(left.evidence, right.evidence)
        if (errors.length > 0) {
          comparisons.push({
            label: `independent-${left.attempt} versus independent-${right.attempt}`,
            errors,
          })
        }
      }
    }
    const unique_facts = [...new Set(comparisons.flatMap(({ errors }) => errors))]
    const disputed_checks = [
      ...new Set(
        unique_facts.map((fact) =>
          fact
            .replace(/\s+differs:.*$/i, "")
            .replace(/\s+disagrees:.*$/i, "")
            .trim(),
        ),
      ),
    ]
    return {
      disputed_checks,
      details:
        `Comparison counts: ${comparisons
          .map(({ label, errors }) => `${label} (${errors.length})`)
          .join(", ")}. ` +
        `Unique disputed facts: ${unique_facts.join("; ")}. Full extraction artifacts are retained for audit.`,
    }
  }

  const retainPrimaryWithConsensusWarning = async (): Promise<PrimaryEvidenceExtraction> => {
    const audit = getConsensusFailureAudit()
    await Bun.write(join(execution.job_dir, "evidence-consensus-audit.txt"), `${audit.details}\n`)
    const shown_checks = audit.disputed_checks.slice(0, 12)
    const warning =
      `Independent datasheet extractions did not fully agree after ${valid_disagreements.length} valid verification attempts. ` +
      "The intrinsically valid primary extraction was retained because no independent value achieved consensus; the output remains available, but disputed footprint and application details are unverified. " +
      `Disputed checks: ${shown_checks.join(", ")}${
        audit.disputed_checks.length > shown_checks.length
          ? `, and ${audit.disputed_checks.length - shown_checks.length} more`
          : ""
      }. Full details are in evidence-consensus-audit.txt and the retained extraction artifacts.`
    await execution.addWarning(warning)
    execution.updateValidation({ evidence: "warning" })
    await execution.append(
      "system",
      "Evidence consensus remained split; retaining the intrinsically valid primary extraction instead of promoting an unconfirmed medoid candidate, and publishing the uncertainty as a warning.\n",
    )
    return primary_evidence
  }

  const retainPrimaryWithoutIndependentVerification = async (
    reason: string,
  ): Promise<PrimaryEvidenceExtraction> => {
    await execution.addWarning(
      `The primary datasheet extraction passed its intrinsic checks, but independent verification could not complete: ${reason}. Verify the footprint and application details before production use.`,
    )
    execution.updateValidation({ evidence: "warning" })
    await execution.append(
      "system",
      "Independent evidence verification was unavailable; continuing with the valid primary extraction and publishing the limitation as a warning.\n",
    )
    return primary_evidence
  }

  const getTargetedConsensusFeedback = (): string => {
    const differences = new Set<string>()
    for (const disagreement of valid_disagreements) {
      for (const error of disagreement.primary_errors) differences.add(error)
    }
    for (let left_index = 0; left_index < valid_disagreements.length; left_index += 1) {
      for (let right_index = left_index + 1; right_index < valid_disagreements.length; right_index += 1) {
        const left = valid_disagreements.at(left_index)
        const right = valid_disagreements.at(right_index)
        if (!left || !right) continue
        for (const error of getPairwiseErrors(left.evidence, right.evidence)) differences.add(error)
      }
    }
    return [...differences].join("; ").slice(0, 6_000)
  }

  for (let attempt = 1; attempt <= max_extraction_attempts; attempt += 1) {
    let independently_verified: IndependentEvidence
    try {
      independently_verified = await extractIndependentComponentEvidence({
        context: execution.context,
        job_dir: execution.job_dir,
        signal: execution.cancellation_signal,
        append: execution.append.bind(execution),
        additional_instructions: execution.additional_instructions,
        retry_feedback: independent_retry_feedback,
        protected_event_log_file: execution.protected_event_log_file,
        published_event_log_file: execution.published_event_log_file,
        attempt,
      })
    } catch (error) {
      if (!canRetryEvidenceFailure(error)) throw error
      const reason = error instanceof Error ? error.message : String(error)
      last_retryable_error = reason
      if (attempt < max_extraction_attempts) {
        independent_retry_feedback = reason
        await execution.append(
          "system",
          `Independent evidence attempt ${attempt} could not complete (${reason}). Retrying verification automatically without consuming a consensus vote…\n`,
        )
        continue
      }
      if (valid_disagreements.length > 0) return retainPrimaryWithConsensusWarning()
      return retainPrimaryWithoutIndependentVerification(
        `independent extraction could not complete after ${attempt} attempt(s): ${reason}`,
      )
    }

    const intrinsic_errors = [
      ...getComponentEvidenceBlockingReasons(independently_verified.component_evidence),
      ...getFootprintEvidenceErrors(
        independently_verified.component_evidence,
        independently_verified.footprint_plan,
      ),
    ]
    if (intrinsic_errors.length > 0) {
      const reason = intrinsic_errors.join("; ")
      last_retryable_error = reason
      if (attempt < max_extraction_attempts) {
        independent_retry_feedback = reason
        await execution.append(
          "system",
          `Independent evidence attempt ${attempt} was incomplete (${reason}). Retrying verification automatically without consuming a consensus vote…\n`,
        )
        continue
      }
      break
    }

    const primary_component_errors = getIndependentComponentEvidenceErrors(
      primary_evidence.component_evidence,
      independently_verified.component_evidence,
    )
    const primary_application_errors = getTypicalApplicationPlanAgreementErrors({
      primary: primary_evidence.typical_application_plan,
      independent: independently_verified.application_plan,
      target_part_number: primary_evidence.component_evidence.part_number.value,
    })
    const comparison_errors = [...primary_component_errors, ...primary_application_errors]
    if (comparison_errors.length === 0) {
      const accepted_differences = getIndependentComponentEvidenceAcceptedDifferences(
        primary_evidence.component_evidence,
        independently_verified.component_evidence,
      )
      for (const difference of accepted_differences) {
        await execution.append("system", `Accepted evidence difference: ${difference}.\n`)
      }
      if (valid_disagreements.length > 0) {
        await execution.append(
          "system",
          `Evidence consensus recovered on independent attempt ${attempt}; the primary extraction is retained.\n`,
        )
      } else if (last_retryable_error) {
        await execution.append(
          "system",
          `Evidence verification recovered on independent attempt ${attempt} after an earlier incomplete attempt; the primary extraction is retained.\n`,
        )
      }
      return primary_evidence
    }

    for (const previous of valid_disagreements) {
      if (getPairwiseErrors(previous.evidence, independently_verified).length === 0) {
        const promoted = await promoteIndependentConsensus({
          execution,
          independently_verified,
          attempt,
        })
        await execution.append(
          "system",
          `Independent evidence consensus overrode the primary extraction after ${attempt} extraction attempt(s) (${comparison_errors.join("; ")}). Recovery matched independent attempts ${previous.attempt} and ${attempt}; their canonical evidence is retained for generation.\n`,
        )
        return promoted
      }
    }

    valid_disagreements.push({
      attempt,
      evidence: independently_verified,
      primary_component_errors,
      primary_application_errors,
      primary_errors: comparison_errors,
    })
    const domain_consensus = getDomainConsensusCandidate()
    if (domain_consensus) {
      const promoted = await promoteIndependentConsensus({
        execution,
        independently_verified: domain_consensus.evidence,
        attempt: domain_consensus.attempt,
      })
      await execution.append(
        "system",
        `Domain-level evidence consensus recovered on independent attempt ${attempt}. Independent attempt ${domain_consensus.attempt} is retained because its component evidence and typical-application plan are each supported by a separate extraction.\n`,
      )
      return promoted
    }
    if (valid_disagreements.length >= max_valid_disagreements) {
      return retainPrimaryWithConsensusWarning()
    }

    independent_retry_feedback =
      valid_disagreements.length === 1
        ? "A prior independent extraction disagreed with the primary evidence. Perform a fresh extraction without assuming either result."
        : `Multiple valid independent extractions disagree on critical evidence. This is a recovery tie-breaker${
            valid_disagreements.length >= 3 ? " and final targeted adjudication" : ""
          }. Re-inspect the original datasheet pixels from scratch and resolve each exact difference below from its cited table or diagram. Concentrate on dimension-leader endpoints, calculated pad centers, every visibly wired configuration pin, and whether depicted system blocks are parts or external interfaces. Do not average prior values.\n\nExact unresolved differences:\n${getTargetedConsensusFeedback()}`
    await execution.append(
      "system",
      valid_disagreements.length === 1
        ? `Independent evidence attempt ${attempt} disagreed with the primary extraction (${comparison_errors.join("; ")}). Retrying with another independent verification…\n`
        : `Independent evidence remains split after attempt ${attempt} (${comparison_errors.join("; ")}). ${
            valid_disagreements.length >= 3
              ? "Running one final targeted adjudication of the exact disputed facts"
              : "Running a recovery tie-breaker verification"
          }…\n`,
    )
  }

  if (valid_disagreements.length > 0) return retainPrimaryWithConsensusWarning()
  return retainPrimaryWithoutIndependentVerification(
    `no valid independent verification was produced after ${max_extraction_attempts} attempt(s)${last_retryable_error ? `: ${last_retryable_error}` : ""}`,
  )
}

async function promoteIndependentConsensus(input: {
  execution: JobExecution
  independently_verified: Awaited<ReturnType<typeof extractIndependentComponentEvidence>>
  attempt: number
}): Promise<PrimaryEvidenceExtraction> {
  const { execution, independently_verified, attempt } = input
  const component_evidence_text = `${JSON.stringify(independently_verified.component_evidence, null, 2)}\n`
  const footprint_plan_text = `${JSON.stringify(independently_verified.footprint_plan, null, 2)}\n`
  const typical_application_plan_text = `${JSON.stringify(independently_verified.application_plan, null, 2)}\n`
  const retained_visual_reference_dir = join(
    execution.job_dir,
    "evidence-attempts",
    `independent-${attempt}`,
    "visual-reference",
  )
  await Promise.all([
    Bun.write(join(execution.job_dir, "component-evidence.json"), component_evidence_text),
    Bun.write(join(execution.job_dir, "footprint-plan.json"), footprint_plan_text),
    Bun.write(join(execution.job_dir, "typical-application-plan.json"), typical_application_plan_text),
    cp(
      join(retained_visual_reference_dir, "land-pattern.png"),
      join(execution.job_dir, "visual-reference", "land-pattern.png"),
    ),
    independently_verified.application_plan.availability === "documented"
      ? cp(
          join(retained_visual_reference_dir, "typical-application.png"),
          join(execution.job_dir, "visual-reference", "typical-application.png"),
        )
      : rm(join(execution.job_dir, "visual-reference", "typical-application.png"), { force: true }),
  ])
  return {
    component_evidence: independently_verified.component_evidence,
    component_evidence_text,
    footprint_plan: independently_verified.footprint_plan,
    footprint_plan_text,
    typical_application_plan: independently_verified.application_plan,
    typical_application_plan_text,
  }
}

export async function runEvidencePhase(execution: JobExecution): Promise<ApprovedJobEvidence> {
  throwIfCancelled(execution.cancellation_signal)
  await execution.append(
    "system",
    "Starting the evidence-only extraction phase; no circuit code will be generated until the evidence agrees…\n",
  )
  const primary_evidence = await extractPrimaryEvidence(execution)
  execution.context.job_store.updateJob(execution.job_id, { evidence_available: true })

  throwIfCancelled(execution.cancellation_signal)
  await execution.append(
    "system",
    "\nRunning an independent extraction pass; critical evidence must agree before code generation…\n",
  )
  const approved_evidence = await verifyEvidenceIndependently(primary_evidence, execution)
  execution.context.job_store.updateJob(execution.job_id, {
    typical_application_title:
      approved_evidence.typical_application_plan.availability === "documented"
        ? approved_evidence.typical_application_plan.title
        : undefined,
  })

  const component_schematic_plan = createComponentSchematicPlan(approved_evidence.component_evidence)
  const component_schematic_plan_text = `${JSON.stringify(component_schematic_plan, null, 2)}\n`
  await Bun.write(join(execution.job_dir, "component-schematic-plan.json"), component_schematic_plan_text)
  const locked_visual_references = await snapshotProtectedTree(join(execution.job_dir, "visual-reference"))
  if (execution.validation.evidence === "pending") execution.updateValidation({ evidence: "passed" })
  await execution.append(
    "system",
    execution.validation.evidence === "warning"
      ? "Evidence selected with a warning. The best-supported evidence is locked; all extraction artifacts are retained for audit.\n"
      : "Evidence approved. The consensus-selected evidence is locked; all extraction artifacts are retained for audit.\n",
  )
  return {
    component_evidence: approved_evidence.component_evidence,
    component_evidence_text: approved_evidence.component_evidence_text,
    component_schematic_plan,
    component_schematic_plan_text,
    footprint_plan: approved_evidence.footprint_plan,
    footprint_plan_text: approved_evidence.footprint_plan_text,
    typical_application_plan: approved_evidence.typical_application_plan,
    typical_application_plan_text: approved_evidence.typical_application_plan_text,
    locked_visual_references,
  }
}
