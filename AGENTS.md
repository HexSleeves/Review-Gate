# Repository Guidelines

## Project Structure & Module Organization

This repo has two runtime surfaces:

- `review_gate_mcp/`: Python MCP server, IPC layer, config, prompts, speech helpers, and install utilities.
- `cursor-extension/`: Cursor extension source in `src/`, Node packaging scripts in `scripts/`, built output in `dist/`, and extension tests in `tests/`.

Top-level docs include [`README.md`](README.md), [`INSTALLATION.md`](INSTALLATION.md), and [`SMOKE_TEST.md`](SMOKE_TEST.md). Python tests live in `tests/`. Static assets such as screenshots live in `assets/`.

## Build, Test, and Development Commands

Use the same checks that CI runs:

- `python -m compileall review_gate_mcp`: syntax-check the Python package.
- `python -m unittest discover -s tests -v`: run Python unit tests.
- `cd cursor-extension && npm install`: install extension dependencies.
- `cd cursor-extension && npm run compile`: type-check and bundle the extension.
- `cd cursor-extension && npm run test`: run extension unit tests with the Node test runner.
- `cd cursor-extension && npm run package:release`: build production assets and emit a single `review-gate-v3-<version>.vsix`.

## Coding Style & Naming Conventions

Python follows standard PEP 8 conventions: 4-space indentation, `snake_case` module/function names, and small focused modules such as `ipc.py` and `install_utils.py`. Keep new public entrypoints aligned with `review_gate_mcp.main:cli`.

Extension code is plain JavaScript with CommonJS `require(...)`. Prettier is the formatter: 2 spaces, semicolons, double quotes, trailing commas `es5`, and `printWidth: 100`. Run `npm run format` or `npm run format:check` before shipping. Use `camelCase` for functions and variables, and keep filenames lowercase like `ipcFiles.js`.

## Testing Guidelines

Add Python tests under `tests/test_<area>.py` and extension tests under `cursor-extension/tests/*.test.cjs`. Prefer focused regression tests around IPC files, popup lifecycle, and malformed transport payloads. A change is not complete until both Python and extension test suites pass locally.

## Commit & Pull Request Guidelines

Recent history uses short imperative subjects, often with a scoped summary after a colon, for example: `Enhance unit tests for IPCManager in test_ipc.py: ...`. Follow that pattern and keep each commit tied to one behavior change.

Pull requests should include:

- a brief problem/solution summary,
- linked issue or context,
- test evidence (`unittest`, `npm run test`, `npm run compile`),
- screenshots or smoke-test notes for webview or packaging changes.

## Security & Configuration Tips

Do not commit local Cursor config or temp IPC artifacts. The installer merges into `~/.cursor/mcp.json`; treat that file as user-specific. Runtime transport files such as `review_gate_trigger.json` and `review_gate_response_<id>.json` belong in the system temp directory, not in the repo.
