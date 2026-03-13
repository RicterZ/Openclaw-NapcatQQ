import type { ChunkMode, OpenClawConfig, ReplyPayload } from "openclaw/plugin-sdk";
import { readFile } from "node:fs/promises";

import type { NapcatWsClient } from "./ws-client.js";
import type { ResolvedNapcatAccount } from "./types.js";
import type { PluginRuntime } from "openclaw/plugin-sdk";

export type NapcatTarget = {
  channel: "group" | "private";
  id: string;
};

export type DeliverNapcatParams = {
  replies: ReplyPayload[];
  target: NapcatTarget;
  client: NapcatWsClient;
  account: ResolvedNapcatAccount;
  cfg: OpenClawConfig;
  runtime: PluginRuntime;
};

type NapcatSegment =
  | { type: "text"; data: { text: string } }
  | { type: "reply"; data: { id: string } }
  | { type: "image" | "video" | "file"; data: { file: string } };

function inferMediaType(url: string): "image" | "video" | "file" {
  const lower = url.toLowerCase();
  if (lower.match(/\.(png|jpe?g|gif|webp|avif)(\?|$)/)) return "image";
  if (lower.match(/\.(mp4|mov|mkv|webm)(\?|$)/)) return "video";
  return "file";
}

/**
 * Napcat requires media file references to be valid URIs (http://, file://, base64://).
 * For local paths (e.g. /tmp/foo.png), read the file and encode as base64:// so that
 * Napcat receives the raw bytes — the Napcat server may be a remote container that has
 * no access to this machine's filesystem.
 */
async function toNapcatFileRef(url: string): Promise<string> {
  if (
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url.startsWith("file://") ||
    url.startsWith("base64://")
  ) {
    return url;
  }
  // Treat anything starting with / as an absolute local path — encode to base64
  if (url.startsWith("/")) {
    const buf = await readFile(url);
    return `base64://${buf.toString("base64")}`;
  }
  return url;
}

async function sendNapcatMessage(opts: {
  client: NapcatWsClient;
  account: ResolvedNapcatAccount;
  target: NapcatTarget;
  segments: NapcatSegment[];
  timeoutMs?: number;
}): Promise<void> {
  if (opts.segments.length === 0) return;
  const action =
    opts.target.channel === "group" ? "send_group_msg" : "send_private_msg";
  const params: Record<string, unknown> = {
    message: opts.segments,
  };
  if (opts.target.channel === "group") {
    params["group_id"] = opts.target.id;
  } else {
    params["user_id"] = opts.target.id;
  }
  await opts.client.request(action, params, { timeoutMs: opts.timeoutMs });
}

export async function deliverNapcatReplies(params: DeliverNapcatParams): Promise<void> {
  const { replies, target, client, account, cfg, runtime } = params;
  const tableMode = runtime.channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "napcat",
    accountId: account.accountId,
  });
  const chunkMode: ChunkMode = runtime.channel.text.resolveChunkMode(
    cfg,
    "napcat",
    account.accountId,
  );
  const chunkLimit =
    runtime.channel.text.resolveTextChunkLimit(cfg, "napcat", account.accountId) ?? 4000;

  for (const reply of replies) {
    const mediaList = reply.mediaUrls ?? (reply.mediaUrl ? [reply.mediaUrl] : []);
    const rawText = reply.text ?? "";
    const convertedText = runtime.channel.text.convertMarkdownTables(rawText, tableMode);
    const chunks = runtime.channel.text.chunkMarkdownTextWithMode(
      convertedText,
      chunkLimit,
      chunkMode,
    );
    let includeReply = Boolean(reply.replyToId);

    if (mediaList.length === 0) {
      for (const chunk of chunks.length > 0 ? chunks : [""]) {
        const segments: NapcatSegment[] = [];
        if (includeReply && reply.replyToId) {
          segments.push({ type: "reply", data: { id: reply.replyToId } });
          includeReply = false;
        }
        if (chunk.trim()) {
          segments.push({ type: "text", data: { text: chunk } });
        }
        await sendNapcatMessage({
          client,
          account,
          target,
          segments,
          timeoutMs: account.timeoutMs,
        });
      }
      continue;
    }

    let first = true;
    for (const url of mediaList) {
      const segments: NapcatSegment[] = [];
      if (includeReply && reply.replyToId) {
        segments.push({ type: "reply", data: { id: reply.replyToId } });
        includeReply = false;
      }
      if (first && convertedText.trim()) {
        segments.push({ type: "text", data: { text: convertedText } });
      }
      first = false;
      const mediaType = inferMediaType(url);
      segments.push({ type: mediaType, data: { file: await toNapcatFileRef(url) } });
      await sendNapcatMessage({
        client,
        account,
        target,
        segments,
        timeoutMs: account.timeoutMs,
      });
    }
  }
}
