import type { ModelFamily, ModelStrategyId } from "./types"

export interface ModelStrategy {
  readonly id: ModelStrategyId
  readonly version: string
  readonly supported_families: readonly ModelFamily[] | "all"
  readonly guidance: string
}

const DEFAULT_STRATEGIES: readonly ModelStrategy[] = [
  {
    id: "vendor",
    version: "1",
    supported_families: "all",
    guidance:
      "Prefer an official redistributable manufacturer macro-model when the datasheet or supplied files contain one. Preserve its equations and document its origin.",
  },
  {
    id: "equation",
    version: "1",
    supported_families: ["passive", "diode", "bjt", "mosfet", "opamp", "comparator", "sensor"],
    guidance:
      "Use continuous equations and a small number of datasheet parameters. Fit across the declared operating range, not at isolated validation coordinates.",
  },
  {
    id: "behavioral",
    version: "1",
    supported_families: "all",
    guidance:
      "Use causal state and electrical inputs for behavior that cannot be represented by a compact primitive model. Expose unsupported digital protocol behavior as a limitation.",
  },
  {
    id: "hybrid",
    version: "1",
    supported_families: "all",
    guidance:
      "Combine physical primitives with bounded behavioral sources where that materially improves convergence or captures documented control behavior.",
  },
]

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
    return strategy
  }
}
