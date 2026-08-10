# Architecture

The backend has one generic pipeline engine and three domain pipelines:

```text
PDF datasheet
    │
    ▼
component_generation ──► validated component TSX + Circuit JSON
          │
          ├──────────────► typical_application ──► validated application TSX
          │
          └──────────────► spice_generation ──► validated model + integrated component
                                                       │
                                                       ▼
                                  React/runframe/reference-graph UI
```

The main architectural boundary is deliberate: an agent may propose an
artifact, but only server code may accept a contract, build a circuit, execute a
simulation, decide pass/fail, or publish a result.

## Layers

The new backend is split into small, directional layers:

- `src/shared/pipeline-types.ts` defines JSON-safe pipeline results, events,
  diagnostics, metrics, and artifact metadata shared with the browser.
- `src/server/pipeline` validates definitions and executes stages. It has no
  component, model, agent, tscircuit, or ngspice policy.
- `src/server/pipeline-local-run` materializes retained task inputs and executes a
  task, pipeline suffix, or full pipeline either in a selected job or in a new clone.
- `src/cli/pipeline-debug.ts` exposes the same contracts as machine-readable
  local commands for developers and coding agents.
- `src/server/component-workflow` owns separate component and
  typical-application registries and their orchestration.
- `src/server/model-workflow` owns the SPICE registry and model-specific
  orchestration.
- `src/server/modeling` owns the versioned model interface and characterization
  contracts, strategy selection, canonical model artifacts, component
  integration, and UI projections.
- `src/server/spice-validation` parses declarative validation plans, compiles
  them to SPICE, executes ngspice, parses raw series, and scores results.
- `src/server/infrastructure` contains replaceable adapters for agents,
  processes, temporary artifact workspaces, and `tsci build`.
- Stores and API modules checkpoint public state and stream it to the existing
  React UI. They do not define workflow order.

`component-workflow/component-pipeline.ts` contains the authoritative component
and typical-application registries. `model-workflow/model-pipeline.ts` contains
the authoritative SPICE registry. There is no dynamic stage discovery or phase
dispatch by method name.

## Typed stage protocol

A pipeline definition has a stable snake-case ID and an ordered list of typed
stage definitions. Every stage declares:

- a stable stage ID;
- its dependencies;
- a typed dependency-output object limited to those declared prior stages;
- a read-only run context and injected services;
- a JSON-serializable output;
- optional hashed artifacts, structured diagnostics, and scalar metrics.

The three product pipelines are linear: after the first stage, each stage
depends only on the immediately preceding output. This makes “Run step” and
“Run from here” deterministic. An isolated invocation accepts an explicit
dependency-output object, verifies its keys against the selected stage
contract, and marks every unselected stage as skipped.

The runner validates the graph before execution. It rejects duplicate or
missing IDs, forward dependencies, and dependency cycles. Completed outputs are
deep-frozen. A stage can complete or explicitly skip; an exception is converted
to a failed stage diagnostic. A stage whose dependency did not complete is
recorded as skipped, and cancellation records the active and remaining stages
as cancelled.

Stage results always have one of these states:

```text
pending → running → completed
                  ↘ skipped
                  ↘ failed
                  ↘ cancelled
```

The runner publishes an immutable snapshot after each event. `JobStore` and
`ModelRunStore` persist that snapshot, while the browser can display the same
stage IDs, states, durations, and diagnostics without parsing prose logs.

A stage marks `commit_state: "committed"` only after its irreversible
publication boundary. From that point onward, cancellation or a debug/event
write failure cannot reclassify the published result as failed. Post-commit
trace failures become structured warnings and are recorded best-effort in
`observer-errors.ndjson`; restart recovery resolves the durable publication.

### Diagnostics

`PipelineError` carries structured context instead of relying on string
matching:

- `code` and `severity` identify the failure class;
- `stage_id` and `operation` locate it in the workflow;
- entity and artifact references identify affected inputs or outputs;
- `cause_chain` retains nested error names, messages, and stacks;
- `hint` describes the next useful inspection;
- `retryable` distinguishes an actionable retry from a deterministic rejection.

