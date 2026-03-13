"""
Download a video/stream URL and ensure it is QQ-compatible before sending.

QQ (via Napcat/OneBot v11) requires:
  - Container : MP4
  - Video codec: H.264 (Main/High profile), yuv420p pixel format
  - Audio codec: AAC, stereo, 44100 Hz
  - moov atom  : at the front of the file (faststart)

Strategy
--------
1. yt-dlp downloads the URL, requesting MP4 output when possible.
2. ffprobe inspects the result.
3. If the file is already fully compatible we just return it (stream-copy
   still adds faststart so QQ can start playing immediately).
4. Otherwise ffmpeg re-encodes only what is necessary.
"""

from __future__ import annotations

import json
import logging
import secrets
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

import yt_dlp

logger = logging.getLogger(__name__)

# Maximum wall-clock seconds to capture from a live stream / long video.
LIVE_CLIP_SECONDS = 30

# Video codecs that QQ accepts without re-encoding (H.264 only).
_COMPAT_VIDEO_CODECS = {"h264"}

# Audio codecs that QQ accepts without re-encoding.
_COMPAT_AUDIO_CODECS = {"aac"}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def download_and_transcode(url: str, duration: int = LIVE_CLIP_SECONDS) -> Optional[Path]:
    """
    Download *url* and return a QQ-compatible MP4 path, or None on failure.
    The caller is responsible for deleting the temp directory when done.
    *duration* caps how many seconds are captured (applies to live streams
    and long videos alike); defaults to LIVE_CLIP_SECONDS.
    """
    work_dir = Path(tempfile.mkdtemp(prefix="nap-msg-video-"))
    token = secrets.token_hex(4)

    raw_path = _download(url, work_dir, token, duration)
    if raw_path is None:
        return None

    compat_path = _ensure_compat(raw_path, work_dir, token)
    return compat_path


# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------

def _download(url: str, work_dir: Path, token: str, duration: int) -> Optional[Path]:
    """Run yt-dlp and return the downloaded file path."""
    outtmpl = str(work_dir / f"{token}.%(ext)s")

    ydl_opts: dict = {
        "outtmpl": outtmpl,
        "outtmpl_na_placeholder": "video",
        # Prefer MP4+H.264 when the site offers it natively
        "format": "bestvideo[ext=mp4][vcodec^=avc]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio/best[ext=mp4]/best",
        # Always merge into MP4 so we don't end up with MKV/WebM containers
        "merge_output_format": "mp4",
        "restrictfilenames": True,
        "nopart": True,
        "live_from_start": False,
        # Stop downloading after `duration` seconds — this cuts the stream
        # at the download stage so yt-dlp exits promptly instead of waiting
        # for the full stream to finish.
        "download_ranges": yt_dlp.utils.download_range_func(None, [(0, duration)]),
        "force_keyframes_at_cuts": True,
        # HLS/m3u8: pass extra flags to ffmpeg's HLS downloader to lift the
        # default protocol/extension safety restrictions that prevent fetching
        # segments from http/https and non-standard file extensions.
        # "data" is required for AES-128 encrypted streams where the key is
        # passed as a data: URI inline.
        "downloader_args": {
            "ffmpeg": [
                "-allowed_extensions", "ALL",
                "-extension_picky", "0",
                "-protocol_whitelist", "file,http,https,tcp,tls,crypto,data",
            ],
        },
        "quiet": True,
        "no_warnings": False,
    }

    logger.info("yt-dlp downloading: %s", url)
    for attempt in range(1, 4):
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ret = ydl.download([url])
        except Exception as exc:  # noqa: BLE001
            logger.warning("yt-dlp attempt %d failed: %s", attempt, exc)
            continue

        if ret in (0, None):
            break
        logger.warning("yt-dlp attempt %d exited with code %s", attempt, ret)
    else:
        logger.error("yt-dlp failed after 3 attempts")
        return None

    path = _pick_largest_video(work_dir)
    if path is None:
        logger.error("No video file found in %s after download", work_dir)
    else:
        logger.info("Downloaded: %s (%.1f MB)", path.name, path.stat().st_size / 1_048_576)
    return path


# ---------------------------------------------------------------------------
# Format inspection
# ---------------------------------------------------------------------------

