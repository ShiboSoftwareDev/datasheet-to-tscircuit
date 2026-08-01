import { expect, test } from "bun:test"
import { parseTypicalApplicationPlan } from "@/server/component-workflow/application-plan"

interface DraftApplicationComponent {
  reference: string
  kind: string
  value: string
  manufacturer_part_number?: string
  source_references?: Array<{ page: number; figure?: string }>
  footprint?: string
  footprint_source_references?: Array<{ page: number; figure?: string }>
}

function requiredItem<T>(items: readonly T[], index: number): T {
  const item = items[index]
  if (item === undefined) throw new Error(`Missing test fixture item ${index}`)
  return item
}

function documentedPlan(pcb_implementation: "verified" | "schematic_only" = "schematic_only"): {
  version: number
  availability: string
  pcb_implementation?: "verified" | "schematic_only"
  title: string
  description: string
  source_references: Array<{ page: number; figure?: string }>
  components: DraftApplicationComponent[]
  connections: Array<{ net: string; pins: string[] }>
} {
  return {
    version: 4,
    availability: "documented",
    pcb_implementation,
    title: "Comparator supply bypass",
    description: "Datasheet example with a local bypass capacitor.",
    source_references: [{ page: 7, figure: "Typical application" }],
    components: [
      {
        reference: "LM393P",
        kind: "integrated_circuit",
        value: "LM393P",
      },
      {
        reference: "C1",
        kind: "capacitor",
        value: "100nF",
      },
    ],
    connections: [
      { net: "VCC", pins: ["LM393P.VCC", "C1.1"] },
      { net: "GND", pins: ["LM393P.GND", "C1.2"] },
    ],
  }
}

test("documented application plans require a mode and canonicalize the target component", () => {
  const parsed = parseTypicalApplicationPlan(documentedPlan(), "LM393P")

  expect(parsed.version).toBe(4)
  expect(parsed.pcb_implementation).toBe("schematic_only")
  expect(parsed.components.map(({ reference }) => reference)).toEqual(["U1", "C1"])
  expect(parsed.connections).toEqual([
    { net: "VCC", pins: ["U1.VCC", "C1.1"] },
    { net: "GND", pins: ["U1.GND", "C1.2"] },
  ])

  const missing_mode = documentedPlan()
  Reflect.deleteProperty(missing_mode, "pcb_implementation")
  expect(() => parseTypicalApplicationPlan(missing_mode)).toThrow(
    "documented typical-application evidence must declare pcb_implementation",
  )
})

test("verified PCB plans require sourced ordering and footprint facts for every external part", () => {
  expect(() => parseTypicalApplicationPlan(documentedPlan("verified"), "LM393P")).toThrow(
    "verified PCB component C1 must include",
  )

  const complete = documentedPlan("verified")
  complete.components[1] = {
    ...requiredItem(complete.components, 1),
    manufacturer_part_number: "GRM188R71C104KA01D",
    source_references: [{ page: 15, figure: "Bill of materials" }],
    footprint: "0402",
    footprint_source_references: [{ page: 22, figure: "Package dimensions" }],
  }
  expect(parseTypicalApplicationPlan(complete, "LM393P").pcb_implementation).toBe("verified")
})

test("not-present application evidence is explicit, empty, and records where the server searched", () => {
  const absent = {
    version: 4,
    availability: "not_present",
    title: "No documented application",
    description: "No complete application circuit was found.",
    source_references: [{ page: 1 }],
    searched_sections: ["application information", "reference design"],
    components: [],
    connections: [],
  }
  expect(parseTypicalApplicationPlan(absent)).toMatchObject({
    availability: "not_present",
    searched_sections: ["application information", "reference design"],
  })

  expect(() => parseTypicalApplicationPlan({ ...absent, searched_sections: [] })).toThrow(
    "must list searched_sections",
  )
  expect(() =>
    parseTypicalApplicationPlan({
      ...absent,
      components: [{ reference: "C1", kind: "capacitor" }],
    }),
  ).toThrow("must have empty components and connections")
  expect(() =>
    parseTypicalApplicationPlan({
      ...absent,
      pcb_implementation: "schematic_only",
    }),
  ).toThrow("must omit pcb_implementation")
})

