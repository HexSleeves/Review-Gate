# AGENTS.md

This file contains essential information for agentic coding assistants working on the Review Gate codebase.

## Project Structure

- `cursor-extension/` - VSCode/Cursor extension (Node.js, CommonJS)
- `review_gate_mcp/` - MCP server (Python 3.8+, asyncio)
- `tests/` - Python unit tests using unittest
- `install.sh` / `uninstall.sh` - Installation scripts

## Build / Lint / Test Commands

### Cursor Extension (Node.js)

```bash
cd cursor-extension
npm run compile          # Build with type checking
npm run watch            # Watch mode for development
npm run package          # Production build (minified)
npm run lint             # Run ESLint
npm run format           # Format with Prettier
npm run format:check     # Check formatting without changes
```

### Python MCP Server

```bash
pytest                           # Run all tests
pytest tests/test_server.py        # Run specific test file
pytest tests/test_server.py::TestReviewGateServer::test_server_initialization  # Run single test
pytest -xvs tests/test_server.py # Verbose, stop on first failure
```

## Code Style Guidelines

### JavaScript / Node.js (cursor-extension/)

**Imports & Structure**

- Use CommonJS: `const fs = require("fs")`
- Group imports: Node.js builtins → local modules
- Export using `module.exports = { ... }`
- Global state stored in `src/state.js` module

**Formatting (Prettier)**

- 100 characters line width
- Double quotes
- Semicolons required
- 2 spaces indentation (no tabs)
- Trailing commas in ES5
- LF line endings

**Naming Conventions**

- Functions/Variables: `camelCase` (e.g., `handleReviewMessage`)
- Classes: `PascalCase` (rare, mostly functional)
- Constants: `UPPER_SNAKE_CASE`
- Files: `camelCase.js`

**Error Handling**

- Always use try-catch for async operations
- Log errors with emoji prefixes: `logger.error("❌ Error message")`
- User feedback: `vscode.window.showErrorMessage("Message")`
- Return meaningful error objects: `{ success: false, error: "reason" }`

**Type Safety**

- JSDoc comments for function signatures
- Check existence before accessing properties: `state.chatPanel?.webview`

**Async Patterns**

- Use async/await exclusively
- File operations: Use `fs.promises` or sync wrappers
- Use setTimeout for debouncing and delays

### Python (review_gate_mcp/)

**Imports**

- Standard library first, then local imports with relative imports: `from .config import logger`
- Type hints from `typing`: `Optional`, `Dict`, `Any`, `List`
- Use `asyncio.to_thread` for blocking operations in async functions

**Formatting**

- PEP 8 compliant
- 88-100 characters line width
- 4 spaces indentation
- Type hints on all functions

**Naming Conventions**

- Functions/Variables: `snake_case` (e.g., `handle_review_gate_chat`)
- Classes: `PascalCase` (e.g., `ReviewGateServer`)
- Private methods: leading underscore `_method_name`
- Constants: `UPPER_SNAKE_CASE`
- Files: `snake_case.py`

**Error Handling**

- Always use try-except with specific exception types
- Log all errors: `logger.error(f"❌ Error: {e}")`
- Use emoji prefixes for log levels: `✅` (success), `⚠️` (warning), `❌` (error)
- Include context in error messages (file path, operation being performed)
- Use `asyncio.Lock()` for thread-safe operations

**Database Operations**

- Use `database.get_database()` singleton instance
- All database operations are async: `await db.fetch_one(...)`
- Use parameterized queries only (never string interpolation)
- Transaction wrapper for multi-step operations

**Async Patterns**

- Use `async def` for async functions
- Use `await` for async calls
- Use `asyncio.sleep()` for delays (not `time.sleep()`)
- Use `asyncio.to_thread()` for CPU-bound blocking operations
- Run migrations on server startup

## Architecture Notes

### IPC Communication

- File-based IPC between MCP server and Cursor extension
- Trigger files: `review_gate_trigger.json`
- Response files: `review_gate_response_{trigger_id}.json`
- Progress files: `review_gate_progress.json`
- Temporary files stored in `/tmp/` (Unix) or `TEMPDIR` (Windows)

### MCP Integration

- MCP server exposes tools, resources, and prompts
- Tool calls trigger popup in Cursor extension
- Extension responds via IPC files
- Session management via UUID-based conversations
- SQLite database for persistence (conversations, messages, templates)

### Webview (cursor-extension/src/webview.js)

- Inline HTML/CSS/JS in single file (webview.js)
- Message passing via `vscode.postMessage()`
- Support for text, voice (SoX/Whisper), and image uploads
- Progress bar overlay for long-running operations

## Testing Guidelines

- Mock external dependencies (MCP, Whisper) in tests
- Use unittest for Python tests
- Test async functions with proper async/await patterns
- Verify IPC file creation/consumption in integration tests
- Test error paths and edge cases

## Common Patterns

**Logging (Python)**: `logger.info("✅ Operation complete")`
**Logging (Node)**: `logMessage("Operation complete")`
**Database query**: `await db.fetch_one("SELECT ... WHERE id = ?", (id,))`
**Type hint**: `async def get_data(id: str) -> Optional[Dict]:`
**Extension command**: `vscode.commands.executeCommand("reviewGate.openChat")`
**MCP tool response**: Return `List[TextContent]` with user input

## Important Files

- `cursor-extension/src/extension.js` - Extension entry point
- `cursor-extension/src/webview.js` - Popup UI (inline HTML)
- `review_gate_mcp/server.py` - MCP server with tool handlers
- `review_gate_mcp/database.py` - SQLite async wrapper
- `review_gate_mcp/ipc.py` - File-based IPC manager
- `mcp.json` - MCP configuration for Cursor
