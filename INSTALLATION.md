# Review Gate V3 Installation

## Automated Install

### macOS / Linux

```bash
git clone https://github.com/LakshmanTurlapati/Review-Gate.git
cd Review-Gate
./install.sh
```

The installer targets `~/cursor-extensions/review-gate-v3`, merges the MCP config safely, and installs the packaged `review-gate-v3-*.vsix` if the `cursor` CLI is available.

Before running the installer from a source checkout, generate release artifacts:

```bash
cd cursor-extension
npm install
npm run package:release
```

`npm run package:release` guarantees a clean `dist/extension.js` bundle and a single
`review-gate-v3-<version>.vsix` in `cursor-extension/`.

## Manual Install

### 1. Copy the runtime files

```bash
mkdir -p ~/cursor-extensions/review-gate-v3
cp -R review_gate_mcp ~/cursor-extensions/review-gate-v3/
cp pyproject.toml requirements.txt readme.md ~/cursor-extensions/review-gate-v3/
cp cursor-extension/review-gate-v3-*.vsix ~/cursor-extensions/review-gate-v3/
```

`package:release` removes old VSIX files first, so the wildcard resolves to one file.

### 2. Create the Python environment

```bash
cd ~/cursor-extensions/review-gate-v3
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install .
pip install ".[speech]"  # optional
deactivate
```

### 3. Install system speech prerequisites

macOS:

```bash
brew install sox ffmpeg pkg-config
```

Ubuntu / Debian:

```bash
sudo apt-get update
sudo apt-get install -y sox ffmpeg pkg-config libavcodec-dev libavformat-dev libavutil-dev libswscale-dev libavdevice-dev
```

### 4. Add the MCP server to Cursor

Create or update `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "review-gate-v3": {
      "command": "/Users/YOUR_USERNAME/cursor-extensions/review-gate-v3/venv/bin/python",
      "args": ["-m", "review_gate_mcp.main"],
      "env": {
        "PYTHONPATH": "/Users/YOUR_USERNAME/cursor-extensions/review-gate-v3",
        "PYTHONUNBUFFERED": "1",
        "REVIEW_GATE_MODE": "cursor_integration"
      }
    }
  }
}
```

If you already have other MCP servers configured, keep them and add the `review-gate-v3` entry alongside them.

### 5. Install the extension

If the `cursor` CLI is available:

```bash
cursor --install-extension ~/cursor-extensions/review-gate-v3/review-gate-v3-*.vsix
```

Otherwise, install the VSIX manually from Cursor:

1. Open Cursor
2. Open the command palette
3. Run `Extensions: Install from VSIX...`
4. Pick the packaged `review-gate-v3-*.vsix` file in `~/cursor-extensions/review-gate-v3/`

### 6. Install the rule file

Copy `ReviewGateV3.mdc` into your Cursor rules directory as `ReviewGate.mdc`.

macOS:

```bash
mkdir -p "$HOME/Library/Application Support/Cursor/User/rules"
cp ReviewGateV3.mdc "$HOME/Library/Application Support/Cursor/User/rules/ReviewGate.mdc"
```

Linux:

```bash
mkdir -p "$HOME/.config/Cursor/User/rules"
cp ReviewGateV3.mdc "$HOME/.config/Cursor/User/rules/ReviewGate.mdc"
```

## Verification

1. Restart Cursor.
2. Run `reviewGate.openChat` or press `Cmd/Ctrl+Shift+R`.
3. Ask Cursor Agent to call `review_gate_chat`.
4. Confirm the popup returns a response to the MCP server.

For a full release checklist, use [SMOKE_TEST.md](SMOKE_TEST.md).
