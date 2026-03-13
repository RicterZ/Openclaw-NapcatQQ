Use `nap-msg` to send QQ messages.
Read necessary environment variables from `nap-msg/.env` file.

### Send Messages
#### Commands

- Private: `nap-msg send <user_id> [segments...]`
- Group: `nap-msg send-group <group_id> [segments...]`
- Forward (group multimodal): `nap-msg send-group <group_id> --forward [segments...]`

#### Segments
Segment flags can be mixed/repeated; the order you type is the order sent.

- `-t/--text "<text>"`
- `-i/--image "<path_or_url>"`
- `-v/--video "<path>"` — local video file
- `--video-url "<url>"` — download via yt-dlp, auto-transcode to QQ-compatible MP4 (live streams: first 30s)
- `-f/--file "<path>"`
- `-r/--reply "<message_id>"`
