import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import { napcatPlugin } from "./src/channel.js";
import { napcatChannelConfigSchema } from "./src/config-schema.js";
import { setNapcatRuntime } from "./src/runtime.js";

const plugin = {
  id: "napcat",
  name: "Napcat",
  description: "Napcat channel plugin via nap-msg RPC bridge",
  configSchema: napcatChannelConfigSchema,
  register(api: OpenClawPluginApi) {
    setNapcatRuntime(api.runtime);
    api.registerChannel({ plugin: napcatPlugin });
  },
};

export default plugin;