Process failures have their own typed codes for spawn failure, non-zero exit,
idle timeout, absolute timeout, and cancellation. The process adapter streams
both output channels, keeps a bounded output tail, watches declared heartbeat
files, applies idle and wall-clock deadlines, and terminates the complete child
process group on cancellation.

## Debug artifacts

Every invocation gets a new UUID so retries never overwrite the preceding
trace:

```text
.runtime/jobs/<job-id>/runs/<pipeline-id>/<invocation-id>/.pipeline/
├── events.ndjson
├── input-objects/                # SHA-256-addressed task input bytes shared by stages
├── observer-errors.ndjson        # only when an optional snapshot sink fails
└── stages/
    ├── 01-extract_evidence/
    │   ├── input.json
    │   ├── input-files.json
    │   ├── output.json
    │   ├── error.json
    │   └── metrics.json
    ├── 02-generate_component/
    │   ├── attempt-history.json
    │   └── rejected-attempts/<attempt>/...
    └── ...

.runtime/jobs/<job-id>/spice/runs/<invocation-id>/.pipeline/
├── events.ndjson
└── stages/...
```

`events.ndjson` is an append-only, sequenced timeline. A stage's `input.json`
is a versioned `pipeline_task_input` envelope recording its pipeline/task
identity, source run, complete JSON execution context, dependency states, and
completed dependency outputs. Its `input-files.json` manifest maps the complete
pre-task filesystem to immutable objects in `input-objects`; runtime logs and
prior run histories are deliberately excluded. Runtime services such as
credentials, process launchers, and installed simulator binaries are injected
by the local runtime. `output.json` contains its
terminal result, diagnostics, and SHA-256 artifact records;
`error.json` contains the structured failure when present; and `metrics.json`
contains timing, counts, and stage metrics.

Before a stage completes, the runner verifies each declared regular file and
copies it into a read-only `artifacts/` directory in that stage bundle. A later
retry therefore cannot change the bytes behind an earlier trace and hash.

The component and model logs remain at `agent.log` and
`spice/model-agent.log`. Each is NDJSON with one complete structured log event
per line, so arbitrary process chunks cannot merge or masquerade as another
event. Each current log and its single `.1` archive are capped at 2 MiB, one
event is capped at 256 KiB with an explicit truncation marker, and live stores
retain the latest 500 events. The pipeline trace is the authoritative
state-machine record.

### Local task and pipeline runs

The local debugger treats each stage as an independently addressable task. The
pipeline is only an ordered composition that passes a completed output into the
next task. `bun run debug -- task run --input <input.json>` selects exactly one
task and validates that the supplied dependency keys match its registry
contract. `pipeline run` accepts only the first registered task's input, while
`local run <job>` locates retained inputs by job, pipeline, and task ID and
supports exact-task, suffix, and whole-pipeline modes.

Cloned Local execution is non-destructive. Immediately before a runnable task starts,
the runtime snapshots its complete job input into a manifest and content-addressed
object store, excluding runtime logs and earlier `runs` histories. A Local run verifies
those hashes, materializes only those retained bytes in a fresh directory,
rewrites every declared job-local path in the context and dependency payload,
restores private stores from the retained checkpoints, and then invokes the
ordinary production stage definition. It never clones or consults the job's
current filesystem state. Supplying a target job instead restores that exact
retained boundary into the selected job, refreshes its live stores from the
restored checkpoints, and runs there under the same per-job execution lease as
the UI. The Local directory contains a stable `summary.json`,
a new event stream, new task bundles, canonical outputs, and immutable artifact
snapshots. This gives a local AI the same task inputs, failures, graphs, and
generated files as the UI without granting it an alternate workflow implementation.

## Component and typical-application pipelines

The workflow is split into two linear pipelines. Component publication is the
only dependency between them:

```text
extract_evidence
  → generate_component
  → build_component
  → validate_component
  → repair_component
  → publish_component

generate_application
  → build_application
  → validate_application
  → repair_application
  → publish_application
```

