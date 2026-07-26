interface PhysicalUnit {
  dimension: "current" | "voltage"
  scale_to_base: number
}

function parsePhysicalUnit(value: string): PhysicalUnit | undefined {
  switch (value.trim().replaceAll("μ", "u").replaceAll("µ", "u").toLowerCase()) {
    case "v":
      return { dimension: "voltage", scale_to_base: 1 }
    case "mv":
      return { dimension: "voltage", scale_to_base: 1e-3 }
    case "uv":
      return { dimension: "voltage", scale_to_base: 1e-6 }
    case "a":
      return { dimension: "current", scale_to_base: 1 }
    case "ma":
      return { dimension: "current", scale_to_base: 1e-3 }
    case "ua":
      return { dimension: "current", scale_to_base: 1e-6 }
    case "na":
      return { dimension: "current", scale_to_base: 1e-9 }
    default:
      return undefined
  }
}

export interface DocumentedStimulusRange {
  low: number
  high: number
  label: string
}

export function isEnableStimulusSeries(input: { title: string; series_id: string }): boolean {
  return /\ben(?:able)?\b/i.test(`${input.series_id} ${input.title}`)
}

export function findDocumentedStimulusRange(input: {
  conditions: string
  title: string
  series_id: string
  series_unit: string
}): DocumentedStimulusRange | undefined {
  const series_label = `${input.series_id} ${input.title}`.toLowerCase()
  const condition_labels = /\bload\s+current\b|\biload\b/.test(series_label)
    ? String.raw`(?:\bI\s*O\b|\bload\s+current\b)`
    : /\binput\s+voltage\b|\bvin\b|\bvi\b/.test(series_label)
      ? String.raw`(?:\bV\s*I\b|\binput\s+voltage\b)`
      : /\bbus\s+voltage\b|\bvbus\b/.test(series_label)
        ? String.raw`(?:\bV\s*BUS\b|\bbus(?:\s+voltage)?(?:\s+step)?\b)`
        : isEnableStimulusSeries(input)
          ? String.raw`(?:\bEN\b|\benable(?:\s+voltage)?\b)`
          : undefined
  if (!condition_labels) return undefined

  const number = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)`
  const unit = String.raw`(?:[munµμ]?[AV])`
  const match = input.conditions.match(
    new RegExp(
      String.raw`${condition_labels}\s*(?:=|:|from)?\s*(${number})\s*(${unit})\s*(?:to|through|→|[-–—])\s*(${number})\s*(${unit})`,
      "i",
    ),
  )
  if (!match) return undefined
  const first_unit = parsePhysicalUnit(match[2]!)
  const second_unit = parsePhysicalUnit(match[4]!)
  const series_unit = parsePhysicalUnit(input.series_unit)
  if (
    !first_unit ||
    !second_unit ||
    !series_unit ||
    first_unit.dimension !== second_unit.dimension ||
    first_unit.dimension !== series_unit.dimension
  ) {
    return undefined
  }
  const first = (Number(match[1]) * first_unit.scale_to_base) / series_unit.scale_to_base
  const second = (Number(match[3]) * second_unit.scale_to_base) / series_unit.scale_to_base
  if (!Number.isFinite(first) || !Number.isFinite(second) || first === second) return undefined
  return {
    low: Math.min(first, second),
    high: Math.max(first, second),
    label: match[0],
  }
}
