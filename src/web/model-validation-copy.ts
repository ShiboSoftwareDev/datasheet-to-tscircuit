import type { ModelValidationSummary } from "@/shared/job-types"

export function getChampionValidationCopy(
  validation: Pick<ModelValidationSummary, "benchmark_count" | "passing_count"> | undefined,
): string {
  if (!validation) return "Not validated"
  return `${validation.passing_count}/${validation.benchmark_count} passing`
}