| Stage | Responsibility |
| --- | --- |
| `extract_evidence` | Record source/tool provenance, initialize public validation state, let an isolated agent inspect the PDF, canonicalize only representation-equivalent input forms, strictly parse pinout/package/application evidence, render every cited page on the server, then independently transcribe both PCB-top pad geometry and the application graph from trusted page images. Pad geometry and net partitions must agree before the server derives plans and atomically publishes the shared semantic evidence-set commit. |
| `generate_component` | Generate only `index.circuit.tsx` from accepted JSON plans and reference images. The PDF is not present in this workspace. |
| `build_component` | Run `tsci build` and the server-created board fixture, then save the unjudged Circuit JSON and execution diagnostics. |
| `validate_component` | Deterministically compare the saved build against the accepted footprint, pinout, and schematic plans without invoking tools or agents. |
| `repair_component` | Feed deterministic validation errors into bounded isolated repair attempts and re-run their build and validation checks. It does not publish. |
| `publish_component` | Commit the passing candidate as the canonical `component.circuit.tsx` and `component.circuit.json`, then expose it to consumers. |
| `generate_application` | Generate a typical application only when the accepted application plan says one is documented. This is the first application stage that requires the published component. |
| `build_application` | Run `tsci build` and save the unjudged application Circuit JSON and execution diagnostics. |
| `validate_application` | Deterministically check source shape, values, connectivity, and the saved Circuit JSON against the accepted plan. |
| `repair_application` | Run bounded repairs. A still-invalid optional application becomes a warning rather than hiding a valid component. |
| `publish_application` | Expose the validated optional application and its warnings. The runner marks the job terminal only after the pipeline trace is fully finalized. |

Important durable component artifacts include:

```text
datasheet.pdf
provenance.json
evidence-commit.json
evidence-revisions/<generation-id>/
├── datasheet.pdf
├── component-evidence.json
├── footprint-plan.json
├── component-schematic-plan.json
├── typical-application-plan.json
├── footprint-geometry-review.json
├── footprint-geometry-verification.json
├── application-connectivity-review.json
├── application-connectivity-verification.json
├── evidence-image-manifest.json
└── visual-reference/
index.circuit.tsx
component.circuit.tsx
component.circuit.json
component-validation.json
typical-application.circuit.tsx       # when documented and valid
application-validation.json
```

Agent output is not written directly into the canonical job directory. Each
artifact attempt receives a fresh temporary workspace containing only declared
inputs. The server parses and validates the candidate there, then promotes
declared files atomically. Invalid attempts are not promoted: their declared
files and validation error are retained under the stage's `rejected-attempts/`
debug directory. A correction workspace is safely seeded from those bounded,
no-symlink files and receives cumulative diagnostics plus the contract hash.
The expensive PDF extraction therefore survives a serialization correction. A
typed or process failure from a nested independent verifier still retains the
enclosing evidence candidate and adds it to the stage diagnostic before
terminating; cancellation remains cancellation and does not create a rejected
candidate.

The evidence contract is defined by shared version/enum constants and exact
canonical examples. Safe boundary canonicalization is deliberately narrow:
integer pin identifiers become strings, the industry synonym `smd` becomes
`smt`, and no other meaning-changing conversion is allowed. Missing versions,
prose or unsupported orientations, identities, dimensions, sources, and
connectivity are never invented. Agent-authored PNG pixels are discarded. The
server renders every cited PDF page at 200 DPI and binds each trusted image,
alias, source page, and the datasheet hash in `evidence-image-manifest.json`.

Identity has two explicit levels. `component-evidence.json` records the base
device family in `part_number` and the exact selected package/carrier variant
in `ordering_code` when they differ. The application-visible U1 `value` remains
the base family, while canonicalization binds U1 `manufacturer_part_number` to
the authoritative selected orderable for downstream generation. An ordering
code must be a distinct extension of its base identity after punctuation is
removed. A supplied wrong, reversed, or truncated identity is rejected. Legacy
exact-only evidence may infer a visible family only when the remaining suffix
matches a datasheet package identifier; arbitrary prefixes are not accepted.

