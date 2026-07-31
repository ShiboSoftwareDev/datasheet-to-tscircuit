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
    ...complete.components[1]!,
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
  expect(() => parseTypicalApplicationPlan({ ...absent, pcb_implementation: "schematic_only" })).toThrow(
    "must omit pcb_implementation",
  )
})

test("application nets reject duplicate endpoints and references to undeclared parts", () => {
  const duplicate = documentedPlan()
  duplicate.connections[1] = { net: "RETURN", pins: ["LM393P.VCC", "C1.2"] }
  expect(() => parseTypicalApplicationPlan(duplicate, "LM393P")).toThrow(
    "endpoint LM393P.VCC is listed on both VCC and RETURN",
  )

  const missing_component = documentedPlan()
  missing_component.connections[0] = { net: "VCC", pins: ["LM393P.VCC", "R1.1"] }
  expect(() => parseTypicalApplicationPlan(missing_component, "LM393P")).toThrow(
    "endpoint R1.1 references an unlisted component",
  )
})