test("application nets reject duplicate endpoints and references to undeclared parts", () => {
  const duplicate = documentedPlan()
  duplicate.connections[1] = { net: "RETURN", pins: ["LM393P.VCC", "C1.2"] }
  expect(() => parseTypicalApplicationPlan(duplicate, "LM393P")).toThrow(
    "endpoint LM393P.VCC is listed on both VCC and RETURN",
  )

  const missing_component = documentedPlan()
  missing_component.connections[0] = {
    net: "VCC",
    pins: ["LM393P.VCC", "R1.1"],
  }
  expect(() => parseTypicalApplicationPlan(missing_component, "LM393P")).toThrow(
    "endpoint R1.1 references an unlisted component",
  )

  const unconnected_component = documentedPlan()
  unconnected_component.components.push({
    reference: "R99",
    kind: "resistor",
    value: "10k",
  })
  expect(() => parseTypicalApplicationPlan(unconnected_component, "LM393P")).toThrow(
    "component R99 is unconnected",
  )
})

test("printed external terminal whitespace canonicalizes without changing component ports", () => {
  const input = documentedPlan()
  input.connections[0] = {
    net: "48V_BATT",
    pins: ["LM393P.VCC", "C1.1", "48V BATT"],
  }
  const parsed = parseTypicalApplicationPlan(input, "LM393P")
  expect(parsed.connections[0]?.pins).toEqual(["U1.VCC", "C1.1", "48V_BATT"])
})

test("application parser preserves sourced scalar objects and omits null optionals", () => {
  const plan = documentedPlan()
  plan.components[0] = {
    ...requiredItem(plan.components, 0),
    manufacturer_part_number: {
      value: "LM393P",
      sources: [{ page: 12, method: "pdf_text", confidence: "high" }],
    },
    footprint: {
      value: "DIP-8",
      sources: [{ page: 20, method: "pdf_text", confidence: "high" }],
    },
  } as unknown as DraftApplicationComponent
  plan.components[1] = {
    ...requiredItem(plan.components, 1),
    manufacturer_part_number: null,
    footprint: null,
  } as unknown as DraftApplicationComponent

  const parsed = parseTypicalApplicationPlan(plan, "LM393P")
  expect(parsed.components[0]).toMatchObject({
    reference: "U1",
    manufacturer_part_number: "LM393P",
    footprint: "DIP-8",
    source_references: [{ page: 12, method: "pdf_text", confidence: "high" }],
    footprint_source_references: [{ page: 20, method: "pdf_text", confidence: "high" }],
  })
  expect(parsed.components[1]).not.toHaveProperty("manufacturer_part_number")
  expect(parsed.components[1]).not.toHaveProperty("footprint")
})

test("unrelated sourced fields cannot satisfy verified part-number provenance", () => {
  const plan = documentedPlan("verified")
  plan.components[1] = {
    ...requiredItem(plan.components, 1),
    manufacturer_part_number: "GENERIC-CAPACITOR",
    source_references: undefined,
    footprint: "0402",
    footprint_source_references: [{ page: 22, figure: "Package dimensions" }],
    purpose: {
      value: "Input bypass",
      sources: [{ page: 7, method: "pdf_text", confidence: "high" }],
    },
  } as unknown as DraftApplicationComponent

  expect(() => parseTypicalApplicationPlan(plan, "LM393P")).toThrow(
    "verified PCB component C1 must include a datasheet-sourced manufacturer_part_number",
  )
})

test("canonicalization preserves external terminals without generating pseudo-components", () => {
  const plan = documentedPlan()
  plan.components.push({
    reference: "VIN_PORT",
    kind: "power_terminal",
    value: "VIN",
  })
  requiredItem(plan.connections, 0).pins.push("VIN_PORT.OUT")
  requiredItem(plan.connections, 1).pins.push("GND")

  const parsed = parseTypicalApplicationPlan(plan, "LM393P")
  expect(parsed.components.map(({ reference }) => reference)).toEqual(["U1", "C1"])
  expect(parsed.connections).toEqual([
    { net: "VCC", pins: ["U1.VCC", "C1.1", "VIN"] },
    { net: "GND", pins: ["U1.GND", "C1.2", "GND"] },
  ])
})

