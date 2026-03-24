import os
import tempfile
import unittest
from pathlib import Path

from review_gate_mcp.install_utils import (
    CANONICAL_SERVER_KEY,
    discover_vsix,
    merge_review_gate_server,
    remove_review_gate_servers,
)


class TestInstallUtils(unittest.TestCase):
    def test_merge_review_gate_server_preserves_unrelated_servers(self):
        existing = {
            "mcpServers": {
                "other-server": {"command": "python", "args": ["-m", "other"]},
                "review-gate-v1": {"command": "old"},
            }
        }

        merged = merge_review_gate_server(existing, "/tmp/review-gate-v3")

        self.assertIn("other-server", merged["mcpServers"])
        self.assertIn(CANONICAL_SERVER_KEY, merged["mcpServers"])
        self.assertNotIn("review-gate-v1", merged["mcpServers"])
        self.assertEqual(
            merged["mcpServers"][CANONICAL_SERVER_KEY]["args"],
            ["-m", "review_gate_mcp.main"],
        )

    def test_remove_review_gate_servers_only_removes_review_gate(self):
        existing = {
            "mcpServers": {
                "review-gate-v3": {"command": "python"},
                "review-gate-v1": {"command": "python"},
                "other-server": {"command": "python"},
            }
        }

        cleaned = remove_review_gate_servers(existing)

        self.assertEqual(cleaned["mcpServers"], {"other-server": {"command": "python"}})

    def test_discover_vsix_returns_newest_v3_package(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            older = Path(temp_dir) / "review-gate-v3-2.9.0.vsix"
            newer = Path(temp_dir) / "review-gate-v3-3.0.0.vsix"
            older.write_text("old", encoding="utf-8")
            newer.write_text("new", encoding="utf-8")
            os.utime(older, (1, 1))
            os.utime(newer, (2, 2))

            vsix_path = discover_vsix(temp_dir)

            self.assertEqual(vsix_path, str(newer))
