import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

export type NapcatRpcNotification = {
  method: string;
  params?: unknown;
};

export type NapcatRpcError = {
  code?: number;
  message?: string;
  data?: unknown;
};

export type NapcatRpcResponse<T> = {
  jsonrpc?: string;
  id?: string | number | null;
  result?: T;
  error?: NapcatRpcError;
  method?: string;
  params?: unknown;
};

export type NapcatRpcClientOptions = {
  cliPath?: string;
  napcatUrl?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  onNotification?: (msg: NapcatRpcNotification) => void;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
};

export class NapcatRpcClient {
  private readonly cliPath: string;
  private readonly napcatUrl?: string;
  private readonly timeoutMs?: number;
  private readonly env?: Record<string, string>;
  private readonly onNotification?: (msg: NapcatRpcNotification) => void;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly closed: Promise<void>;
  private closedResolve: (() => void) | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private reader: Interface | null = null;
  private nextId = 1;

  constructor(opts: NapcatRpcClientOptions = {}) {
    this.cliPath = opts.cliPath?.trim() || "nap-msg";
    this.napcatUrl = opts.napcatUrl?.trim() || undefined;
    this.timeoutMs = opts.timeoutMs;
    this.env = opts.env;
    this.onNotification = opts.onNotification;
    this.closed = new Promise((resolve) => {
      this.closedResolve = resolve;
    });
  }

  async start(): Promise<void> {
    if (this.child) return;
    const args = ["rpc"];
    if (this.napcatUrl) {
      args.push("--napcat-url", this.napcatUrl);
    }
    const child = spawn(this.cliPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(this.napcatUrl ? { NAPCAT_URL: this.napcatUrl } : {}),
        ...this.env,
      },
    });
    this.child = child;
    this.reader = createInterface({ input: child.stdout });

    this.reader.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      this.handleLine(trimmed);
    });

    child.stderr?.on("data", (chunk) => {
      const lines = chunk.toString().split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        // Expose stderr as notifications to aid debugging without crashing.
        this.onNotification?.({ method: "stderr", params: line.trim() });
      }
    });

    child.on("error", (err) => {
      this.failAll(err instanceof Error ? err : new Error(String(err)));
      this.closedResolve?.();
    });

    child.on("close", () => {
      this.failAll(new Error("nap-msg rpc closed"));
      this.closedResolve?.();
    });
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    this.reader?.close();
    this.reader = null;
    this.child.stdin?.end();
    const child = this.child;
    this.child = null;

    await Promise.race([
      this.closed,
      new Promise<void>((resolve) => {
        setTimeout(() => {
          if (!child.killed) child.kill("SIGTERM");
          resolve();
        }, 500);
      }),
    ]);
  }

  async waitForClose(): Promise<void> {
    await this.closed;
  }

  async request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    if (!this.child || !this.child.stdin) {
      throw new Error("nap-msg rpc not running");
    }
    const id = this.nextId++;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params: params ?? {},
    };
    const line = `${JSON.stringify(payload)}\n`;
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs ?? 10_000;

    const response = new Promise<T>((resolve, reject) => {
      const key = String(id);
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(key);
              reject(new Error(`nap-msg rpc timeout (${method})`));
            }, timeoutMs)
          : undefined;
      this.pending.set(key, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });

    this.child.stdin.write(line);
    return await response;
  }

  private handleLine(line: string) {
    let parsed: NapcatRpcResponse<unknown>;
    try {
      parsed = JSON.parse(line) as NapcatRpcResponse<unknown>;
    } catch (err) {
      this.onNotification?.({
        method: "error",
        params: `nap-msg rpc: failed to parse ${line}: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    if (parsed.id !== undefined && parsed.id !== null) {
      const key = String(parsed.id);
      const pending = this.pending.get(key);
      if (!pending) return;
      if (pending.timer) clearTimeout(pending.timer);
      this.pending.delete(key);

      if (parsed.error) {
        const message = parsed.error.message ?? "nap-msg rpc error";
        const details =
          parsed.error.data !== undefined
            ? typeof parsed.error.data === "string"
              ? parsed.error.data
              : JSON.stringify(parsed.error.data)
            : undefined;
        const suffix = [details, typeof parsed.error.code === "number" ? `code=${parsed.error.code}` : null]
          .filter(Boolean)
          .join(" ");
        pending.reject(new Error(suffix ? `${message}: ${suffix}` : message));
        return;
      }
      pending.resolve(parsed.result);
      return;
    }

    if (parsed.method) {
      this.onNotification?.({
        method: parsed.method,
        params: parsed.params,
      });
    }
  }

  private failAll(err: Error) {
    for (const [key, pending] of this.pending.entries()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(key);
    }
  }
}
