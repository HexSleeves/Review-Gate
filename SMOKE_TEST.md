# Review Gate V3 Smoke Test

## Install / Startup

1. Run `cd cursor-extension && npm run package:release`.
2. Confirm release artifacts exist:
   - `cursor-extension/dist/extension.js`
   - exactly one `cursor-extension/review-gate-v3-*.vsix`
3. Run `./install.sh` on macOS or Linux.
4. Confirm `~/.cursor/mcp.json` contains `review-gate-v3`.
5. Confirm `~/cursor-extensions/review-gate-v3` exists and includes:
   - `review_gate_mcp/`
   - `venv/`
   - `review-gate-v3-*.vsix`

## Cursor Integration

1. Restart Cursor.
2. Trigger `reviewGate.openChat`.
3. Confirm the popup opens and accepts text input.
4. Ask Cursor Agent to call `review_gate_chat`.
5. Confirm one popup opens for one MCP request.
6. Submit a response and confirm the server receives it.

## Attachments / Speech

1. Upload an image and confirm it is attached to the response.
2. If SoX and Whisper are installed, record speech and confirm transcription appears in the popup.
3. If Whisper is not installed, confirm the popup still works and speech failure is reported clearly.

## Progress / Cleanup

1. Trigger a progress update and confirm the progress bar renders once.
2. Confirm no stale `review_gate_trigger_*` backup files are created.
3. Confirm response and acknowledgement files are cleaned up after a completed interaction.

## Uninstall

1. Run `./uninstall.sh`.
2. Confirm only Review Gate MCP entries are removed from `~/.cursor/mcp.json`.
3. Confirm unrelated MCP servers remain intact.
