import { expect, test } from "bun:test"
import type { AnyCircuitElement } from "circuit-json"
import { applicationSourceNetName } from "@/server/component-workflow/application-endpoint"
import {
  getFootprintPlanErrors,
  getTypicalApplicationComponentValueErrors,
  getTypicalApplicationConnectivityErrors,
  getTypicalApplicationSourceErrors,
  getTypicalApplicationTargetComponentErrors,
} from "@/server/job-artifact-validator"

test("application source gate rejects only standalone netlabel JSX elements", () => {
  expect(
    getTypicalApplicationSourceErrors(
      '<board><netlabel net="VIN" /><trace from=".U1 > .VIN" to="net.VIN" /></board>',
    ),
  ).toEqual(["Typical application source must not instantiate <netlabel> elements"])
  expect(
    getTypicalApplicationSourceErrors(
      '<board><netalias net="VIN" /><trace from=".U1 > .VIN" to="net.VIN" schDisplayLabel="VIN" /></board>',
    ),
  ).toEqual([])
  expect(getTypicalApplicationSourceErrors('<trace from=".U1 > .VIN" to={sel.net.VIN} />')).toEqual([])
  expect(
    getTypicalApplicationSourceErrors(
      '<board><inductor name="L1" footprint="0805" pcbX={1} /></board>',
      "schematic_only",
    ),
  ).toEqual([
    "Schematic-only typical application source must not assign PCB footprints",
    "Schematic-only typical application source must not assign PCB placement props",
  ])

  const verified_plan = {
    components: [
      { reference: "U1" },
      {
        reference: "L1",
        manufacturer_part_number: "DFE201612E-R47M",
        footprint: "0805",
      },
    ],
    connections: [{ net: "SW", pins: ["U1.SW", "L1.pin1"] }],
  }
  expect(
    getTypicalApplicationSourceErrors(
      'import Component from "./component.circuit"\nexport default () => <board><Component name="U1" /><inductor name="L1" inductance="0.47uH" manufacturerPartNumber="DFE201612E-R47M" footprint="0805" /></board>',
      "verified",
      verified_plan,
    ),
  ).toEqual([])
  expect(
    getTypicalApplicationSourceErrors(
      'import Component from "./component.circuit"\nexport default () => <board><Component name="U1" /><inductor name="L1" inductance="0.47uH" manufacturerPartNumber="DFE201612E-R47M" footprint="0402" /></board>',
      "verified",
      verified_plan,
    ),
  ).toContain('Verified PCB component L1 must set literal footprint="0805"')

  const schematic_only_plan = {
    components: [
      { reference: "U1" },
      {
        reference: "C1",
        manufacturer_part_number: "GRM188R60J106ME84",
      },
    ],
    connections: [{ net: "VIN", pins: ["U1.VIN", "C1.pin1"] }],
  }
  expect(
    getTypicalApplicationSourceErrors(
      'import Component from "./component.circuit"\nexport default () => <group><Component name="U1" /><capacitor name="C1" capacitance="10uF" /></group>',
      "schematic_only",
      schematic_only_plan,
    ),
  ).toEqual(['Application component C1 must set literal manufacturerPartNumber="GRM188R60J106ME84"'])
  expect(
    getTypicalApplicationSourceErrors(
      'import Component from "./component.circuit"\nexport default () => <group><Component name="U1" /><capacitor name="C1" capacitance="10uF" manufacturerPartNumber="GRM188R60J106ME84" /></group>',
      "schematic_only",
      schematic_only_plan,
    ),
  ).toEqual([])
})

