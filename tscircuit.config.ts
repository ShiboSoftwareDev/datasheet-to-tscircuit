import { createNgspiceSpiceEngine } from "@tscircuit/ngspice-spice-engine"

const ngspiceSpiceEngine = await createNgspiceSpiceEngine()

export default {
  platformConfig: {
    spiceEngineMap: {
      ngspice: ngspiceSpiceEngine,
    },
  },
}
