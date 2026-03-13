import { createHash, createHmac } from "node:crypto";
import { type NapcatAsrConfig } from "./types.js";
import { type NapcatLogger } from "./logger.js";

/**
 * Returns true when the ASR config has both required credentials.
 */
export function isAsrEnabled(asr: NapcatAsrConfig | undefined): boolean {
  return Boolean(asr?.secretId?.trim() && asr?.secretKey?.trim());
}

function hmacSha256(key: Buffer, msg: string): Buffer {
  return createHmac("sha256", key).update(msg, "utf8").digest();
}

function buildTc3Headers(
  body: Buffer,
  timestamp: number,
  secretId: string,
  secretKey: string,
  region: string | undefined,
): Record<string, string> {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10); // YYYY-MM-DD
  const payloadHash = createHash("sha256").update(body).digest("hex");

  const canonicalRequest = [
    "POST",
    "/",
    "",
    "content-type:application/json; charset=utf-8",
    "host:asr.tencentcloudapi.com",
    "",
    "content-type;host",
    payloadHash,
  ].join("\n");

  const credentialScope = `${date}/asr/tc3_request`;
  const stringToSign = [
    "TC3-HMAC-SHA256",
    String(timestamp),
    credentialScope,
    createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
  ].join("\n");

  const secretDate = hmacSha256(Buffer.from("TC3" + secretKey, "utf8"), date);
  const secretService = hmacSha256(secretDate, "asr");
  const secretSigning = hmacSha256(secretService, "tc3_request");
  const signature = createHmac("sha256", secretSigning)
    .update(stringToSign, "utf8")
    .digest("hex");

  const authorization =
    `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, ` +
    `SignedHeaders=content-type;host, Signature=${signature}`;

  const headers: Record<string, string> = {
    Authorization: authorization,
    "Content-Type": "application/json; charset=utf-8",
    Host: "asr.tencentcloudapi.com",
    "X-TC-Action": "SentenceRecognition",
    "X-TC-Version": "2019-06-14",
    "X-TC-Timestamp": String(timestamp),
    "X-TC-RequestClient": "maid",
  };

  if (region) {
    headers["X-TC-Region"] = region;
  }

  return headers;
}

/**
 * Call Tencent Cloud SentenceRecognition API and return the recognized text.
 *
 * @param audioBytes  Raw audio data (MP3 or other format supported by the engine)
 * @param voiceFormat Audio format string, e.g. "mp3" (default)
 * @param asr         ASR config from channels.napcat.asr in config.json
 * @param log         Optional logger
 */
export async function sentenceRecognize(
  audioBytes: Buffer,
  voiceFormat: string = "mp3",
  asr: NapcatAsrConfig,
  log?: NapcatLogger,
): Promise<string> {
  if (!audioBytes || audioBytes.length === 0) {
    throw new Error("Audio data is empty");
  }

  const secretId = asr.secretId.trim();
  const secretKey = asr.secretKey.trim();
  if (!secretId || !secretKey) {
    throw new Error("ASR credentials not configured (channels.napcat.asr.secretId / secretKey)");
  }

  const region = asr.region?.trim() || undefined;
  const engine = asr.engine?.trim() || "16k_zh";

  const payload = {
    SubServiceType: 2,
    EngSerViceType: engine,
    SourceType: 1,
    VoiceFormat: voiceFormat,
    Data: audioBytes.toString("base64"),
  };

  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const timestamp = Math.floor(Date.now() / 1000);
  const headers = buildTc3Headers(body, timestamp, secretId, secretKey, region);

  log?.info(`Calling Tencent ASR (engine=${engine}, format=${voiceFormat}, bytes=${audioBytes.length})`);

  const url = "https://asr.tencentcloudapi.com";
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    throw new Error(`Tencent Cloud ASR HTTP ${resp.status} ${resp.statusText}`);
  }

  const result = (await resp.json()) as Record<string, unknown>;
  const response = result["Response"] as Record<string, unknown> | undefined;
  if (!response) {
    throw new Error("Tencent Cloud ASR returned invalid structure");
  }

  const error = response["Error"] as Record<string, unknown> | undefined;
  if (error) {
    const code = error["Code"];
    const msg = error["Message"];
    throw new Error(`Tencent Cloud ASR error: ${String(code)} - ${String(msg)}`);
  }

  const text = response["Result"];
  if (!text) {
    throw new Error("Tencent Cloud ASR did not return a recognition result");
  }

  const recognized = String(text);
  log?.info(`ASR result: "${recognized}"`);
  return recognized;
}
