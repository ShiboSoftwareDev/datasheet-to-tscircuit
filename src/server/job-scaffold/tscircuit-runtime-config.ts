const local_engine_url = new URL("./local-ngspice-engine.ts", import.meta.url).href

export const TSCIRCUIT_RUNTIME_CONFIG = `import { createLocalNgspiceSpiceEngine } from ${JSON.stringify(
  local_engine_url,
)}

const ngspiceSpiceEngine = await createLocalNgspiceSpiceEngine()

export default {
  platformConfig: {
    spiceEngineMap: {
      ngspice: ngspiceSpiceEngine,
    },
  },
}
`
