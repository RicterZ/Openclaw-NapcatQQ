import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

let runtime: PluginRuntime | null = null;

export function setNapcatRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getNapcatRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Napcat runtime not initialized");
  }
  return runtime;
}
