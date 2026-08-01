import type { ModelContract, ModelReferencePoint } from "./types"

export const MIN_FRESH_REFERENCE_CURVE_POINTS = 8

export interface ReferenceCurvePartition {
  training_points: ModelReferencePoint[]
  withheld_points: ModelReferencePoint[]
}

/**
 * Keeps the curve endpoints and alternating interior samples for model fitting.
 * The complementary interior samples stay private to server-side validation.
 *
 * New characterizations are required to contain enough points for a meaningful
 * split. The fallback for shorter curves exists only so immutable version-1
 * contracts remain usable: whenever an interior point exists, at least one is
 * still withheld.
 */
export function partitionReferenceCurvePoints(
  points: readonly ModelReferencePoint[],
): ReferenceCurvePartition {
  if (points.length <= 2) {
    return {
      training_points: points.map(({ x, y }) => ({ x, y })),
      withheld_points: [],
    }
  }

  const interior_indices = Array.from({ length: points.length - 2 }, (_, index) => index + 1)
  let withheld_indices = interior_indices.filter((_, index) => index % 2 === 1)
  if (withheld_indices.length === 0) {
    withheld_indices = [interior_indices[Math.floor(interior_indices.length / 2)]!]
  }
  const withheld = new Set(withheld_indices)

  return {
    training_points: points.flatMap((point, index) =>
      withheld.has(index) ? [] : [{ x: point.x, y: point.y }],
    ),
    withheld_points: points.flatMap((point, index) =>
      withheld.has(index) ? [{ x: point.x, y: point.y }] : [],
    ),
  }
}

/**
 * Returns the deterministic model-authoring view of a version-1 contract.
 * Only modeled curve samples are filtered; scalar and documented-only evidence
 * is preserved. The input remains the authoritative full validation contract.
 */
export function createModelTrainingContract(contract: ModelContract): ModelContract {
  return {
    version: 1,
    ...(contract.application_fixture
      ? { application_fixture: structuredClone(contract.application_fixture) }
      : {}),
    interface: {
      ...contract.interface,
      pins: contract.interface.pins.map((pin) => ({ ...pin, labels: [...pin.labels] })),
    },
    characterization: {
      ...contract.characterization,
      requirements: contract.characterization.requirements.map((requirement) => {
        const reference_curve = requirement.reference_curve
          ? {
              ...requirement.reference_curve,
              points:
                requirement.support.status === "modeled"
                  ? partitionReferenceCurvePoints(requirement.reference_curve.points).training_points
                  : requirement.reference_curve.points.map(({ x, y }) => ({ x, y })),
            }
          : undefined
        return {
          ...requirement,
          support: { ...requirement.support },
          conditions: { ...requirement.conditions },
          expected: { ...requirement.expected },
          ...(reference_curve ? { reference_curve } : {}),
          sources: requirement.sources.map((source) => ({ ...source })),
        }
      }),
      assumptions: [...contract.characterization.assumptions],
      limitations: [...contract.characterization.limitations],
    },
  }
}
