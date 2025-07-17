# VSCode Extension Integration Guide for Review Gate V2

## Overview

Review Gate V2 now provides enhanced integration with VSCode through its callback system and extension architecture. This guide covers how to integrate the Review Gate callback system into your VSCode extension development workflow.

## Key Features

### 1. MCP Server Integration

- **Seamless communication** between VSCode extensions and MCP servers
- **Real-time feedback** through the Review Gate callback system
- **Multi-modal support** for text, voice, and image inputs
- **Cross-platform compatibility** (Windows, macOS, Linux)

### 2. VSCode Extension API Integration

- **Extension manifest generation** for better integration
- **Command palette integration** for quick access
- **Status bar updates** for MCP server status
- **Webview panels** for rich UI interactions

### 3. Callback System Architecture

```typescript
interface ReviewGateCallback {
  onUserInput: (input: string, attachments?: any[]) => void;
  onSpeechTranscribed: (transcription: string) => void;
  onImageUploaded: (imageData: ImageData) => void;
  onStatusChanged: (status: MCPStatus) => void;
}
```

## Installation Steps

### Step 1: Install Review Gate V2

```bash
# Clone the repository
git clone https://github.com/LakshmanTurlapati/Review-Gate.git
cd Review-Gate/V2

# Run the enhanced installer
./install.sh
```

### Step 2: VSCode Extension Setup

The installer automatically creates a VSCode extension manifest at:

- **macOS/Linux**: `~/.vscode/extensions/review-gate-v3-mcp/`
- **Windows**: `%USERPROFILE%\.vscode\extensions\review-gate-v3-mcp\`

### Step 3: Configure Your Extension

Add the Review Gate callback system to your VSCode extension:

```typescript
import * as vscode from 'vscode';
import { ReviewGateIntegration } from './review-gate-integration';

export function activate(context: vscode.ExtensionContext) {
    const reviewGate = new ReviewGateIntegration(context);

    // Register callback handlers
    reviewGate.onUserInput((input, attachments) => {
        // Handle user input from Review Gate
        console.log('User input:', input);
        console.log('Attachments:', attachments);
    });

    reviewGate.onSpeechTranscribed((transcription) => {
        // Handle speech-to-text results
        console.log('Speech transcription:', transcription);
    });

    reviewGate.onStatusChanged((status) => {
        // Handle MCP server status changes
        console.log('MCP Status:', status);
    });
}
```

## Integration Examples

### Example 1: Code Review Extension

```typescript
export class CodeReviewExtension {
    private reviewGate: ReviewGateIntegration;

    constructor(context: vscode.ExtensionContext) {
        this.reviewGate = new ReviewGateIntegration(context);
        this.setupCallbacks();
    }

    private setupCallbacks() {
        this.reviewGate.onUserInput((input, attachments) => {
            // Process code review feedback
            this.processReviewFeedback(input, attachments);
        });
    }

    async requestCodeReview(code: string) {
        // Trigger Review Gate for code review
        const response = await this.reviewGate.requestInput({
            message: `Please review this code:\n\n${code}`,
            title: "Code Review",
            context: "code_review"
        });

        return response;
    }

    private processReviewFeedback(input: string, attachments: any[]) {
        // Process the review feedback
        // Apply suggestions, generate reports, etc.
    }
}
```

### Example 2: Documentation Generator

```typescript
export class DocGeneratorExtension {
    private reviewGate: ReviewGateIntegration;

    constructor(context: vscode.ExtensionContext) {
        this.reviewGate = new ReviewGateIntegration(context);
        this.setupCallbacks();
    }

    private setupCallbacks() {
        this.reviewGate.onUserInput((input) => {
            this.generateDocumentation(input);
        });

        this.reviewGate.onSpeechTranscribed((transcription) => {
            // Use voice input for documentation
            this.processVoiceDocumentation(transcription);
        });
    }

