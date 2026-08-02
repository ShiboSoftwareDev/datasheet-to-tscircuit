import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseComponentEvidence } from "@/server/component-evidence"
import {
  APPLICATION_CONNECTIVITY_REVIEW_SCHEMA_ID,
  applyApplicationConnectivityObservation,
  canonicalizeApplicationGraph,
  compareApplicationGraphs,
  installApplicationConnectivityObservation,
  observeApplicationConnectivity,
  parseApplicationConnectivityReview,
  verifyApplicationConnectivity,
} from "@/server/component-workflow/application-connectivity-verification"
import { parseTypicalApplicationPlan } from "@/server/component-workflow/application-plan"
import type { AgentClient } from "@/server/infrastructure/agent"

const source = { page: 17, method: "pdf_text", confidence: "high" }
const visual_source = {
  page: 36,
  method: "pdf_visual",
  confidence: "high",
  image: "visual-reference/land-pattern.png",
  render_dpi: 200,
}

const evidence = parseComponentEvidence({
  version: 1,
  status: "resolved",
  part_number: { value: "REGULATOR", sources: [source] },
  package: {
    name: { value: "TEST", sources: [source] },
    pin_count: { value: 3, sources: [source] },
  },
  pinout: {
    pins: [
      { number: "1", labels: ["VOUT"], role: "power_output", sources: [source] },
      { number: "2", labels: ["FB"], role: "input", sources: [source] },
      { number: "3", labels: ["GND"], role: "ground", sources: [source] },
    ],
  },
  footprint: {
    view: "pcb_top",
    units: "mm",
    drawing_orientation: { value: "pcb_top", sources: [visual_source] },
    pads: [
      { pin: "1", kind: "smt", x: -1, y: 0, width: 1, height: 1, sources: [visual_source] },
      { pin: "2", kind: "smt", x: 0, y: 1, width: 1, height: 1, sources: [visual_source] },
      { pin: "3", kind: "smt", x: 1, y: 0, width: 1, height: 1, sources: [visual_source] },
    ],
  },
  unresolved_ambiguities: [],
})

function requiredItem<T>(items: readonly T[], index: number): T {
  const item = items[index]
  if (item === undefined) throw new Error(`Missing test fixture item ${index}`)
  return item
}

const plan = parseTypicalApplicationPlan(
  {
    version: 4,
    availability: "documented",
    pcb_implementation: "schematic_only",
    title: "Feedback divider",
    description: "A documented divider.",
    source_references: [{ page: 17, figure: "Typical application" }],
    components: [
      { reference: "U1", kind: "integrated_circuit", value: "REGULATOR" },
      { reference: "R1", kind: "resistor", value: "10k" },
      { reference: "R2", kind: "resistor", value: "1k" },
    ],
    connections: [
      { net: "OUTPUT", pins: ["U1.VOUT", "R1.1"] },
      { net: "FEEDBACK", pins: ["U1.FB", "R1.2", "R2.1"] },
      { net: "GROUND", pins: ["U1.GND", "R2.2"] },
    ],
  },
  "REGULATOR",
)

function visibleComponents(reviewed_plan = plan) {
  return reviewed_plan.components.map(({ reference, kind, value, manufacturer_part_number }) => ({
    reference,
    kind,
    ...(value === undefined ? {} : { value }),
    ...(manufacturer_part_number === undefined ? {} : { manufacturer_part_number }),
  }))
}

function review(
  connections: Array<{ pins: string[] }>,
  reviewed_plan = plan,
  components = visibleComponents(reviewed_plan),
) {
  return parseApplicationConnectivityReview(
    {
      version: 1,
      availability: "documented",
      source: {
        page: 17,
        figure: "Typical application",
        method: "pdf_visual",
        confidence: "high",
        image: "visual-reference/typical-application.png",
        render_dpi: 200,
      },
      components,
      connections,
    },
    reviewed_plan,
  )
}

test("independent graph agreement ignores net names, ordering, and U1 pin aliases", () => {
  const verified = compareApplicationGraphs({
    plan,
    evidence,
    review: review([
      { pins: ["R2.2", "U1.3"] },
      { pins: ["R2.1", "R1.2", "U1.2"] },
      { pins: ["R1.1", "U1.1"] },
    ]),
  })
  expect(verified.status).toBe("verified")
  expect(verified.graph_sha256).toMatch(/^[a-f0-9]{64}$/)
})

