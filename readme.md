# Review Gate V3

Review Gate V3 is a Cursor extension plus local MCP server that keeps an agent session open for iterative human feedback. It uses file-based IPC between the Python MCP server and the Cursor webview, with optional speech-to-text and image attachments.

![Review Gate V3 Interface](assets/snippet.png)

## Repo Layout

- `cursor-extension/` - Cursor/VS Code extension bundle
- `review_gate_mcp/` - Python MCP server and IPC helpers
- `tests/` - Python unit tests
- `install.sh` / `uninstall.sh` - macOS/Linux install flows

## Prerequisites

- Cursor IDE
- Python 3.10+
- Node.js 20+
- SoX for local speech capture
- `faster-whisper` is optional; without it, the popup still works but speech transcription is disabled

## Install

### Automated install on macOS/Linux

```bash
git clone https://github.com/LakshmanTurlapati/Review-Gate.git
cd Review-Gate
./install.sh
```

The installer:

- installs the Python package into `~/cursor-extensions/review-gate-v3`
- merges a `review-gate-v3` entry into `~/.cursor/mcp.json`
- installs the packaged VSIX from `cursor-extension/review-gate-v3-*.vsix` when the `cursor` CLI is available
- keeps unrelated MCP servers intact

### Manual install

See [INSTALLATION.md](INSTALLATION.md) for the exact MCP config and manual extension steps.

## Development

### Python

```bash
python3 -m unittest discover -s tests -v
python3 -m compileall review_gate_mcp
```

### Extension

```bash
cd cursor-extension
npm install
npm run compile
npm run test
npm run package
```

## Runtime Notes

- The MCP server is started with `python -m review_gate_mcp.main`
- The extension and server communicate through temp files such as:
  - `review_gate_trigger.json`
  - `review_gate_ack_<trigger_id>.json`
  - `review_gate_response_<trigger_id>.json`
  - `review_gate_progress.json`
- Speech requests use dedicated trigger/response files and degrade cleanly when Whisper is unavailable

## Troubleshooting

- Server log: `/tmp/review_gate_v3.log` on macOS/Linux, or the system temp dir on Windows
- Validate Python package startup:

```bash
python3 -m review_gate_mcp.main
```

- Validate SoX:

```bash
sox --version
```

- If the popup never appears, verify:
  - Cursor has the Review Gate V3 extension installed
  - `~/.cursor/mcp.json` contains the `review-gate-v3` server entry
  - the server log is updating while Cursor is running

## Verification Checklist

Use [SMOKE_TEST.md](SMOKE_TEST.md) after installation or before cutting a release.
