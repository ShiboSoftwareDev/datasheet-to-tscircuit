# Datasheet to tscircuit

A Bun + React application that accepts a component datasheet, runs
[`tsci-agent`](https://github.com/tscircuit/tsci-agent) in an isolated job
workspace, streams the full agent process output, builds the generated TSX with
`tsci`, and previews the resulting Circuit JSON in schematic and PCB viewers.

## Run locally

```bash
bun install
tsci login
bun run dev
```

Open `http://localhost:5173`. The API runs on `http://localhost:3000` and is
proxied by Vite in development.

## Production

```bash
bun run build
bun run start
```

Set `PORT` to change the server port. Set `TSCI_AGENT_BIN` or `TSCI_BIN` to
override the discovered local executables.

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

> `tsci-agent`'s workspace isolation is a directory boundary, not a security
> container. Run the server in a container or similarly restricted worker before
> accepting untrusted public uploads in production.
