import { createLocalNgspiceSpiceEngine } from "./src/server/job-scaffold/local-ngspice-engine"

const ngspiceSpiceEngine = await createLocalNgspiceSpiceEngine()

export default {
  platformConfig: {
    spiceEngineMap: {
      ngspice: ngspiceSpiceEngine,
    },
  },
}
