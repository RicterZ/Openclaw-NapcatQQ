Use `nap-msg` to send / receive QQ messages for moltbot.
Read necessary environment variables from `.env` file.

### Send Messages
#### Commands

- Private: `nap-msg send <user_id> [segments...]`
- Group: `nap-msg send-group <group_id> [segments...]`
- Forward (group multimodal): `nap-msg send-group <group_id> --forward [segments...]`

#### Segments
Segment flags can be mixed/repeated; the order you type is the order sent. Normal send can mix text + image only; other mixes use forward.

- `-t/--text "<text>"`
- `-i/--image "<path_or_url>"`
- `-v/--video "<path_or_url>"`
- `-f/--file "<path>"`
- `-r/--reply "<message_id>"`
- `--video-url "<url>"` (downloads link and sends as video; live streams send a short clip)

### Receive Messages
#### Commands

- Watch incoming QQ messages as JSON: `nap-msg watch`

#### Output

- Private: `{"user_id": 312641104, "message_id": 1466193708, "message_type": "group", "raw_message": "test", "group_id": 2158015541}`
- Group: `{"user_id": 312641104, "message_id": 380822531, "message_type": "private", "raw_message": "test private message"}`
