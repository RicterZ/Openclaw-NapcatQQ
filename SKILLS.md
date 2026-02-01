# QQ Message Skill (nap-msg)

Env vars load automatically (including from a local `.env`).

## CLI
- Private: `nap-msg send <user_id> [segments...]`
- Group: `nap-msg send-group <group_id> [segments...]`
- Group forward: `nap-msg send-group <group_id> --forward [segments...]`
- Segments (order preserved): `-t/--text`, `-i/--image`, `-v/--video`, `-f/--file`, `-r/--reply`, `--video-url`
- Video download: `--video-url <http/rtsp...>` uses yt-dlp; VODs download fully, live streams clip first 30s; errors are forwarded to group as a node with the original request + error text.

## JSON-RPC (stdio)
- Start server: `nap-msg rpc`
- Methods:
  - `initialize` → responds with capabilities `{streaming:true, attachments:true}`
  - `message.send` (`to`/`chatId`, optional `isGroup`, `text`)
  - `messages.history` → returns `{messages: []}` (not implemented)
  - `chats.list` → returns `[]`