test("unknown-value passives must use the explicit generic chip representation", () => {
  const plan = {
    components: [{ reference: "U1" }, { reference: "RSHUNT", kind: "resistor" }],
    connections: [{ net: "SENSE", pins: ["U1.SENSE", "RSHUNT.pin1"] }],
  }
  const source = (passive: string) =>
    `import ValidatedComponent from "./component.circuit"\nexport default () => <group><ValidatedComponent name="U1" />${passive}</group>`

  expect(
    getTypicalApplicationSourceErrors(
      source('<capacitor name="RSHUNT" capacitance="1uF" />'),
      "schematic_only",
      plan,
    ),
  ).toContain(
    "Application component RSHUNT has no documented numeric resistor value and must use a literal <chip> element",
  )
  expect(
    getTypicalApplicationSourceErrors(
      source('<chip name="RSHUNT" value="RSHUNT" pinLabels={{ pin1: "1", pin2: "2" }} />'),
      "schematic_only",
      plan,
    ),
  ).toEqual([])
})

test("application source must instantiate the validated default import as U1", () => {
  const plan = { components: [{ reference: "U1" }], connections: [] }
  expect(
    getTypicalApplicationSourceErrors(
      'import ValidatedComponent from "./component.circuit"\nexport default () => <chip name="U1" manufacturerPartNumber="SUBSTITUTE" />',
      "schematic_only",
      plan,
    ),
  ).toEqual([
    'Typical application must instantiate the default import ValidatedComponent from ./component.circuit exactly once with literal name="U1"',
  ])
  expect(
    getTypicalApplicationSourceErrors(
      'import ValidatedComponent from "./component.circuit"\nexport default () => <ValidatedComponent name="U1" />',
      "schematic_only",
      plan,
    ),
  ).toEqual([])
  expect(
    getTypicalApplicationSourceErrors(
      'import ValidatedComponent from "./component.circuit"\nexport default () => <><ValidatedComponent name="U1" /><ValidatedComponent name="U2" /></>',
      "schematic_only",
      plan,
    ),
  ).toEqual([
    'Typical application must instantiate the default import ValidatedComponent from ./component.circuit exactly once with literal name="U1"',
  ])
})

const connectivityPlan = {
  components: [{ reference: "U1" }, { reference: "R3" }],
  connections: [
    { net: "VIN", pins: ["U1.VIN", "R3.pin1"] },
    { net: "PG", pins: ["U1.PG", "R3.pin2"] },
  ],
}

function applicationCircuit(r3_pullup_net: "vin" | "vout"): AnyCircuitElement[] {
  return [
    { type: "source_component", source_component_id: "u1", name: "U1" },
    {
      type: "source_port",
      source_port_id: "u1_vin",
      source_component_id: "u1",
      name: "VIN",
      subcircuit_connectivity_map_key: "vin",
    },
    {
      type: "source_port",
      source_port_id: "u1_pg",
      source_component_id: "u1",
      name: "PG",
      subcircuit_connectivity_map_key: "pg",
    },
    { type: "source_component", source_component_id: "r3", name: "R3" },
    {
      type: "source_port",
      source_port_id: "r3_1",
      source_component_id: "r3",
      name: "pin1",
      pin_number: "1",
      subcircuit_connectivity_map_key: r3_pullup_net,
    },
    {
      type: "source_port",
      source_port_id: "r3_2",
      source_component_id: "r3",
      name: "pin2",
      pin_number: "2",
      subcircuit_connectivity_map_key: "pg",
    },
  ] as unknown as AnyCircuitElement[]
}

test("datasheet connectivity gate catches a cleanly-built pull-up on the wrong net", () => {
  expect(getTypicalApplicationConnectivityErrors(connectivityPlan, applicationCircuit("vin"))).toEqual([])
  expect(getTypicalApplicationConnectivityErrors(connectivityPlan, applicationCircuit("vout"))).toEqual([
    "VIN: expected pins are not electrically connected: U1.VIN, R3.pin1",
  ])
})