def _probe(path: Path) -> Optional[dict]:
    """Return ffprobe JSON for *path*, or None if ffprobe is unavailable / fails."""
    cmd = [
        "ffprobe", "-v", "quiet",
        "-print_format", "json",
        "-show_streams", "-show_format",
        str(path),
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except FileNotFoundError:
        logger.warning("ffprobe not found; skipping format check")
        return None
    except Exception as exc:  # noqa: BLE001
        logger.warning("ffprobe error: %s", exc)
        return None

    if result.returncode != 0:
        logger.warning("ffprobe returned %d: %s", result.returncode, result.stderr[:200])
        return None

    try:
        return json.loads(result.stdout)
    except Exception:
        return None


class _FormatInfo:
    """Parsed codec/container information for a video file."""

    def __init__(self, probe: dict):
        streams = probe.get("streams", [])
        fmt = probe.get("format", {})

        self.container: str = (fmt.get("format_name") or "").split(",")[0].strip().lower()

        video_streams = [s for s in streams if s.get("codec_type") == "video"]
        audio_streams = [s for s in streams if s.get("codec_type") == "audio"]

        vs = video_streams[0] if video_streams else {}
        as_ = audio_streams[0] if audio_streams else {}

        self.video_codec: str = (vs.get("codec_name") or "").lower()
        self.pix_fmt: str = (vs.get("pix_fmt") or "").lower()
        self.audio_codec: str = (as_.get("codec_name") or "").lower()
        self.audio_channels: int = int(as_.get("channels") or 0)
        self.sample_rate: int = int(as_.get("sample_rate") or 0)
        self.width: int = int(vs.get("width") or 0)
        self.height: int = int(vs.get("height") or 0)

    def needs_video_transcode(self) -> bool:
        return (
            self.video_codec not in _COMPAT_VIDEO_CODECS
            or self.pix_fmt not in ("yuv420p", "yuvj420p", "")
        )

    def needs_audio_transcode(self) -> bool:
        return self.audio_codec not in _COMPAT_AUDIO_CODECS

    def needs_odd_dimension_fix(self) -> bool:
        return bool(self.width % 2 or self.height % 2)

    def is_mp4_container(self) -> bool:
        return self.container in ("mov,mp4,m4a,3gp,3g2,mj2", "mp4", "mov")

    def __repr__(self) -> str:
        return (
            f"<FormatInfo container={self.container!r} "
            f"video={self.video_codec!r}/{self.pix_fmt!r} "
            f"audio={self.audio_codec!r} "
            f"size={self.width}x{self.height}>"
        )


# ---------------------------------------------------------------------------
# Transcode / fixup
# ---------------------------------------------------------------------------

def _ensure_compat(src: Path, work_dir: Path, token: str) -> Optional[Path]:
    """
    Inspect *src* and return a QQ-compatible MP4.
    Re-encodes only the streams that need it; always applies faststart.
    """
    probe = _probe(src)
    if probe is None:
        # ffprobe unavailable – fall back to full transcode to be safe
        logger.info("ffprobe unavailable; performing full transcode")
        return _transcode(src, work_dir, token, force_video=True, force_audio=True)

    info = _FormatInfo(probe)
    logger.info("Probed %s: %r", src.name, info)

    force_video = info.needs_video_transcode() or info.needs_odd_dimension_fix()
    force_audio = info.needs_audio_transcode()
    needs_container_fix = not info.is_mp4_container()

    if not force_video and not force_audio and not needs_container_fix:
        # Already correct codecs and container; just remux with faststart
        logger.info("Codecs OK; remuxing with faststart")
        return _remux_faststart(src, work_dir, token)

    logger.info(
        "Transcoding: force_video=%s force_audio=%s container_fix=%s",
        force_video, force_audio, needs_container_fix,
    )
    return _transcode(src, work_dir, token, force_video=force_video, force_audio=force_audio)


def _remux_faststart(src: Path, work_dir: Path, token: str) -> Optional[Path]:
    """Stream-copy into a new MP4 with moov atom at the front."""
    dest = work_dir / f"{token}_out.mp4"
    cmd = [
        "ffmpeg", "-y", "-i", str(src),
        "-c", "copy",
        "-movflags", "+faststart",
        str(dest),
    ]
    return _run_ffmpeg(cmd, dest)


def _transcode(
    src: Path,
    work_dir: Path,
    token: str,
    *,
    force_video: bool,
    force_audio: bool,
) -> Optional[Path]:
    """Re-encode to H.264+AAC MP4 with QQ-safe settings."""
    dest = work_dir / f"{token}_out.mp4"

    cmd = ["ffmpeg", "-y", "-i", str(src)]

    if force_video:
        cmd += [
            "-c:v", "libx264",
            "-preset", "fast",       # balance speed vs. compression
            "-crf", "23",
            "-profile:v", "main",
            "-level:v", "4.1",
            "-pix_fmt", "yuv420p",
            # Ensure width and height are divisible by 2
            "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        ]
    else:
        cmd += ["-c:v", "copy"]

    if force_audio:
        cmd += [
            "-c:a", "aac",
            "-b:a", "128k",
            "-ar", "44100",
            "-ac", "2",
        ]
    else:
        cmd += ["-c:a", "copy"]

    cmd += ["-movflags", "+faststart", str(dest)]

    return _run_ffmpeg(cmd, dest)


def _run_ffmpeg(cmd: list[str], dest: Path) -> Optional[Path]:
    logger.info("Running: %s", " ".join(cmd))
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except FileNotFoundError:
        logger.error("ffmpeg not found; cannot process video")
        return None
    except subprocess.TimeoutExpired:
        logger.error("ffmpeg timed out after 120s")
        return None
    except Exception as exc:  # noqa: BLE001
        logger.error("ffmpeg error: %s", exc)
        return None

    if result.returncode != 0:
        logger.error("ffmpeg failed (code %d):\n%s", result.returncode, result.stderr[-1000:])
        return None

    logger.info("ffmpeg done: %s (%.1f MB)", dest.name, dest.stat().st_size / 1_048_576)
    return dest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_VIDEO_SUFFIXES = {".mp4", ".mkv", ".webm", ".mov", ".flv", ".avi", ".ts", ".m4v"}


def _pick_largest_video(directory: Path) -> Optional[Path]:
    candidates = [
        p for p in directory.iterdir()
        if p.is_file() and p.suffix.lower() in _VIDEO_SUFFIXES
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_size)