test("independent inventory treats a drawn lamp and load as the same visible component kind", () => {
  const load_plan = parseTypicalApplicationPlan(
    {
      version: 4,
      availability: "documented",
      pcb_implementation: "schematic_only",
      title: "Switched load",
      description: "A documented load branch.",
      source_references: [{ page: 17, figure: "Typical application" }],
      components: [
        { reference: "U1", kind: "integrated_circuit", value: "REGULATOR" },
        { reference: "L1", kind: "load" },
      ],
      connections: [
        { net: "OUTPUT", pins: ["U1.VOUT", "L1.1"] },
        { net: "GROUND", pins: ["U1.GND", "L1.2"] },
      ],
    },
    "REGULATOR",
  )
  const reviewed_components = visibleComponents(load_plan).map((component) =>
    component.reference === "L1" ? { ...component, kind: "lamp" } : component,
  )
  const verified = compareApplicationGraphs({
    plan: load_plan,
    evidence,
    review: review([{ pins: ["U1.1", "L1.1"] }, { pins: ["U1.3", "L1.2"] }], load_plan, reviewed_components),
  })
  expect(verified.status).toBe("verified")
})

test("independent graph agreement rejects the agent-71 misplaced resistor endpoint", () => {
  expect(() =>
    compareApplicationGraphs({
      plan,
      evidence,
      review: review([
        { pins: ["U1.1", "R1.1"] },
        { pins: ["U1.2", "R2.1"] },
        { pins: ["U1.3", "R1.2", "R2.2"] },
      ]),
    }),
  ).toThrow("Independent application connectivity does not match")
})

test("independent graph agreement rejects the agent-72 R3 pull-up moved from VIN to VOUT", () => {
  const pullup_plan = parseTypicalApplicationPlan(
    {
      version: 4,
      availability: "documented",
      pcb_implementation: "schematic_only",
      title: "Status pull-up",
      description: "R3 is pulled up to VIN, not VOUT.",
      source_references: [{ page: 17, figure: "Typical application" }],
      components: [
        { reference: "U1", kind: "integrated_circuit", value: "REGULATOR" },
        { reference: "R3", kind: "resistor", value: "100k" },
        { reference: "C1", kind: "capacitor", value: "10uF" },
      ],
      connections: [
        { net: "VIN", pins: ["VIN", "C1.1", "R3.1"] },
        { net: "STATUS", pins: ["U1.FB", "R3.2"] },
        { net: "VOUT", pins: ["VOUT", "U1.VOUT"] },
        { net: "GND", pins: ["GND", "U1.GND", "C1.2"] },
      ],
    },
    "REGULATOR",
  )

  expect(() =>
    compareApplicationGraphs({
      plan: pullup_plan,
      evidence,
      review: review(
        [
          { pins: ["VIN", "C1.1"] },
          { pins: ["U1.2", "R3.2"] },
          { pins: ["VOUT", "U1.1", "R3.1"] },
          { pins: ["GND", "U1.3", "C1.2"] },
        ],
        pullup_plan,
      ),
    }),
  ).toThrow("Independent application connectivity does not match")
})

test("documented reviews distinguish extractor-owned images from independently discovered pages", () => {
  expect(() =>
    parseApplicationConnectivityReview(
      {
        version: 1,
        availability: "documented",
        source: {
          page: 18,
          method: "pdf_visual",
          confidence: "high",
          image: "visual-reference/typical-application.png",
          render_dpi: 200,
        },
        components: visibleComponents(plan),
        connections: [{ pins: ["U1.1", "VOUT"] }],
      },
      plan,
    ),
  ).toThrow("must omit the extractor-owned image")

  const independently_discovered = parseApplicationConnectivityReview(
    {
      version: 1,
      availability: "documented",
      source: {
        page: 18,
        method: "pdf_visual",
        confidence: "high",
      },
      components: visibleComponents(plan),
      connections: plan.connections.map(({ pins }) => ({ pins })),
    },
    plan,
  )
  expect(() => compareApplicationGraphs({ plan, evidence, review: independently_discovered })).toThrow(
    "reviewer found the documented application on PDF page 18",
  )
})

