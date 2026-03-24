import argparse
import json
import os
from pathlib import Path
from typing import Any, Dict, Iterable, Optional


CANONICAL_SERVER_KEY = "review-gate-v3"
LEGACY_SERVER_KEYS = ("review-gate-v2",)
ALL_SERVER_KEYS = (CANONICAL_SERVER_KEY, *LEGACY_SERVER_KEYS)
VSIX_GLOB = "review-gate-v3-*.vsix"


def discover_vsix(extension_dir: str) -> Optional[str]:
    """Return the newest packaged V3 extension artifact in the given directory."""
    candidates = sorted(
        Path(extension_dir).glob(VSIX_GLOB),
        key=lambda candidate: candidate.stat().st_mtime,
        reverse=True,
    )
    if not candidates:
        return None
    return str(candidates[0])


def build_server_entry(review_gate_dir: str) -> Dict[str, Any]:
    """Build the canonical MCP server configuration for Review Gate."""
    install_dir = Path(review_gate_dir)
    python_binary = install_dir / "venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    return {
        "command": str(python_binary),
        "args": ["-m", "review_gate_mcp.main"],
        "env": {
            "PYTHONPATH": str(install_dir),
            "PYTHONUNBUFFERED": "1",
            "REVIEW_GATE_MODE": "cursor_integration",
        },
    }


def merge_review_gate_server(
    config: Optional[Dict[str, Any]],
    review_gate_dir: str,
    *,
    preserve_server_keys: Optional[Iterable[str]] = None,
) -> Dict[str, Any]:
    """Merge the canonical Review Gate MCP entry into an existing config."""
    merged = dict(config or {})
    servers = dict(merged.get("mcpServers", {}))

    keys_to_remove = set(ALL_SERVER_KEYS)
    if preserve_server_keys:
        keys_to_remove -= set(preserve_server_keys)

    for key in keys_to_remove:
        servers.pop(key, None)

    servers[CANONICAL_SERVER_KEY] = build_server_entry(review_gate_dir)
    merged["mcpServers"] = servers
    return merged


def remove_review_gate_servers(config: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Remove Review Gate MCP entries while preserving every other server."""
    cleaned = dict(config or {})
    servers = dict(cleaned.get("mcpServers", {}))
    for key in ALL_SERVER_KEYS:
        servers.pop(key, None)
    cleaned["mcpServers"] = servers
    return cleaned


def load_config(path: str) -> Dict[str, Any]:
    """Load an MCP config from disk. Missing files return an empty config."""
    config_path = Path(path)
    if not config_path.exists():
        return {"mcpServers": {}}
    with config_path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def save_config(path: str, config: Dict[str, Any]) -> None:
    """Persist an MCP config to disk with deterministic formatting."""
    config_path = Path(path)
    config_path.parent.mkdir(parents=True, exist_ok=True)
    with config_path.open("w", encoding="utf-8") as handle:
        json.dump(config, handle, indent=2)
        handle.write("\n")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Review Gate installer helpers")
    subparsers = parser.add_subparsers(dest="command", required=True)

    merge_parser = subparsers.add_parser("merge-config", help="Merge Review Gate into an MCP config")
    merge_parser.add_argument("--config", required=True)
    merge_parser.add_argument("--install-dir", required=True)

    remove_parser = subparsers.add_parser(
        "remove-config", help="Remove Review Gate entries from an MCP config"
    )
    remove_parser.add_argument("--config", required=True)

    discover_parser = subparsers.add_parser("discover-vsix", help="Discover the packaged V3 VSIX")
    discover_parser.add_argument("--extension-dir", required=True)

    return parser


def main() -> int:
    parser = _build_parser()
    args = parser.parse_args()

    if args.command == "merge-config":
        config = load_config(args.config)
        merged = merge_review_gate_server(config, args.install_dir)
        save_config(args.config, merged)
        return 0

    if args.command == "remove-config":
        config = load_config(args.config)
        cleaned = remove_review_gate_servers(config)
        save_config(args.config, cleaned)
        return 0

    if args.command == "discover-vsix":
        vsix_path = discover_vsix(args.extension_dir)
        if not vsix_path:
            return 1
        print(vsix_path)
        return 0

    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
