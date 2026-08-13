import { expect, test } from "bun:test"
import type { AnyCircuitElement } from "circuit-json"
import {
  type ComponentEvidence,
  createFootprintPlanFromEvidence,
  createTscircuitPinMappings,
  getPinoutEvidenceErrors,
  physicalPinHint,
} from "../src/server/component-evidence"
import {
  createComponentSchematicPlan,
  getComponentSchematicPlanErrors,
} from "../src/server/component-schematic-plan"
import { validateGeneratedSource } from "../src/server/component-workflow/stage-helpers"
import { getFootprintPlanErrors } from "../src/server/job-artifact-validator"
import { createModelInterface } from "../src/server/modeling"

const evidence: ComponentEvidence = {
  version: 1,
  status: "resolved",
  part_number: { value: "GRID-3", sources: [] },
  package: {
    name: { value: "BGA", sources: [] },
    pin_count: { value: 3, sources: [] },
  },
  pinout: {
    pins: [
      { number: "A1", labels: ["DATA"], role: "bidirectional", sources: [] },
      { number: "B1", labels: ["VCC"], role: "power_input", sources: [] },
      { number: "C1", labels: ["B1"], role: "ground", sources: [] },
    ],
  },
  footprint: {
    view: "pcb_top",
    units: "mm",
    drawing_orientation: { value: "pcb_top", sources: [] },
    pads: [
      { pin: "A1", kind: "smt", x: -0.5, y: 0, width: 0.25, height: 0.25, sources: [] },
      { pin: "B1", kind: "smt", x: 0, y: 0, width: 0.25, height: 0.25, sources: [] },
      { pin: "C1", kind: "smt", x: 0.5, y: 0, width: 0.25, height: 0.25, sources: [] },
    ],
  },
  unresolved_ambiguities: [],
}

const ports = evidence.pinout.pins.map((pin, index) => ({
  type: "source_port",
  source_port_id: `port-${index + 1}`,
  source_component_id: "component",
  pin_number: index + 1,
  name: pin.labels[0],
  port_hints: [`pin${index + 1}`, pin.labels[0], physicalPinHint(pin.number)],
  requires_power: pin.role === "power_input",
  provides_power: false,
  requires_ground: pin.role === "ground",
  can_use_open_drain: false,
  is_using_open_drain: false,
}))

const circuit_json = [
  {
    type: "source_component",
    source_component_id: "component",
    name: "U1",
    manufacturer_part_number: "GRID-3",
  },
  ...ports,
  ...evidence.footprint.pads.map((pad, index) => ({
    type: "pcb_smtpad",
    pcb_smtpad_id: `pad-${index + 1}`,
    x: pad.x,
    y: pad.y,
    width: pad.width,
    height: pad.height,
    port_hints: [String(index + 1), physicalPinHint(pad.pin!)],
  })),
  {
    type: "schematic_port",
    source_port_id: "port-1",
    side_of_component: "right",
    center: { x: 1, y: 0 },
  },
  {
    type: "schematic_port",
    source_port_id: "port-2",
    side_of_component: "top",
    center: { x: 0, y: 1 },
  },
  {
    type: "schematic_port",
    source_port_id: "port-3",
    side_of_component: "bottom",
    center: { x: 0, y: -1 },
  },
] as AnyCircuitElement[]

test("alphanumeric physical pins retain identity through numeric tscircuit ports", () => {
  expect(createTscircuitPinMappings(evidence)).toEqual([
    { physical_pin: "A1", tscircuit_pin_number: 1, physical_pin_hint: physicalPinHint("A1") },
    { physical_pin: "B1", tscircuit_pin_number: 2, physical_pin_hint: physicalPinHint("B1") },
    { physical_pin: "C1", tscircuit_pin_number: 3, physical_pin_hint: physicalPinHint("C1") },
  ])
  expect(getPinoutEvidenceErrors(evidence, circuit_json)).toEqual([])
  expect(getFootprintPlanErrors(createFootprintPlanFromEvidence(evidence), circuit_json)).toEqual([])
  expect(getComponentSchematicPlanErrors(createComponentSchematicPlan(evidence), circuit_json)).toEqual([])
  expect(createModelInterface(evidence, circuit_json).pins.map(({ physical_pin }) => physical_pin)).toEqual([
    "A1",
    "B1",
    "C1",
  ])
})

test("generated sources reject unsafe TypeScript escape hatches", () => {
  expect(() =>
    validateGeneratedSource(
      "type Props = { [name: string]: any }; export default function Part(_: Props) { return <chip /> }",
      "component",
    ),
  ).toThrow(/unsafe TypeScript escape hatch/)
  expect(() => validateGeneratedSource("export default (() => <chip />) as unknown", "component")).toThrow(
    /unsafe TypeScript escape hatch/,
  )
})

test("generated application sources require tscircuit traces", () => {
  expect(() =>
    validateGeneratedSource(
      `import Part from "./component.circuit"
       export default function Application() {
         return <board><Part name="U1" /><connection net="VCC" pins={["U1.VCC", "VCC"]} /></board>
       }`,
      "application",
    ),
  ).toThrow(/express electrical connections with <trace/)
})

test("generated component sources require JSX footprint port binding", () => {
  expect(() =>
    validateGeneratedSource(
      `const variants = { qfn: { footprint: [{ type: "pcb_smtpad", portHints: ["1"] }] } }
       export default function Part() { return <chip footprint={variants.qfn.footprint} /> }`,
      "component",
    ),
  ).toThrow(/passing raw pad arrays.*does not bind pads to ports/)

  expect(() =>
    validateGeneratedSource(
      `export default function Part() {
         return <chip footprint={<footprint><smtpad shape="rect" pcbX={0} pcbY={0} width={1} height={1} /></footprint>} />
       }`,
      "component",
    ),
  ).toThrow(/without portHints/)

  expect(() =>
    validateGeneratedSource(
      `const pads = [{ x: 0, y: 0, portHints: ["1"] }]
       export default function Part() {
         return <chip footprint={<footprint>{pads.map((pad) => <smtpad shape="rect" pcbX={pad.x} pcbY={pad.y} width={1} height={1} portHints={pad.portHints} />)}</footprint>} />
       }`,
      "component",
    ),
  ).not.toThrow()

  expect(() =>
    validateGeneratedSource(
      `export default function Part() {
         return <chip footprint={<footprint><smtpad pcbX={0} pcbY={0} width={1} height={1} portHints={["1"]} /></footprint>} />
       }`,
      "component",
    ),
  ).toThrow(/literal shape="rect"/)
})
