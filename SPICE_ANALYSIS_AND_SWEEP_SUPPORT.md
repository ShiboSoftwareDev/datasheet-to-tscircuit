# Supporting DC, AC, transient, and parameter-sweep simulations in tscircuit

Status: architecture and implementation plan, based on the local repository/package snapshot inspected on 2026-07-17.

## Conclusion

tscircuit should expose four user-facing simulation capabilities:

1. DC analysis, including operating point and direct source sweep
2. AC small-signal analysis
3. Transient analysis
4. An outer parameter sweep that can wrap any of the analyses above

A fifth piece of infrastructure is required: a measurement/derivation layer. It is not another SPICE analysis. It reduces an analysis result to values such as average output voltage, ripple, frequency, input power, output power, or efficiency. Most power-converter characteristic curves in a datasheet are produced by an outer parameter sweep plus one or more measurements.

The ngspice WASM layer is not the main blocker. `@tscircuit/eecircuit-engine` already parses real DC/transient results, complex AC results, time axes, and frequency axes. The main blockers are the transient-only contracts and adapters above it.

## Analysis type versus plotted graph

An analysis describes what the simulator executes. A graph is one view derived from its result. They should not be represented as the same concept.

| Analysis or wrapper | ngspice statement | X values returned by one inner run | Typical graph |
| --- | --- | --- | --- |
| DC operating point | `.op` | No swept axis; one scalar value per vector | Operating-point table |
| DC source sweep | `.dc V1 0 5 0.1` | Every source value in the requested range | Voltage/current versus input voltage |
| AC small-signal | `.ac dec 20 10 1Meg` | Every requested frequency | Bode magnitude/phase versus frequency |
| Transient | `.tran 1u 10m` | Every simulated time sample | Voltage/current versus time |
| Outer parameter sweep | tscircuit orchestration | One coordinate per requested parameter value | Efficiency, frequency, ripple, or regulation versus load/input/temperature |

DC, AC, and transient each return all of their graph points from one engine invocation. tscircuit must not invoke ngspice once per time, frequency, or direct-DC point.

An outer parameter sweep is different. For `N` values, its portable implementation requires `N` inner analyses. For example, an efficiency-versus-load graph with 20 load-current values normally needs 20 transient analyses. Each transient analysis still returns all time points in one invocation, and a measurement reduces that waveform to one efficiency value.

ngspice control scripts can perform repeated runs inside one process, but the current EEcircuit API exposes only one current/last raw plot. The recommended first implementation is therefore `N` sequential `runSim()` calls while reusing one initialized WASM/ngspice instance. A later worker pool can use multiple independent instances.

