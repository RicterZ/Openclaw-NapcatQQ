import { emptyPluginConfigSchema, getChatChannelMeta, type ChannelLogSink, type ChannelPlugin, type MoltbotConfig } from "openclaw/plugin-sdk";
import { connectionManager } from "./connection-manager.js";
import { getNapcatRuntime } from "./runtime.js";

const meta = getChatChannelMeta("napcat");

type NapcatRawEvent = {
  sender?: string | number;
  chatId?: string | number;
  isGroup?: boolean;
  text?: string | null;
  messageId?: string | number;
  images?: string[];
  videos?: string[];
  files?: string[];
};

type NapcatNormalizedInbound = {
  chatIdRaw: string;
  canonicalPeerId: string;
  isGroup: boolean;
  senderId?: string;
  senderLabel?: string;
  messageId?: string;
  rawBody: string;
  body: string;
  attachments: string[];
  fromLabel: string;
};

type NapcatTarget = {
  chatIdRaw: string;
  canonical: string;
  isGroup: boolean;
};

type ReplyDispatcher = (params: any) => Promise<void>;

type NapcatRuntime = ReturnType<typeof getNapcatRuntime>;

function sanitizeUtf8(text: string): string {
  return text
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

function coerceId(value?: string | number | null): string | null {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  return str ? str : null;
}

// Streaming is always on for Napcat.
function resolveStreamingPreference(): boolean {
  return true;
}

function normalizeOutboundTarget(raw?: string | number | null): NapcatTarget | null {
  const id = coerceId(raw);
  if (!id) return null;
  let trimmed = id;
  if (trimmed.toLowerCase().startsWith("napcat:")) {
    trimmed = trimmed.slice("napcat:".length);
  }

  const lower = trimmed.toLowerCase();
  if (lower.startsWith("group-")) {
    const chatIdRaw = trimmed.slice("group-".length).trim();
    if (!chatIdRaw) return null;
    return { chatIdRaw, isGroup: true, canonical: `group-${chatIdRaw}` };
  }
  if (lower.startsWith("group:")) {
    const chatIdRaw = trimmed.slice("group:".length).trim();
    if (!chatIdRaw) return null;
    return { chatIdRaw, isGroup: true, canonical: `group-${chatIdRaw}` };
  }
  if (lower.startsWith("user-")) {
    const chatIdRaw = trimmed.slice("user-".length).trim();
    if (!chatIdRaw) return null;
    return { chatIdRaw, isGroup: false, canonical: `user-${chatIdRaw}` };
  }
  return { chatIdRaw: trimmed, isGroup: false, canonical: `user-${trimmed}` };
}

function normalizeInboundMessage(raw: NapcatRawEvent, log?: ChannelLogSink): NapcatNormalizedInbound | null {
  const chatIdRaw = coerceId(raw.chatId);
  const senderId = coerceId(raw.sender);
  const messageId = coerceId(raw.messageId);
  const isGroup = Boolean(raw.isGroup);
  if (!chatIdRaw) {
    log?.debug?.("[napcat] drop inbound: missing chatId");
    return null;
  }

  const attachments: string[] = [];
  for (const bucket of [raw.images, raw.videos, raw.files]) {
    if (!Array.isArray(bucket)) continue;
    for (const entry of bucket) {
      if (typeof entry === "string") {
        const trimmed = entry.trim();
        if (trimmed) attachments.push(trimmed);
      }
    }
  }

  const textParts: string[] = [];
  if (typeof raw.text === "string" && raw.text.trim()) {
    textParts.push(raw.text.trim());
  }
  if (attachments.length) {
    textParts.push(attachments.join("\n"));
  }

  const joined = sanitizeUtf8(textParts.join("\n").trim());
  if (!joined) {
    log?.debug?.("[napcat] drop inbound: empty content");
    return null;
  }

  const canonicalPeerId = isGroup ? `group-${chatIdRaw}` : `user-${chatIdRaw}`;
  const fromLabel = isGroup ? `group:${chatIdRaw}` : `user:${senderId ?? chatIdRaw}`;

  return {
    chatIdRaw,
    canonicalPeerId,
    isGroup,
    senderId: senderId ?? undefined,
    senderLabel: senderId ?? chatIdRaw,
    messageId: messageId ?? undefined,
    rawBody: joined,
    body: joined,
    attachments,
    fromLabel,
  };
}

async function deliverNapcatText(params: {
  target: NapcatTarget;
  text: string;
  accountId: string;
  setStatus?: (next: any) => void;
  log?: ChannelLogSink;
}) {
  await connectionManager.ensureConnected();
  await connectionManager.send("message.send", {
    chatId: params.target.chatIdRaw,
    to: params.target.chatIdRaw,
    isGroup: params.target.isGroup,
    text: sanitizeUtf8(params.text),
  });
  params.setStatus?.({ accountId: params.accountId, lastOutboundAt: Date.now(), lastError: null });
}

function formatNapcatPayloadText(
  runtime: NapcatRuntime,
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string },
  tableMode: string,
): string | null {
  const parts: string[] = [];
  if (payload.text?.trim()) parts.push(payload.text);
  const mediaList = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];
  if (mediaList.length) {
    parts.push(mediaList.join("\n"));
  }
  const joined = parts.join("\n").trim();
  if (!joined) return null;
  const converted = runtime.channel.text.convertMarkdownTables(joined, tableMode);
  return sanitizeUtf8(converted);
}