test("cached reviews are rebound when the extractor adopts a reviewer-discovered page", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "application-connectivity-rebind-"))
  try {
    const discovered_review = parseApplicationConnectivityReview(
      {
        version: 1,
        availability: "documented",
        source: {
          page: 18,
          figure: "Correct application",
          method: "pdf_visual",
          confidence: "high",
        },
        components: visibleComponents(plan),
        connections: plan.connections.map(({ pins }) => ({ pins })),
      },
      plan,
    )
    const corrected_plan = parseTypicalApplicationPlan(
      {
        ...plan,
        source_references: [{ page: 18, figure: "Correct application" }],
      },
      "REGULATOR",
    )
    const installed = installApplicationConnectivityObservation({
      workspace,
      plan: corrected_plan,
      observation: {
        version: 1,
        schema_id: APPLICATION_CONNECTIVITY_REVIEW_SCHEMA_ID,
        review: discovered_review,
        verifier_attempts: 1,
        verifier_agent_duration_ms: 13,
      },
    })

    expect(installed.review).toMatchObject({
      source: {
        page: 18,
        image: "visual-reference/typical-application.png",
        render_dpi: 200,
      },
    })
    const installed_review = await Bun.file(join(workspace, "application-connectivity-review.json")).json()
    expect(parseApplicationConnectivityReview(installed_review, corrected_plan)).toEqual(installed.review)
    if (installed.review.availability !== "documented") {
      throw new Error("Expected a documented cached observation")
    }
    expect(
      applyApplicationConnectivityObservation({
        plan: corrected_plan,
        evidence,
        observation: installed,
      }),
    ).toMatchObject({ status: "verified", source: installed.review.source })

    const absent_plan = parseTypicalApplicationPlan({
      version: 4,
      availability: "not_present",
      title: "No application",
      description: "No documented application was found.",
      source_references: [{ page: 18 }],
      searched_sections: ["application information"],
      components: [],
      connections: [],
    })
    const unmaterialized = installApplicationConnectivityObservation({
      workspace,
      plan: absent_plan,
      observation: installed,
    })
    expect(unmaterialized.review).not.toHaveProperty("source.image")
    expect(unmaterialized.review).not.toHaveProperty("source.render_dpi")
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test("documented review envelopes and nested records reject unknown fields", () => {
  const valid = {
    version: 1,
    availability: "documented",
    source: {
      page: 17,
      figure: "Typical application",
      method: "pdf_visual",
      confidence: "high",
      image: "visual-reference/typical-application.png",
      render_dpi: 200,
    },
    components: visibleComponents(plan),
    connections: plan.connections.map(({ pins }) => ({ pins })),
  }

  expect(() => parseApplicationConnectivityReview({ ...valid, agent_note: "unsupported" }, plan)).toThrow(
    "documented connectivity review contains unsupported fields: agent_note",
  )
  expect(() =>
    parseApplicationConnectivityReview(
      { ...valid, source: { ...valid.source, source_url: "unsupported" } },
      plan,
    ),
  ).toThrow("connectivity review source[0] contains unsupported fields: source_url")
  expect(() =>
    parseApplicationConnectivityReview(
      {
        ...valid,
        components: valid.components.map((component, index) =>
          index === 0 ? { ...component, note: "unsupported" } : component,
        ),
      },
      plan,
    ),
  ).toThrow("connectivity review components[0] contains unsupported fields: note")
  expect(() =>
    parseApplicationConnectivityReview(
      {
        ...valid,
        connections: valid.connections.map((connection, index) =>
          index === 0 ? { ...connection, net: "unsupported" } : connection,
        ),
      },
      plan,
    ),
  ).toThrow("connectivity review connections[0] contains unsupported fields: net")
})

test("extractor and independent review share canonical external terminal labels", () => {
  const spaced_plan = parseTypicalApplicationPlan(
    {
      ...plan,
      connections: plan.connections.map((connection, index) =>
        index === 0 ? { ...connection, pins: [...connection.pins, "48V BATT"] } : connection,
      ),
    },
    "REGULATOR",
  )
  const review = parseApplicationConnectivityReview(
    {
      version: 1,
      availability: "documented",
      source: {
        page: 17,
        figure: "Typical application",
        method: "pdf_visual",
        confidence: "high",
        image: "visual-reference/typical-application.png",
        render_dpi: 200,
      },
      components: visibleComponents(spaced_plan),
      connections: spaced_plan.connections.map(({ pins }, index) => ({
        pins: index === 0 ? pins.map((pin) => (pin === "48V_BATT" ? "48V BATT" : pin)) : pins,
      })),
    },
    spaced_plan,
  )
  expect(review.availability).toBe("documented")
  if (review.availability !== "documented") throw new Error("expected documented review")
  expect(review.connections[0]?.pins).toContain("48V_BATT")
  expect(compareApplicationGraphs({ plan: spaced_plan, review, evidence }).status).toBe("verified")
})

test("documented reviews reject low-confidence sources and isolated inventory entries", () => {
  expect(() =>
    parseApplicationConnectivityReview(
      {
        version: 1,
        availability: "documented",
        source: { page: 17, method: "pdf_text", confidence: "high" },
        components: visibleComponents(plan),
        connections: plan.connections.map(({ pins }) => ({ pins })),
      },
      plan,
    ),
  ).toThrow("documented connectivity review source must use pdf_visual")

  expect(() =>
    parseApplicationConnectivityReview(
      {
        version: 1,
        availability: "documented",
        source: {
          page: 17,
          method: "pdf_visual",
          confidence: "low",
          image: "visual-reference/typical-application.png",
          render_dpi: 200,
        },
        components: visibleComponents(plan),
        connections: plan.connections.map(({ pins }) => ({ pins })),
      },
      plan,
    ),
  ).toThrow("documented connectivity review source must have medium or high confidence")

  expect(() =>
    review(
      plan.connections.map(({ pins }) => ({ pins })),
      plan,
      [...visibleComponents(plan), { reference: "C99", kind: "capacitor" }],
    ),
  ).toThrow("component C99 is isolated")
})

test("component fact comparison is canonical, optional when unseen, and strict when emitted", () => {
  const alias_connections = [
    { pins: ["R2.2", "U1.3"] },
    { pins: ["R2.1", "R1.2", "U1.2"] },
    { pins: ["R1.1", "U1.1"] },
  ]
  const without_optional_facts = visibleComponents(plan).map(({ reference, kind }) => ({
    reference,
    kind,
  }))
  expect(
    compareApplicationGraphs({
      plan,
      evidence,
      review: review(alias_connections, plan, without_optional_facts),
    }).status,
  ).toBe("verified")

  const equivalent_values = without_optional_facts.map((component) =>
    component.reference === "R1"
      ? { ...component, value: "10 kOhm" }
      : component.reference === "R2"
        ? { ...component, value: "1 kΩ" }
        : component,
  )
  expect(
    compareApplicationGraphs({
      plan,
      evidence,
      review: review(alias_connections, plan, equivalent_values),
    }).status,
  ).toBe("verified")

  const wrong_kind = without_optional_facts.map((component) =>
    component.reference === "R1" ? { ...component, kind: "diode" } : component,
  )
  expect(() =>
    compareApplicationGraphs({
      plan,
      evidence,
      review: review(alias_connections, plan, wrong_kind),
    }),
  ).toThrow("R1.kind")

  const wrong_value = without_optional_facts.map((component) =>
    component.reference === "R1" ? { ...component, value: "22 kΩ" } : component,
  )
  expect(() =>
    compareApplicationGraphs({
      plan,
      evidence,
      review: review(alias_connections, plan, wrong_value),
    }),
  ).toThrow("R1.value")
})

test("visible U1 families match authoritative orderable identities while external MPNs stay exact", () => {
  const exact_evidence = {
    ...evidence,
    part_number: { ...evidence.part_number, value: "TPS63802DLAR" },
  }
  const exact_plan = parseTypicalApplicationPlan(
    {
      ...plan,
      components: plan.components.map((component) =>
        component.reference === "U1"
          ? {
              ...component,
              value: "TPS63802",
              manufacturer_part_number: "TPS63802DLAR",
            }
          : component.reference === "R1"
            ? { ...component, manufacturer_part_number: "RC0603FR-0710KL" }
            : component,
      ),
    },
    { part_number: "TPS63802DLAR", legacy_package_identifiers: ["DLA"] },
  )
  const family_components = visibleComponents(exact_plan).map((component) =>
    component.reference === "U1"
      ? {
          reference: "U1",
          kind: component.kind,
          manufacturer_part_number: "TPS63802",
        }
      : component,
  )
  const exact_review = review(
    exact_plan.connections.map(({ pins }) => ({ pins })),
    exact_plan,
    family_components,
  )

  expect(
    compareApplicationGraphs({ plan: exact_plan, evidence: exact_evidence, review: exact_review }).status,
  ).toBe("verified")

  const ina_evidence = {
    ...evidence,
    part_number: { ...evidence.part_number, value: "INA237" },
    ordering_code: { ...evidence.part_number, value: "INA237AIDGSR" },
  }
  const ina_plan = parseTypicalApplicationPlan(
    {
      ...plan,
      components: plan.components.map((component) =>
        component.reference === "U1"
          ? {
              ...component,
              value: "INA237",
              manufacturer_part_number: "INA237AIDGSR",
            }
          : component,
      ),
    },
    { part_number: "INA237", ordering_code: "INA237AIDGSR" },
  )
  const ina_components = visibleComponents(ina_plan).map((component) =>
    component.reference === "U1"
      ? { reference: "U1", kind: component.kind, manufacturer_part_number: "INA237" }
      : component,
  )
  expect(
    compareApplicationGraphs({
      plan: ina_plan,
      evidence: ina_evidence,
      review: review(
        ina_plan.connections.map(({ pins }) => ({ pins })),
        ina_plan,
        ina_components,
      ),
    }).status,
  ).toBe("verified")

  const wrong_family = family_components.map((component) =>
    component.reference === "U1" ? { ...component, manufacturer_part_number: "TPS63803" } : component,
  )
  expect(() =>
    compareApplicationGraphs({
      plan: exact_plan,
      evidence: exact_evidence,
      review: review(
        exact_plan.connections.map(({ pins }) => ({ pins })),
        exact_plan,
        wrong_family,
      ),
    }),
  ).toThrow("U1.manufacturer_part_number")

  const truncated_variant = family_components.map((component) =>
    component.reference === "U1" ? { ...component, manufacturer_part_number: "TPS63802D" } : component,
  )
  expect(() =>
    compareApplicationGraphs({
      plan: exact_plan,
      evidence: exact_evidence,
      review: review(
        exact_plan.connections.map(({ pins }) => ({ pins })),
        exact_plan,
        truncated_variant,
      ),
    }),
  ).toThrow("U1.manufacturer_part_number")

  const longer_unverified_variant = family_components.map((component) =>
    component.reference === "U1"
      ? { ...component, manufacturer_part_number: "TPS63802DLARWRONG" }
      : component,
  )
  expect(() =>
    compareApplicationGraphs({
      plan: exact_plan,
      evidence: exact_evidence,
      review: review(
        exact_plan.connections.map(({ pins }) => ({ pins })),
        exact_plan,
        longer_unverified_variant,
      ),
    }),
  ).toThrow("U1.manufacturer_part_number")

  const shortened_external_mpn = family_components.map((component) =>
    component.reference === "R1" ? { ...component, manufacturer_part_number: "RC0603" } : component,
  )
  expect(() =>
    compareApplicationGraphs({
      plan: exact_plan,
      evidence: exact_evidence,
      review: review(
        exact_plan.connections.map(({ pins }) => ({ pins })),
        exact_plan,
        shortened_external_mpn,
      ),
    }),
  ).toThrow("R1.manufacturer_part_number")
})

test("semantic comparison reports inventory, fact, and graph disagreements together", () => {
  const mismatched = review(
    [{ pins: ["U1.1", "R1.1", "C99.1"] }, { pins: ["U1.2", "R1.2"] }, { pins: ["U1.3", "C99.2"] }],
    plan,
    [
      { reference: "U1", kind: "integrated_circuit" },
      { reference: "R1", kind: "diode", value: "22k" },
      { reference: "C99", kind: "capacitor", value: "1 nF" },
    ],
  )

  let failure: unknown
  try {
    compareApplicationGraphs({ plan, evidence, review: mismatched })
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(AggregateError)
  const message = failure instanceof Error ? failure.message : ""
  expect(message).toContain("Independent application component inventory does not match")
  expect(message).toContain("R1.kind")
  expect(message).toContain("R1.value")
  expect(message).toContain("Independent application connectivity does not match")
})

test("application review reports every malformed endpoint in one schema failure", () => {
  let failure: unknown
  try {
    parseApplicationConnectivityReview(
      {
        version: 1,
        availability: "documented",
        source: {
          page: 17,
          figure: "Typical application",
          method: "pdf_visual",
          confidence: "high",
          image: "visual-reference/typical-application.png",
          render_dpi: 200,
        },
        components: visibleComponents(plan),
        connections: [
          { pins: ["V_S = 2.7V–5.5V", "U1.1", "R1.1"] },
          { pins: ["48V battery rail", "U1.2", "R1.2", "R2.1"] },
          { pins: ["To MCU", "U1.3", "R2.2"] },
        ],
      },
      plan,
    )
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(AggregateError)
  const message = failure instanceof Error ? failure.message : ""
  expect(message).toContain("V_S = 2.7V–5.5V")
  expect(message).toContain("48V battery rail")
  expect(message).toContain("To MCU")
  expect(message).not.toContain("references a component absent")
  expect(message).not.toContain("is isolated")
})

test("clearly symmetric passive terminals may be permuted without changing connectivity", () => {
  expect(
    compareApplicationGraphs({
      plan,
      evidence,
      review: review([
        { pins: ["R2.1", "U1.3"] },
        { pins: ["R2.2", "R1.1", "U1.2"] },
        { pins: ["R1.2", "U1.1"] },
      ]),
    }).status,
  ).toBe("verified")
})

test("directional component terminals remain distinct", () => {
  const directional_plan = parseTypicalApplicationPlan(
    {
      version: 4,
      availability: "documented",
      pcb_implementation: "schematic_only",
      title: "Clamp",
      description: "A directional diode clamp.",
      source_references: [{ page: 17 }],
      components: [
        { reference: "U1", kind: "integrated_circuit", value: "REGULATOR" },
        { reference: "D1", kind: "diode", value: "1N4148" },
      ],
      connections: [
        { net: "OUTPUT", pins: ["U1.VOUT", "D1.A"] },
        { net: "FEEDBACK", pins: ["U1.FB", "D1.K"] },
        { net: "GROUND", pins: ["U1.GND", "GND"] },
      ],
    },
    "REGULATOR",
  )

  expect(() =>
    compareApplicationGraphs({
      plan: directional_plan,
      evidence,
      review: review(
        [{ pins: ["U1.1", "D1.K"] }, { pins: ["U1.2", "D1.A"] }, { pins: ["U1.3", "GND"] }],
        directional_plan,
      ),
    }),
  ).toThrow("Independent application connectivity does not match")
})

test("generic capacitors remain polarity-preserving unless explicitly nonpolarized", () => {
  const capacitorPlan = (kind: string) =>
    parseTypicalApplicationPlan(
      {
        version: 4,
        availability: "documented",
        pcb_implementation: "schematic_only",
        title: "Supply bypass",
        description: "A two-terminal supply capacitor.",
        source_references: [{ page: 17 }],
        components: [
          { reference: "U1", kind: "integrated_circuit", value: "REGULATOR" },
          { reference: "C1", kind, value: "10uF" },
        ],
        connections: [
          { net: "SUPPLY", pins: ["U1.VOUT", "C1.1"] },
          { net: "GROUND", pins: ["U1.GND", "C1.2", "GND"] },
        ],
      },
      "REGULATOR",
    )
  const swappedReview = (application_plan: ReturnType<typeof capacitorPlan>) =>
    review([{ pins: ["U1.1", "C1.2"] }, { pins: ["U1.3", "C1.1", "GND"] }], application_plan)

  const generic = capacitorPlan("capacitor")
  expect(() => compareApplicationGraphs({ plan: generic, evidence, review: swappedReview(generic) })).toThrow(
    "Independent application connectivity does not match",
  )
  const ceramic = capacitorPlan("ceramic_capacitor")
  expect(compareApplicationGraphs({ plan: ceramic, evidence, review: swappedReview(ceramic) }).status).toBe(
    "verified",
  )
})

test("U1 aliases reject ambiguity but physical pin numbers take precedence", () => {
  const ambiguous_alias_evidence = {
    ...evidence,
    pinout: {
      pins: [
        { ...requiredItem(evidence.pinout.pins, 0), labels: ["RESET"] },
        { ...requiredItem(evidence.pinout.pins, 1), labels: ["/RESET"] },
        requiredItem(evidence.pinout.pins, 2),
      ],
    },
  }
  expect(() =>
    canonicalizeApplicationGraph({
      connections: [{ pins: ["U1.RESET", "R1.1"] }],
      evidence: ambiguous_alias_evidence,
    }),
  ).toThrow("ambiguous U1 alias for pins 1, 2")

  const numeric_label_evidence = {
    ...evidence,
    pinout: {
      pins: [
        requiredItem(evidence.pinout.pins, 0),
        { ...requiredItem(evidence.pinout.pins, 1), labels: ["1", "FB"] },
        requiredItem(evidence.pinout.pins, 2),
      ],
    },
  }
  expect(
    canonicalizeApplicationGraph({
      connections: [{ pins: ["U1.1", "R1.1"] }],
      evidence: numeric_label_evidence,
    }),
  ).toEqual([["R1.port:1", "U1.pin:1"]])
})

test("canonical graphs reject aliases that collapse onto a reused physical endpoint", () => {
  expect(() =>
    canonicalizeApplicationGraph({
      connections: [{ pins: ["U1.1", "U1.VOUT"] }],
      evidence,
    }),
  ).toThrow("already used by U1.1 in node 0")
})

test("graph comparison preserves endpoint multiplicity instead of collapsing Sets", () => {
  const multiplicity_plan = parseTypicalApplicationPlan(
    {
      version: 4,
      availability: "documented",
      pcb_implementation: "schematic_only",
      title: "Parallel resistor terminals",
      description: "Both resistor terminals are explicitly tied to output.",
      source_references: [{ page: 17 }],
      components: [
        { reference: "U1", kind: "integrated_circuit", value: "REGULATOR" },
        { reference: "R1", kind: "resistor", value: "10k" },
      ],
      connections: [
        { net: "OUTPUT", pins: ["U1.VOUT", "R1.1", "R1.2"] },
        { net: "FEEDBACK", pins: ["U1.FB", "FB"] },
        { net: "GROUND", pins: ["U1.GND", "GND"] },
      ],
    },
    "REGULATOR",
  )

  expect(() =>
    compareApplicationGraphs({
      plan: multiplicity_plan,
      evidence,
      review: review(
        [{ pins: ["U1.1", "R1.1"] }, { pins: ["U1.2", "FB"] }, { pins: ["U1.3", "GND"] }],
        multiplicity_plan,
      ),
    }),
  ).toThrow("Independent application connectivity does not match")
})

test("independent component inventory detects extra connected components and preserves external rails", () => {
  const independent = review(
    [{ pins: ["C99.1", "U1.1"] }, { pins: ["R2.1", "R1.2", "U1.2"] }, { pins: ["R2.2", "U1.3"] }],
    plan,
    [...visibleComponents(plan), { reference: "C99", kind: "capacitor" }],
  )
  expect(independent).toMatchObject({ availability: "documented" })
  expect(() => compareApplicationGraphs({ plan, evidence, review: independent })).toThrow(
    "Independent application component inventory does not match",
  )

  const external_plan = parseTypicalApplicationPlan(
    {
      version: 4,
      availability: "documented",
      pcb_implementation: "schematic_only",
      title: "External rails",
      description: "Every target pin reaches a named external terminal.",
      source_references: [{ page: 17 }],
      components: [{ reference: "U1", kind: "integrated_circuit", value: "REGULATOR" }],
      connections: [
        { net: "OUTPUT", pins: ["U1.VOUT", "VOUT"] },
        { net: "FEEDBACK", pins: ["U1.FB", "FB"] },
        { net: "GROUND", pins: ["U1.GND", "GND"] },
      ],
    },
    "REGULATOR",
  )
  const external_review = review(
    [{ pins: ["GND", "U1.3"] }, { pins: ["VOUT", "U1.1"] }, { pins: ["FB", "U1.2"] }],
    external_plan,
  )
  expect(
    compareApplicationGraphs({
      plan: external_plan,
      evidence,
      review: external_review,
    }).status,
  ).toBe("verified")

  expect(() =>
    compareApplicationGraphs({
      plan: external_plan,
      evidence,
      review: review(
        [{ pins: ["FB", "U1.1"] }, { pins: ["VOUT", "U1.2"] }, { pins: ["GND", "U1.3"] }],
        external_plan,
      ),
    }),
  ).toThrow("Independent application connectivity does not match")
})

test("not_present claims require an independent review and disagree with discovered applications", () => {
  const absent_plan = parseTypicalApplicationPlan({
    version: 4,
    availability: "not_present",
    title: "No application",
    description: "No documented application was found.",
    source_references: [{ page: 1 }],
    searched_sections: ["application information"],
    components: [],
    connections: [],
  })
  const absent_review = parseApplicationConnectivityReview(
    {
      version: 1,
      availability: "not_present",
      searched_sections: ["application information", "reference design"],
    },
    absent_plan,
  )
  expect(
    compareApplicationGraphs({
      plan: absent_plan,
      review: absent_review,
      evidence,
    }),
  ).toMatchObject({
    status: "verified",
    availability: "not_present",
    searched_sections: ["application information", "reference design"],
  })

  const discovered_review = parseApplicationConnectivityReview(
    {
      version: 1,
      availability: "documented",
      source: {
        page: 9,
        figure: "Application circuit",
        method: "pdf_visual",
        confidence: "high",
      },
      components: [{ reference: "U1", kind: "integrated_circuit" }],
      connections: [{ pins: ["U1.1", "VOUT"] }],
    },
    absent_plan,
  )
  expect(() =>
    compareApplicationGraphs({
      plan: absent_plan,
      review: discovered_review,
      evidence,
    }),
  ).toThrow("extractor=not_present, verifier=documented")
})

test("one typed independent observation can be applied to multiple repaired outer plans", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "application-connectivity-observation-"))
  try {
    await mkdir(join(workspace, "visual-reference"), { recursive: true })
    await Promise.all([
      Bun.write(join(workspace, "datasheet.pdf"), "datasheet fixture"),
      Bun.write(join(workspace, "visual-reference", "typical-application.png"), "png fixture"),
    ])
    let agent_calls = 0
    const agent_client: AgentClient = {
      async run(input) {
        agent_calls += 1
        await Bun.write(
          join(input.workspace, "application-connectivity-review.json"),
          `${JSON.stringify({
            version: 1,
            availability: "documented",
            source: {
              page: 17,
              figure: "Typical application",
              method: "pdf_visual",
              confidence: "high",
            },
            components: visibleComponents(plan),
            connections: [
              { pins: ["R2.2", "U1.3"] },
              { pins: ["R2.1", "R1.2", "U1.2"] },
              { pins: ["R1.1", "U1.1"] },
            ],
          })}\n`,
        )
        return { attempts: 1, duration_ms: 13, output_tail: "" }
      },
    }
    const observation = await observeApplicationConnectivity({
      workspace,
      plan,
      evidence,
      outer_attempt: 1,
      debug_dir: join(workspace, "debug"),
      signal: new AbortController().signal,
      use_openai: false,
      agent_client,
      image_extension: "test-image-extension.ts",
      on_output: () => undefined,
    })
    const protected_path = join(workspace, "protected-review.json")
    const review_path = join(workspace, "application-connectivity-review.json")
    await Bun.write(protected_path, '{"protected":true}\n')
    await rm(review_path)
    await symlink(protected_path, review_path)
    const installed_observation = installApplicationConnectivityObservation({
      workspace,
      plan,
      observation,
    })
    expect(await Bun.file(protected_path).text()).toBe('{"protected":true}\n')
    expect(await Bun.file(review_path).json()).toEqual(installed_observation.review)
    const rejected_plan = parseTypicalApplicationPlan(
      {
        ...plan,
        connections: [
          { net: "OUTPUT", pins: ["U1.VOUT", "R1.1"] },
          { net: "FEEDBACK", pins: ["U1.FB", "R2.1"] },
          { net: "GROUND", pins: ["U1.GND", "R1.2", "R2.2"] },
        ],
      },
      "REGULATOR",
    )

    expect(() =>
      applyApplicationConnectivityObservation({ plan: rejected_plan, evidence, observation }),
    ).toThrow("Independent application connectivity does not match")
    expect(applyApplicationConnectivityObservation({ plan, evidence, observation })).toMatchObject({
      status: "verified",
      verifier_attempts: 1,
      verifier_agent_duration_ms: 13,
    })
    expect(agent_calls).toBe(1)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test("verifier workspace exposes no extractor hints, crop, inventory, or graph", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "application-connectivity-mismatch-"))
  try {
    await mkdir(join(workspace, "visual-reference"), { recursive: true })
    await Promise.all([
      Bun.write(join(workspace, "datasheet.pdf"), "datasheet fixture"),
      Bun.write(join(workspace, "visual-reference", "typical-application.png"), "png fixture"),
    ])
    const raw_review = {
      version: 1,
      availability: "documented",
      source: {
        page: 17,
        figure: "Typical application",
        method: "pdf_visual",
        confidence: "high",
      },
      components: visibleComponents(plan),
      connections: [
        { pins: ["U1.1", "R1.1"] },
        { pins: ["U1.2", "R2.1"] },
        { pins: ["U1.3", "R1.2", "R2.2"] },
      ],
    }
    const agent_client: AgentClient = {
      async run(input) {
        expect(await Bun.file(join(input.workspace, "verification-request.json")).exists()).toBe(false)
        expect(
          await Bun.file(join(input.workspace, "visual-reference", "typical-application.png")).exists(),
        ).toBe(false)
        expect(input.prompt).not.toContain("target_pin_naming_hints")
        expect(input.prompt).not.toContain("verification-request.json")
        expect(await Bun.file(join(input.workspace, "APPLICATION-CONNECTIVITY-SCHEMA.md")).text()).toContain(
          "an SPDT switch has one common",
        )
        await Bun.write(
          join(input.workspace, "application-connectivity-review.json"),
          `${JSON.stringify(raw_review)}\n`,
        )
        return { attempts: 1, duration_ms: 7, output_tail: "" }
      },
    }

    await expect(
      verifyApplicationConnectivity({
        workspace,
        plan,
        evidence,
        outer_attempt: 1,
        debug_dir: join(workspace, "debug"),
        signal: new AbortController().signal,
        use_openai: false,
        agent_client,
        image_extension: "test-image-extension.ts",
        on_output: () => undefined,
      }),
    ).rejects.toThrow("Independent application connectivity does not match")
    expect(await Bun.file(join(workspace, "application-connectivity-review.json")).json()).toEqual({
      ...raw_review,
      source: {
        ...raw_review.source,
        image: "visual-reference/typical-application.png",
        render_dpi: 200,
      },
    })
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test("verifier independently checks not_present without requiring an application crop", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "application-connectivity-absent-"))
  try {
    await Bun.write(join(workspace, "datasheet.pdf"), "datasheet fixture")
    const absent_plan = parseTypicalApplicationPlan({
      version: 4,
      availability: "not_present",
      title: "No application",
      description: "No documented application was found.",
      source_references: [{ page: 1 }],
      searched_sections: ["application information"],
      components: [],
      connections: [],
    })
    let calls = 0
    const agent_client: AgentClient = {
      async run(input) {
        calls += 1
        expect(await Bun.file(join(input.workspace, "verification-request.json")).exists()).toBe(false)
        expect(
          await Bun.file(join(input.workspace, "visual-reference", "typical-application.png")).exists(),
        ).toBe(false)
        await Bun.write(
          join(input.workspace, "application-connectivity-review.json"),
          `${JSON.stringify({
            version: 1,
            availability: "not_present",
            searched_sections: ["application information", "reference design"],
            ...(calls === 1 ? { connections: [] } : {}),
          })}\n`,
        )
        return { attempts: 1, duration_ms: 11, output_tail: "" }
      },
    }

    const verified = await verifyApplicationConnectivity({
      workspace,
      plan: absent_plan,
      evidence,
      outer_attempt: 1,
      debug_dir: join(workspace, "debug"),
      signal: new AbortController().signal,
      use_openai: false,
      agent_client,
      image_extension: "test-image-extension.ts",
      on_output: () => undefined,
    })
    expect(calls).toBe(2)
    expect(verified).toMatchObject({
      status: "verified",
      availability: "not_present",
      verifier_attempts: 2,
      verifier_agent_duration_ms: 22,
    })
    expect(await Bun.file(join(workspace, "application-connectivity-review.json")).json()).toMatchObject({
      availability: "not_present",
    })
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