    async generateDocumentationFromVoice() {
        const response = await this.reviewGate.requestInput({
            message: "Please describe the functionality you want documented. You can use voice input.",
            title: "Documentation Generator",
            context: "documentation",
            enableVoice: true
        });

        return response;
    }
}
```

## Advanced Features

### 1. Multi-Modal Input Support

```typescript
// Request input with image support
const response = await reviewGate.requestInput({
    message: "Please review this UI mockup and provide feedback",
    title: "UI Review",
    context: "ui_review",
    enableImages: true,
    enableVoice: true
});
```

### 2. Real-time Status Updates

```typescript
// Monitor MCP server status
reviewGate.onStatusChanged((status) => {
    if (status.active) {
        // Update status bar
        statusBarItem.text = "$(check) Review Gate Active";
        statusBarItem.color = "green";
    } else {
        statusBarItem.text = "$(x) Review Gate Inactive";
        statusBarItem.color = "red";
    }
});
```

### 3. Custom Callbacks

```typescript
// Register custom callback for specific events
reviewGate.registerCallback('file_selected', (data) => {
    // Handle file selection from Review Gate
    console.log('Selected files:', data.files);
});

// Trigger custom callback
await reviewGate.triggerCallback('file_review', {
    instruction: "Please select files for analysis",
    file_types: ["*.ts", "*.js", "*.json"]
});
```

## File Structure

```
your-extension/
├── src/
│   ├── extension.ts
│   ├── review-gate-integration.ts
│   └── types/
│       └── review-gate.d.ts
├── package.json
└── README.md
```

## Configuration

### package.json

```json
{
  "name": "your-extension",
  "displayName": "Your Extension with Review Gate",
  "description": "Extension with Review Gate integration",
  "version": "1.0.0",
  "engines": {
    "vscode": "^1.95.0"
  },
  "dependencies": {
    "review-gate-v3-integration": "^0.0.1"
  },
  "contributes": {
    "commands": [
      {
        "command": "yourExtension.openReviewGate",
        "title": "Open Review Gate"
      }
    ]
  }
}
```

## Testing Your Integration

### 1. Unit Tests

```typescript
import { ReviewGateIntegration } from './review-gate-integration';

describe('Review Gate Integration', () => {
    let reviewGate: ReviewGateIntegration;

    beforeEach(() => {
        reviewGate = new ReviewGateIntegration(mockContext);
    });

    test('should handle user input callback', async () => {
        const mockInput = "Test input";
        const mockCallback = jest.fn();

        reviewGate.onUserInput(mockCallback);

        // Simulate user input
        await reviewGate.simulateUserInput(mockInput);

        expect(mockCallback).toHaveBeenCalledWith(mockInput, []);
    });
});
```

### 2. Integration Tests

```typescript
describe('MCP Server Integration', () => {
    test('should communicate with MCP server', async () => {
        const response = await reviewGate.requestInput({
            message: "Test message",
            title: "Test"
        });

        expect(response).toBeDefined();
        expect(response.success).toBe(true);
    });
});
```

## Best Practices

### 1. Error Handling

```typescript
try {
    const response = await reviewGate.requestInput({
        message: "Please provide input",
        title: "Request"
    });
} catch (error) {
    vscode.window.showErrorMessage(`Review Gate error: ${error.message}`);
}
```

### 2. Timeout Management

```typescript
const response = await reviewGate.requestInput({
    message: "Quick feedback needed",
    title: "Quick Review",
    timeout: 60000 // 1 minute timeout
});
```

### 3. Resource Cleanup

```typescript
export function deactivate() {
    reviewGate.dispose();
}
```

## Troubleshooting

### Common Issues

1. **MCP Server Not Running**
   - Check if the MCP server is configured in `~/.cursor/mcp.json`
   - Verify the server is running: `tail -f /tmp/review_gate_v3.log`

2. **Extension Not Loading**
   - Ensure the extension manifest is properly generated
   - Check VSCode extension logs in the Output panel

3. **Callback Not Triggering**
   - Verify the callback is registered before use
   - Check the trigger ID matching in logs

### Debug Commands

```bash
# Check MCP server status
tail -f /tmp/review_gate_v3.log

# Test MCP server directly
cd ~/cursor-extensions/review-gate-v3
source venv/bin/activate
python review_gate_v3_mcp.py

# Check extension status
code --list-extensions | grep review-gate
```

## Contributing

To contribute to the VSCode integration:

1. Fork the repository
2. Create a feature branch
3. Add your integration enhancements
4. Submit a pull request

## Support

For VSCode integration support:

- Create an issue in the GitHub repository
- Check the troubleshooting guide
- Review the logs for error messages

---

*This integration guide is part of Review Gate V2 by Lakshman Turlapati*
