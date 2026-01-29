import base64
import hashlib
import hmac
import json
import os
import time
from datetime import datetime
from typing import Optional

import httpx



def _hmac_sha256(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def _build_tc3_headers(body: bytes, timestamp: int, secret_id: str, secret_key: str, region: Optional[str]) -> dict:
    date = datetime.utcfromtimestamp(timestamp).strftime("%Y-%m-%d")
    payload_hash = hashlib.sha256(body).hexdigest()

    canonical_request = "\n".join(
        [
            "POST",
            "/",
            "",
            "content-type:application/json; charset=utf-8",
            "host:asr.tencentcloudapi.com",
            "",
            "content-type;host",
            payload_hash,
        ]
    )

    credential_scope = f"{date}/asr/tc3_request"
    string_to_sign = "\n".join(
        [
            "TC3-HMAC-SHA256",
            str(timestamp),
            credential_scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ]
    )

    secret_date = _hmac_sha256(("TC3" + secret_key).encode("utf-8"), date)
    secret_service = _hmac_sha256(secret_date, "asr")
    secret_signing = _hmac_sha256(secret_service, "tc3_request")
    signature = hmac.new(secret_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    authorization = (
        f"TC3-HMAC-SHA256 Credential={secret_id}/{credential_scope}, "
        f"SignedHeaders=content-type;host, Signature={signature}"
    )

    headers = {
        "Authorization": authorization,
        "Content-Type": "application/json; charset=utf-8",
        "Host": "asr.tencentcloudapi.com",
        "X-TC-Action": "SentenceRecognition",
        "X-TC-Version": "2019-06-14",
        "X-TC-Timestamp": str(timestamp),
        "X-TC-RequestClient": "maid",
    }
    if region:
        headers["X-TC-Region"] = region

    return headers


async def sentence_recognize(
    data: bytes,
    voice_format: str = "mp3",
    eng_service_type: Optional[str] = None,
    project_id: Optional[int] = None,
) -> str:
    if not data:
        raise ValueError("Audio data is empty")

    secret_id = os.getenv("TENCENT_SECRET_ID", "").strip()
    secret_key = os.getenv("TENCENT_SECRET_KEY", "").strip()
    if not secret_id or not secret_key:
        raise RuntimeError("Missing Tencent Cloud credentials: set TENCENT_SECRET_ID and TENCENT_SECRET_KEY")

    region = os.getenv("TENCENT_ASR_REGION", "").strip() or None
    engine = eng_service_type or os.getenv("TENCENT_ASR_ENGINE", "16k_zh").strip()

    payload = {
        "SubServiceType": 2,
        "EngSerViceType": engine,
        "SourceType": 1,
        "VoiceFormat": voice_format,
        "Data": base64.b64encode(data).decode("utf-8"),
    }
    if project_id is not None:
        payload["ProjectId"] = project_id

    body = json.dumps(payload).encode("utf-8")
    ts = int(time.time())
    headers = _build_tc3_headers(body, ts, secret_id, secret_key, region)

    url = "https://asr.tencentcloudapi.com"
    logger.info("Calling Tencent Cloud sentence recognition")

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(url, content=body, headers=headers)
        resp.raise_for_status()
        result = resp.json()

    response = result.get("Response") if isinstance(result, dict) else None
    if not response:
        raise RuntimeError("Tencent Cloud returned invalid structure")

    if "Error" in response:
        err = response["Error"]
        code = err.get("Code")
        msg = err.get("Message")
        raise RuntimeError(f"Tencent Cloud ASR error: {code} - {msg}")

    text = response.get("Result")
    if not text:
        raise RuntimeError("Tencent Cloud did not return recognition result")

    return text