# moltbot-napcat-bridge

CLI relay that sends messages from moltbot to a Napcat WebSocket backend.

## Usage
- Install with Poetry: `poetry install`
- Run CLI via Poetry: `poetry run nap-msg --help`

Napcat backend: set env `NAPCAT_URL` (or pass `--napcat-url`).

## Test (manual RPC receive)
1. Export Napcat URL in the shell: `set NAPCAT_URL=ws://<host>:<port>` (PowerShell) or `export NAPCAT_URL=...` (bash).
2. Terminal A: start RPC server and leave it running: `poetry run nap-msg rpc`.
3. In the same terminal, type a subscribe request and press Enter on one line:
   ```
   {"jsonrpc":"2.0","id":1,"method":"watch.subscribe","params":{}}
   ```
   You should see a `{"result":{"subscription":...},"id":1,...}` response.
4. Trigger a QQ message on Napcat; the RPC server should print a notification:
   ```
   {"jsonrpc":"2.0","method":"message","params":{"subscription":1,"message":{...}}}
   ```
5. To test sending, type:
   ```
   {"jsonrpc":"2.0","id":2,"method":"message.send","params":{"to":"<qq_id>","text":"hello","isGroup":false}}
   ```
   A `result` response means the send call was accepted.
