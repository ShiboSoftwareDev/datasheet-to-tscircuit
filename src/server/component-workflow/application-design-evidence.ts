import { parseApplicationSourceReferences, type ApplicationSourceReference } from "./application-plan"

export const APPLICATION_DESIGN_EVIDENCE_VERSION = 1 as const

const EVIDENCE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_FACTS_PER_GROUP = 128

export interface ApplicationDesignFact {
  evidence_id: string
  statement: string
  source_references: ApplicationSourceReference[]
}

export interface ApplicationDesignEvidence {
  version: typeof APPLICATION_DESIGN_EVIDENCE_VERSION
  capabilities: ApplicationDesignFact[]
  constraints: ApplicationDesignFact[]
  prohibited_uses: ApplicationDesignFact[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .sort()
  if (unexpected.length > 0) throw new Error(`${label} contains unsupported fields: ${unexpected.join(", ")}`)
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function parseFacts(input: {
  value: unknown
  label: string
  allow_unmaterialized_pdf_visual: boolean
  seen_ids: Set<string>
}): ApplicationDesignFact[] {
  if (!Array.isArray(input.value) || input.value.length > MAX_FACTS_PER_GROUP) {
    throw new Error(`${input.label} must be an array of at most ${MAX_FACTS_PER_GROUP} facts`)
  }
  return input.value.map((raw_fact, index) => {
    const label = `${input.label}[${index}]`
    if (!isRecord(raw_fact)) throw new Error(`${label} must be an object`)
    assertOnlyKeys(raw_fact, ["evidence_id", "statement", "source_references"], label)
    const evidence_id = requiredText(raw_fact.evidence_id, `${label}.evidence_id`)
    if (!EVIDENCE_ID_PATTERN.test(evidence_id)) {
      throw new Error(`${label}.evidence_id must be a lowercase hyphenated identifier`)
    }
    if (input.seen_ids.has(evidence_id)) {
      throw new Error(`application design evidence repeats evidence_id ${evidence_id}`)
    }
    input.seen_ids.add(evidence_id)
    const source_references = parseApplicationSourceReferences({
      value: raw_fact.source_references,
      label: `${label}.source_references`,
      allow_unmaterialized_pdf_visual: input.allow_unmaterialized_pdf_visual,
    })
    if (
      source_references.some(
        ({ method, confidence }) =>
          method === "calculated" || method === "package_standard" || confidence === "low",
      )
    ) {
      throw new Error(`${label} must use medium- or high-confidence datasheet evidence`)
    }
    return {
      evidence_id,
      statement: requiredText(raw_fact.statement, `${label}.statement`),
      source_references,
    }
  })
}

function parseWithOptions(
  value: unknown,
  options: { allow_unmaterialized_pdf_visual: boolean },
): ApplicationDesignEvidence {
  if (!isRecord(value) || value.version !== APPLICATION_DESIGN_EVIDENCE_VERSION) {
    throw new Error("application-design-evidence.json must be a version-1 artifact")
  }
  assertOnlyKeys(
    value,
    ["version", "capabilities", "constraints", "prohibited_uses"],
    "application-design-evidence.json",
  )
  const seen_ids = new Set<string>()
  const capabilities = parseFacts({
    value: value.capabilities,
    label: "application design capabilities",
    allow_unmaterialized_pdf_visual: options.allow_unmaterialized_pdf_visual,
    seen_ids,
  })
  const constraints = parseFacts({
    value: value.constraints,
    label: "application design constraints",
    allow_unmaterialized_pdf_visual: options.allow_unmaterialized_pdf_visual,
    seen_ids,
  })
  const prohibited_uses = parseFacts({
    value: value.prohibited_uses,
    label: "application design prohibited_uses",
    allow_unmaterialized_pdf_visual: options.allow_unmaterialized_pdf_visual,
    seen_ids,
  })
  if (capabilities.length === 0) {
    throw new Error("application design evidence must include at least one supported capability")
  }
  if (constraints.length === 0) {
    throw new Error("application design evidence must include at least one implementation constraint")
  }
  return { version: 1, capabilities, constraints, prohibited_uses }
}

export function parseApplicationDesignEvidence(value: unknown): ApplicationDesignEvidence {
  return parseWithOptions(value, { allow_unmaterialized_pdf_visual: false })
}

export function parseUnmaterializedApplicationDesignEvidence(value: unknown): ApplicationDesignEvidence {
  return parseWithOptions(value, { allow_unmaterialized_pdf_visual: true })
}

export function applicationDesignEvidenceSources(
  evidence: ApplicationDesignEvidence,
): ApplicationSourceReference[] {
  return [...evidence.capabilities, ...evidence.constraints, ...evidence.prohibited_uses].flatMap(
    ({ source_references }) => source_references,
  )
}

export function rewriteApplicationDesignEvidenceSources(
  evidence: ApplicationDesignEvidence,
  rewrite: (source: ApplicationSourceReference) => ApplicationSourceReference,
): ApplicationDesignEvidence {
  const rewriteFacts = (facts: ApplicationDesignFact[]) =>
    facts.map((fact) => ({
      ...fact,
      source_references: fact.source_references.map(rewrite),
    }))
  return {
    version: 1,
    capabilities: rewriteFacts(evidence.capabilities),
    constraints: rewriteFacts(evidence.constraints),
    prohibited_uses: rewriteFacts(evidence.prohibited_uses),
  }
}