test("target canonicalization uses exact manufacturer identity and never trusts U1 alone", () => {
  const exact_mpn = documentedPlan()
  exact_mpn.components[0] = {
    reference: "IC_MAIN",
    kind: "integrated_circuit",
    value: "Dual comparator",
    manufacturer_part_number: "LM393P",
  }
  exact_mpn.connections = [
    { net: "VCC", pins: ["IC_MAIN.VCC", "C1.1"] },
    { net: "GND", pins: ["IC_MAIN.GND", "C1.2"] },
  ]
  expect(parseTypicalApplicationPlan(exact_mpn, "LM393P").components[0]?.reference).toBe("U1")

  const wrong_u1 = documentedPlan()
  wrong_u1.components[0] = {
    reference: "U1",
    kind: "integrated_circuit",
    value: "Different comparator",
    manufacturer_part_number: "LM2903P",
  }
  wrong_u1.connections = [
    { net: "VCC", pins: ["U1.VCC", "C1.1"] },
    { net: "GND", pins: ["U1.GND", "C1.2"] },
  ]
  expect(() => parseTypicalApplicationPlan(wrong_u1, "LM393P")).toThrow(
    "must resolve exactly one target component to U1",
  )
})

test("target canonicalization accepts the evidence ordering code as the exact application MPN", () => {
  const plan = documentedPlan()
  plan.components[0] = {
    reference: "IC_MAIN",
    kind: "buck_boost_converter",
    value: "TPS63802",
  }
  plan.connections = [
    { net: "VCC", pins: ["IC_MAIN.VCC", "C1.1"] },
    { net: "GND", pins: ["IC_MAIN.GND", "C1.2"] },
  ]

  const parsed = parseTypicalApplicationPlan(plan, {
    part_number: "TPS63802",
    ordering_code: "TPS63802DLAR",
  })
  expect(parsed.components[0]).toMatchObject({
    reference: "U1",
    value: "TPS63802",
    manufacturer_part_number: "TPS63802DLAR",
  })

  requiredItem(plan.components, 0).manufacturer_part_number = "TPS63802DLAR"
  expect(
    parseTypicalApplicationPlan(plan, {
      part_number: "TPS63802",
      ordering_code: "TPS63802DLAR",
    }).components[0],
  ).toMatchObject({
    value: "TPS63802",
    manufacturer_part_number: "TPS63802DLAR",
  })

  requiredItem(plan.components, 0).value = "TPS63802DLAR"
  expect(
    parseTypicalApplicationPlan(plan, {
      part_number: "TPS63802",
      ordering_code: "TPS63802DLAR",
    }).components[0],
  ).toMatchObject({
    value: "TPS63802",
    manufacturer_part_number: "TPS63802DLAR",
  })

  requiredItem(plan.components, 0).manufacturer_part_number = "TPS63802WRONG"
  expect(() =>
    parseTypicalApplicationPlan(plan, {
      part_number: "TPS63802",
      ordering_code: "TPS63802DLAR",
    }),
  ).toThrow("must resolve exactly one target component to U1")
})

test("target canonicalization separates visible family identity from the selected orderable", () => {
  const plan = documentedPlan()
  plan.components[0] = {
    reference: "U1",
    kind: "current_monitor",
    value: "INA237",
  }
  plan.connections = [
    { net: "VCC", pins: ["U1.VCC", "C1.1"] },
    { net: "GND", pins: ["U1.GND", "C1.2"] },
  ]

  const target = {
    part_number: "INA237",
    ordering_code: "INA237AIDGSR",
  }
  expect(parseTypicalApplicationPlan(plan, target).components[0]).toMatchObject({
    reference: "U1",
    value: "INA237",
    manufacturer_part_number: "INA237AIDGSR",
  })

  requiredItem(plan.components, 0).manufacturer_part_number = "INA237AIDGSR"
  expect(parseTypicalApplicationPlan(plan, target).components[0]).toMatchObject({
    value: "INA237",
    manufacturer_part_number: "INA237AIDGSR",
  })
})

test("legacy exact-only evidence accepts a specific application-visible family prefix", () => {
  const plan = documentedPlan()
  plan.components[0] = {
    reference: "U1",
    kind: "buck_boost_converter",
    value: "TPS63802",
  }
  plan.connections = [
    { net: "VCC", pins: ["U1.VCC", "C1.1"] },
    { net: "GND", pins: ["U1.GND", "C1.2"] },
  ]

  const legacy_target = {
    part_number: "TPS63802DLAR",
    legacy_package_identifiers: ["DLA"],
  }
  expect(parseTypicalApplicationPlan(plan, legacy_target).components[0]).toMatchObject({
    reference: "U1",
    value: "TPS63802",
    manufacturer_part_number: "TPS63802DLAR",
  })

  requiredItem(plan.components, 0).manufacturer_part_number = "TPS63802"
  expect(parseTypicalApplicationPlan(plan, legacy_target).components[0]).toMatchObject({
    value: "TPS63802",
    manufacturer_part_number: "TPS63802DLAR",
  })

  requiredItem(plan.components, 0).value = "TPS63803"
  expect(() => parseTypicalApplicationPlan(plan, legacy_target)).toThrow(
    "must resolve exactly one target component to U1",
  )

  requiredItem(plan.components, 0).value = "TPS63802DLA"
  requiredItem(plan.components, 0).manufacturer_part_number = undefined
  expect(() => parseTypicalApplicationPlan(plan, legacy_target)).toThrow(
    "must resolve exactly one target component to U1",
  )
})

