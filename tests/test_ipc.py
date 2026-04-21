import asyncio
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

            self.assertEqual(
                result,
                {"status": "completed", "user_input": "hello", "attachments": []},
            )
            self.assertFalse(response_file.exists())

    async def test_wait_for_acknowledgement_accepts_envelope_payload(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            manager = IPCManager()

            def temp_path(filename: str) -> str:
                return str(Path(temp_dir) / filename)

            ack_file = Path(temp_dir) / "review_gate_ack_trigger-1.json"
            ack_file.write_text(
                '{"protocol_version":"review-gate-transport/v1","type":"ack","trigger_id":"trigger-1","acknowledged":true}',
                encoding="utf-8",
            )

            with mock.patch("review_gate_mcp.ipc.get_temp_path", side_effect=temp_path):
                acknowledged = await manager.wait_for_extension_acknowledgement(
                    "trigger-1", timeout=1
                )

            self.assertTrue(acknowledged)
            self.assertFalse(ack_file.exists())

    async def test_wait_for_user_input_supports_cancelled_envelope_status(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            manager = IPCManager()

            def temp_path(filename: str) -> str:
                return str(Path(temp_dir) / filename)

            response_file = Path(temp_dir) / "review_gate_response_trigger-2.json"
            response_file.write_text(
                '{"protocol_version":"review-gate-transport/v1","type":"response","trigger_id":"trigger-2","response_status":"cancelled","user_payload":{"text":"","attachments":[]}}',
                encoding="utf-8",
            )

            with mock.patch("review_gate_mcp.ipc.get_temp_path", side_effect=temp_path):
                result = await manager.wait_for_user_input("trigger-2", timeout=1)

            self.assertEqual(
                result,
                {"status": "cancelled", "user_input": "", "attachments": []},
            )
            self.assertFalse(response_file.exists())

    async def test_wait_for_user_input_removes_stale_mismatched_trigger_file(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            manager = IPCManager()

            def temp_path(filename: str) -> str:
                return str(Path(temp_dir) / filename)

            response_file = Path(temp_dir) / "review_gate_response_trigger-3.json"
            response_file.write_text(
                '{"trigger_id":"different-trigger","user_input":"hello"}',
                encoding="utf-8",
            )

            with mock.patch("review_gate_mcp.ipc.get_temp_path", side_effect=temp_path):
                result = await manager.wait_for_user_input("trigger-3", timeout=0.3)

            self.assertIsNone(result)
            self.assertFalse(response_file.exists())

    async def test_wait_for_user_input_quarantines_malformed_response(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            manager = IPCManager()

            def temp_path(filename: str) -> str:
                return str(Path(temp_dir) / filename)

            response_file = Path(temp_dir) / "review_gate_response_trigger-4.json"
            response_file.write_text('{"trigger_id":"trigger-4","user_input":', encoding="utf-8")

            with mock.patch("review_gate_mcp.ipc.get_temp_path", side_effect=temp_path):
                result = await manager.wait_for_user_input("trigger-4", timeout=0.3)

            self.assertIsNone(result)
            quarantined_files = list(
                Path(temp_dir).glob("review_gate_response_trigger-4.malformed.*.json")
            )
            self.assertTrue(quarantined_files)

    async def test_reserve_request_slot_serializes_overlapping_requests(self):
        manager = IPCManager()
        first_entered = asyncio.Event()
        allow_first_exit = asyncio.Event()
        second_entered = asyncio.Event()
        queue_positions = []
        execution_order = []

        async def first_request():
            async with manager.reserve_request_slot("trigger-a") as slot:
                queue_positions.append(slot["queue_position"])
                execution_order.append("first-enter")
                first_entered.set()
                await allow_first_exit.wait()
                execution_order.append("first-exit")

        async def second_request():
            await first_entered.wait()
            async with manager.reserve_request_slot("trigger-b") as slot:
                queue_positions.append(slot["queue_position"])
                execution_order.append("second-enter")
                second_entered.set()

        first_task = asyncio.create_task(first_request())
        second_task = asyncio.create_task(second_request())

        await first_entered.wait()
        await asyncio.sleep(0.05)
        self.assertFalse(second_entered.is_set())

        allow_first_exit.set()
        await asyncio.gather(first_task, second_task)

        self.assertEqual(queue_positions, [1, 2])
        self.assertEqual(execution_order, ["first-enter", "first-exit", "second-enter"])

    async def test_trigger_popup_replay_cleans_stale_artifacts_before_write(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            manager = IPCManager()

            def temp_path(filename: str) -> str:
                return str(Path(temp_dir) / filename)

            trigger_file = Path(temp_dir) / "review_gate_trigger.json"
            trigger_file.write_text(
                '{"trigger_id":"stale-trigger","message":"stale"}',
                encoding="utf-8",
            )

            ack_file = Path(temp_dir) / "review_gate_ack_replay-1.json"
            ack_file.write_text('{"acknowledged":true}', encoding="utf-8")
            response_file = Path(temp_dir) / "review_gate_response_replay-1.json"
            response_file.write_text('{"user_input":"old"}', encoding="utf-8")

            with mock.patch("review_gate_mcp.ipc.get_temp_path", side_effect=temp_path), mock.patch(
                "review_gate_mcp.ipc.sync_file_system"
            ):
                success = await manager.trigger_cursor_popup_immediately(
                    {"tool": "review_gate_chat", "trigger_id": "replay-1"}
                )

            self.assertTrue(success)
            self.assertFalse(ack_file.exists())
            self.assertFalse(response_file.exists())

            written = trigger_file.read_text(encoding="utf-8")
            self.assertIn('"trigger_id": "replay-1"', written)
