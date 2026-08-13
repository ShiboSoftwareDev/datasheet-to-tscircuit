import type { ComponentEvidence } from "../component-evidence"
import { getApplicationTargetPinCoverageErrors } from "./application-connectivity-verification"
import type { ApplicationDesignEvidence } from "./application-design-evidence"
import {
  executableApplicationPassiveType,
  tscircuitApplicationPassiveValue,
} from "./application-passive-kind"
import {
  applicationTargetIdentityFromEvidence,
  isRecord,
  parseTypicalApplicationPlan,
  type TypicalApplicationPlan,
} from "./application-plan"

const APPLICATION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_GENERATED_APPLICATIONS = 12

export interface GeneratedApplicationPlan {
  application_id: string
  title: string
  description: string
  rationale: string
  evidence_ids: string[]
  pcb_implementation: "schematic_only"
  components: TypicalApplicationPlan["components"]
  connections: TypicalApplicationPlan["connections"]
}

export interface GeneratedApplicationPlanSet {
  version: 1
  applications: GeneratedApplicationPlan[]
}

export type ApplicationPlanCatalogEntry =
  | {
      application_id: "reference"
      origin: "datasheet_reference"
      title: string
      plan: TypicalApplicationPlan
    }
  | {
      application_id: string
      origin: "ai_generated"
      title: string
      plan: GeneratedApplicationPlan
    }