function resolveReplyDispatchers(
  runtime: NapcatRuntime,
  preferStreaming: boolean,
  log?: ChannelLogSink,
): {
  primary: ReplyDispatcher;
  fallback?: ReplyDispatcher;
  primaryLabel: string;
} {
  const replyApi = runtime.channel.reply as Record<string, any>;
  const candidates: Array<{ key: string; label: string }> = preferStreaming
    ? [
        { key: "dispatchReplyWithStreamingDispatcher", label: "streaming" },
        { key: "createReplyDispatcherWithTyping", label: "typing" },
        { key: "createReplyDispatcher", label: "typing" },
      ]
    : [];

  let fallback: ReplyDispatcher | undefined;
  const buffered = replyApi.dispatchReplyWithBufferedBlockDispatcher;
  if (typeof buffered === "function") {
    fallback = buffered as ReplyDispatcher;
  }

  for (const candidate of candidates) {
    const fn = replyApi[candidate.key];
    if (typeof fn === "function") {
      log?.debug?.(`[napcat] using ${candidate.label} reply dispatcher (${candidate.key})`);
      return { primary: fn as ReplyDispatcher, fallback, primaryLabel: candidate.label };
    }
  }

  if (fallback) {
    log?.warn?.("[napcat] streaming dispatcher unavailable; falling back to buffered");
    return { primary: fallback, fallback: undefined, primaryLabel: "buffered" };
  }

  throw new Error("napcat: no reply dispatcher available in runtime");
}

