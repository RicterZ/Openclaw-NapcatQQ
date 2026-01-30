import type { OpenclawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

import { napcatPlugin } from "./src/channel.js";
import { setNapcatRuntime } from "./src/runtime.js";

const plugin = {
  id: "napcat",
  name: "Napcat",
  description: "Napcat channel plugin (JSON-RPC over stdin/stdout)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenclawPluginApi) {
    setNapcatRuntime(api.runtime);
    api.registerChannel({ plugin: napcatPlugin });
  },
};

export default plugin;