test("datasheet connectivity verifies named external terminals through source nets", () => {
  const plan = {
    ...connectivityPlan,
    connections: [
      { net: "VIN", pins: ["U1.VIN", "R3.pin1", "VIN"] },
      { net: "PG", pins: ["U1.PG", "R3.pin2", "PG"] },
    ],
  }
  const external_nets = [
    {
      type: "source_net",
      source_net_id: "net_vin",
      name: "VIN",
      subcircuit_connectivity_map_key: "vin",
    },
    {
      type: "source_net",
      source_net_id: "net_pg",
      name: "PG",
      subcircuit_connectivity_map_key: "pg",
    },
  ] as unknown as AnyCircuitElement[]
  expect(
    getTypicalApplicationConnectivityErrors(plan, [...applicationCircuit("vin"), ...external_nets]),
  ).toEqual([])

  const swapped = external_nets.map((net) => ({
    ...net,
    subcircuit_connectivity_map_key: (net as unknown as { name: string }).name === "VIN" ? "pg" : "vin",
  })) as AnyCircuitElement[]
  expect(getTypicalApplicationConnectivityErrors(plan, [...applicationCircuit("vin"), ...swapped])).toEqual([
    "VIN: expected pins are not electrically connected: U1.VIN, R3.pin1, VIN",
    "PG: expected pins are not electrically connected: U1.PG, R3.pin2, PG",
  ])
})

test("datasheet connectivity resolves a numeric-leading semantic terminal through its safe source net", () => {
  const plan = {
    components: [{ reference: "U1" }],
    connections: [{ net: "48V_BATT", pins: ["U1.VIN", "48V_BATT"] }],
  }
  const circuit = [
    { type: "source_component", source_component_id: "u1", name: "U1" },
    {
      type: "source_port",
      source_port_id: "u1_vin",
      source_component_id: "u1",
      name: "VIN",
      subcircuit_connectivity_map_key: "battery",
    },
    {
      type: "source_net",
      source_net_id: "net_battery",
      name: applicationSourceNetName("48V_BATT"),
      subcircuit_connectivity_map_key: "battery",
    },
  ] as unknown as AnyCircuitElement[]

  expect(getTypicalApplicationConnectivityErrors(plan, circuit)).toEqual([])
})

test("datasheet connectivity rejects missing or ambiguous external source nets", () => {
  const plan = {
    components: [{ reference: "U1" }],
    connections: [{ net: "VIN", pins: ["U1.VIN", "VIN"] }],
  }
  const circuit = applicationCircuit("vin").filter(
    (element) => (element as unknown as { type: string; name?: string }).name !== "R3",
  )
  expect(getTypicalApplicationConnectivityErrors(plan, circuit)).toContain(
    'VIN: Expected external terminal "VIN" resolved to 0 source nets',
  )

  const duplicate_nets = ["net_vin_a", "net_vin_b"].map((source_net_id) => ({
    type: "source_net",
    source_net_id,
    name: "VIN",
    subcircuit_connectivity_map_key: "vin",
  })) as unknown as AnyCircuitElement[]
  expect(getTypicalApplicationConnectivityErrors(plan, [...circuit, ...duplicate_nets])).toContain(
    'VIN: Expected external terminal "VIN" resolved to 2 source nets',
  )
})

test("datasheet connectivity follows trace-connected source net ids", () => {
  const plan = {
    components: [{ reference: "U1" }],
    connections: [{ net: "VIN", pins: ["U1.VIN", "VIN"] }],
  }
  const circuit = [
    { type: "source_component", source_component_id: "u1", name: "U1" },
    { type: "source_port", source_port_id: "u1_vin", source_component_id: "u1", name: "VIN" },
    { type: "source_net", source_net_id: "net_vin", name: "VIN" },
    {
      type: "source_trace",
      source_trace_id: "trace_vin",
      connected_source_port_ids: ["u1_vin"],
      connected_source_net_ids: ["net_vin"],
    },
  ] as unknown as AnyCircuitElement[]
  expect(getTypicalApplicationConnectivityErrors(plan, circuit)).toEqual([])
})