The authoritative command syntax and raw-analysis behavior are documented in the [ngspice manual](https://ngspice.sourceforge.io/docs/ngspice-manual.pdf) and [ngspice control-language tutorial](https://ngspice.sourceforge.io/ngspice-control-language-tutorial.html).

## Current data flow and the blocking points

```text
<analogsimulation> props
        |
        v
@tscircuit/core creates simulation_experiment
        |
        v
circuit-json-to-spice creates one netlist
        |
        v
@tscircuit/ngspice-spice-engine
        |
        v
@tscircuit/eecircuit-engine -> ngspice WASM
        |
        v
Circuit JSON simulation results
        |
        +--> circuit-to-svg / schematic-viewer
        +--> runframe / CLI / datasheet-to-tscircuit
```

The forward path reaches ngspice, but nearly every public contract and return adapter assumes a transient time axis.

### `@tscircuit/props`

Repository: [tscircuit/props](https://github.com/tscircuit/props)

Observed package: `0.0.577`.

`lib/components/analogsimulation.ts` currently allows only `simulationType: "spice_transient_analysis"` and exposes transient fields such as `duration`, `startTime`, and `timePerStep`. `lib/platformConfig.ts` defines `SpiceEngine.simulate(spiceString)`, so experiment identity, analysis configuration, vector bindings, cancellation, capabilities, and batch execution cannot be passed structurally.

### `circuit-json`

Repository: [tscircuit/circuit-json](https://github.com/tscircuit/circuit-json)

Observed package: `0.0.448`.

`ExperimentType` already names `spice_dc_sweep`, `spice_dc_operating_point`, `spice_transient_analysis`, and `spice_ac_analysis`. However, `SimulationExperiment` only contains generic fields and transient timing fields. It has no DC sweep target/range, AC frequency sweep, outer parameter sweep, or measurement definitions.

The only analysis graph result elements are `simulation_transient_voltage_graph` and `simulation_transient_current_graph`. There is no general axis/series result, no DC result, and no complex AC result.

There is also a source-modeling issue. The current `simulation_voltage_source` union treats a non-DC source as a time-domain waveform. `circuit-json-to-spice` serializes it as `SIN(...)` or `PULSE(...)`. Small-signal AC excitation is different SPICE data (`AC <magnitude> <phase>`), and a source can legally have a DC bias, a transient waveform, and an AC excitation at the same time. These fields must not be mutually exclusive.

### `@tscircuit/core`

Repository: [tscircuit/core](https://github.com/tscircuit/core)

`lib/components/primitive-components/AnalogSimulation.ts` always inserts a transient experiment, regardless of the provided simulation type.

`Group_doInitialSimulationSpiceEngineRender.ts` converts the circuit to one shared SPICE string and invokes an engine for each `<analogsimulation>`. It then associates returned data with `simulation_experiment.list()[0]`. Consequently, multiple experiments are not isolated or reliably associated with their own results. The result path recognizes only transient voltage/current graphs and the independent-axis oscilloscope feature is also transient-specific.

The default `spicey` adapter in `lib/spice/get-spicey-engine.ts` returns only transient voltage graphs. The underlying `spicey` package can calculate AC data, but its core adapter discards it, and `spicey` does not provide the full ngspice analysis/model surface.

### `circuit-json-to-spice`

Repository: [tscircuit/circuit-json-to-spice](https://github.com/tscircuit/circuit-json-to-spice)

Observed package: `0.0.43`.

`process-simulation-experiment.ts` recognizes transient experiments, emits `.PRINT TRAN`/`.SAVE`, and populates one `tranCommand`. `SpiceNetlist` and `convertSpiceNetlistToString.ts` have no generic analysis command representation. No `.op`, `.dc`, or `.ac` command is generated.

Probe metadata is embedded in comments and then reparsed downstream. This is fragile for new analyses. The compiler already knows the exact Circuit JSON ID to SPICE vector/name mapping and should return that mapping as structured metadata with the netlist.

### `@tscircuit/ngspice-spice-engine`

Repository: [tscircuit/ngspice-spice-engine](https://github.com/tscircuit/ngspice-spice-engine)

Observed package: `0.0.19`.

The EEcircuit result types used by this adapter already support real and complex values and classify vectors as voltage, current, time, frequency, or untyped. The adapter then rejects complex results, requires a time vector, recognizes only `.print tran`, and emits only transient Circuit JSON graph elements.

The adapter caches one mutable `Simulation` object. Concurrent calls need a queue/mutex or separate instances; otherwise multiple `<analogsimulation>` elements or an outer sweep can race through `setNetList()` and `runSim()`.

### `@tscircuit/eecircuit-engine`

Repository: [eelab-dev/EEcircuit-engine](https://github.com/eelab-dev/EEcircuit-engine)

This is the most analysis-ready layer. `src/readOutput.ts` parses real and complex raw files. The repository has an AC test returning complex vectors with a frequency axis and a DC example returning a swept real result. Minimal additions are needed for explicit analysis metadata, scale-vector identity, diagnostics, cancellation, and possibly multiple raw plots later.

The current execution API returns one result plot per `runSim()`. That is another reason to compile and run one experiment per engine call instead of placing several analysis cards in one deck.

### Rendering and application repositories

- [tscircuit/circuit-to-svg](https://github.com/tscircuit/circuit-to-svg) filters for transient graph elements, reads `timestamps_ms`, and labels the X axis `Time (ms)`. It needs arbitrary axes, units, and linear/log scales.
- [tscircuit/schematic-viewer](https://github.com/tscircuit/schematic-viewer) selects only transient graph IDs for its Circuit JSON simulation viewer. Its separate interactive EEcircuit path can see time or frequency data, but currently plots only the real part of complex data.
- [tscircuit/runframe](https://github.com/tscircuit/runframe) considers an analog simulation pending until it sees a transient voltage graph. A current-only result can therefore remain pending, and all future result types would do the same.
- [tscircuit/cli](https://github.com/tscircuit/cli) already has useful low-level pieces: it recognizes `.tran`, `.ac`, `.dc`, and `.op` statements when deciding whether to inject a default transient analysis, and its result table prints real or complex EEcircuit results. Its normal Circuit JSON compiler still cannot create the non-transient analyses.
- [tscircuit/docs](https://github.com/tscircuit/docs) documents only transient `<analogsimulation>` usage and transient CLI output.
- [tscircuit/tscircuit](https://github.com/tscircuit/tscircuit) must release a compatible dependency set after the lower-level packages are published.
- This `datasheet-to-tscircuit` repository explicitly accepts only `kind: "transient_voltage"`, requires `x_axis: "time_ms"`, parses only `simulation_transient_voltage_graph`, and preflights only transient output. It should migrate after the ecosystem contracts are available.

## Proposed public model

The exact prop names should be finalized in `@tscircuit/props`, but the API must follow the existing tscircuit convention: JSX props are flat and `simulationType` is the discriminant. Analysis-specific props remain top-level and are accepted only for their matching `simulationType`.

```tsx
<analogsimulation
  name="ac-response"
  spiceEngine="ngspice"
  simulationType="spice_ac_analysis"
  acSweepType="decade"
  acPointsPerInterval={20}
  acStartFrequency="10Hz"
  acStopFrequency="1MHz"
/>
```

```tsx
<analogsimulation
  name="input-line-sweep"
  spiceEngine="ngspice"
  simulationType="spice_dc_sweep"
  dcSweepSource=".Vin"
  dcSweepStart="2.5V"
  dcSweepStop="5.5V"
  dcSweepStep="0.1V"
/>
```

```tsx
<analogsimulation
  name="efficiency-vs-load"
  spiceEngine="ngspice"
  simulationType="spice_transient_analysis"
  duration="10ms"
  timePerStep="1us"
/>
<simulationparametersweep
  simulation="efficiency-vs-load"
  target=".Iload"
  targetProperty="current"
  values={["1mA", "10mA", "100mA", "500mA", "1A"]}
/>
<simulationmeasurement
  simulation="efficiency-vs-load"
  name="vout-average"
  probe=".Vout"
  operation="mean"
  windowStart="8ms"
  windowEnd="10ms"
/>
<simulationmeasurement
  simulation="efficiency-vs-load"
  name="vout-ripple"
  probe=".Vout"
  operation="peak_to_peak"
  windowStart="8ms"
  windowEnd="10ms"
/>
```

`simulationparametersweep` and `simulationmeasurement` are proposed dedicated elements, not existing elements. They keep every prop flat while allowing more than one measurement to refer to an analysis. They should resolve the `simulation` and selector props to Circuit JSON IDs during core rendering. If different names are selected during the API review, the flat shape and ID-based relationship should remain.

The existing flat transient API must remain an alias during migration:

```tsx
<analogsimulation duration="10ms" timePerStep="1us" />
```

Omitting `simulationType` should continue to default to `spice_transient_analysis`. Supplying transient-only props such as `duration` with a different `simulationType` should be a validation error.

Source props need a separate small-signal excitation:

```tsx
<voltagesource
  name="Vin"
  voltage="5V"
  acMagnitude="1V"
  acPhase="0deg"
/>
```

`voltage`, `waveShape`/transient waveform fields, and `acMagnitude`/`acPhase` should be independently optional and serializable together.

## Canonical Circuit JSON result

Circuit JSON elements must also remain flat. Do not put `x_axis`, `series`, `values`, sweep coordinates, or measurement definitions into nested objects. Repeatable entities should be separate Circuit JSON elements connected by IDs.

The analysis configuration remains on one flat `simulation_experiment` element. For example:

```json
{
  "type": "simulation_experiment",
  "simulation_experiment_id": "experiment_ac_1",
  "name": "ac-response",
  "experiment_type": "spice_ac_analysis",
  "ac_sweep_type": "decade",
  "ac_points_per_interval": 20,
  "ac_start_frequency_hz": 10,
  "ac_stop_frequency_hz": 1000000
}
```

Keep the existing transient graph elements for backward compatibility, but add one canonical flat result element per output series. For example:

```json
{
  "type": "simulation_analysis_result",
  "simulation_analysis_result_id": "result_ac_1",
  "simulation_experiment_id": "experiment_ac_1",
  "result_kind": "analysis",
  "analysis_type": "spice_ac_analysis",
  "name": "V(out)",
  "simulation_voltage_probe_id": "voltage_probe_1",
  "x_axis_name": "frequency",
  "x_axis_quantity": "frequency",
  "x_axis_unit": "Hz",
  "x_axis_scale": "log",
  "x_values": [10, 12.589, 15.849],
  "y_axis_quantity": "voltage",
  "y_axis_unit": "V",
  "value_type": "complex",
  "y_real_values": [0.99, 0.98, 0.96],
  "y_imaginary_values": [-0.01, -0.02, -0.04]
}
```

Important rules for this schema:

- One result element represents one output series. Multiple series are multiple flat elements sharing `simulation_experiment_id`.
- X-axis fields are optional for `.op`; `y_values` then contains one scalar.
- `value_type: "real"` uses `y_values`. `value_type: "complex"` uses `y_real_values` and `y_imaginary_values`. Do not discard AC phase or store only the real component.
- Store complex values canonically as real/imaginary. Magnitude, decibels, and phase are display/derivation transforms.
- Preserve quantity and unit separately from the label.
- Preserve probe/source IDs rather than relying on generated SPICE vector names.
- A parameter-sweep summary is another flat result element with `result_kind: "parameter_sweep_summary"`, `x_values` containing parameter values, and `y_values` containing one measurement per point.
- Store parameter sweep definitions, measurements, and per-point statuses as their own flat elements. Link them using `simulation_experiment_id`, `simulation_parameter_sweep_id`, `simulation_measurement_id`, and `simulation_sweep_point_id`.
- A failed outer-sweep coordinate produces a `simulation_sweep_point` with a failure status and a linked simulation error element; it must not silently shift the result arrays.
- `simulation_oscilloscope_trace` remains a transient display element. Do not overload it for Bode or characteristic plots.

A flat parameter-sweep element would look like:

```json
{
  "type": "simulation_parameter_sweep",
  "simulation_parameter_sweep_id": "sweep_1",
  "simulation_experiment_id": "experiment_tran_1",
  "target_source_component_id": "source_component_iload",
  "target_property": "current",
  "value_unit": "A",
  "values": [0.001, 0.01, 0.1, 0.5, 1]
}
```

A flat measurement element would look like:

```json
{
  "type": "simulation_measurement",
  "simulation_measurement_id": "measurement_vout_average",
  "simulation_experiment_id": "experiment_tran_1",
  "name": "vout-average",
  "operation": "mean",
  "simulation_voltage_probe_id": "voltage_probe_vout",
  "window_start_ms": 8,
  "window_end_ms": 10
}
```

During migration, the engine adapter can emit both the canonical result and legacy transient voltage/current graphs. Existing viewers remain functional while new consumers move to the canonical result.

## Structured compiler and engine contracts

`circuit-json-to-spice` should compile one `SimulationExperiment` into a netlist plus bindings:

```ts
interface CompiledSpiceExperiment {
  experimentId: string
  analysisType: ExperimentType
  netlist: string
  vectorBindings: Array<{
    spiceVector: string
    probeId?: string
    sourceComponentId?: string
    quantity: "voltage" | "current"
  }>
  parameterBindings: Array<{
    sourceComponentId: string
    property: string
    spiceName: string
  }>
}
```

`CompiledSpiceExperiment` is an internal compiler return type, not JSX props or a Circuit JSON element. Its structured binding records do not change the flat public data conventions.

The compiler should:

- emit exactly one of `.op`, `.dc`, `.ac`, or `.tran` for one compiled experiment;
- replace `SpiceNetlist.tranCommand` with a generic analysis statement representation;
- generate `.SAVE`/`.PRINT` vectors for all analysis types;
- resolve a DC sweep source from a stable Circuit JSON/source component ID to the generated `V...` or `I...` SPICE name;
- return bindings directly instead of forcing the engine adapter to regex comments and `.print tran` lines;
- serialize small-signal source data as `DC ... AC ...` independently of transient waveform syntax.

For compatibility, `SpiceEngine.simulate(spiceString)` can remain temporarily. Add a structured optional method and capability declaration:

```ts
interface SpiceEngine {
  supportedAnalysisTypes?: ExperimentType[]
  supportsComplexResults?: boolean
  reusesSimulationSession?: boolean
  simulate(spiceString: string): Promise<LegacySpiceEngineSimulationResult>
  simulateAnalysis?(
    request: SpiceSimulationRequest,
  ): Promise<SpiceEngineSimulationResult>
}
```

`SpiceSimulationRequest` should contain the compiled experiment, solver options, and an optional `AbortSignal`. The result should contain canonical Circuit JSON, diagnostics, and engine/version metadata. Core can use `simulateAnalysis` when present and use the legacy method only for transient compatibility.

## Repository-by-repository implementation

### 1. `circuit-json`

- Expand `SimulationExperiment` into a flat discriminated union for operating point, DC sweep, AC analysis, and transient analysis.
- Add separate flat elements for parameter sweeps, measurements, one analysis-result series, sweep points, and simulation diagnostics.
- Keep arrays limited to scalar samples/values or ID lists; do not introduce nested axis, series, measurement, or sweep objects.
- Add `ac_magnitude` and `ac_phase` to voltage/current source data without making them exclusive with DC/transient fields.
- Retain all existing transient schemas and IDs.
- Add Zod and JSON fixture tests for real, complex, scalar, log-axis, and partial-sweep results.

### 2. `@tscircuit/props`

- Expand `AnalogSimulationProps` as a flat union discriminated by `simulationType`; add only top-level analysis-specific props.
- Add flat prop schemas for the proposed `simulationparametersweep` and `simulationmeasurement` elements.
- Keep legacy transient fields and normalize them in core.
- Add `acMagnitude`/`acPhase` source props.
- Extend `SpiceEngine` with capabilities and `simulateAnalysis` without immediately removing `simulate`.
- Reject invalid combinations at prop validation time.

### 3. `circuit-json-to-spice`

- Implement `.op`, `.dc`, `.ac`, and `.tran` processors.
- Return a `CompiledSpiceExperiment` with vector and parameter bindings.
- Make probe selection independent of analysis type.
- Add golden-netlist tests for every analysis and for a source with DC bias plus AC excitation.
- Keep `circuitJsonToSpice(...).toSpiceString()` as a compatibility facade.

### 4. `@tscircuit/eecircuit-engine`

- Preserve its existing real/complex parser.
- Add explicit `analysisType`, plot name, and scale-vector metadata to the result instead of requiring header/vector inference.
- Return structured diagnostics and make cancellation/reset behavior explicit.
- Verify that repeated sequential `setNetList()`/`runSim()` calls are safe on one initialized instance.
- Multiple-plot raw output and native batch/control execution can be a later optimization, not an MVP dependency.

### 5. `@tscircuit/ngspice-spice-engine`

- Replace the transient-only graph converter with a generic EEcircuit-result converter.
- Accept real `.op`/`.dc`/`.tran` results and complex `.ac` results.
- Identify the scale through structured metadata, with a defensive fallback to time, frequency, or the first raw scale vector.
- Map vectors through compiler bindings, not `.print tran` regexes.
- Emit canonical results and, for transient analyses, legacy graph elements during migration.
- Serialize access to the cached mutable `Simulation` instance. A separate instance pool is the only safe form of parallelism.
- Keep ngspice’s native transient sample grid in the canonical result. Resampling should be an explicit export/display operation rather than an unconditional engine mutation.

### 6. `@tscircuit/core`

- Normalize old/new props and insert the correct experiment subtype.
- Compile and execute each experiment separately. Never associate every response with `simulation_experiment.list()[0]`.
- Resolve sweep targets from component name/ref and property to stable Circuit JSON IDs before SPICE compilation.
- Add a reusable outer-sweep runner. For each coordinate, apply a simulation-only override, compile one inner experiment, execute it, and record status/provenance.
- Queue engine calls according to declared capabilities.
- Insert canonical results, diagnostics, progress, and legacy transient projections.
- Keep independent-axis oscilloscope behavior only on transient results.

The sweep runner should initially live in a small isolated core module. If the CLI and other non-core callers need it directly, publish it later as a reusable `@tscircuit/spice-runner` package rather than duplicating orchestration.

### 7. Measurement library

Implement measurements in TypeScript over canonical vectors so they work with ngspice and future engines. Initial reducers should include:

- mean, RMS, minimum, maximum, peak-to-peak, integral, and final value;
- frequency, period, duty cycle, and threshold crossing;
- average power from synchronized voltage/current vectors;
- derived expressions for efficiency and regulation.

Support absolute windows and a steady-state window such as the final `N` cycles. Interpolate vectors onto compatible sample times before multiplying voltage and current. Define current direction and power sign conventions in the schema and documentation. Parse expressions into a restricted AST; do not use JavaScript `eval`.

Native ngspice `.meas` can be an optional optimization later, but it should not be the canonical measurement API.

### 8. `spicey`

- Expose its existing AC output through the structured engine contract if maintaining it as an engine.
- Declare unsupported analyses honestly; do not silently return an empty result for DC or advanced-model circuits.
- Either add DC support or let core require/select ngspice for experiments outside `spicey` capabilities.
- Do not make complete multi-analysis support depend on bringing `spicey` to ngspice feature parity.

### 9. `circuit-to-svg` and `schematic-viewer`

- Add a generic Cartesian chart renderer for arbitrary axis quantities/units.
- Support linear and logarithmic X scales, multiple real series, legends, and empty/error states.
- For complex AC series, render magnitude and phase; offer linear magnitude versus dB as a display choice.
- Continue routing legacy transient graphs to the existing oscilloscope renderer to avoid visual regressions.
- Select results by `simulation_experiment_id`, not merely by graph type.

Dual Y axes and 2-D/heat-map sweep displays can wait. Multiple curves with the same unit and separate magnitude/phase panels are enough for the first release.

### 10. `runframe`, CLI, docs, and aggregate package

- In runframe, treat any completed canonical result, legacy voltage/current graph, or simulation error as terminal. Do not wait specifically for a transient voltage graph.
- Show experiment name/type, sweep progress, failed coordinates, and analysis-aware chart controls.
- In CLI, allow selecting/listing experiments and exporting canonical results as JSON or CSV. A direct analysis should execute once; an outer sweep should report `completed/total` inner runs.
- Add docs examples for operating point, DC sweep, AC, transient, and parameter-swept measurements.
- Release the aggregate `tscircuit` package only after compatible lower-level versions are published.

### 11. `datasheet-to-tscircuit`

After the ecosystem support lands:

- Change `SimulationExtractionDefinition` into a discriminated union for transient waveforms and generic X/Y characteristic curves.
- Parse `simulation_analysis_result` and select a series/measurement by stable ID or name.
- Count actual inner analyses, not merely benchmark graphs. A 20-point transient parameter sweep is 20 simulation runs.
- Extend preflight capability checks beyond the presence of `simulation_transient_voltage_graph`.
- Compare arbitrary physical X/Y axes with units, log scaling, and tolerances.
- Update benchmark locking/signatures to include analysis, sweep coordinates, measurements, solver options, and model revision.

For TPS63802-style curves, the likely mapping is:

| Datasheet curve | tscircuit implementation |
| --- | --- |
| Startup/load transient | One transient analysis; plot waveform directly |
| Small-signal loop/frequency response, if the model exposes it | One AC analysis; plot magnitude/phase |
| Static transfer curve that a source sweep can solve | One direct DC sweep |
| Efficiency versus load/input | Outer load/input sweep; transient analysis per point; average power and efficiency measurements |
| Switching frequency versus load | Outer load sweep; transient analysis per point; frequency measurement |
| Output ripple versus load | Outer load sweep; transient analysis per point; peak-to-peak measurement in steady state |
| Current limit versus input voltage | Outer input sweep; transient or DC inner analysis depending on model behavior; threshold/current measurement |

## Delivery sequence

### Phase 1: contracts and fixtures

1. Agree on the Circuit JSON experiment/result schemas.
2. Add Circuit JSON fixtures for `.op`, `.dc`, `.ac`, `.tran`, and a parameter-sweep summary.
3. Add props and the backward-compatible engine contract.

### Phase 2: direct analyses

1. Implement all four ngspice statements in `circuit-json-to-spice`.
2. Generalize `ngspice-spice-engine` result conversion.
3. Update core to execute and associate one experiment per engine call.
4. Prove call counts: one engine call each for an entire DC, AC, or transient dataset.

This phase provides the three core analog analysis families before outer-sweep complexity is introduced.

### Phase 3: generic visualization and export

1. Add canonical result rendering in `circuit-to-svg` and `schematic-viewer`.
2. Fix runframe pending/result logic.
3. Add CLI JSON/CSV export and experiment selection.

### Phase 4: measurements and outer parameter sweep

1. Implement deterministic measurement reducers.
2. Add sequential sweep orchestration, progress, cancellation, partial failures, and caching.
3. Add an optional bounded worker pool only after separate engine instances are proven safe.

### Phase 5: datasheet workflow

1. Expand this repository’s benchmark schema and validator.
2. Add representative efficiency, switching-frequency, ripple, and regulation benchmarks.
3. Update documentation and release the compatible aggregate dependency set.

## Required tests

Use small analytic circuits before testing vendor converter models:

- `.op`: resistor divider, compare the output scalar to the closed-form value.
- `.dc`: sweep the divider input source, verify all expected X points and output slope.
- `.ac`: RC low-pass, verify the cutoff magnitude and approximately `-45°` phase.
- `.tran`: RC step, verify the time constant and preserve existing transient snapshots.
- outer sweep: sweep resistance or load current, run exactly once per coordinate, and verify a derived summary curve.
- source encoding: verify one voltage source can serialize `DC 5 AC 1 0` and optionally a transient waveform.
- multi-experiment: verify result IDs associate with the correct experiment and no `list()[0]` behavior remains.
- engine concurrency: verify one shared instance queues calls and a pool uses separate instances.
- complex conversion: retain real/imaginary values and derive correct magnitude, dB, and phase.
- rendering: snapshot linear DC, logarithmic Bode, transient, multiple series, and partial-sweep error states.
- compatibility: an existing flat transient `<analogsimulation>` produces the same legacy graph data and view.

Instrumented integration tests should assert these execution counts:

| Request | Expected `runSim()` count |
| --- | ---: |
| One `.op` experiment | 1 |
| One 101-point `.dc` sweep | 1 |
| One 200-frequency `.ac` analysis | 1 |
| One transient waveform with thousands of samples | 1 |
| 20-point outer sweep around transient | 20 |
| 20-point outer sweep around a 200-frequency AC analysis | 20, producing a 20 × 200 dataset before measurement/display reduction |

## Acceptance criteria

- Existing transient JSX remains valid and visually unchanged.
- DC operating point, DC source sweep, AC, and transient compile from typed props to valid ngspice statements.
- One direct analysis returns all native axis points in one engine invocation.
- AC complex information is preserved and can be viewed as magnitude/phase and dB/phase.
- Multiple experiments are executed and associated independently.
- Outer sweep execution is deterministic, cancellable, reports progress, and preserves failed-point diagnostics.
- A measurement can turn each transient sweep point into one datasheet-curve point.
- Viewers accept arbitrary X/Y quantities and units and support logarithmic frequency axes.
- CLI can export raw/canonical series and derived sweep summaries.
- `datasheet-to-tscircuit` can validate at least one non-time-axis characteristic curve without special-casing its graph type.

## Main risks and decisions

- **Model capability:** a vendor switching-regulator model may support transient behavior but not meaningful small-signal AC or DC convergence. The analysis API cannot make an unsuitable model support an analysis.
- **AC excitation ambiguity:** time-domain sine sources and small-signal AC sources must be separate fields.
- **Sweep identity:** use component/source IDs and property bindings, not generated SPICE names, in public APIs.
- **Concurrency:** one cached mutable EEcircuit `Simulation` cannot safely serve concurrent calls without serialization.
- **Result size:** nested sweeps can be large. Keep raw inner results optional, stream progress, and store compact measurement summaries by default.
- **Numerical provenance:** store engine/version, model revision, solver options, analysis definition, measurement window, and sweep coordinate with results used for datasheet validation.
- **Engine fallback:** an engine must declare unsupported analyses and fail clearly. Silent empty result arrays are not acceptable.
- **Release skew:** these repositories publish independently. Contract fixtures and a compatibility matrix are needed before updating the aggregate package.

The smallest useful release is not “parameter sweep only.” It is canonical result schemas plus direct DC/AC/transient execution and viewing. Once those contracts are stable, the outer sweep and measurement runner becomes a composition layer instead of another set of graph-specific exceptions.
