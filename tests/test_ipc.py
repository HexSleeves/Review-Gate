import tempfile
import unittest
from pathlib import Path
from unittest import mock

from review_gate_mcp.ipc import IPCManager


class TestIPCManager(unittest.IsolatedAsyncioTestCase):
    async def test_trigger_popup_writes_single_atomic_trigger_file(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            manager = IPCManager()

            def temp_path(filename: str) -> str:
                return str(Path(temp_dir) / filename)

            with mock.patch("review_gate_mcp.ipc.get_temp_path", side_effect=temp_path), mock.patch(
                "review_gate_mcp.ipc.sync_file_system"
            ):
                success = await manager.trigger_cursor_popup_immediately(
                    {"tool": "review_gate_chat", "trigger_id": "abc123"}
                )

            self.assertTrue(success)
            self.assertTrue((Path(temp_dir) / "review_gate_trigger.json").exists())
            self.assertFalse((Path(temp_dir) / "review_gate_trigger_0.json").exists())

    async def test_wait_for_user_input_uses_trigger_scoped_response_file(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            manager = IPCManager()

            def temp_path(filename: str) -> str:
                return str(Path(temp_dir) / filename)

            response_file = Path(temp_dir) / "review_gate_response_trigger-1.json"
            response_file.write_text(
                '{"trigger_id":"trigger-1","user_input":"hello","attachments":[]}',
                encoding="utf-8",
            )

            with mock.patch("review_gate_mcp.ipc.get_temp_path", side_effect=temp_path):
                result = await manager.wait_for_user_input("trigger-1", timeout=1)

            self.assertEqual(result, ("hello", []))
            self.assertFalse(response_file.exists())
