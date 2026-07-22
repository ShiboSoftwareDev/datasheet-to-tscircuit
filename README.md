# Datasheet to tscircuit

A Bun + React application that accepts a component datasheet, runs
[`tsci-agent`](https://github.com/tscircuit/tsci-agent) in a per-job
workspace, streams the full agent process output, builds the generated TSX with
`tsci`, and previews the resulting Circuit JSON with the same
[`@tscircuit/runframe`](https://github.com/tscircuit/runframe) surface used by
tscircuit.com.

## Run locally with Docker

The recommended demo runs the web app, API, `tsci-agent`, and `tsci` together
inside one local container. Install Docker Desktop and the `tsci` CLI, then
authenticate on the host:

```bash
tsci login
cp .env.example .env
tsci auth print-token
```

Paste the printed token into `.env` as `TSCIRCUIT_JWT`. The file is ignored by
Git and excluded from the Docker build context. Then build the image:

```bash
mkdir -p .runtime
bun run build
```

After the image has built successfully, start the application:

```bash
bun start
```

The startup entrypoint prepares the bind-mounted `.runtime` directory and then
drops privileges before running the server as the non-root `bun` user. To test
that behavior without starting the server, run:

```bash
bun run test:docker
```

Open `http://localhost:3000`. Compose publishes the port on host loopback only,
so it is not reachable from other machines. Generated PDFs, TSX, Circuit JSON,
and `agent.log` files persist under `.runtime/jobs` after the container stops.

To use OpenAI, authenticate once from the repository directory:

```bash
bun run auth:openai
```

The command starts a temporary authentication container and publishes its OAuth
callback on host loopback. OpenAI credentials are stored in
`/app/.runtime/pi-agent`, inside the existing `.runtime` bind mount. They persist
across application restarts, container recreation, and image rebuilds, so login
is normally required only once. Run the command again if the credentials expire
or become invalid. The tscircuit AI Gateway remains the default.

Stop the application with:

```bash
bun run stop
```

## Develop without Docker

```bash
bun install
tsci login
bun run dev
```

Open `http://localhost:5173`. The API runs on `http://localhost:3000` and is
proxied by Vite. Direct server execution binds to `127.0.0.1` by default. Set
`HOST` or `PORT` to override the bind address or port, and set `TSCI_AGENT_BIN`
or `TSCI_BIN` to override the discovered local executables.

## Source organization

The server is organized by responsibility. Each feature directory exposes its
public surface through `index.ts`, while its implementation lives in named
operation modules alongside that index.

```text
src/
├── server/
│   ├── agent-tools/                 structured AI-agent CLI tools
│   ├── component-evidence/          evidence parsing and validation
│   ├── component-schematic-plan/    schematic-plan parsing and validation
│   ├── instructions/                agent workspace instruction strings
│   ├── job-api/                     component-job HTTP operations
│   ├── job-artifact-validator/      generated component/application checks
│   ├── job-restorer/                persisted job recovery
│   ├── job-runner/                  component conversion phases and prompts
│   ├── job-scaffold/                generated component workspace files
│   ├── model-artifact-monitor/      saved model preview readers
│   ├── model-benchmark-lock/        immutable benchmark lock handling
│   ├── model-progress/              model progress parsing and monitoring
│   ├── model-run-api/               SPICE model-run HTTP operations
│   ├── model-runner/                model setup, refinement, and validation
│   ├── model-scaffold/              generated model workspace files and prompts
│   ├── model-scorer/                benchmark scoring and comparison output
│   ├── model-simulation-validator/  independent simulation validation
│   └── paths/                       repository path definitions
├── shared/                          browser/server data contracts
└── web/                             React UI and browser API client
```

Files are named for their exported operation. Orchestrators compose those
operations while stateful stores retain related class methods. Internal
functions follow the [tscircuit code handbook](https://github.com/tscircuit/handbook/blob/main/guides/code.md): input data is grouped into a named object and a store or execution context is passed separately.

## How jobs work

Each upload gets its own directory under `.runtime/jobs`. The server writes the
PDF and a small tscircuit project scaffold there, then executes:

```bash
tsci-agent do --prompt "..." --dir .runtime/jobs/<job_id>
```

Both stdout and stderr are streamed to the browser and persisted to
`agent.log`. The current `tsci-agent` event renderer already reports agent,
turn, tool, retry, compaction, assistant-text, and thinking events, so a separate
`--log-file` flag is not required.

The server also checkpoints task metadata to `job.json` and model-run state to
`spice/model-run.json`. At startup it scans `.runtime/jobs` and restores every
recoverable task, log, generated component, model checkpoint, and preview. A run
that was interrupted by the restart is shown as failed and can be retried from
its preserved files. Deleting a task removes its in-memory component/model jobs
and its complete `.runtime/jobs/<job_id>` directory, so it does not return after
the next restart.

After the agent exits successfully, the server runs `tsci build` and returns the
generated `index.circuit.tsx` and Circuit JSON to the browser.

The New Task form can also launch an ngspice-validated SPICE behavioral-model run with a 1×, 2×, 4×, or 8×
effort budget. Model creation is enabled by default, and the toggle/effort choice
is retained locally for the next task. Its setup agent starts alongside component conversion and extracts
datasheet curves, provenance, and benchmark references without consuming the
effort budget. If setup finishes first, the model run waits for the authoritative
component pinout. Once the component is available, a separate untimed pass
finalizes and source-compiles every benchmark circuit without running ngspice,
then the server locks the circuits and evidence before
any model artifact may be created. The refinement timer starts only after that
lock exists; higher effort uses the same locked benchmarks and scoring process
for more refinement iterations.

Model work is stored under `.runtime/jobs/<job_id>/spice`. The server immutably
snapshots the benchmark-finalization pass's manifest, evidence, and test benches
outside the agent workspace before refinement. It owns the numeric benchmark
scorer, reruns every generated tscircuit analog test bench, and
keeps the best checkpointed model when time expires. The model tab streams
structured progress checkpoints live, including datasheet/graph evidence counts,
the active benchmark, iteration number, and current champion score, alongside the
complete agent log. As benchmark TSX, saved Circuit JSON, and numeric evidence
appear, the server loads them into the runframe and plots the reference curve
with the current model result. Viewing or switching benchmarks never executes TSX;
only the agent and background validation workflow can refresh a saved simulation.
Candidate CSVs written by the agent are not trusted for final scoring or display:
the server performs a fresh `tsci build` for each analog circuit, rejects Circuit
JSON errors, and archives the exact source, Circuit JSON, and hashed extracted
curve under the job's `.model-validation` directory. Diagnostic copies are given
back to the agent under `spice/validation-artifacts`; scoring and plotting use only
the archived server results. The preview dropdown switches the saved circuit and its paired reference/result curve
together. SPICE runframes expose only Analog Simulation, Code, and Schematic, with
Analog Simulation selected initially. A failed validation pass is sent back to
the agent for another correction pass until every locked benchmark passes or the
effort budget ends; timed-out runs still expose the latest checkpoint. The
manifest, evidence, conditions, tolerances, critical flags, and sweep points remain
immutable. If independent validation nevertheless discovers a structural defect
in a locked benchmark harness, the server pauses the timer, discards all model
refinement artifacts, permits a bounded repair of only the affected
`benchmarks/*.circuit.tsx` files, and source-compiles the repaired suite. A successful
repair creates an audited lock generation while preserving the earlier snapshot,
then restarts model refinement from a clean effort boundary. Any attempted change
to the manifest or evidence rejects the repair. The published component wrapper
is always generated by the server from canonical
`model.lib` and is attached only after every locked benchmark passes. Reference and model-result traces use
complementary dash phases so both remain visible when their values overlap.
The canonical or last promoted model is published before bounded independent
validation, so a validation timeout cannot hide an available checkpoint.
Set `MODEL_BASE_EFFORT_MS` to change the local duration represented by 1× effort
(30 minutes by default). Refinement and independent validation share that effort
window, but the server stops refinement early enough to reserve validation time.
Set `MODEL_STALE_TIMEOUT_MS` to change the agent-process inactivity watchdog
(10 minutes by default); every stdout or stderr chunk resets this timeout.
Independent validation uses one bounded global worker pool across every benchmark.
It prioritizes one run from each benchmark so saved viewers appear early, then
dispatches remaining sweep points in round-robin order. Each successful run is
copied immediately to durable preview storage, and each completed benchmark
publishes its verified comparison curve without waiting for the full suite.
Validation disables unrelated PCB and parts-engine work; parameterized sweep
points retain isolated build outputs. Reference setup
and waiting for the component remain untimed. The result is not described as
PSpice-validated unless a PSpice execution backend actually runs it.

The task sidebar can start and monitor multiple conversions concurrently. Each
job has an independent process group and cancel control, so stopping one task
does not interrupt other agents or the application container.

## Security and hosting

The local Docker container is the current process and filesystem isolation
boundary. It runs as a non-root user, drops Linux capabilities, and mounts only
`.runtime` from this repository. The agent still has outbound network access,
the `TSCIRCUIT_JWT` credential, and write access to generated job files, so this
configuration is for a trusted local operator and must not be exposed as a
public upload service.

The image includes Poppler so the agent can extract datasheet text with
`pdftotext` and render pinout or mechanical-drawing pages with `pdftoppm` before
generating the component.

Long-term hosted deployment should move authentication, durable job state,
storage, quotas, and sandbox orchestration into a separate private backend. That
hosted backend is intentionally outside the scope of this local demo.