For every application claim, including `not_present`, a second isolated agent
receives only the immutable source PDF and its reviewer contract—never the
extractor's page selection, crop, pin hints, component inventory, or graph. It
independently searches the document and emits visible components and electrical
endpoint partitions, or the sections it searched. The server compares the
component inventory and kind (plus any independently visible value or MPN),
canonicalizes physical U1 identities, external terminals, and unordered net
membership, ignores net names and ordering, and requires exact multiset graph
agreement. This catches omitted parts, kind/value disagreements, and misplaced
endpoints without trusting extractor-owned topology. Review parsing reports all
malformed endpoints without cascading derivative errors and, once the review is
valid, collects inventory, visible-fact, and graph differences into one
cumulative correction diagnostic instead of revealing one issue per outer
attempt.

Footprint geometry has the same independent boundary. A separate isolated
reviewer receives `datasheet.pdf`, the server-rendered full-page
`visual-reference/land-pattern.png`, but no extractor pin names,
`component-evidence.json`, `footprint-plan.json`, or extractor-authored
dimensions. The server strictly parses the review, rejects low-confidence or
duplicate-pad identities, and compares every pad center, copper dimension,
kind, and hole dimension at 0.01 mm tolerance. A valid disagreement rejects the
outer extraction candidate, so a plausible but copied special-pad dimension
cannot publish merely because generated TSX repeats it.

Independent reviews are observations, not mutable extractor artifacts. Each is
fingerprinted from its reviewer contract and immutable inputs: the bound source
PDF and, for footprint review, the trusted land-pattern page and content hash.
The fingerprint contains the effective schema, instructions, and base-prompt
digest rather than a manually synchronized version label. An unchanged
fingerprint reuses the same observation across outer evidence repairs; a changed
immutable input reruns the reviewer. Before comparison or publication, the
server atomically reinstalls its cached review JSON over the retained workspace
copy, preventing deletion, edits, or symlink substitution by a correction
attempt.

The version-3 evidence commit is the publication barrier. The server first
semantically re-parses the canonical evidence, derived plans, independent
footprint and application reviews, both agreement records, and trusted-image
manifest. It then materializes one fully synced immutable
`evidence-revisions/<generation-id>` directory and atomically replaces
`evidence-commit.json` to select it. API readers serve only the snapshotted
bytes covered by that pointer, so a failed replacement, partial promotion, or
later root-file mutation cannot expose a mixed evidence generation. Each
revision carries the exact datasheet bytes bound by the trusted-image manifest,
so model characterization cannot race a later PDF replacement. Version-1 and
version-2 markers remain read-compatible, but version 1 is not accepted as a
model-generation input because it did not bind the PDF.

Transport retries and artifact retries are separate. The agent adapter retries
only classified transient transport failures; schema, source, build, and
electrical failures go through their owning validation or repair stage.

## SPICE workflow

The SPICE pipeline starts alongside the component job but waits for the
component pipeline's terminal publication:

```text
wait_for_component
  → prepare_workspace
  → find_reference_graphs
  → create_comparison_graphs
  → infer_spice_model
  → create_simulation_tsx
  → run_simulations
  → compare_simulation_outputs
  → repair_spice_model
  → publish
```

| Stage | Responsibility |
| --- | --- |
| `wait_for_component` | Wait for terminal component publication, not the early live-preview milestone, and fail with component context if the job cannot produce one. |
| `prepare_workspace` | Copy canonical inputs and derive an exact server-owned SPICE interface from accepted pin evidence. |
| `find_reference_graphs` | Scan the complete PDF, retain eligible datasheet graph crops and independently verified numeric traces, and publish them to Datasheet Reference. |
| `create_comparison_graphs` | Turn accepted reference traces and printed conditions into the comparison cases used by later simulation scoring. |
| `infer_spice_model` | Infer a self-contained `model.lib` and explanatory `model-card.md`; derive the manifest and revision on the server. |
| `create_simulation_tsx` | Render every validation case to a standalone, hash-retained TSX source in one deterministic pass. |
| `run_simulations` | Execute ngspice, private stimulus-causality replays, and the retained tscircuit TSX sources; persist raw outputs and viewer Circuit JSON. |
| `compare_simulation_outputs` | Compare simulator outputs with the reference/comparison curves and emit a dedicated comparison receipt plus closed-enum repair feedback. |
| `repair_spice_model` | Repair only the model from typed aggregate comparison feedback, then rerun validation. The comparison plan remains unchanged; the effort multiplier bounds repair attempts. |
| `publish` | Revalidate the hash-bound candidate/viewer receipts, re-render every reference crop from the canonical PDF, generate and build the wrapper, verify its exact model and pin mapping, stage hash-verified immutable model/component bundles, and atomically select the pair with one publication pointer. |

