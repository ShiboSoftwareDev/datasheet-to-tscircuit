import type { ModelContract } from "./types"

/** A compact generated contract reference; it is documentation, never simulator input. */
export function buildValidationPlanGuide(contract: ModelContract): string {
  const pins = contract.interface.pins.map(({ spice_node }) => spice_node)
  const requirements = contract.characterization.requirements
    .filter(({ support }) => support.status === "modeled")
    .map(({ requirement_id }) => requirement_id)
  return `# validation-plan.json (version 1)

Server-owned model entry: \`${contract.interface.entry_name}\`
Server-owned pin order: ${pins.map((pin) => `\`${pin}\``).join(", ")}
Modeled requirement ids: ${requirements.map((id) => `\`${id}\``).join(", ")}

Top level:

\`{ "version": 1, "model": { "entry_name": string, "pins": string[] }, "cases": Case[] }\`

Each Case contains exactly:

- \`id\`: stable lowercase id
- optional \`title\`
- \`requirement_ids\`: one or more modeled ids; all modeled ids must be covered
- \`nets\`: declared local net ids
- \`fixtures\`: one or more elements
- \`analysis\`: one analysis object
- \`observations\`: one or more observable comparisons

Endpoints are \`gnd\`, \`dut.<spice_node>\`, or \`net.<id>\`.

Fixture shapes:

- resistor: \`{id,type,positive,negative,resistance_ohms}\`
- capacitor: \`{id,type,positive,negative,capacitance_farads}\`
- inductor: \`{id,type,positive,negative,inductance_henries}\`
- voltage_source: \`{id,type,positive,negative,dc_volts,pulse?}\`
- current_source: \`{id,type,positive,negative,dc_amps,pulse?}\`
- diode: \`{id,type,anode,cathode}\`

A pulse is \`{low,high,delay,rise,fall,width,period}\`, all in SI units.

Analysis shapes:

- \`{ "type": "operating_point" }\`
- \`{ "type": "dc_sweep", "source_id": string, "start": number, "stop": number, "step": number }\`
- \`{ "type": "transient", "step": number, "stop": number, "start"?: number }\`

Observation shapes:

- voltage: \`{id,requirement_id,type:"voltage",positive,negative,unit:"V",scale,evidence?}\`
- current: \`{id,requirement_id,type:"current",element_id,unit:"A",scale,evidence?}\`

\`scale\` is \`linear\` or \`log\`. Do not write \`reference\`. The server binds
each observation to its named modeled requirement and materializes one of:

- \`{ "type": "target", "target": number, "tolerance": positive_number }\`
- \`{ "type": "bounds", "min"?: number, "max"?: number }\`
- \`{ "type": "curve", "tolerance": positive_fraction, "points": [{"x":number,"y":number}, ...] }\`

Every named net must join at least two fixture terminals. Every DUT pin must be
connected by at least one fixture across the plan. Every case must contain a
grounded fixture. Observations do not count as electrical connections. Unknown
fields are rejected with their JSON path.
`
}