async function buildReplyContext(params: {
  normalized: NapcatNormalizedInbound;
  cfg: MoltbotConfig;
  accountId: string;
  runtime: NapcatRuntime;
  log?: ChannelLogSink;
}) {
  const { normalized, cfg, accountId, runtime } = params;
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: "napcat",
    accountId,
    peer: {
      kind: normalized.isGroup ? "group" : "dm",
      id: normalized.canonicalPeerId,
    },
  });

  const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const envelopeBody = runtime.channel.reply.formatAgentEnvelope({
    channel: "Napcat",
    from: normalized.fromLabel,
    previousTimestamp,
    envelope: envelopeOptions,
    body: normalized.body,
  });

  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: envelopeBody,
    RawBody: normalized.rawBody,
    CommandBody: normalized.rawBody,
    From: `napcat:${normalized.canonicalPeerId}`,
    To: `napcat:${normalized.canonicalPeerId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: normalized.isGroup ? "group" : "direct",
    ConversationLabel: normalized.fromLabel,
    SenderName: normalized.senderLabel ?? undefined,
    SenderId: normalized.senderId ?? normalized.chatIdRaw,
    CommandAuthorized: true,
    Provider: "napcat",
    Surface: "napcat",
    MessageSid: normalized.messageId ?? undefined,
    OriginatingChannel: "napcat",
    OriginatingTo: `napcat:${normalized.canonicalPeerId}`,
  });

  await runtime.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      params.log?.error?.(`[napcat] failed to update session meta: ${String(err)}`);
    },
  });

  const tableMode = runtime.channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "napcat",
    accountId: route.accountId,
  });

  return { ctxPayload, route, tableMode };
}

async function handleNapcatInbound(params: {
  raw: NapcatRawEvent;
  cfg: MoltbotConfig;
  accountId: string;
  setStatus: (next: any) => void;
  log?: ChannelLogSink;
}) {
  const runtime = getNapcatRuntime();
  const normalized = normalizeInboundMessage(params.raw, params.log);
  if (!normalized) return;

  const { ctxPayload, route, tableMode } = await buildReplyContext({
    normalized,
    cfg: params.cfg,
    accountId: params.accountId,
    runtime,
    log: params.log,
  });

  params.setStatus({ accountId: route.accountId, lastInboundAt: Date.now(), lastError: null });

  const preferStreaming = resolveStreamingPreference();
  const { primary, fallback, primaryLabel } = resolveReplyDispatchers(runtime, preferStreaming, params.log);

  const dispatcherParams = {
    ctx: ctxPayload,
    cfg: params.cfg,
    dispatcherOptions: {
      deliver: async (payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string }) => {
        const text = formatNapcatPayloadText(runtime, payload, tableMode);
        if (!text) return;
        await deliverNapcatText({
          target: {
            chatIdRaw: normalized.chatIdRaw,
            canonical: normalized.canonicalPeerId,
            isGroup: normalized.isGroup,
          },
          text,
          accountId: route.accountId,
          setStatus: params.setStatus,
          log: params.log,
        });
      },
      onError: (err: Error, info: { kind: string }) => {
        params.log?.error?.(`[${route.accountId}] napcat ${info.kind} reply failed: ${String(err)}`);
      },
    },
  };

  try {
    await primary(dispatcherParams as any);
  } catch (err) {
    if (fallback && primaryLabel !== "buffered") {
      params.log?.warn?.(
        `[napcat] primary dispatcher failed (${primaryLabel}), retrying buffered: ${(err as Error).message}`,
      );
      await fallback(dispatcherParams as any);
    } else {
      throw err;
    }
  }
}

export const napcatPlugin: ChannelPlugin<any> = {
  id: "napcat",
  meta: { ...meta, aliases: ["nap"] },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1200, idleMs: 800 },
  },
  configSchema: emptyPluginConfigSchema(),
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: (_cfg, accountId) => ({
      accountId: accountId ?? "default",
      name: accountId ?? "default",
      enabled: true,
      configured: true,
      config: {},
    }),
    defaultAccountId: () => "default",
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const existing = cfg.channels?.napcat?.accounts || {};
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          napcat: {
            ...(cfg.channels?.napcat || {}),
            accounts: {
              ...existing,
              [accountId]: { ...(existing[accountId] || {}), enabled },
            },
          },
        },
      };
    },
    deleteAccount: ({ cfg, accountId }) => {
      const existing = { ...(cfg.channels?.napcat?.accounts || {}) };
      delete existing[accountId];
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          napcat: {
            ...(cfg.channels?.napcat || {}),
            accounts: existing,
          },
        },
      };
    },
    isConfigured: (account) => Boolean(account?.configured ?? true),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name ?? account.accountId,
      enabled: Boolean(account.enabled ?? true),
      configured: Boolean(account.configured ?? true),
    }),
    resolveAllowFrom: () => [],
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text) => [text],
    chunkerMode: "text",
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId }) => {
      const target = normalizeOutboundTarget(to);
      if (!target) {
        throw new Error("napcat target is required");
      }
      const message = sanitizeUtf8(text?.trim() ?? "");
      if (!message) {
        throw new Error("napcat message text is empty");
      }
      await deliverNapcatText({
        target,
        text: message,
        accountId: accountId ?? "default",
      });
      return { channel: "napcat", to: target.canonical, text: message };
    },
    sendMedia: async ({ to, mediaUrl, text, accountId }) => {
      const target = normalizeOutboundTarget(to);
      if (!target) {
        throw new Error("napcat target is required");
      }
      const payloadText = sanitizeUtf8([text, mediaUrl].filter(Boolean).join("\n").trim());
      if (!payloadText) {
        throw new Error("napcat message text is empty");
      }
      await deliverNapcatText({
        target,
        text: payloadText,
        accountId: accountId ?? "default",
      });
      return { channel: "napcat", to: target.canonical, mediaUrl, text: payloadText };
    },
  },
  status: {
    defaultRuntime: {
      accountId: "default",
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      cliPath: null,
      dbPath: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    },
    collectStatusIssues: () => [],
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? true,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      cliPath: snapshot.cliPath ?? null,
      dbPath: snapshot.dbPath ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async () => {
      try {
        const connected = await connectionManager.ensureConnected();
        return { ok: connected };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    },
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name ?? account.accountId,
      enabled: Boolean(account.enabled ?? true),
      configured: Boolean(account.configured ?? true),
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      cliPath: runtime?.cliPath ?? null,
      dbPath: runtime?.dbPath ?? null,
      probe: runtime?.probe,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
    resolveAccountState: ({ enabled }) => (enabled ? "enabled" : "disabled"),
  },
  gateway: {
    startAccount: async (ctx) => {
      ctx.log?.info(`[${ctx.account.accountId}] napcat plugin starting`);
      ctx.setStatus({
        accountId: ctx.account.accountId,
        running: true,
        lastStartAt: Date.now(),
        lastError: null,
      });

      const unsubscribe = connectionManager.subscribe((message) => {
        handleNapcatInbound({
          raw: message as NapcatRawEvent,
          cfg: ctx.cfg,
          accountId: ctx.account.accountId,
          setStatus: ctx.setStatus,
          log: ctx.log,
        }).catch((err) => {
          ctx.log?.error?.(
            `napcat inbound dispatch failed: ${(err as Error).stack || (err as Error).message}`,
          );
        });
      });

      await connectionManager.ensureConnected();

      return async () => {
        ctx.log?.info(`[${ctx.account.accountId}] napcat plugin stopping`);
        ctx.setStatus({
          accountId: ctx.account.accountId,
          running: false,
          lastStopAt: Date.now(),
        });
        try {
          unsubscribe();
        } catch (e) {
          ctx.log?.warn?.(`napcat unsubscribe failed: ${(e as Error).message}`);
        }
        await connectionManager.disconnect();
      };
    },
  },
};