### Stable model contracts

The handoffs between model stages are versioned files rather than prose or log
markers:

- `model-interface.json` is derived by the server from validated Circuit JSON.
  It owns the subcircuit entry name, physical pin order, the exact selector-safe
  port hints and source-port IDs present in that build, and SPICE node names.
- `model-characterization.json` is the parsed agent proposal.
- `time-graph-hints.json` is a deterministic complete-PDF `pdftotext` scan for
  timing captions and printed time axes, including plural/title-before-figure
  layouts. Each hint retains source-grounded nearby operating conditions and
  deterministic blockers for register programming, digital protocols, and
  internal configuration. It also retains a server-derived transient fixture
  only when the graph's own layout-preserving section prints the response and
  stimulus signals, numeric low/high levels, and rise/fall times. The explicit
  `null` form is authoritative and prevents a later agent from inventing a
  convenient pulse for switching, startup, or other unqualified waveforms.
- `reference-graph-preflight.json` is generated independently for each immutable
  discovery crop before its first comparison-digitization attempt. It contains
  only bounded canonical-PDF facts: adjacent figure identity, OCR measurement
  and division-scale candidates, neutral grid-line candidates, deterministic
  grid spacing, and source units-per-pixel/anchor-span candidates. The artifact
  is attempt guidance, not an acceptance receipt; the ordinary pixel verifier
  and source-proof builder still recompute candidate-specific trace, grid,
  scale, caption, and baseline acceptance. Per-graph copies remain under
  `reference-observer/<graph-id>/preflight.json` beside retry history.
- `model-reference-observation.json` is produced in a separate source-only
  workspace with no candidate characterization. It inventories elapsed-time
  graphs, their visible time-axis evidence, public-pin response, supported
  fixture reproducibility, and an independent 200-DPI crop containing the
  plotted axes and immediately adjacent figure-number caption. Every eligible
  voltage/time graph also carries a private pixel trace: SI axis ranges, two
  pixel/value calibration anchors per axis, trace color, and distributed
  pixel-bound numeric points. The characterization agent receives only a
  sanitized graph/crop inventory, never this numeric provenance.
- `model-reference-source-proof.json` is a deterministic receipt built from
  canonical `datasheet.pdf`, not agent assertions. It binds the PDF and exact
  crop hashes, a 600-DPI Poppler render, the Tesseract version and bounded OCR
  token boxes, an adjacent `pdftotext -bbox-layout` figure identity, and either
  two source-read ticks per axis or source-read oscilloscope division scales
  reconciled with detected grid spacing and a local printed nominal voltage.
  Missing OCR executables are a typed non-retryable infrastructure failure;
  ambiguous or unsupported source calibration makes only that graph ineligible.
- `model-reference-verification.json` records the server-computed one-to-one
  page, figure, electrical-binding, and exact canonical-crop match between that
  observation and every modeled curve. It also binds the source-calibration
  receipt digest, observer/candidate curve digests, independent interpolation
  error and coverage metrics, and a hash-checked proof that every withheld
  observer point remains inside and touches the waveform in that exact crop.
- `model-contract.json` combines the interface fixed for the current invocation
  with accepted characterization requirements.
- `validation-plan.json` is a declarative circuit contract. An agent proposes
  fixture elements, analyses, and observations. Numeric references and
  datasheet evidence are server-owned output fields: the proposal parser
  replaces any legacy agent-authored copies with values derived from the
  immutable model contract before any model is generated. Persisted canonical
  plans use a separate strict parser so altered references or evidence fail
  restart and publication integrity checks.
- `model.lib` must expose exactly one public `.SUBCKT` with the server-owned
  entry and pin order. Self-contained private helper subcircuits and `.MODEL`
  definitions are allowed; external includes, control blocks, and shell commands
  are rejected.