test("datasheet connectivity scopes repeated keys and external names to the application subcircuit", () => {
  const plan = {
    components: [{ reference: "U1" }],
    connections: [{ net: "VIN", pins: ["U1.VIN", "VIN"] }],
  }
  const circuit = [
    {
      type: "source_group",
      source_group_id: "application_group",
      subcircuit_id: "application_subcircuit",
    },
    { type: "source_component", source_component_id: "u1", source_group_id: "application_group", name: "U1" },
    {
      type: "source_port",
      source_port_id: "u1_vin",
      source_component_id: "u1",
      name: "VIN",
      subcircuit_id: "application_subcircuit",
      subcircuit_connectivity_map_key: "net0",
    },
    {
      type: "source_net",
      source_net_id: "application_vin",
      name: "VIN",
      subcircuit_id: "application_subcircuit",
      subcircuit_connectivity_map_key: "net0",
    },
    {
      type: "source_net",
      source_net_id: "child_vin",
      name: "VIN",
      subcircuit_id: "child_subcircuit",
      subcircuit_connectivity_map_key: "net0",
    },
  ] as unknown as AnyCircuitElement[]

  expect(getTypicalApplicationConnectivityErrors(plan, circuit)).toEqual([])

  const cross_scope_plan = {
    components: [{ reference: "U1" }, { reference: "C1" }],
    connections: [{ net: "VIN", pins: ["U1.VIN", "C1.1"] }],
  }
  const cross_scope_circuit = [
    ...circuit,
    {
      type: "source_component",
      source_component_id: "c1",
      source_group_id: "application_group",
      name: "C1",
    },
    {
      type: "source_port",
      source_port_id: "c1_1",
      source_component_id: "c1",
      name: "pin1",
      pin_number: 1,
      subcircuit_id: "child_subcircuit",
      subcircuit_connectivity_map_key: "net0",
    },
  ] as unknown as AnyCircuitElement[]
  expect(getTypicalApplicationConnectivityErrors(cross_scope_plan, cross_scope_circuit)).toContain(
    'VIN: Expected pin "C1.1" resolved to 0 source ports',
  )
})

test("datasheet connectivity includes ordinary nested groups but excludes child subcircuits", () => {
  const grouped_circuit = applicationCircuit("vin").map((element) => {
    const record = element as unknown as Record<string, unknown>
    if (record.type === "source_component") {
      return {
        ...record,
        source_group_id: record.name === "R3" ? "layout_group" : "application_group",
      }
    }
    if (record.type === "source_port") {
      return { ...record, subcircuit_id: "application_subcircuit" }
    }
    return record
  }) as unknown as AnyCircuitElement[]
  grouped_circuit.unshift(
    {
      type: "source_group",
      source_group_id: "layout_group",
      parent_source_group_id: "application_group",
      name: "layout",
    } as unknown as AnyCircuitElement,
    {
      type: "source_group",
      source_group_id: "application_group",
      subcircuit_id: "application_subcircuit",
      is_subcircuit: true,
    } as unknown as AnyCircuitElement,
  )

  expect(getTypicalApplicationConnectivityErrors(connectivityPlan, grouped_circuit)).toEqual([])

  const unplanned_nested = [
    ...grouped_circuit,
    {
      type: "source_component",
      source_component_id: "r99",
      source_group_id: "layout_group",
      name: "R99",
    },
  ] as unknown as AnyCircuitElement[]
  expect(getTypicalApplicationConnectivityErrors(connectivityPlan, unplanned_nested)).toContain(
    "Unexpected application component R99",
  )

  const child_subcircuit = [
    ...grouped_circuit,
    {
      type: "source_group",
      source_group_id: "child_implementation_group",
      parent_subcircuit_id: "instantiated_child",
    },
    {
      type: "source_component",
      source_component_id: "internal_r1",
      source_group_id: "child_implementation_group",
      name: "R_INTERNAL",
    },
  ] as unknown as AnyCircuitElement[]
  expect(getTypicalApplicationConnectivityErrors(connectivityPlan, child_subcircuit)).toEqual([])

  const hidden_sibling_root = [
    ...grouped_circuit,
    {
      type: "source_group",
      source_group_id: "sibling_root",
      subcircuit_id: "sibling_subcircuit",
    },
    {
      type: "source_component",
      source_component_id: "hidden_r99",
      source_group_id: "sibling_root",
      name: "R99",
    },
  ] as unknown as AnyCircuitElement[]
  expect(getTypicalApplicationConnectivityErrors(connectivityPlan, hidden_sibling_root)).toContain(
    "Application component R99 is outside the selected root scope application_group",
  )
})

