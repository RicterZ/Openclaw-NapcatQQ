# QQ Message Skill (nap-msg)

Env vars load automatically (including from a local `.env`).

## CLI
- Private: `nap-msg send <user_id> [segments...]`
- Group: `nap-msg send-group <group_id> [segments...]`
- Group forward: `nap-msg send-group <group_id> --forward [segments...]`
- Segments (order preserved): `-t/--text`, `-i/--image`, `-v/--video`, `-f/--file`, `-r/--reply`, `--video-url`
- Video download: `--video-url <http/rtsp...>` fetches the stream, sends full videos or a short clip for live sources, and includes an error forward when downloading fails.

## JSON-RPC (stdio)
- Start server: `nap-msg rpc`
- Methods:
  - `initialize` → responds with capabilities `{streaming:true, attachments:true}`
  - `message.send` (`to`/`chatId`, optional `isGroup`, `text`)
  - `messages.history` → returns `{messages: []}` (not implemented)
  - `chats.list` → returns `[]`
