import { expect, test } from "bun:test"
import type { AnyCircuitElement } from "circuit-json"
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
      'import Component from "./index.circuit"\nexport default () => <board><Component name="U1" /><inductor name="L1" inductance="0.47uH" manufacturerPartNumber="DFE201612E-R47M" footprint="0805" /></board>',
      "verified",
      verified_plan,
    ),
  ).toEqual([])
  expect(
    getTypicalApplicationSourceErrors(
      'import Component from "./index.circuit"\nexport default () => <board><Component name="U1" /><inductor name="L1" inductance="0.47uH" manufacturerPartNumber="DFE201612E-R47M" footprint="0402" /></board>',
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
      'import Component from "./index.circuit"\nexport default () => <group><Component name="U1" /><capacitor name="C1" capacitance="10uF" /></group>',
      "schematic_only",
      schematic_only_plan,
    ),
  ).toEqual(['Application component C1 must set literal manufacturerPartNumber="GRM188R60J106ME84"'])
  expect(
    getTypicalApplicationSourceErrors(
      'import Component from "./index.circuit"\nexport default () => <group><Component name="U1" /><capacitor name="C1" capacitance="10uF" manufacturerPartNumber="GRM188R60J106ME84" /></group>',
      "schematic_only",
      schematic_only_plan,
    ),
  ).toEqual([])
})

test("application source must instantiate the validated default import as U1", () => {
  const plan = { components: [{ reference: "U1" }], connections: [] }
  expect(
    getTypicalApplicationSourceErrors(
      'import ValidatedComponent from "./index.circuit"\nexport default () => <chip name="U1" manufacturerPartNumber="SUBSTITUTE" />',
      "schematic_only",
      plan,
    ),
  ).toEqual([
    'Typical application must instantiate the default import ValidatedComponent from ./index.circuit exactly once with literal name="U1"',
  ])
  expect(
    getTypicalApplicationSourceErrors(
      'import ValidatedComponent from "./index.circuit"\nexport default () => <ValidatedComponent name="U1" />',
      "schematic_only",
      plan,
    ),
  ).toEqual([])
  expect(
    getTypicalApplicationSourceErrors(
      'import ValidatedComponent from "./index.circuit"\nexport default () => <><ValidatedComponent name="U1" /><ValidatedComponent name="U2" /></>',
      "schematic_only",
      plan,
    ),
  ).toEqual([
    'Typical application must instantiate the default import ValidatedComponent from ./index.circuit exactly once with literal name="U1"',
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