test("target canonicalization rejects a wrong visible family and a wrong selected orderable", () => {
  const target = {
    part_number: "INA237",
    ordering_code: "INA237AIDGSR",
  }
  const wrong_family = documentedPlan()
  wrong_family.components[0] = {
    reference: "U1",
    kind: "current_monitor",
    value: "INA238",
    manufacturer_part_number: "INA237AIDGSR",
  }
  expect(() => parseTypicalApplicationPlan(wrong_family, target)).toThrow(
    'application value must identify family "INA237"',
  )

  const wrong_orderable = documentedPlan()
  wrong_orderable.components[0] = {
    reference: "U1",
    kind: "current_monitor",
    value: "INA237",
    manufacturer_part_number: "INA237AIDGST",
  }
  expect(() => parseTypicalApplicationPlan(wrong_orderable, target)).toThrow(
    'manufacturer_part_number, when present, must equal selected ordering identity "INA237AIDGSR"',
  )

  const family_as_orderable = documentedPlan()
  family_as_orderable.components[0] = {
    reference: "U1",
    kind: "current_monitor",
    value: "INA237",
    manufacturer_part_number: "INA237",
  }
  expect(() => parseTypicalApplicationPlan(family_as_orderable, target)).toThrow(
    'manufacturer_part_number, when present, must equal selected ordering identity "INA237AIDGSR"',
  )

  expect(() =>
    parseTypicalApplicationPlan(family_as_orderable, {
      part_number: "INA237AIDGSR",
      ordering_code: "INA237",
    }),
  ).toThrow('ordering identity "INA237" must extend base part number "INA237AIDGSR"')
})

test("application nets require a real component endpoint before and after canonicalization", () => {
  const bare_only = documentedPlan()
  bare_only.connections[0] = { net: "INPUT", pins: ["INPUT", "SOURCE"] }
  expect(() => parseTypicalApplicationPlan(bare_only, "LM393P")).toThrow(
    "must include at least one component.port endpoint",
  )

  const pseudo_only = documentedPlan()
  pseudo_only.components.push(
    { reference: "INPUT_PORT", kind: "input_terminal", value: "INPUT" },
    { reference: "SOURCE_PORT", kind: "external_terminal", value: "SOURCE" },
  )
  pseudo_only.connections[0] = {
    net: "INPUT",
    pins: ["INPUT_PORT.OUT", "SOURCE_PORT.OUT"],
  }
  expect(() => parseTypicalApplicationPlan(pseudo_only, "LM393P")).toThrow(
    "must retain at least one component.port endpoint after canonicalization",
  )
})

test("target canonicalization rejects ambiguous components and alias-created duplicates", () => {
  const ambiguous = documentedPlan()
  ambiguous.components.push({
    reference: "IC2",
    kind: "integrated_circuit",
    value: "LM393P",
  })
  expect(() => parseTypicalApplicationPlan(ambiguous, "LM393P")).toThrow("resolves 2 components to target U1")

  const component_collision = documentedPlan()
  component_collision.components.push({
    reference: "U1",
    kind: "resistor",
    value: "10k",
  })
  expect(() => parseTypicalApplicationPlan(component_collision, "LM393P")).toThrow(
    "canonicalization produces duplicate component U1",
  )

  const endpoint_collision = documentedPlan()
  endpoint_collision.connections[1] = {
    net: "RETURN",
    pins: ["U1.VCC", "C1.2"],
  }
  expect(() => parseTypicalApplicationPlan(endpoint_collision, "LM393P")).toThrow(
    "canonical endpoint U1.VCC is listed on both VCC and RETURN",
  )

  const prefix_only = documentedPlan()
  prefix_only.components[0] = {
    reference: "LM393P_BACKUP",
    kind: "integrated_circuit",
    value: "LM393P_BACKUP",
  }
  prefix_only.connections = [
    { net: "VCC", pins: ["LM393P_BACKUP.VCC", "C1.1"] },
    { net: "GND", pins: ["LM393P_BACKUP.GND", "C1.2"] },
  ]
  expect(() => parseTypicalApplicationPlan(prefix_only, "LM393P")).toThrow(
    "must resolve exactly one target component to U1",
  )

  const short_part_number = documentedPlan()
  short_part_number.components[0] = {
    reference: "555",
    kind: "integrated_circuit",
    value: "555",
  }
  short_part_number.connections = [
    { net: "VCC", pins: ["555.VCC", "C1.1"] },
    { net: "GND", pins: ["555.GND", "C1.2"] },
  ]
  expect(parseTypicalApplicationPlan(short_part_number, "555").components[0]?.reference).toBe("U1")
})

