import type { ChunkMode, OpenClawConfig, ReplyPayload } from "openclaw/plugin-sdk";

import type { NapcatRpcClient } from "./rpc-client.js";
import type { ResolvedNapcatAccount } from "./types.js";
import type { PluginRuntime } from "openclaw/plugin-sdk";

export type NapcatTarget = {
  channel: "group" | "private";
  id: string;
};

export type DeliverNapcatParams = {
  replies: ReplyPayload[];
  target: NapcatTarget;
  client: NapcatRpcClient;
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

async function sendNapcatMessage(opts: {
  client: NapcatRpcClient;
  account: ResolvedNapcatAccount;
  target: NapcatTarget;
  segments: NapcatSegment[];
  timeoutMs?: number;
}): Promise<void> {
  if (opts.segments.length === 0) return;
  await opts.client.request("send", {
    channel: opts.target.channel,
    group_id: opts.target.channel === "group" ? opts.target.id : undefined,
    user_id: opts.target.channel === "private" ? opts.target.id : undefined,
    message: opts.segments,
    napcat_url: opts.account.napcatUrl,
    timeout: opts.timeoutMs,
  });
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
      segments.push({ type: mediaType, data: { file: url } });
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