- `model-manifest.json` is generated by the server and contains the canonical
  pin mapping plus a revision derived from the model source.
- `validation-results.json` records per-case series, metrics, errors, and hashes
  of the plan, model, and manifest used for the run. For an electrically bound
  curve it also contains a server-owned `bound_pulse_flatten_v2` receipt: the
  same candidate must change by a material fraction of the immutable reference
  span and the flattened-stimulus replay must fail the reference comparison.
- `viewer-validation.json` binds the plan, manifest, model source, and one
  canonical Circuit JSON file per case. Publication rereads these hashed files,
  proves that each graph embeds the exact DUT model and pin map, and requires
  the exact Runframe waveform to pass rescoring.
- `published-model.json` version 3 binds the owning job, one invocation, the
  immutable `fresh_time_voltage_v1` policy, model revision, accepted-model
  bundle manifest, and integrated-component bundle manifest. Version-2
  pointers remain readable for existing jobs, but the publication writer only
  accepts version 3. The pointer is the only publication commit point; files
  copied to legacy root paths afterward are compatibility mirrors.

The model-generation agent does not receive `validation-plan.json` or raw
validation artifacts. For each fresh modeled reference curve, the server keeps
the endpoints and alternating interior samples in a deterministic training view
and withholds the complementary interior samples. Fresh curves therefore need
at least eight points, with the minimum increasing by crop width up to 48 points.
Generation and repair see only that training contract; the immutable full
contract remains authoritative for scoring and publication. A regression model
that matches every visible sample but misses a held-out sample fails full server
scoring.

The server compiles the documented typical application into an immutable
application-fixture contract before characterization. Printed ground aliases
such as GND, AGND, and PGND are merged into the one simulator reference node
while their original source endpoints remain recorded. Only supported passives
with a positive SI value become executable fixtures. Batteries, switches,
loads, chargers, and valueless passives remain explicitly listed as
`non_executable_components`; they are hash-bound to the retained source plan but
are never assigned invented SPICE behavior. A graph that depends on an omitted
value or apparatus must supply a supported, source-proven electrical binding or
remain documented-only.

Fresh executable characterization is intentionally narrower than the generic
persisted schema: a modeled requirement must be a public-pin transient response
with elapsed time in seconds, a digitized voltage reference curve, and the exact
source-observer crop derived from the cited PDF page at 200 DPI. Scalar,
operating-point, DC-only, and current-only evidence remains `documented_only`;
it cannot be promoted into a fake waveform. The server replaces the
characterizer's rectangle with the observer-owned crop before materialization;
publication accepts no shifted, clipped, containing, or merely overlapping
variant. The crop must be at least 96×64 pixels, fit the canonical page, contain
visible nonuniform pixels, retain a source-local matching caption, and carry a
source-grounded axis-calibration receipt. PDF/OCR source proof runs inside the
independent observer's correction boundary: an invalid crop, missing local
caption, or unproven axis returns graph-specific feedback before the artifact is
promoted. Only a valid observation with no source-eligible graph reaches the
terminal `no_eligible_time_domain_graph` result. A graph is eligible only when its
printed numeric conditions identify a stimulus that can be
expressed by the supported passive and pulsed/DC fixture language without
hidden register, protocol, or internal configuration setup. The server binds
that exact stimulus and response to the public interface and constrains pulse
timing to the graph window. An all-documented proposal is retried when the
independent observer found an eligible graph. If the source-only observer finds
none, the workflow ends immediately with the typed
`no_eligible_time_domain_graph` diagnostic before characterization can invent a
model. Compatibility parsing still accepts already-published scalar/DC
contracts, while the immutable fresh-publication policy marker prevents a new
run from selecting that compatibility path.

Generated DUT source is causal: behavioral access to simulator time,
independent PWL/PULSE/SIN/EXP/SFFM/AM playback sources, autonomous random/noise
expressions, XSPICE code models, and scripted initial state are rejected.
Ordinary electrical state and input-dependent B/E/G behavior remain supported.
The private flattened-pulse replay runs after initial generation and every
repair; its dynamic-region comparison rejects token stimulus dependence and its
detailed waveform is never returned to the repair agent.