test("datasheet connectivity rejects unplanned root-level electrical connections", () => {
  const plan = {
    components: [{ reference: "U1" }],
    connections: [{ net: "VIN", pins: ["U1.VIN", "VIN"] }],
  }
  const circuit = [
    { type: "source_component", source_component_id: "u1", name: "U1" },
    {
      type: "source_port",
      source_port_id: "u1_vin",
      source_component_id: "u1",
      name: "VIN",
      subcircuit_connectivity_map_key: "vin",
    },
    {
      type: "source_net",
      source_net_id: "net_vin",
      name: "VIN",
      subcircuit_connectivity_map_key: "vin",
    },
    {
      type: "source_port",
      source_port_id: "u1_en",
      source_component_id: "u1",
      name: "EN",
      subcircuit_connectivity_map_key: "bad",
    },
    {
      type: "source_net",
      source_net_id: "net_bad",
      name: "BAD",
      subcircuit_connectivity_map_key: "bad",
    },
  ] as unknown as AnyCircuitElement[]

  expect(getTypicalApplicationConnectivityErrors(plan, circuit)).toEqual([
    "Unexpected root-level application connection: BAD, U1.EN",
  ])
})

test("datasheet connectivity rejects components absent from the approved plan", () => {
  const circuit = [
    ...applicationCircuit("vin"),
    { type: "source_component", source_component_id: "c99", name: "C99", capacitance: 1e-6 },
  ] as AnyCircuitElement[]
  expect(getTypicalApplicationConnectivityErrors(connectivityPlan, circuit)).toEqual([
    "Unexpected application component C99",
  ])
})

test("application U1 must retain the validated component identity and pin signature", () => {
  const validated = [
    {
      type: "source_component",
      source_component_id: "validated-u1",
      name: "ValidatedPart",
      manufacturer_part_number: "TARGET-2",
    },
    {
      type: "source_port",
      source_port_id: "validated-vin",
      source_component_id: "validated-u1",
      pin_number: "1",
      name: "VIN",
      port_hints: ["pin1", "VIN"],
      requires_power: true,
    },
    {
      type: "source_port",
      source_port_id: "validated-ground",
      source_component_id: "validated-u1",
      pin_number: "2",
      name: "GND",
      port_hints: ["pin2", "GND"],
      requires_ground: true,
    },
  ] as unknown as AnyCircuitElement[]
  const substitute = [
    {
      type: "source_component",
      source_component_id: "application-u1",
      name: "U1",
      manufacturer_part_number: "SUBSTITUTE-2",
    },
    {
      type: "source_port",
      source_port_id: "application-vin",
      source_component_id: "application-u1",
      pin_number: "1",
      name: "INPUT",
      port_hints: ["pin1", "INPUT"],
    },
    {
      type: "source_port",
      source_port_id: "application-ground",
      source_component_id: "application-u1",
      pin_number: "3",
      name: "GND",
      port_hints: ["pin3", "GND"],
      requires_ground: true,
    },
  ] as unknown as AnyCircuitElement[]

  expect(getTypicalApplicationTargetComponentErrors(validated, substitute)).toEqual([
    'Typical application U1 manufacturer_part_number is "SUBSTITUTE-2", expected validated value "TARGET-2"',
    "Typical application U1 pin 1 is missing validated aliases: vin",
    "Typical application U1 pin 1 has requires_power=false, expected true",
    "Typical application U1 is missing validated pin 2",
    "Typical application U1 has unexpected pin 3",
  ])
})

