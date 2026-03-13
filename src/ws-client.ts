import { randomUUID } from "node:crypto";
import { createLogger, type LogSink, type NapcatLogger } from "./logger.js";

export type NapcatEvent = Record<string, unknown>;

export type NapcatWsClientOptions = {
  url: string;
  timeoutMs?: number;
  onEvent?: (event: NapcatEvent) => void;
  /** Called when the WebSocket connection is closed (for any reason). */
  onClose?: () => void;
  /** Log sink from ctx.log — enables structured, leveled output. */
  log?: LogSink;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
};

/**
 * WebSocket client for Napcat OneBot v11.
 *
 * Frames with an `echo` field are matched to pending requests.
 * Frames with a `post_type` field are dispatched to the `onEvent` callback
 * (meta_event frames are silently ignored).
 */
export class NapcatWsClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly onEvent?: (event: NapcatEvent) => void;
  private readonly onClose?: () => void;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly log: NapcatLogger;
  private ws: WebSocket | null = null;

  constructor(opts: NapcatWsClientOptions) {
    this.url = opts.url;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.onEvent = opts.onEvent;
    this.onClose = opts.onClose;
    this.log = createLogger("ws-client", opts.log);
  }

  async connect(): Promise<void> {
    if (this.ws) return;
    return new Promise<void>((resolve, reject) => {
      this.log.debug(`Connecting to ${this.url}`);
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.addEventListener("open", () => {
        this.log.debug(`Connected to ${this.url}`);
        resolve();
      });

      ws.addEventListener("error", (evt) => {
        const msg = (evt as ErrorEvent).message ?? String(evt);
        const err = new Error(`Napcat WS error: ${msg}`);
        this.log.error(`WS error: ${msg}`);
        if (ws.readyState !== WebSocket.OPEN) {
          this.ws = null;
          reject(err);
        } else {
          this.failAll(err);
        }
      });

      ws.addEventListener("close", (evt) => {
        this.log.debug(`Connection closed (code=${evt.code})`);
        this.ws = null;
        this.failAll(new Error("Napcat WS closed"));
        this.onClose?.();
      });

      ws.addEventListener("message", (evt) => {
        const raw = String(evt.data);
        this.log.debug(`← ${raw}`);
        this.handleMessage(raw);
      });
    });
  }

  async disconnect(): Promise<void> {
    const ws = this.ws;
    if (!ws) return;
    this.log.debug("Disconnecting");
    this.ws = null;
    this.failAll(new Error("Napcat WS disconnected"));
    return new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      ws.addEventListener("close", () => resolve(), { once: true });
      ws.close();
    });
  }

  /** True when the underlying WebSocket is open. */
  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Send a OneBot action request and wait for the matching response.
   * Uses a UUID as the `echo` field to correlate the reply.
   */
  async request<T = unknown>(
    action: string,
    params?: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("Napcat WS not connected");
    }

    const echo = randomUUID();
    const payload = { action, params: params ?? {}, echo };
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;

    this.log.debug(`→ ${JSON.stringify(payload, (_key, value) => {
      if (typeof value === "string" && value.startsWith("base64://") && value.length > 64) {
        return `base64://<${value.length - 9} bytes>`;
      }
      return value;
    })}`);

    const responsePromise = new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(echo);
              const msg = `Request timeout after ${timeoutMs}ms (action=${action})`;
              this.log.warn(msg);
              reject(new Error(`Napcat WS request timeout (${action})`));
            }, timeoutMs)
          : undefined;
      this.pending.set(echo, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });

    ws.send(JSON.stringify(payload));
    return responsePromise;
  }

  private handleMessage(raw: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.log.warn(`Non-JSON frame ignored: ${raw.slice(0, 120)}`);
      return;
    }

    // Response frame: has echo field
    const echo = frame["echo"];
    if (typeof echo === "string" && echo) {
      const pending = this.pending.get(echo);
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        this.pending.delete(echo);
        const status = frame["status"];
        const retcode = frame["retcode"];
        if (
          (status !== undefined && status !== "ok") ||
          (typeof retcode === "number" && retcode !== 0)
        ) {
          const msg = frame["message"] ?? frame["msg"] ?? `Napcat API error (${echo})`;
          const errMsg = String(msg);
          this.log.error(`API error for echo=${echo}: ${errMsg}`);
          pending.reject(new Error(errMsg));
        } else {
          this.log.debug(`Response ok for echo=${echo}`);
          pending.resolve(frame["data"] ?? frame);
        }
      } else {
        this.log.debug(`Received response for unknown echo=${echo} (already resolved/timed out?)`);
      }
      return;
    }

    // Event frame: has post_type field
    const postType = frame["post_type"];
    if (typeof postType === "string") {
      if (postType === "meta_event") {
        this.log.debug(`meta_event dropped (sub_type=${frame["meta_event_type"] ?? "?"})`);
        return;
      }
      this.log.debug(`Event: post_type=${postType}`);
      this.onEvent?.(frame);
    }
  }

  private failAll(err: Error): void {
    const count = this.pending.size;
    if (count > 0) {
      this.log.warn(`Failing ${count} pending request(s): ${err.message}`);
    }
    for (const [key, pending] of this.pending.entries()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(key);
    }
  }
}
