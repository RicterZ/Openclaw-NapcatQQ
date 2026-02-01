from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import secrets
import sys
import tempfile
from pathlib import Path
from typing import Iterable, List, Optional

import yt_dlp

from .client import DEFAULT_TIMEOUT, NapcatRelayClient, send_group_forward_message, send_group_message, send_private_message
from .messages import FileMessage, ForwardNode, ImageMessage, ReplyMessage, TextMessage, VideoMessage
from .rpc import run_rpc_server


def _segment_action(segment_type: str):
    """Create an argparse action that appends (type, value) while preserving CLI order."""

    class _SegmentAction(argparse.Action):
        def __call__(self, parser, namespace, values, option_string=None):
            segments = getattr(namespace, self.dest, []) or []
            segments.append((segment_type, values))
            setattr(namespace, self.dest, segments)

    return _SegmentAction


def _load_dotenv_if_present() -> None:
    env_path = Path.cwd() / ".env"
    if not env_path.is_file():
        return
    try:
        for line in env_path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if stripped.startswith("export "):
                stripped = stripped[len("export ") :].strip()
            if "=" not in stripped:
                continue
            key, _, value = stripped.partition("=")
            key = key.strip()
            if not key or key in os.environ:
                continue
            value = value.strip()
            if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
                value = value[1:-1]
            os.environ[key] = value
    except OSError as exc:
        logging.debug("Skipping .env load: %s", exc)


def _configure_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    fmt = "%(asctime)s [%(levelname)s] %(message)s"
    log_path = Path.cwd() / "nap-msg.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    file_handler = logging.FileHandler(log_path, encoding="utf-8")

    logging.basicConfig(level=level, format=fmt, handlers=[file_handler], force=True)