Generation and repair also use a fail-closed agent capability profile. The only
enabled tool names come from one explicit extension: one reader confined to the
canonical temporary workspace and one writer confined to `model.lib` and
`model-card.md`. There is no shell, unrestricted built-in file tool, ambient
context-file discovery, or additional extension. The custom names do not match
built-ins, so an extension-load failure leaves the agent without tools instead
of silently restoring broad filesystem access. A repair receives the preceding
model plus an aggregate enum-and-count failure summary; simulator output, paths,
case IDs, observation IDs, metrics, sample counts, fixture values, hashes, and
validation coordinates never cross into its workspace. This keeps optimization
tied to documented behavior instead of a visible testbench.

The declarative validation language currently supports operating-point, DC
sweep, and transient analyses; resistor, capacitor, inductor, diode, voltage
source, and current source fixtures; voltage and current observations; and
target, bounds, or curve comparisons. It intentionally has no raw SPICE
expression or `.measure` escape hatch.

## SPICE execution and scoring

`spice-validation` implements one deterministic path:

1. Parse the complete plan and report all path-specific contract errors.
2. Verify the model entry/pin mapping, fixture identifiers, connectivity,
   ground, sweep source, requirement coverage, and DUT-pin coverage.
3. Compile each case to a server-owned SPICE netlist.
4. Remove stale raw data, request ASCII output, and run each case in its own
   artifact directory.
5. Parse ngspice raw vectors and compare every observation with its declared
   target, bounds, or reference curve.
6. Persist process logs, netlist/raw hashes, per-case results, and the aggregate
   result.

The replayable layout is:

```text
spice/candidates/<revision>-<id>/validation/
├── model.lib
├── validation-results.json
├── viewer-validation.json
├── cases/
│   └── <case-id>.circuit.json
└── <case-id>/
    ├── .spiceinit
    ├── circuit.cir
    ├── result.raw
    ├── stdout.log
    ├── stderr.log
    └── result.json
```

This directory answers four debugging questions without rerunning an agent:
which inputs were tested, which netlist was executed, what the simulator
returned, and why the comparison passed or failed.

A passing candidate is still private until its deterministic validation TSX
also builds through tscircuit and the retained Circuit JSON contains exactly one
traceable transient experiment with a scored voltage waveform for every
observation. The Circuit JSON must also contain the exact planned PULSE helper,
including source kind, DC/low/high levels, edge timing, DUT endpoint, polarity,
and ground/net connectivity. Current graphs are not accepted because the
installed tscircuit runtime does not currently emit them.
The direct server ngspice result and the Runframe-consumed waveform must both
pass the immutable datasheet curve. The same viewer check runs again immediately
before publication, so a schematic-only snapshot, an operating-point result, or
a missing graph cannot become an accepted model. Publication independently
re-renders each exact graph crop from canonical `datasheet.pdf`, compares
decoded pixels with the retained crop, re-runs the source axis/caption proof,
and requires byte-stable proof semantics. A coherent synthetic PNG, a same-page
neighboring plot, or a stale receipt cannot publish.

A passing candidate is still private until the integrated wrapper also builds
and its pin map matches. Publication creates a new immutable accepted pair:

```text
published-model.json
spice/accepted-revisions/<revision>-<publication-id>/
├── bundle-manifest.json
├── publication-record.json
├── model-workflow-policy.json
├── model.lib
├── model-card.md
├── model-manifest.json
├── model-contract.json
├── model-characterization.json
├── validation-plan.json
├── validation-results.json
├── model-ui.json
├── time-graph-hints.json
├── model-reference-observation.json
├── model-reference-source-proof.json
├── model-reference-verification.json
├── datasheet.pdf
├── evidence/figures/...
└── validation/
    ├── viewer-validation.json
    └── cases/<case-id>.{preview.json,circuit.tsx,circuit.json}
published-models/<revision>-<publication-id>/
├── bundle-manifest.json
├── publication-record.json
├── model-workflow-policy.json
├── index.circuit.tsx
├── component.circuit.json
└── model.lib
```