test("datasheet connectivity resolves punctuation-bearing endpoints through polarity aliases", () => {
  const plan = {
    components: [{ reference: "U1" }, { reference: "R1" }],
    connections: [
      { net: "SENSE_POS", pins: ["U1.IN+", "R1.1"] },
      { net: "SENSE_NEG", pins: ["U1.IN−", "R1.2"] },
    ],
  }
  const circuit = [
    { type: "source_component", source_component_id: "u1", name: "U1" },
    { type: "source_component", source_component_id: "r1", name: "R1" },
    {
      type: "source_port",
      source_port_id: "u1_pos",
      source_component_id: "u1",
      name: "IN_POS",
      port_hints: ["IN_POS", "pin10", "10"],
      subcircuit_connectivity_map_key: "sense-pos",
    },
    {
      type: "source_port",
      source_port_id: "u1_neg",
      source_component_id: "u1",
      name: "IN_NEG",
      port_hints: ["IN_NEG", "pin9", "9"],
      subcircuit_connectivity_map_key: "sense-neg",
    },
    {
      type: "source_port",
      source_port_id: "r1_1",
      source_component_id: "r1",
      name: "pin1",
      pin_number: 1,
      subcircuit_connectivity_map_key: "sense-pos",
    },
    {
      type: "source_port",
      source_port_id: "r1_2",
      source_component_id: "r1",
      name: "pin2",
      pin_number: 2,
      subcircuit_connectivity_map_key: "sense-neg",
    },
  ]

  expect(getTypicalApplicationConnectivityErrors(plan, circuit as unknown as AnyCircuitElement[])).toEqual([])

  const positive_port = circuit[2]
  const negative_port = circuit[3]
  if (!positive_port || !negative_port) throw new Error("Fixture source ports are missing")
  positive_port.name = "IN_NEG"
  positive_port.port_hints = ["IN_NEG", "pin10", "10"]
  negative_port.name = "IN_POS"
  negative_port.port_hints = ["IN_POS", "pin9", "9"]
  expect(getTypicalApplicationConnectivityErrors(plan, circuit as unknown as AnyCircuitElement[])).toEqual([
    "SENSE_POS: expected pins are not electrically connected: U1.IN+, R1.1",
    "SENSE_NEG: expected pins are not electrically connected: U1.IN−, R1.2",
  ])
})

test("datasheet connectivity accepts swapped pins only for interchangeable passives", () => {
  const plan = {
    components: [{ reference: "U1" }, { reference: "L1" }],
    connections: [
      { net: "SW_L1", pins: ["U1.L1", "L1.1"] },
      { net: "SW_L2", pins: ["U1.L2", "L1.2"] },
    ],
  }
  const circuit = (interchangeable: boolean) =>
    [
      { type: "source_component", source_component_id: "u1", name: "U1" },
      {
        type: "source_component",
        source_component_id: "l1",
        name: "L1",
        are_pins_interchangeable: interchangeable,
      },
      {
        type: "source_port",
        source_port_id: "u1_l1",
        source_component_id: "u1",
        name: "L1",
        subcircuit_connectivity_map_key: "switch-a",
      },
      {
        type: "source_port",
        source_port_id: "u1_l2",
        source_component_id: "u1",
        name: "L2",
        subcircuit_connectivity_map_key: "switch-b",
      },
      {
        type: "source_port",
        source_port_id: "l1_pin1",
        source_component_id: "l1",
        name: "pin1",
        pin_number: 1,
        subcircuit_connectivity_map_key: "switch-b",
      },
      {
        type: "source_port",
        source_port_id: "l1_pin2",
        source_component_id: "l1",
        name: "pin2",
        pin_number: 2,
        subcircuit_connectivity_map_key: "switch-a",
      },
    ] as unknown as AnyCircuitElement[]

  expect(getTypicalApplicationConnectivityErrors(plan, circuit(true))).toEqual([])
  expect(getTypicalApplicationConnectivityErrors(plan, circuit(false))).toEqual([
    "SW_L1: expected pins are not electrically connected: U1.L1, L1.1",
    "SW_L2: expected pins are not electrically connected: U1.L2, L1.2",
  ])
})

