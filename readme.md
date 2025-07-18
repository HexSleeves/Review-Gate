[![3OtOp7R.th.png](https://iili.io/3OtOp7R.th.png)](https://freeimage.host/i/3OtOp7R)

# Review Gate V3 for Cursor IDE ゲート

**Cursor** would often drop the mic 🎤 way too early! I'd give it a complex task, it'd use maybe 5 of its ~25 available tool calls for that single "main request," then call it a day. Not only was that untapped AI power for that *single thought*, but making small follow-up tweaks meant starting a *new request*. Doing that too often, and my precious **~500 monthly requests** (you know the ones!) would burn up much faster than I liked :(

**Presenting: The Review Gate V3 – The "Turn Your 500 Cursor Requests into 2500!" Rule with Voice & Vision!**
(Okay, maybe not *always* a perfect 5x, but you get the damn idea! 😉)

I evolved this Global Rule for our beloved Cursor IDE to transform my (and your!) AI from a quick sprinter into an endurance marathon runner for complex ideas, all within the lifecycle of a *single main request*. But now it's **supercharged with voice commands, image uploads, and a beautiful popup interface!** I've basically told Cursor: "Hold up, *we're* not done with this request until *I* say we're done." Before it dares to end the conversation, it *must* open a special **interactive popup** for my (and your!) final, iterative commands with full multi-modal support.

If each main request can now handle the depth of what might have taken 5 separate (and shallow) requests before, we're effectively **supercharging those ~500 monthly requests to feel like 2500 in terms of iterative power!** It's about making every single one count, HARD.

## 🎬 Quick Demo

**See Review Gate V3 in action!** → <https://www.youtube.com/watch?v=mZmNM-AIf4M>

## ✨ Key Features

* **🎤 Voice-Activated AI Control:** Speak your sub-prompts directly! Click the mic, speak naturally, and watch your words transcribe automatically using local Faster-Whisper AI.
* **📷 Visual Context Sharing:** Upload images, screenshots, diagrams, or mockups directly in the popup. The AI sees everything you share.
* **🎨 Beautiful Popup Interface:** Professional orange-glow design that fits perfectly in Cursor with real-time MCP status indicators.
* **AI On MY Leash:** Makes the Cursor Agent wait for *my* (and your!) "go-ahead" via an interactive popup before it truly signs off on an *initial* request.
* **Multiply Your Request Power:** Make *one* main request do the work of many! Instead of 5 new prompts (and 5 dings on your ~500 request counter!), use the Review Gate for 5 (or more!) iterative sub-prompts *within that single request's lifecycle and tool call budget*.
* **Unlock Full Tool Call Potential:** I designed this to help us guide the AI to use more of its ~25 available tool calls for a *single complex idea* through those sub-prompts.
* **MCP Integration Magic:** Built on the Model Context Protocol for seamless Cursor integration. The popup automatically appears when needed.
* **Cross-Platform Speech:** Whisper speech-to-text works flawlessly on macOS and is implemented for Windows, though Windows support hasn't been extensively tested (take it with a grain of salt!).

## 🚀 Installation

### Prerequisites

* **System:** macOS, Linux, or Windows 10/11
* **IDE:** Cursor (latest version)
* **Python:** Version 3.8 or higher
* **Pip:** Python package manager
* **Audio (for voice):**
  * **macOS/Linux:** SoX audio utility
  * **Windows:** SoX (optional, via Chocolatey)

### Quick Install (Recommended)

The automated installer handles dependencies, sets up the MCP server, and configures the Cursor extension.

**macOS/Linux:**

```bash
# Clone the repository and navigate to the V3 directory
git clone https://github.com/LakshmanTurlapati/Review-Gate.git

# Make the installer executable and run it
chmod +x install.sh
./install.sh
```

**Windows (PowerShell):**

```powershell
# Clone the repository and navigate to the V3 directory
git clone https://github.com/LakshmanTurlapati/Review-Gate.git

# Allow script execution and run the installer
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
./install.ps1
```

### Manual Installation

If the automated installation fails, follow these steps.

#### 1. Create Installation Directory

**macOS/Linux:**

```bash
mkdir -p ~/cursor-extensions/review-gate-v3
cd ~/cursor-extensions/review-gate-v3
```

**Windows:**

```cmd
mkdir %USERPROFILE%\cursor-extensions\review-gate-v3
cd %USERPROFILE%\cursor-extensions\review-gate-v3
```

#### 2. Copy Required Files

Copy the following files from the `V3` folder of the cloned repository into your new installation directory:

* `review_gate_v3_mcp.py`
* `requirements_simple.txt`
* `review-gate-v3-0.0.1.vsix` (This is inside the `V3` folder, not `V3/cursor-extension`)

#### 3. Set Up Python Environment

**macOS/Linux:**

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements_simple.txt
```

**Windows:**

```cmd
python -m venv venv
venv\Scripts\activate
pip install -r requirements_simple.txt
```

#### 4. Install SoX (for Speech-to-Text)

**macOS:**

```bash
brew install sox
```

**Linux (Ubuntu/Debian):**

```bash
sudo apt-get install sox
```

**Windows (with Chocolatey):**

```cmd
choco install sox
```

#### 5. Configure MCP Server

Create or edit `~/.cursor/mcp.json` (macOS/Linux) or `%USERPROFILE%\.cursor\mcp.json` (Windows) and add the following configuration. **Remember to replace `YOUR_USERNAME` with your actual username.**

**macOS/Linux:**

```json
{
  "mcpServers": {
    "review-gate-v3": {
      "command": "/Users/YOUR_USERNAME/cursor-extensions/review-gate-v3/venv/bin/python",
      "args": ["/Users/YOUR_USERNAME/cursor-extensions/review-gate-v3/review_gate_v3_mcp.py"],
      "env": {
        "PYTHONPATH": "/Users/YOUR_USERNAME/cursor-extensions/review-gate-v3",
        "PYTHONUNBUFFERED": "1",
        "REVIEW_GATE_MODE": "cursor_integration"
      }
    }
  }
}
```

**Windows:**

```json
{
  "mcpServers": {
    "review-gate-v3": {
      "command": "C:\\Users\\YOUR_USERNAME\\cursor-extensions\\review-gate-v3\\venv\\Scripts\\python.exe",
      "args": ["C:\\Users\\YOUR_USERNAME\\cursor-extensions\\review-gate-v3\\review_gate_v3_mcp.py"],
      "env": {
        "PYTHONPATH": "C:\\Users\\YOUR_USERNAME\\cursor-extensions\\review-gate-v3",
        "PYTHONUNBUFFERED": "1",
        "REVIEW_GATE_MODE": "cursor_integration"
      }
    }
  }
}
```

#### 6. Install Cursor Extension

1. Open Cursor.
2. Press `Cmd+Shift+P` (macOS) or `Ctrl+Shift+P` (Windows/Linux).
3. Type "Extensions: Install from VSIX" and press Enter.
4. Navigate to your installation directory and select `review-gate-v3-0.0.1.vsix`.
5. Restart Cursor when prompted.

## How to Use

### 1. Copy the Rule to Cursor

**This is a critical step.** The rule tells Cursor when to activate the Review Gate.

1. Open the `ReviewGateV3.mdc` file from the repository.
2. Copy the entire content of the file.
3. In Cursor, go to `File > Settings > Rules`.
4. Paste the rule into the rules section and save.
5. Restart Cursor for the rule to take effect.

### 2. Using the Review Gate

Once installed and configured, the Review Gate will automatically appear when you give Cursor a task that triggers the `review_gate_chat` tool. You can also trigger it manually with `Cmd+Shift+R` (macOS) or `Ctrl+Shift+R` (Windows/Linux).

In the popup, you can:

* **Type** follow-up commands.
* **Speak** commands by clicking the microphone icon.
* **Upload** images for visual context.
* Type `TASK_COMPLETE` when you are finished with the current task.

## Troubleshooting

* **MCP Server Not Starting:**
  * Verify your Python installation (`python3 --version`).
  * Ensure the virtual environment is activated and dependencies are installed.
  * Check the log file at `/tmp/review_gate_v3.log` (macOS/Linux) or `%TEMP%\review_gate_v3.log` (Windows).
* **Extension Not Working:**
  * Make sure the extension is enabled in the Extensions panel in Cursor.
  * Check the developer console in Cursor (`Help > Toggle Developer Tools`) for errors.
* **Popup Not Appearing:**
  * Double-check your `mcp.json` configuration for correct paths.
  * Ensure you have copied the rule into Cursor's settings.

## For Developers

If you want to integrate Review Gate V3 with your own VSCode extensions, see the [VSCode Integration Guide](VSCODE_INTEGRATION.md).

## ⚠️ Disclaimers

* **Experimental:** This is a power-user tool. It's clever, but future Cursor updates might affect it.
* **Local Server:** The MCP server runs locally on your machine.
* **Local Speech Processing:** Voice is processed locally with Faster-Whisper.
* **Platform Compatibility:**
  * **macOS:** Fully tested.
  * **Windows:** Implemented, but not extensively tested.
  * **Linux:** Should work, but not tested.

## About Me

This project was created by Lakshman Turlapati. You can find more of my work at [www.audienclature.com](https://www.audienclature.com).