Both manifests bind every regular file in their bundle, including identical
publication ownership records. Readers verify the complete file set, hashes,
owning job and invocation, model revision, deterministic wrapper, embedded
source, and exact pin map before selecting it. They then reopen individual
artifacts with `O_NOFOLLOW`, enforce per-file bounds, and recheck size and
SHA-256 before returning buffered bytes. A corrupt pointer or bundle is isolated
to that job during startup: the base component remains visible as failed with a
traceable integrity warning, and healthy siblings still restore. Prepared model
directories are removed on cancellation, stale identity, or any other
pre-pointer failure. Cleanup first resolves the current pointer and never
deletes the generation it selects.

Pointer and checkpoint writers treat rename as the visibility boundary. A
parent-directory `fsync` failure after rename is reported as a durability
warning rather than as a failed write, preventing callers from rolling back
live state after readers can already observe the new pointer.

## UI preservation

The rewrite keeps the existing browser contracts and visualization surfaces:

- component TSX and Circuit JSON viewers;
- datasheet land-pattern, schematic, and typical-application references;
- live logs, cancellation, retry, and persisted restoration;
- model source and model card views;
- validation-case selection and deterministic TSX fixture projections;
- retained datasheet graph images;
- reference-versus-result plots and comparison metrics;
- component and model execution traces with stage status, error code, and
  duration.

`modeling/ui-projection.ts` derives display data from the selected accepted
validation plan and server-scored result. It writes
`model-ui.json`, `validation/cases/<case-id>.preview.json`, and deterministic
`validation/cases/<case-id>.circuit.tsx`. A saved Circuit JSON snapshot exposes
the analog tab only when it contains a completed transient experiment and
waveform. The displayed result curve and comparison metrics come from those
exact Runframe-consumed samples; `validation-results.json` remains the separate
server-validation record. Scalar compatibility previews are labeled as
specification checks and never as graph matches.

The UI is a projection of canonical artifacts, not an independent validation
path. Changing tabs or selecting a case does not redefine the model contract or
pass/fail result.

## Extension points

### Add a pipeline stage

1. Add the stage output to the workflow's `*PipelineOutputs` type.
2. Implement the stage with `defineComponentStage` or `defineModelStage`.
3. Declare explicit dependencies and return JSON-safe output.
4. Add the stage once to the authoritative pipeline registry.
5. Return hashed artifacts and typed diagnostics where they help debugging.

Do not add a second orchestration list, infer progress from log text, or access a
store through an undeclared global.

### Add a model strategy

Add a versioned strategy to `modeling/strategy-registry.ts` (and its strategy ID
type when introducing a new ID). Declare supported model families and concise
guidance. Inject a custom `ModelStrategyRegistry` through `ModelRunnerContext`
for tests or alternate deployments.

### Add validation vocabulary

Extend the type, strict parser, connectivity/coverage validation, compiler, raw
series mapping, and scoring together. Preserve the declarative boundary: a new
feature must compile from typed data and must not accept arbitrary simulator
commands.

### Add an external adapter

Agents and child processes are interfaces injected through workflow services.
New providers should implement `AgentClient` or `ProcessRunner`, preserve typed
errors and cancellation, and avoid leaking provider-specific states into domain
stages.

## Design rules

1. One authoritative stage registry per workflow.
2. Stable, versioned, machine-validated contracts between stages.
3. Agents propose; server code validates, executes, scores, and publishes.
4. Within an invocation, accepted evidence and validation contracts are
   immutable once downstream generation begins. A retry starts a new invocation
   instead of rewriting the earlier trace.
5. Every agent attempt is isolated and only declared artifacts are promoted.
6. Validation failures are data until a bounded repair stage exhausts its
   budget.
7. Retry only the failure class that owns the retry policy.
8. Use structured diagnostics and artifact references, never log-marker state
   machines.
9. Derive UI projections from canonical artifacts instead of creating a second
   source of truth.
10. Keep agent, child-process, and tscircuit implementations behind injected
    services. Keep filesystem access explicit and confined to workflow and
    artifact modules.
11. Publish related artifacts as an immutable, fully hashed set selected by one
    atomic pointer; treat later root-file copies as compatibility only.