test("footprint gate catches a special pad whose width was copied from the ordinary pads", () => {
  const plan = {
    version: 1 as const,
    view: "pcb_top" as const,
    source_references: [{ page: 31, figure: "DLA0010A land pattern" }],
    pads: [
      { pin: "1", kind: "smt" as const, x: -1, y: 0, width: 0.6, height: 0.3 },
      { pin: "8", kind: "smt" as const, x: 1, y: 0, width: 1.3, height: 0.3 },
    ],
  }
  const circuit = [
    { type: "pcb_smtpad", port_hints: ["1"], x: -1, y: 0, width: 0.6, height: 0.3 },
    { type: "pcb_smtpad", port_hints: ["8"], x: 1, y: 0, width: 0.9, height: 0.3 },
  ] as unknown as AnyCircuitElement[]

  expect(getFootprintPlanErrors(plan, circuit)).toEqual(["Pin 8: width 0.9 mm (expected 1.3 mm)"])
})

test("footprint gate validates unassigned mechanical copper without inventing an electrical pin", () => {
  const plan = {
    version: 1 as const,
    view: "pcb_top" as const,
    source_references: [{ page: 4 }],
    pads: [{ pin: null, kind: "smt" as const, x: 0, y: 2, width: 1.2, height: 1.2 }],
  }
  const circuit = [
    { type: "pcb_smtpad", x: 0, y: 2, width: 1.2, height: 1.2 },
  ] as unknown as AnyCircuitElement[]

  expect(getFootprintPlanErrors(plan, circuit)).toEqual([])
})

test("application value gate catches a changed feedback-divider value", () => {
  const plan = {
    components: [
      { reference: "R1", kind: "resistor", value: "511k" },
      { reference: "R2", kind: "resistor", value: "100k" },
    ],
    connections: [{ net: "FB", pins: ["R1.pin2", "R2.pin1"] }],
  }
  const circuit = [
    { type: "source_component", source_component_id: "r1", name: "R1", resistance: 511_000 },
    { type: "source_component", source_component_id: "r2", name: "R2", resistance: 110_000 },
  ] as unknown as AnyCircuitElement[]

  expect(getTypicalApplicationComponentValueErrors(plan, circuit)).toEqual([
    "Application component R2 has resistance 110000, expected 100k",
  ])
})

test("application value gate rejects invented values for an undocumented shunt scalar", () => {
  const plan = {
    components: [{ reference: "RSHUNT", kind: "resistor" }],
    connections: [{ net: "SENSE", pins: ["RSHUNT.pin1", "SENSE"] }],
  }
  const generic_symbol = [
    { type: "source_component", source_component_id: "rshunt", name: "RSHUNT" },
  ] as unknown as AnyCircuitElement[]
  const invented_zero = [
    { type: "source_component", source_component_id: "rshunt", name: "RSHUNT", resistance: 0 },
  ] as unknown as AnyCircuitElement[]
  const non_numeric = [
    { type: "source_component", source_component_id: "rshunt", name: "RSHUNT", resistance: null },
  ] as unknown as AnyCircuitElement[]
  const wrong_passive_kind = [
    { type: "source_component", source_component_id: "rshunt", name: "RSHUNT", capacitance: 1e-6 },
  ] as unknown as AnyCircuitElement[]

  expect(getTypicalApplicationComponentValueErrors(plan, generic_symbol)).toEqual([])
  expect(getTypicalApplicationComponentValueErrors(plan, invented_zero)).toEqual([
    "Application component RSHUNT invents passive value fields resistance=0, but the documented plan has no numeric value; use a generic two-pin chip",
  ])
  expect(getTypicalApplicationComponentValueErrors(plan, non_numeric)).toEqual([
    "Application component RSHUNT invents passive value fields resistance=null, but the documented plan has no numeric value; use a generic two-pin chip",
  ])
  expect(getTypicalApplicationComponentValueErrors(plan, wrong_passive_kind)).toEqual([
    "Application component RSHUNT invents passive value fields capacitance=0.000001, but the documented plan has no numeric value; use a generic two-pin chip",
  ])
})

