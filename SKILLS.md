# QQ Message Skill

Use `nap-msg` to send and receive QQ messages for moltbot.
Environment variables are read automatically (including from a local `.env` in the working directory).

## Send Messages
**Commands**
- Private: `nap-msg send <user_id> [segments...]`
- Group: `nap-msg send-group <group_id> [segments...]`
- Group forward: `nap-msg send-group <group_id> --forward [segments...]`

**Segments** (flags can be mixed/repeated; CLI order is send order)
- `-t/--text "<text>"`
- `-i/--image "<path_or_url>"`
- `-v/--video "<path_or_url>"`
- `-f/--file "<path>"`
- `-r/--reply "<message_id>"`

## Receive Messages
**Command**
- Watch incoming QQ messages as JSON: `nap-msg watch`

**Sample output**
- Group: `{"user_id": 312641104, "message_id": 1466193708, "message_type": "group", "raw_message": "test", "group_id": 2158015541}`
- Private: `{"user_id": 312641104, "message_id": 380822531, "message_type": "private", "raw_message": "test private message"}`

## Workflow

1. Use `nap-msg watch` to listen for incoming messages; enqueue multiple messages.
2. Process the queue in order and inspect `message_type`.
3. Reply based on the type: send to `group_id` for `group`, or to `user_id` for `private`.
4. Send replies with `nap-msg send`.
