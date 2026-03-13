/**
 * Napcat plugin logger.
 *
 * Wraps the OpenClaw `ChannelLogSink` (ctx.log) with a module-scoped prefix
 * so every log line shows where it came from, e.g.:
 *
 *   [napcat/ws-client] Connected to ws://napcat:3001
 *   [napcat/watcher]   WS frame: {"post_type":"message",...}
 *   [napcat/media]     Downloaded image to napcat/image/2026-03/abc123.jpg
 *
 * Usage:
 *   import { createLogger } from "./logger.js";
 *   const log = createLogger("ws-client", ctx.log);
 *   log.info("Connected");
 *   log.debug(`Raw frame: ${raw}`);  // only emitted when debug sink is present
 */

/** Subset of ChannelLogSink exposed by openclaw/plugin-sdk */
export type LogSink = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
};

export type NapcatLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  /** Only emitted when the underlying sink has a debug method. */
  debug: (msg: string) => void;
  /** Returns a child logger with an additional sub-scope suffix. */
  child: (subScope: string) => NapcatLogger;
};

/**
 * Create a scoped logger.
 *
 * @param scope   Short module name, e.g. "ws-client", "watcher", "media", "asr"
 * @param sink    The OpenClaw log sink from ctx.log (may be undefined during tests)
 */
export function createLogger(scope: string, sink: LogSink | undefined): NapcatLogger {
  const prefix = `[napcat/${scope}]`;

  const logger: NapcatLogger = {
    info:  (msg) => sink?.info(`${prefix} ${msg}`),
    warn:  (msg) => sink?.warn(`${prefix} ${msg}`),
    error: (msg) => sink?.error(`${prefix} ${msg}`),
    debug: (msg) => sink?.debug?.(`${prefix} ${msg}`),
    child: (subScope) => createLogger(`${scope}/${subScope}`, sink),
  };

  return logger;
}