test("application value gate cannot be satisfied by a same-name child-subcircuit component", () => {
  const plan = {
    components: [{ reference: "C1", kind: "capacitor", value: "10uF" }],
    connections: [{ net: "VIN", pins: ["C1.pin1", "VIN"] }],
  }
  const circuit = [
    { type: "source_group", source_group_id: "app", subcircuit_id: "app-subcircuit" },
    {
      type: "source_component",
      source_component_id: "root-c1",
      source_group_id: "app",
      name: "C1",
      capacitance: "1uF",
    },
    {
      type: "source_group",
      source_group_id: "child-implementation",
      parent_subcircuit_id: "child-subcircuit",
    },
    {
      type: "source_component",
      source_component_id: "child-c1",
      source_group_id: "child-implementation",
      name: "C1",
      capacitance: "10uF",
    },
    {
      type: "source_port",
      source_port_id: "root-c1-pin1",
      source_component_id: "root-c1",
      subcircuit_id: "app-subcircuit",
      name: "pin1",
    },
  ] as unknown as AnyCircuitElement[]

  expect(getTypicalApplicationComponentValueErrors(plan, circuit)).toEqual([
    "Application component C1 has capacitance 0.000001, expected 10uF",
  ])
})

test("application component gate enforces sourced manufacturer part numbers", () => {
  const plan = {
    components: [
      {
        reference: "L1",
        kind: "inductor",
        value: "0.47uH",
        manufacturer_part_number: "DFE201612E-R47M",
        footprint: "0805",
      },
    ],
    connections: [{ net: "SW", pins: ["L1.pin1", "L1.pin2"] }],
  }
  const circuit = [
    {
      type: "source_component",
      source_component_id: "l1",
      name: "L1",
      inductance: "0.47uH",
      manufacturer_part_number: "UNSOURCED-0805",
    },
    {
      type: "cad_component",
      cad_component_id: "l1-cad",
      pcb_component_id: "l1-pcb",
      source_component_id: "l1",
      footprinter_string: "0402",
      position: { x: 0, y: 0, z: 0 },
      model_object_fit: "contain_within_bounds",
    },
  ] as unknown as AnyCircuitElement[]

  expect(getTypicalApplicationComponentValueErrors(plan, circuit)).toContain(
    'Application component L1 has manufacturer part number "UNSOURCED-0805", expected "DFE201612E-R47M"',
  )
  expect(getTypicalApplicationComponentValueErrors(plan, circuit)).toContain(
    'Application component L1 has footprint "0402", expected "0805"',
  )
})

test("application component gate trusts the generated target IC ordering code", () => {
  const plan = {
    components: [
      {
        reference: "U1",
        kind: "buck-boost converter",
        manufacturer_part_number: "TPS63802DLA",
      },
    ],
    connections: [],
  }
  const circuit = [
    {
      type: "source_component",
      source_component_id: "u1",
      name: "U1",
      manufacturer_part_number: "TPS63802DLAR",
    },
  ] as unknown as AnyCircuitElement[]

  expect(getTypicalApplicationComponentValueErrors(plan, circuit)).toEqual([])
})
