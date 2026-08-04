import type { ModelContract } from "./types"

/** A compact generated contract reference; it is documentation, never simulator input. */
export function buildValidationPlanGuide(contract: ModelContract): string {
  const pins = contract.interface.pins.map(({ spice_node }) => spice_node)
  const modeled_requirements = contract.characterization.requirements.filter(
    ({ support }) => support.status === "modeled",
  )
  const requirements = modeled_requirements.map(({ requirement_id }) => requirement_id)
  const electrical_bindings = modeled_requirements.flatMap(({ requirement_id, reference_curve }) =>
    reference_curve?.electrical_binding
      ? [`- \`${requirement_id}\`: \`${JSON.stringify(reference_curve.electrical_binding)}\``]
      : [],
  )
  const is_time_domain_contract =
    modeled_requirements.length > 0 &&
    modeled_requirements.every(
      ({ analysis, reference_curve }) =>
        analysis === "transient" && reference_curve?.x_quantity === "time" && reference_curve.x_unit === "s",
    )
  const current_contract_analysis = is_time_domain_contract
    ? `Every modeled requirement in this contract is transient. Use the transient
shape for every case. The current tscircuit analog viewer cannot verify
operating-point, DC-sweep, or current-graph output. Use voltage observations only.`
    : `This is a compatibility contract. Match each case analysis to its modeled
requirement; do not convert a scalar requirement into a synthetic transient.`
  const current_contract_reference = is_time_domain_contract
    ? "A fresh time-domain contract always binds the curve shape."
    : "This compatibility contract may bind any shape declared by its requirement."
  return `# validation-plan.json (version 1)

Server-owned model entry: \`${contract.interface.entry_name}\`
Server-owned pin order: ${pins.map((pin) => `\`${pin}\``).join(", ")}
Modeled requirement ids: ${requirements.map((id) => `\`${id}\``).join(", ")}
${
  electrical_bindings.length > 0
    ? `\nServer-owned graph electrical bindings:\n${electrical_bindings.join("\n")}`
    : ""
}

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

For a documented application-bound requirement, the agent proposal omits
\`application_fixture\`, its node-group nets, and its passive elements. The server
injects the exact resolved topology and passives into the canonical persisted case.
Do not copy or recreate them from model-contract.json.

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
For every server-owned graph electrical binding above, use exactly one non-flat
PULSE source with the declared stimulus kind and orientation: voltage_step maps to
voltage_source and current_step maps to current_source. Extra PULSE sources that do
not match a bound requirement are rejected. Copy low, high, delay, rise, fall, width,
and period exactly from the server-owned binding; low and high must differ. The
source's dc_volts or dc_amps must equal pulse.low. Transient stop must include both
the bound delay+rise transition and the complete reference-curve time range. Each
bound requirement gets its own case; that case covers exactly one requirement and
all of its observations name that requirement.
Instantiate every binding \`auxiliary_fixtures\` entry exactly once. A \`dc_voltage\`
entry maps to a non-pulsed voltage_source with its declared endpoints and dc_volts;
\`dc_current\` maps to a non-pulsed current_source with its declared endpoints and
dc_amps. For a documented application, omit \`logic_state\`: the server compiles its
resolved condition overlay as a direct topology connection in both ngspice and TSX.
Without a documented application, \`logic_state\` maps to a non-pulsed zero-volt
voltage_source from its endpoint to its reference. An independent source touching a bound response,
stimulus, or auxiliary public endpoint is rejected unless it is that one exact
bound source. Never place a voltage source across the observed response.
When the binding carries \`application_fixture_sha256\` and
\`application_topology_sha256\`, supply only those exact stimulus/auxiliary sources.
Any extra passive or independent source changes the printed application and is rejected.

Analysis shapes:

- \`{ "type": "operating_point" }\`
- \`{ "type": "dc_sweep", "source_id": string, "start": number, "stop": number, "step": number }\`
- \`{ "type": "transient", "step": number, "stop": number, "start"?: number }\`

The validation language retains all three shapes for persisted-contract
compatibility. ${current_contract_analysis}

Observation shapes:

- voltage: \`{id,requirement_id,type:"voltage",positive,negative,unit:"V",scale}\`
- current: \`{id,requirement_id,type:"current",element_id,unit:"A",scale}\`

Fixture current is positive from its first terminal (positive/anode) toward its
second terminal (negative/cathode). To measure positive current entering a DUT
pin, orient a series resistor or zero-volt sense source from the supply net to
the DUT pin and observe that element.
For a server-owned graph binding, the voltage observation endpoints must exactly
equal response.positive and response.negative; measuring another DUT pin or
reversing polarity is rejected.

\`scale\` is \`linear\` or \`log\`. Do not write \`reference\` or \`evidence\`.
Both are server-owned output fields. The server binds each observation to its
named modeled requirement, attaches its canonical datasheet page, and
materializes one of the following reference shapes. ${current_contract_reference}

- \`{ "type": "target", "target": number, "tolerance": positive_number }\`
- \`{ "type": "bounds", "min"?: number, "max"?: number }\`
- \`{ "type": "curve", "tolerance": fraction_in_(0,0.1], "points": [{"x":number,"y":number}, ...] }\`

When a legacy requirement declares target together with min/max, the server
materializes the intersection of the target tolerance band and those hard
bounds; no declared constraint is discarded. Do not synthesize a flat transient
from a scalar legacy reference.

Every named net must join at least two fixture terminals. Every DUT pin must be
connected by at least one fixture across the plan. Every case must contain a
grounded fixture. Observations do not count as electrical connections. Unknown
fields are rejected with their JSON path. The server runs hidden weak/inert and
active/load-injection DUT probes; every observation must produce finite samples
that change materially between those probes. Passing either probe is allowed.
`
}