export interface ApplicationPlanCatalog {
  version: 1
  default_application_id: string
  applications: ApplicationPlanCatalogEntry[]
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

function normalizedReference(value: string): string {
  return value.trim().toLowerCase()
}

function externalIntegrationRole(endpoint: string): string {
  const words = endpoint
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  const compact = words.join("")
  const has = (...candidates: string[]): boolean => candidates.some((candidate) => words.includes(candidate))

  if (
    ["pgood", "powergood", "powerok", "powerready", "railgood", "railready", "supplygood"].includes(
      compact,
    ) ||
    (has("power", "rail", "supply", "rails") && has("good", "ok", "ready"))
  ) {
    return "power_good"
  }
  if (has("switched", "gated", "removable", "isolated")) return "switched_domain"
  if (compact === "oe" || compact === "en" || has("enable", "disable", "shutdown")) return "enable"
  if (has("interrupt", "irq")) return "interrupt"
  if (has("fault", "alert")) return "fault"
  if (has("reset")) return "reset"
  if (has("mode", "select", "config", "configuration")) return "configuration"
  if (has("monitor", "sense", "feedback")) return "feedback"
  if (has("clock", "clk")) return "clock"
  return "signal"
}

function planTopologySignature(plan: {
  components: TypicalApplicationPlan["components"]
  connections: TypicalApplicationPlan["connections"]
}): string {
  const componentKind = (reference: string): string =>
    plan.components.find(
      (component) => normalizedReference(component.reference) === normalizedReference(reference),
    )?.kind ?? "unknown"
  return JSON.stringify(
    plan.connections
      .map((connection) =>
        connection.pins
          .map((endpoint) => {
            const separator = endpoint.indexOf(".")
            if (separator < 0) return `external.${externalIntegrationRole(endpoint)}`
            const reference = endpoint.slice(0, separator)
            const terminal = endpoint
              .slice(separator + 1)
              .trim()
              .toLowerCase()
            return normalizedReference(reference) === "u1"
              ? `u1.${terminal}`
              : `${componentKind(reference).trim().toLowerCase()}.${terminal}`
          })
          .sort(),
      )
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  )
}

function designEvidenceIds(evidence: ApplicationDesignEvidence): string[] {
  return [...evidence.capabilities, ...evidence.constraints, ...evidence.prohibited_uses].map(
    ({ evidence_id }) => evidence_id,
  )
}

function parseGeneratedApplication(input: {
  value: unknown
  index: number
  component_evidence: ComponentEvidence
  design_evidence: ApplicationDesignEvidence
  reference_plan: TypicalApplicationPlan
}): GeneratedApplicationPlan {
  const label = `generated application plans[${input.index}]`
  if (!isRecord(input.value)) throw new Error(`${label} must be an object`)
  assertOnlyKeys(
    input.value,
    [
      "application_id",
      "title",
      "description",
      "rationale",
      "evidence_ids",
      "pcb_implementation",
      "components",
      "connections",
    ],
    label,
  )
  const application_id = requiredText(input.value.application_id, `${label}.application_id`)
  if (!APPLICATION_ID_PATTERN.test(application_id) || application_id === "reference") {
    throw new Error(`${label}.application_id must be a non-reference lowercase hyphenated identifier`)
  }
  if (input.value.pcb_implementation !== "schematic_only") {
    throw new Error(`${label}.pcb_implementation must be schematic_only`)
  }
  if (!Array.isArray(input.value.evidence_ids) || input.value.evidence_ids.length === 0) {
    throw new Error(`${label}.evidence_ids must identify grounding design facts`)
  }
  const known_ids = designEvidenceIds(input.design_evidence)
  const evidence_ids = [
    ...new Set(
      input.value.evidence_ids.map((value, index) => requiredText(value, `${label}.evidence_ids[${index}]`)),
    ),
  ].sort((left, right) => left.localeCompare(right))
  const unknown_id = evidence_ids.find((evidence_id) => !known_ids.includes(evidence_id))
  if (unknown_id) throw new Error(`${label} cites unknown design evidence ${unknown_id}`)
  const capability_ids = input.design_evidence.capabilities.map(({ evidence_id }) => evidence_id)
  const constraint_ids = input.design_evidence.constraints.map(({ evidence_id }) => evidence_id)
  if (!evidence_ids.some((evidence_id) => capability_ids.includes(evidence_id))) {
    throw new Error(`${label} must cite at least one supported capability`)
  }
  if (!evidence_ids.some((evidence_id) => constraint_ids.includes(evidence_id))) {
    throw new Error(`${label} must cite at least one implementation constraint`)
  }
  if (!Array.isArray(input.value.components)) throw new Error(`${label}.components must be an array`)
  const target_components = input.value.components.filter(
    (component) =>
      isRecord(component) &&
      typeof component.reference === "string" &&
      normalizedReference(component.reference) === "u1",
  )
  if (target_components.length !== 1) throw new Error(`${label} must contain exactly one target U1`)
  const target_identity = applicationTargetIdentityFromEvidence(input.component_evidence)
  const components = input.value.components.map((component) =>
    component === target_components[0]
      ? {
          ...component,
          reference: "U1",
          value: target_identity.part_number,
          manufacturer_part_number: target_identity.ordering_code ?? target_identity.part_number,
        }
      : component,
  )
  const grounding_source = [...input.design_evidence.capabilities, ...input.design_evidence.constraints].find(
    ({ evidence_id }) => evidence_ids.includes(evidence_id),
  )?.source_references[0]
  const fallback_source = input.reference_plan.source_references[0]
  const source_reference = grounding_source ?? fallback_source
  if (!source_reference) throw new Error(`${label} has no grounding datasheet source`)
  const executable_plan = parseTypicalApplicationPlan(
    {
      version: 4,
      availability: "documented",
      pcb_implementation: "schematic_only",
      title: requiredText(input.value.title, `${label}.title`),
      description: requiredText(input.value.description, `${label}.description`),
      source_references: [source_reference],
      components,
      connections: input.value.connections,
    },
    target_identity,
  )
  for (const component of executable_plan.components) {
    const passive_type = executableApplicationPassiveType(component.kind)
    if (!passive_type || passive_type === "diode") continue
    if (!component.value || !tscircuitApplicationPassiveValue(component.value)) {
      throw new Error(
        `${label}.components ${component.reference} must give its ${passive_type} a concrete executable numeric value; put dielectric, tolerance, and other descriptive text in purpose instead`,
      )
    }
  }
  const coverage_errors = getApplicationTargetPinCoverageErrors({
    availability: "documented",
    connections: executable_plan.connections,
    evidence: input.component_evidence,
    subject: `Generated application ${application_id}`,
  })
  if (coverage_errors.length > 0) {
    throw new AggregateError(coverage_errors, `${label} does not cover the component pin contract`)
  }
  return {
    application_id,
    title: executable_plan.title,
    description: executable_plan.description,
    rationale: requiredText(input.value.rationale, `${label}.rationale`),
    evidence_ids,
    pcb_implementation: "schematic_only",
    components: executable_plan.components,
    connections: executable_plan.connections,
  }
}

export function parseGeneratedApplicationPlanSet(input: {
  value: unknown
  component_evidence: ComponentEvidence
  design_evidence: ApplicationDesignEvidence
  reference_plan: TypicalApplicationPlan
}): GeneratedApplicationPlanSet {
  if (!isRecord(input.value) || input.value.version !== 1) {
    throw new Error("generated-application-plans.json must be a version-1 artifact")
  }
  assertOnlyKeys(input.value, ["version", "applications"], "generated-application-plans.json")
  if (
    !Array.isArray(input.value.applications) ||
    input.value.applications.length > MAX_GENERATED_APPLICATIONS
  ) {
    throw new Error(
      `generated-application-plans.json applications must contain at most ${MAX_GENERATED_APPLICATIONS} entries`,
    )
  }
  const applications = input.value.applications.map((value, index) =>
    parseGeneratedApplication({ ...input, value, index }),
  )
  const ids = applications.map(({ application_id }) => application_id)
  if (new Set(ids).size !== ids.length) throw new Error("generated application ids must be unique")
  const titles = applications.map(({ title }) => title.trim().toLowerCase())
  if (new Set(titles).size !== titles.length) throw new Error("generated application titles must be unique")
  const signatures = [
    ...(input.reference_plan.availability === "documented"
      ? [planTopologySignature(input.reference_plan)]
      : []),
  ]
  for (const application of applications) {
    const signature = planTopologySignature(application)
    if (signatures.includes(signature)) {
      throw new Error(
        `generated application ${application.application_id} duplicates a reference or earlier application topology`,
      )
    }
    signatures.push(signature)
  }
  return { version: 1, applications }
}

export function createApplicationPlanCatalog(input: {
  reference_plan: TypicalApplicationPlan
  generated: GeneratedApplicationPlanSet
}): ApplicationPlanCatalog {
  const applications: ApplicationPlanCatalogEntry[] = [
    ...(input.reference_plan.availability === "documented"
      ? [
          {
            application_id: "reference" as const,
            origin: "datasheet_reference" as const,
            title: input.reference_plan.title,
            plan: input.reference_plan,
          },
        ]
      : []),
    ...input.generated.applications.map(
      (plan): ApplicationPlanCatalogEntry => ({
        application_id: plan.application_id,
        origin: "ai_generated",
        title: plan.title,
        plan,
      }),
    ),
  ]
  if (applications.length === 0) {
    throw new Error("Application planning produced neither a reference nor a supported generated application")
  }
  return {
    version: 1,
    default_application_id: applications[0]!.application_id,
    applications,
  }
}

export function parseApplicationPlanCatalog(input: {
  value: unknown
  reference_plan: TypicalApplicationPlan
  component_evidence: ComponentEvidence
  design_evidence: ApplicationDesignEvidence
}): ApplicationPlanCatalog {
  if (!isRecord(input.value) || input.value.version !== 1) {
    throw new Error("application-plan-catalog.json must be a version-1 artifact")
  }
  assertOnlyKeys(
    input.value,
    ["version", "default_application_id", "applications"],
    "application-plan-catalog.json",
  )
  if (!Array.isArray(input.value.applications)) {
    throw new Error("application-plan-catalog.json applications must be an array")
  }
  const expected_reference_count = input.reference_plan.availability === "documented" ? 1 : 0
  const raw_reference_entries = input.value.applications.filter(
    (entry) => isRecord(entry) && entry.origin === "datasheet_reference",
  )
  if (raw_reference_entries.length !== expected_reference_count) {
    throw new Error("application plan catalog must contain exactly its committed reference plan")
  }
  if (expected_reference_count === 1) {
    const reference = raw_reference_entries[0]!
    assertOnlyKeys(reference, ["application_id", "origin", "title", "plan"], "reference application")
    if (
      reference.application_id !== "reference" ||
      reference.title !== input.reference_plan.title ||
      JSON.stringify(reference.plan) !== JSON.stringify(input.reference_plan) ||
      input.value.applications[0] !== reference
    ) {
      throw new Error("The committed datasheet reference application must be first and unchanged")
    }
  }
  const raw_generated = input.value.applications.flatMap((entry, index) => {
    if (!isRecord(entry) || entry.origin !== "ai_generated") return []
    assertOnlyKeys(entry, ["application_id", "origin", "title", "plan"], `application catalog[${index}]`)
    if (!isRecord(entry.plan)) throw new Error(`application catalog[${index}].plan must be an object`)
    if (entry.application_id !== entry.plan.application_id || entry.title !== entry.plan.title) {
      throw new Error(`application catalog[${index}] identity does not match its plan`)
    }
    return [entry.plan]
  })
  if (raw_generated.length + expected_reference_count !== input.value.applications.length) {
    throw new Error("application plan catalog contains an unsupported origin")
  }
  const generated = parseGeneratedApplicationPlanSet({
    value: { version: 1, applications: raw_generated },
    component_evidence: input.component_evidence,
    design_evidence: input.design_evidence,
    reference_plan: input.reference_plan,
  })
  const parsed = createApplicationPlanCatalog({
    reference_plan: input.reference_plan,
    generated,
  })
  if (input.value.default_application_id !== parsed.default_application_id) {
    throw new Error(
      `application-plan-catalog.json default_application_id must be ${parsed.default_application_id}`,
    )
  }
  return parsed
}

export function executablePlanFromCatalogEntry(entry: ApplicationPlanCatalogEntry): TypicalApplicationPlan {
  if (entry.origin === "datasheet_reference") return entry.plan
  return {
    version: 4,
    availability: "documented",
    pcb_implementation: "schematic_only",
    title: entry.plan.title,
    description: entry.plan.description,
    source_references: [],
    components: entry.plan.components,
    connections: entry.plan.connections,
  }
}
