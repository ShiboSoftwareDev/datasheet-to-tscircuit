import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseComponentEvidence } from "@/server/component-evidence"
import {
  canonicalizeApplicationGraph,
  compareApplicationGraphs,
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

test("verifier requests expose only non-authoritative hints and retain raw mismatches", async () => {
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
        image: "visual-reference/typical-application.png",
        render_dpi: 200,
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
        const request = await Bun.file(join(input.workspace, "verification-request.json")).json()
        expect(request.naming_hints_are_incomplete_and_non_authoritative).toBe(true)
        expect(request).not.toHaveProperty("component_naming_hints")
        expect(request.target_pin_naming_hints).toEqual(
          evidence.pinout.pins.map(({ number, labels }) => ({ number, labels })),
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
    expect(await Bun.file(join(workspace, "application-connectivity-review.json")).json()).toEqual(raw_review)
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
        const request = await Bun.file(join(input.workspace, "verification-request.json")).json()
        expect(request.application_image_supplied).toBe(false)
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