test("application plans report legacy and misspelled fields instead of silently dropping them", () => {
  const component_typo = documentedPlan()
  ;(component_typo.components[0] as unknown as Record<string, unknown>).footprint_sources = [{ page: 20 }]
  expect(() => parseTypicalApplicationPlan(component_typo, "LM393P")).toThrow(
    "typical application components[0] contains unsupported fields: footprint_sources",
  )

  const connection_typo = documentedPlan()
  ;(connection_typo.connections[0] as unknown as Record<string, unknown>).sources = [{ page: 8 }]
  expect(() => parseTypicalApplicationPlan(connection_typo, "LM393P")).toThrow(
    "typical application connections[0] contains unsupported fields: sources",
  )
})

test("calculated and package-standard citations require explanatory notes", () => {
  const calculated = documentedPlan()
  calculated.source_references = [
    { page: 7, method: "calculated" },
  ] as unknown as typeof calculated.source_references
  expect(() => parseTypicalApplicationPlan(calculated, "LM393P")).toThrow(
    "must explain its calculated source in note",
  )

  const package_standard = documentedPlan()
  package_standard.source_references = [
    { page: 7, method: "package_standard" },
  ] as unknown as typeof package_standard.source_references
  expect(() => parseTypicalApplicationPlan(package_standard, "LM393P")).toThrow(
    "must explain its package_standard source in note",
  )
})

test("calculated facts cannot verify MPNs or footprints and package standards only verify footprints", () => {
  const calculated_mpn = documentedPlan("verified")
  calculated_mpn.components[1] = {
    ...requiredItem(calculated_mpn.components, 1),
    manufacturer_part_number: {
      value: "GENERIC-CAPACITOR",
      sources: [
        {
          page: 15,
          method: "calculated",
          confidence: "medium",
          note: "Inferred from capacitance and voltage.",
        },
      ],
    },
    footprint: {
      value: "0402",
      sources: [
        {
          page: 22,
          method: "package_standard",
          confidence: "high",
          note: "IPC 0402 courtyard and land pattern.",
        },
      ],
    },
  } as unknown as DraftApplicationComponent
  expect(() => parseTypicalApplicationPlan(calculated_mpn, "LM393P")).toThrow(
    "verified PCB component C1 must include a datasheet-sourced manufacturer_part_number",
  )

  const standard_mpn = structuredClone(calculated_mpn)
  requiredItem(standard_mpn.components, 1).manufacturer_part_number = {
    value: "GENERIC-CAPACITOR",
    sources: [
      {
        page: 15,
        method: "package_standard",
        confidence: "medium",
        note: "The package standard cannot identify an orderable part.",
      },
    ],
  } as unknown as string
  expect(() => parseTypicalApplicationPlan(standard_mpn, "LM393P")).toThrow(
    "verified PCB component C1 must include a datasheet-sourced manufacturer_part_number",
  )

  const calculated_footprint = structuredClone(calculated_mpn)
  requiredItem(calculated_footprint.components, 1).manufacturer_part_number = {
    value: "GRM188R71C104KA01D",
    sources: [{ page: 15, method: "pdf_text", confidence: "high" }],
  } as unknown as string
  requiredItem(calculated_footprint.components, 1).footprint = {
    value: "0402",
    sources: [
      {
        page: 22,
        method: "calculated",
        confidence: "medium",
        note: "Calculated from nominal dimensions.",
      },
    ],
  } as unknown as string
  expect(() => parseTypicalApplicationPlan(calculated_footprint, "LM393P")).toThrow(
    "verified PCB component C1 must include a datasheet- or package-standard-sourced footprint",
  )
})
