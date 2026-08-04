import type { ModelFamily, ModelStrategyId } from "./types"

export interface ModelStrategy {
  readonly id: ModelStrategyId
  readonly version: string
  readonly supported_families: readonly ModelFamily[] | "all"
  readonly guidance: string
}

const DEFAULT_STRATEGIES: readonly ModelStrategy[] = [
  {
    id: "equation",
    version: "1",
    supported_families: ["passive", "diode", "bjt", "mosfet", "opamp", "comparator", "sensor"],
    guidance:
      "Use continuous equations and a small number of datasheet parameters. Fit across the declared operating range, not at isolated validation coordinates.",
  },
  {
    id: "behavioral",
    version: "2",
    supported_families: "all",
    guidance:
      "Use causal state and electrical inputs for behavior that cannot be represented by a compact primitive model. Expose unsupported digital protocol behavior as a limitation.",
  },
  {
    id: "hybrid",
    version: "2",
    supported_families: "all",
    guidance:
      "Combine physical primitives with bounded behavioral sources where that materially improves convergence or captures documented control behavior.",
  },
]

const POWER_CONVERTER_GUIDANCE = `For power converters, use an averaged closed-loop regulator model. A robust starting topology is a bounded Thevenin-like output behind a positive finite output resistance, with positive C/L state only on private controller nodes. Drive that state from the public output-voltage regulation error (target minus measured output), so an external load step naturally causes droop or overshoot and the controller then restores regulation over the datasheet timescale. MODE, EN, VIN, and other public pins may select documented operating parameters.

The server-owned application fixture is the only owner of output/load capacitance, inductance, resistance, and load stimulus. Do not reproduce or cancel fixture passives inside the DUT; do not sense a duplicate capacitor through a zero-volt branch; do not inject a fixed current chosen to equal the fixture's baseline load; and do not add an output-connected fast state or equalizer chosen to disappear before the first reference sample. Internal controller state must remain causally active over the measured response and affect the output through the regulator loop.`

export class ModelStrategyRegistry {
  readonly strategies: readonly ModelStrategy[]

  constructor(strategies: readonly ModelStrategy[] = DEFAULT_STRATEGIES) {
    const ids = strategies.map(({ id }) => id)
    if (new Set(ids).size !== ids.length) throw new Error("Model strategy ids must be unique")
    this.strategies = strategies.map((strategy) => ({ ...strategy }))
  }

  require(id: ModelStrategyId, family: ModelFamily): ModelStrategy {
    const strategy = this.strategies.find((candidate) => candidate.id === id)
    if (!strategy) throw new Error(`Unknown model strategy ${id}`)
    if (strategy.supported_families !== "all" && !strategy.supported_families.includes(family)) {
      throw new Error(`Model strategy ${id} does not support family ${family}`)
    }
    if (family !== "power_converter") return strategy
    return {
      ...strategy,
      guidance: `${strategy.guidance}\n\n${POWER_CONVERTER_GUIDANCE}`,
    }
  }
}
