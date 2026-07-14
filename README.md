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

After the agent exits successfully, the server runs `tsci build` and returns the
generated `index.circuit.tsx` and Circuit JSON to the browser.

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