def _add_segment_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("-t", "--text", dest="segments", action=_segment_action("text"), help="Text segment")
    parser.add_argument("-i", "--image", dest="segments", action=_segment_action("image"), help="Image file path or URL")
    parser.add_argument("-f", "--file", dest="segments", action=_segment_action("file"), help="File path to upload")
    parser.add_argument("-v", "--video", dest="segments", action=_segment_action("video"), help="Video file path or URL")
    parser.add_argument(
        "--video-url",
        dest="segments",
        action=_segment_action("video-url"),
        help="Video/stream URL to download via yt-dlp then send",
    )
    parser.add_argument("-r", "--reply", dest="segments", action=_segment_action("reply"), help="Reply to a message id")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="nap-msg",
        description="Relay CLI for sending messages from moltbot to Napcat.",
    )
    parser.add_argument(
        "--napcat-url",
        default=os.getenv("NAPCAT_URL"),
        help="Napcat WebSocket endpoint (env NAPCAT_URL).",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=None,
        help=f"Response wait timeout in seconds (default: env NAPCAT_TIMEOUT or {DEFAULT_TIMEOUT})",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable debug logging.",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    send_private = subparsers.add_parser("send", help="Send a private message")
    send_private.add_argument("user_id", help="Target QQ user id")
    _add_segment_args(send_private)

    send_group = subparsers.add_parser("send-group", help="Send a group message")
    send_group.add_argument("group_id", help="Target QQ group id")
    _add_segment_args(send_group)
    send_group.add_argument(
        "--type",
        choices=["normal", "forward"],
        default="normal",
        help="Send as normal message or as a forward message.",
    )
    send_group.add_argument(
        "--forward",
        action="store_true",
        help="Shortcut for --type forward.",
    )

    rpc = subparsers.add_parser("rpc", help="Run JSON-RPC server on stdin/stdout")
    rpc.add_argument(
        "--napcat-url",
        dest="rpc_napcat_url",
        help="Napcat WebSocket endpoint (override global).",
    )
    rpc.add_argument(
        "--timeout",
        dest="rpc_timeout",
        type=float,
        default=None,
        help="Response wait timeout in seconds for RPC mode.",
    )

    return parser


def _build_message_segments(args: argparse.Namespace) -> List[object]:
    segments = getattr(args, "segments", []) or []
    parts, errors, _ = _build_parts_and_errors(segments)
    if errors:
        return []
    return parts


def _build_parts_and_errors(segments: List[tuple]) -> tuple[List[object], List[dict], List[tuple]]:
    parts: List[object] = []
    errors: List[dict] = []
    builders = {
        "reply": ReplyMessage,
        "text": TextMessage,
        "image": ImageMessage,
        "video": VideoMessage,
        "file": FileMessage,
        "video-url": _video_url_segment,
    }
    for seg_type, value in segments:
        builder = builders.get(seg_type)
        if not builder:
            continue
        try:
            part = builder(value)
        except Exception as exc:  # noqa: BLE001
            logging.exception("Failed to build segment %s", seg_type)
            errors.append({"segment": seg_type, "value": value, "error": str(exc)})
            continue
        if part is None:
            errors.append({"segment": seg_type, "value": value, "error": "no content built"})
            continue
        parts.append(part)
    return parts, errors, segments


def _build_forward_nodes(parts: List[object]) -> List[ForwardNode]:
    user_id = os.getenv("NAPCAT_FORWARD_USER_ID", "")
    nickname = os.getenv("NAPCAT_FORWARD_NICKNAME", "メイド")
    return [ForwardNode(user_id, nickname, [part]) for part in parts]


def _build_error_forward_content(parts: List[object], errors: List[dict], raw_segments: List[tuple]) -> List[object]:
    content = list(parts)
    content.append(TextMessage(_compose_error_text(errors, raw_segments)))
    return content or [TextMessage(_compose_error_text(errors, raw_segments))]


def _compose_error_text(errors: List[dict], raw_segments: List[tuple]) -> str:
    original = "; ".join(f"{seg}:{val}" for seg, val in raw_segments) if raw_segments else "none"
    err_lines = "; ".join(
        f"{err.get('segment')}: {err.get('value')} => {err.get('error')}" for err in errors
    ) or "unknown error"
    return f"Message delivery failed. Original: [{original}]. Errors: {err_lines}."


def _serialize_parts(parts: List[object]) -> List[dict]:
    return [part.as_dict() if hasattr(part, "as_dict") else part for part in parts]


def _print_response(response: dict) -> None:
    sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write("\n")
    sys.stdout.flush()


def _video_url_segment(video_url: str) -> Optional[VideoMessage]:
    print("Downloading video, please wait up to 60s...")
    path = _download_video_url(video_url)
    if not path:
        return None
    return VideoMessage(str(path))


def _download_video_url(video_url: str) -> Optional[Path]:
    """Download a video/stream URL via yt-dlp and return the saved file path."""
    target_dir = Path(tempfile.mkdtemp(prefix="nap-msg-video-"))
    base_name = f"{secrets.token_hex(4)}.%(ext)s"
    output_tmpl = target_dir / base_name
    base_opts = {
        "outtmpl": str(output_tmpl),
        "outtmpl_na_placeholder": "video",
        "restrictfilenames": True,
        "nopart": True,
        "downloader_args": {
            "hls": [
                "-allowed_extensions",
                "ALL",
                "-extension_picky",
                "0",
                "-protocol_whitelist",
                "file,http,https,tcp,tls,crypto",
            ]
        },
    }

    is_live = _probe_is_live_api(video_url, base_opts)
    opts = dict(base_opts)
    opts.setdefault("external_downloader_args", {})["ffmpeg"] = ["-t", "30"]
    if is_live:
        opts["force_keyframes_at_cuts"] = True
        opts["no_live_from_start"] = True

    logging.debug("Downloading video via yt-dlp live=%s url=%s", is_live, video_url)
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            result = ydl.download([video_url])
    except Exception as exc:  # noqa: BLE001
        logging.exception("yt-dlp download failed")
        return None

    if result not in (0, None):
        logging.error("yt-dlp download failed with code %s", result)
        return None

    try:
        video_file = _pick_downloaded_file(target_dir)
    except Exception as exc:  # noqa: BLE001
        logging.exception("Failed to locate downloaded video")
        return None

    logging.debug("Downloaded video to %s", video_file)
    return video_file


def _probe_is_live_api(video_url: str, base_opts: dict) -> bool:
    try:
        with yt_dlp.YoutubeDL(dict(base_opts)) as ydl:
            info = ydl.extract_info(video_url, download=False)
    except Exception as exc:  # noqa: BLE001
        logging.debug("Probe via yt-dlp failed, assuming non-live: %s", exc)
        return False

    live_status = info.get("live_status")
    return bool(info.get("is_live")) or live_status in {"is_live", "is_upcoming"}


def _pick_downloaded_file(target_dir: Path) -> Path:
    candidates = list(_iter_video_files(target_dir))
    if not candidates:
        raise RuntimeError(f"No video file downloaded into {target_dir}")
    return max(candidates, key=lambda p: p.stat().st_size)


def _iter_video_files(target_dir: Path) -> Iterable[Path]:
    video_suffixes = {
        ".mp4",
        ".mkv",
        ".webm",
        ".mov",
        ".flv",
        ".avi",
        ".ts",
        ".m4v",
    }
    for path in target_dir.iterdir():
        if not path.is_file():
            continue
        if path.suffix.lower() in video_suffixes:
            yield path


def _run_send_group(args: argparse.Namespace) -> int:
    parts, errors, raw_segments = _build_parts_and_errors(getattr(args, "segments", []))
    if not parts and not errors:
        return 2

    is_forward = args.forward or args.type == "forward"
    client = NapcatRelayClient(url=args.napcat_url, timeout=args.timeout)

    try:
        if errors:
            content = _build_error_forward_content(parts, errors, raw_segments)
            nodes = _build_forward_nodes(content)
            response = asyncio.run(send_group_forward_message(client, args.group_id, nodes))
        elif is_forward:
            nodes = _build_forward_nodes(parts)
            response = asyncio.run(send_group_forward_message(client, args.group_id, nodes))
        else:
            response = asyncio.run(send_group_message(client, args.group_id, _serialize_parts(parts)))
    except Exception as exc:  # noqa: BLE001
        logging.exception("Failed to send message: %s", exc)
        return 1

    _print_response(response)
    return 0


def _run_send_private(args: argparse.Namespace) -> int:
    parts, errors, raw_segments = _build_parts_and_errors(getattr(args, "segments", []))
    if not parts and not errors:
        return 2

    client = NapcatRelayClient(url=args.napcat_url, timeout=args.timeout)

    if errors:
        error_text = _compose_error_text(errors, raw_segments)
        if parts:
            parts = parts + [TextMessage(error_text)]
        else:
            parts = [TextMessage(error_text)]

    try:
        response = asyncio.run(send_private_message(client, args.user_id, _serialize_parts(parts)))
    except Exception as exc:  # noqa: BLE001
        logging.exception("Failed to send message: %s", exc)
        return 1

    _print_response(response)
    return 0


def main(argv: list[str] | None = None) -> int:
    _load_dotenv_if_present()
    parser = _build_parser()
    args = parser.parse_args(argv)
    _configure_logging(args.verbose)

    if args.command == "send":
        return _run_send_private(args)
    if args.command == "send-group":
        return _run_send_group(args)
    if args.command == "rpc":
        return run_rpc_server(
            default_url=getattr(args, "rpc_napcat_url", None) or args.napcat_url,
            default_timeout=getattr(args, "rpc_timeout", None) or args.timeout,
        )

    parser.error(f"Unknown command {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
