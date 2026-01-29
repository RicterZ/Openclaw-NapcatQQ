from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from typing import Any, Optional

from .client import NapcatRelayClient, send_group_message, send_private_message
from .messages import Command, CommandType
from .watch import DEFAULT_IGNORE_PREFIXES, _event_to_receive_params, watch_forever

logger = logging.getLogger(__name__)


class RpcServer:
    def __init__(self) -> None:
        self._watch_task: Optional[asyncio.Task] = None

    async def serve(self) -> None:
        """Run a JSON-RPC loop over stdin/stdout (one JSON object per line)."""
        loop = asyncio.get_running_loop()
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Invalid JSON request: %s", exc)
                continue

            try:
                await self._handle_request(request)
            except Exception as exc:  # noqa: BLE001
                logger.exception("Unhandled RPC error: %s", exc)
                self._write_error(request.get("id"), code=-32000, message=str(exc))

    async def _handle_request(self, request: dict) -> None:
        method = request.get("method")
        req_id = request.get("id")
        params = request.get("params") or {}

        if method == "initialize":
            self._handle_initialize(req_id)
            return
        if method == "watch.subscribe":
            await self._handle_subscribe(params, req_id)
            return
        if method == "watch.unsubscribe":
            await self._handle_unsubscribe(req_id)
            return
        if method == "message.send":
            await self._handle_message_send(params, req_id)
            return
        if method == "send":
            await self._handle_send(params, req_id)
            return
        if method == "chats.list":
            self._write_result(req_id, [])
            return

        self._write_error(req_id, code=-32601, message="Method not found")

    def _handle_initialize(self, req_id: Any) -> None:
        result = {"capabilities": {"streaming": True, "attachments": True}}
        self._write_result(req_id, result)

    async def _handle_message_send(self, params: dict, req_id: Any) -> None:
        text = params.get("text")
        to = params.get("to") or params.get("chatId") or params.get("chat_id")
        is_group = params.get("isGroup")
        if not to or text is None:
            self._write_error(req_id, code=-32602, message="to/chatId and text are required")
            return

        channel = "group" if is_group else "private"
        message = [{"type": "text", "data": {"text": text}}]
        await self._handle_send(
            {
                "channel": channel,
                "group_id": to if is_group else None,
                "user_id": None if is_group else to,
                "message": message,
                "napcat_url": params.get("napcat_url"),
                "timeout": params.get("timeout"),
            },
            req_id,
        )

    async def _handle_subscribe(self, params: dict, req_id: Any) -> None:
        await self._stop_watch()
        url = params.get("napcat_url") or os.getenv("NAPCAT_URL")
        if not url:
            self._write_error(req_id, code=-32000, message="NAPCAT_URL is required")
            return

        from_group = params.get("from_group")
        from_user = params.get("from_user")
        ignore_prefixes = params.get("ignore_prefixes") or DEFAULT_IGNORE_PREFIXES
        asr_enabled = _asr_enabled()

        self._watch_task = asyncio.create_task(
            watch_forever(
                url=url,
                from_group=from_group,
                from_user=from_user,
                ignore_prefixes=ignore_prefixes,
                asr_enabled=asr_enabled,
                emit=self._emit_notification,
            )
        )
        self._write_result(req_id, {"status": "subscribed"})

    async def _handle_unsubscribe(self, req_id: Any) -> None:
        await self._stop_watch()
        self._write_result(req_id, {"status": "unsubscribed"})

    async def _handle_send(self, params: dict, req_id: Any) -> None:
        channel = params.get("channel") or params.get("type")
        group_id = params.get("group_id")
        user_id = params.get("user_id")
        timeout = params.get("timeout")
        client = NapcatRelayClient(url=params.get("napcat_url"), timeout=timeout)

        if not channel:
            if group_id:
                channel = "group"
            elif user_id:
                channel = "private"

        try:
            if channel == "group_forward":
                messages = params.get("messages") or params.get("nodes")
                if not messages:
                    raise ValueError("messages is required for group_forward")
                payload = {"group_id": str(group_id), "messages": messages}
                command = Command(CommandType.SEND_GROUP_FORWARD_MSG, payload)
                result = await client.send_command(command)
            elif channel == "group":
                message = params.get("message")
                if not message:
                    raise ValueError("message is required for group send")
                result = await send_group_message(client, group_id, message)
            elif channel == "private":
                message = params.get("message")
                if not message:
                    raise ValueError("message is required for private send")
                result = await send_private_message(client, user_id, message)
            else:
                raise ValueError("Unsupported channel; use group, group_forward, or private")
        except Exception as exc:  # noqa: BLE001
            logger.debug("send failed: %s", exc)
            self._write_error(req_id, code=-32000, message=str(exc))
            return

        self._write_result(req_id, result)

    async def _stop_watch(self) -> None:
        if self._watch_task is None:
            return
        task = self._watch_task
        self._watch_task = None
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    def _emit_notification(self, event: dict) -> None:
        payload = {"jsonrpc": "2.0", "method": "message.receive", "params": _event_to_receive_params(event)}
        self._write_json(payload)

    def _write_result(self, req_id: Any, result: Any) -> None:
        if req_id is None:
            return
        self._write_json({"jsonrpc": "2.0", "id": req_id, "result": result})

    def _write_error(self, req_id: Any, code: int, message: str) -> None:
        if req_id is None:
            return
        error_obj = {"code": code, "message": message}
        self._write_json({"jsonrpc": "2.0", "id": req_id, "error": error_obj})

    def _write_json(self, obj: dict) -> None:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False))
        sys.stdout.write("\n")
        sys.stdout.flush()


def _asr_enabled() -> bool:
    return bool(os.getenv("TENCENT_SECRET_ID", "").strip() and os.getenv("TENCENT_SECRET_KEY", "").strip())


def run_rpc_server() -> int:
    server = RpcServer()
    try:
        asyncio.run(server.serve())
        return 0
    except KeyboardInterrupt:
        return 0
