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

- \`id\`: matches \`[a-z][a-z0-9_-]{0,63}\`; case ids may contain hyphens
- optional \`title\`
- \`requirement_ids\`: one or more modeled ids; all modeled ids must be covered
- \`nets\`: declared local net ids
- \`fixtures\`: one or more elements
- \`analysis\`: one analysis object
- \`observations\`: one or more observable comparisons

Fixture ids, net ids, and observation ids must match
\`[A-Za-z][A-Za-z0-9_]{0,63}\`; they cannot contain hyphens. Requirement ids are
the server-owned snake_case values listed above.

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

- voltage: \`{id,requirement_id,type:"voltage",positive,negative,unit:"V",scale}\`
- current: \`{id,requirement_id,type:"current",element_id,unit:"A",scale}\`

Fixture current is positive from its first terminal (positive/anode) toward its
second terminal (negative/cathode). To measure positive current entering a DUT
pin, orient a series resistor or zero-volt sense source from the supply net to
the DUT pin and observe that element.

\`scale\` is \`linear\` or \`log\`. Do not write \`reference\` or \`evidence\`.
Both are server-owned output fields. The server binds each observation to its
named modeled requirement, attaches its canonical datasheet page, and
materializes one of:

- \`{ "type": "target", "target": number, "tolerance": positive_number }\`
- \`{ "type": "bounds", "min"?: number, "max"?: number }\`
- \`{ "type": "curve", "tolerance": fraction_in_(0,0.5], "points": [{"x":number,"y":number}, ...] }\`

When a requirement declares target together with min/max, the server materializes
the intersection of the target tolerance band and those hard bounds; no declared
constraint is discarded. Scalar target/bounds apply to every simulated sample.
An operating-point requirement may use a DC sweep as a stronger static check only
when the same scalar limits apply throughout the sweep. Characterization reserves
analysis=dc_sweep for varying responses and requires a reference curve.

Every named net must join at least two fixture terminals. Every DUT pin must be
connected by at least one fixture across the plan. Every case must contain a
grounded fixture. Observations do not count as electrical connections. Unknown
fields are rejected with their JSON path. The server runs hidden weak/inert and
active/load-injection DUT probes; every observation must produce finite samples
that change materially between those probes. Passing either probe is allowed.
`
}
