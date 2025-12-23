# Review Gate V2 - Project Context

## Project Overview

Review Gate V2 is a tool designed to enhance the workflow within the Cursor IDE. It acts as an intermediary layer (a "gate") that forces an interactive review step before the AI agent concludes a task. This allows users to provide multi-modal feedback (text, voice, images) to guide the agent iteratively within a single request context.

The project consists of two main components working in tandem:
1.  **MCP Server (`review_gate_mcp`):** A Python-based server implementing the Model Context Protocol. It exposes tools to the Cursor Agent that trigger the review process.
2.  **Cursor Extension (`cursor-extension`):** A VS Code/Cursor extension that provides the graphical user interface (popup) for the user to interact with.

## Architecture

The system uses a file-based Inter-Process Communication (IPC) mechanism to bridge the local MCP server and the Cursor Extension.

1.  **Trigger:** The Cursor Agent calls the `review_gate_chat` tool exposed by the MCP server.
2.  **IPC:** The MCP server (`IPCManager`) writes a trigger file (JSON) to the system's temporary directory.
3.  **UI:** The Cursor Extension watches for this trigger file, opens a Webview panel, and accepts user input.
4.  **Feedback:** User input (text, transcribed speech, or image paths) is written back to a response file.
5.  **Response:** The MCP server reads the response file and returns the content to the Cursor Agent.

## Directory Structure

*   `review_gate_mcp/`: The Python MCP server package.
    *   `server.py`: Core MCP server logic and tool definitions.
    *   `ipc.py`: Handles file-based communication (triggers/responses) with the extension.
    *   `speech.py`: Manages speech-to-text functionality using `faster-whisper`.
    *   `main.py`: Entry point for the server.
*   `cursor-extension/`: The VS Code/Cursor extension source.
    *   `src/`: Source code for the extension.
        *   `extension.js`: Entry point and lifecycle management.
        *   `webview.js`: Manages the Webview UI.
        *   `ipc.js`: Handles file watching and status monitoring.
        *   `audio.js`: Audio recording logic.
*   `install.sh`: Automated installation script for macOS/Linux.
*   `install.ps1`: Automated installation script for Windows.
*   `pyproject.toml`: Python project configuration and dependencies.
*   `ReviewGateV2.mdc`: The Cursor rule file that instructs the AI to use the tool.

## Building and Running

### Installation (Automated)

The primary way to set up the project is via the provided scripts:

```bash
# macOS/Linux
./install.sh

# Windows
./install.ps1
```

These scripts handle:
1.  Creating a Python virtual environment.
2.  Installing the `review_gate_mcp` package.
3.  Configuring Cursor's `mcp.json` to register the server.
4.  Installing the Cursor Extension (VSIX).

### Manual Development

**Python MCP Server:**

```bash
# Install dependencies
pip install .           # Core dependencies
pip install ".[speech]" # With speech support

# Run the server
python -m review_gate_mcp.main
```

**Cursor Extension:**

```bash
cd cursor-extension
# (Assuming npm/node is available)
npm install
npm run package # Uses vsce package to create .vsix
```

## Development Conventions

*   **Modularization:** The project has been refactored from monolithic files into modular packages. New code should follow this structure.
*   **IPC Safety:** File operations for IPC use atomic writes or specific unique filenames where possible to avoid race conditions. Temporary files are cleaned up after use.
*   **Speech Handling:** Speech-to-text is an optional dependency (`faster-whisper`). The system should degrade gracefully if it is not available or if `onnxruntime` issues occur.
*   **Logging:** Both the MCP server and the Extension log to `review_gate_v2.log` in the temp directory for debugging.

## Key Files

*   `review_gate_mcp/server.py`: Defines the `review_gate_chat` tool.
*   `cursor-extension/src/webview.js`: Contains the HTML/JS for the user interface.
*   `pyproject.toml`: Defines the Python package build and dependencies.
