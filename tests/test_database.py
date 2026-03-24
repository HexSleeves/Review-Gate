import tempfile
import unittest
from pathlib import Path

from review_gate_mcp.database import Database


class TestDatabase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.temp_dir.name) / "review_gate.db")
        self.db = Database(db_path=self.db_path)
        await self.db.initialize()

    async def asyncTearDown(self):
        self.temp_dir.cleanup()

    async def test_cleanup_stale_sessions_returns_mutation_count(self):
        session_uuid = await self.db.create_session("session-stale")
        await self.db.execute(
            "UPDATE sessions SET heartbeat_at = ?, status = 'active' WHERE uuid = ?",
            ("2000-01-01T00:00:00", session_uuid),
        )

        updated_rows = await self.db.cleanup_stale_sessions(timeout_seconds=300)
        session = await self.db.get_session(session_uuid)

        self.assertEqual(updated_rows, 1)
        self.assertEqual(session["status"], "stale")

    async def test_cleanup_old_sessions_returns_deleted_count(self):
        recent_session = await self.db.create_session("session-recent")
        old_session = await self.db.create_session("session-old")
        await self.db.execute(
            "UPDATE sessions SET created_at = ?, heartbeat_at = ? WHERE uuid = ?",
            ("2000-01-01T00:00:00", "2000-01-01T00:00:00", old_session),
        )

        deleted_rows = await self.db.cleanup_old_sessions(age_hours=1)
        self.assertEqual(deleted_rows, 1)
        self.assertIsNotNone(await self.db.get_session(recent_session))
        self.assertIsNone(await self.db.get_session(old_session))

    async def test_session_heartbeat_refreshes_expiry(self):
        session_uuid = await self.db.create_session("session-heartbeat")
        original_session = await self.db.get_session(session_uuid)
        await self.db.execute(
            "UPDATE sessions SET expires_at = ? WHERE uuid = ?",
            ("2000-01-01T00:00:00", session_uuid),
        )

        await self.db.update_session_heartbeat(session_uuid)
        refreshed_session = await self.db.get_session(session_uuid)

        self.assertNotEqual(original_session["expires_at"], refreshed_session["expires_at"])
        self.assertNotEqual("2000-01-01T00:00:00", refreshed_session["expires_at"])
        self.assertEqual(refreshed_session["status"], "active")
