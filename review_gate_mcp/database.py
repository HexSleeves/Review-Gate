"""
SQLite database layer for Review Gate V2.
Uses asyncio.to_thread for async operations without external dependencies.
"""
import asyncio
import json
import sqlite3
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .config import get_temp_path, logger


class Database:
    """Async SQLite database wrapper with migration support."""

    def __init__(self, db_path: Optional[str] = None):
        self.db_path = db_path or get_temp_path("review_gate.db")
        self._lock = asyncio.Lock()
        self._initialized = False

    async def initialize(self) -> None:
        """Initialize database and run migrations."""
        if self._initialized:
            return

        # Ensure database directory exists
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)

        # Initialize schema
        await self._run_migrations()

        # Detect filesystem type for WAL mode decision
        self._use_wal = await self._detect_filesystem_type()

        # Enable WAL mode if on local filesystem
        if self._use_wal:
            await self.execute("PRAGMA journal_mode=WAL")
            logger.info("✅ Database WAL mode enabled")
        else:
            await self.execute("PRAGMA journal_mode=TRUNCATE")
            logger.info("ℹ️ Database using TRUNCATE journal mode (network filesystem)")

        self._initialized = True
        logger.info(f"✅ Database initialized at {self.db_path}")

    async def _detect_filesystem_type(self) -> bool:
        """Detect if database is on a local filesystem (True) or network (False)."""
        try:
            import os
            import stat

            stat_info = os.stat(self.db_path)

            # Check for NFS file system
            if hasattr(stat, 'ST_TYPE'):
                if stat_info.st_type == stat.ST_NFS:
                    logger.info("ℹ️ Detected NFS filesystem, disabling WAL mode")
                    return False

            # macOS check for network mounts
            if os.name == 'posix':
                try:
                    # Check if path is under /Volumes (often network on macOS)
                    if '/Volumes/' in self.db_path:
                        logger.info("ℹ️ Detected /Volumes path, using journal mode")
                        return False
                except OSError:
                    pass

            return True  # Assume local filesystem

        except Exception as e:
            logger.warning(f"⚠️ Could not detect filesystem type: {e}, using WAL mode")
            return True

    async def _run_migrations(self) -> None:
        """Run pending database migrations."""
        migrations = [
            self._migration_001_initial_schema,
            self._migration_002_add_sessions,
            self._migration_003_add_checkpoints,
            self._migration_004_add_templates,
            self._migration_005_add_config,
            self._migration_006_add_progress,
        ]

        # Get current version
        version = await self._get_schema_version()
        logger.info(f"📊 Current schema version: {version}")

        # Run pending migrations
        for i, migration in enumerate(migrations, start=1):
            if i > version:
                logger.info(f"🔄 Running migration {i}")
                await migration()
                await self.execute(
                    "INSERT OR REPLACE INTO schema_migrations (version, applied_at, description) VALUES (?, ?, ?)",
                    (i, datetime.now().isoformat(), migration.__doc__ or f"Migration {i}")
                )
                logger.info(f"✅ Migration {i} complete")

    async def _get_schema_version(self) -> int:
        """Get current schema version."""
        try:
            result = await self.fetch_one("SELECT MAX(version) as v FROM schema_migrations")
            return result[0] if result and result[0] else 0
        except sqlite3.OperationalError:
            # Schema doesn't exist yet
            return 0

    async def execute(self, query: str, params: Tuple = ()) -> None:
        """Execute a SQL query with parameters (for INSERT, UPDATE, DELETE)."""
        async with self._lock:
            def _execute():
                with sqlite3.connect(self.db_path) as conn:
                    conn.row_factory = sqlite3.Row
                    cursor = conn.cursor()
                    cursor.execute(query, params)
                    conn.commit()
                    return cursor.rowcount

            try:
                return await asyncio.to_thread(_execute)
            except Exception as e:
                logger.error(f"❌ Database execute error: {e}")
                logger.error(f"   Query: {query}")
                logger.error(f"   Params: {params}")
                raise

    async def fetch_one(self, query: str, params: Tuple = ()) -> Optional[Tuple]:
        """Fetch a single row from a SELECT query."""
        async with self._lock:
            def _fetch():
                with sqlite3.connect(self.db_path) as conn:
                    conn.row_factory = sqlite3.Row
                    cursor = conn.cursor()
                    cursor.execute(query, params)
                    row = cursor.fetchone()
                    return tuple(row) if row else None

            try:
                return await asyncio.to_thread(_fetch)
            except Exception as e:
                logger.error(f"❌ Database fetch_one error: {e}")
                return None

    async def fetch_all(self, query: str, params: Tuple = ()) -> List[Tuple]:
        """Fetch all rows from a SELECT query."""
        async with self._lock:
            def _fetch():
                with sqlite3.connect(self.db_path) as conn:
                    conn.row_factory = sqlite3.Row
                    cursor = conn.cursor()
                    cursor.execute(query, params)
                    return [tuple(row) for row in cursor.fetchall()]

            try:
                return await asyncio.to_thread(_fetch)
            except Exception as e:
                logger.error(f"❌ Database fetch_all error: {e}")
                return []

    async def fetch_dict(self, query: str, params: Tuple = ()) -> Optional[Dict]:
        """Fetch a single row as a dictionary."""
        async with self._lock:
            def _fetch():
                with sqlite3.connect(self.db_path) as conn:
                    conn.row_factory = sqlite3.Row
                    cursor = conn.cursor()
                    cursor.execute(query, params)
                    row = cursor.fetchone()
                    return dict(row) if row else None

            try:
                return await asyncio.to_thread(_fetch)
            except Exception as e:
                logger.error(f"❌ Database fetch_dict error: {e}")
                return None

    async def fetch_all_dicts(self, query: str, params: Tuple = ()) -> List[Dict]:
        """Fetch all rows as dictionaries."""
        async with self._lock:
            def _fetch():
                with sqlite3.connect(self.db_path) as conn:
                    conn.row_factory = sqlite3.Row
                    cursor = conn.cursor()
                    cursor.execute(query, params)
                    return [dict(row) for row in cursor.fetchall()]

            try:
                return await asyncio.to_thread(_fetch)
            except Exception as e:
                logger.error(f"❌ Database fetch_all_dicts error: {e}")
                return []

    # Migrations

    async def _migration_001_initial_schema(self) -> None:
        """Create initial schema with conversations and messages tables."""
        await self.execute("""
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL,
                description TEXT
            )
        """)

        await self.execute("""
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                session_uuid TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                title TEXT,
                context TEXT
            )
        """)

        await self.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                attachments TEXT,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
            )
        """)

        # Create indexes
        await self.execute("CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id)")
        await self.execute("CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC)")

    async def _migration_002_add_sessions(self) -> None:
        """Add sessions table and session_uuid foreign key constraint."""
        await self.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                uuid TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                expires_at TEXT,
                heartbeat_at TEXT
            )
        """)

        await self.execute("CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)")
        await self.execute("CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)")
        await self.execute("CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations(session_uuid)")

    async def _migration_003_add_checkpoints(self) -> None:
        """Add checkpoints table for rollback capability."""
        await self.execute("""
            CREATE TABLE IF NOT EXISTS checkpoints (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                name TEXT NOT NULL,
                snapshot_data TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
            )
        """)

        await self.execute("CREATE INDEX IF NOT EXISTS idx_checkpoints_conversation ON checkpoints(conversation_id)")

    async def _migration_004_add_templates(self) -> None:
        """Add templates table for prompt templates."""
        await self.execute("""
            CREATE TABLE IF NOT EXISTS templates (
                id TEXT PRIMARY KEY,
                name TEXT UNIQUE NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                category TEXT,
                prompt_template TEXT NOT NULL,
                arguments_schema TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)

        await self.execute("CREATE INDEX IF NOT EXISTS idx_templates_category ON templates(category)")

    async def _migration_005_add_config(self) -> None:
        """Add config table for runtime configuration."""
        await self.execute("""
            CREATE TABLE IF NOT EXISTS config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                type TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)

    async def _migration_006_add_progress(self) -> None:
        """Add progress tracking table."""
        await self.execute("""
            CREATE TABLE IF NOT EXISTS progress (
                conversation_id TEXT PRIMARY KEY,
                percent INTEGER NOT NULL DEFAULT 0,
                status_message TEXT,
                step_name TEXT,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
            )
        """)

    # Conversation operations

    async def create_conversation(
        self,
        session_uuid: str,
        title: Optional[str] = None,
        context: Optional[str] = None
    ) -> str:
        """Create a new conversation."""
        conv_id = str(uuid.uuid4())
        now = datetime.now().isoformat()

        await self.execute(
            """INSERT INTO conversations (id, session_uuid, created_at, updated_at, status, title, context)
               VALUES (?, ?, ?, ?, 'active', ?, ?)""",
            (conv_id, session_uuid, now, now, title, context)
        )

        return conv_id

    async def get_conversation(self, conv_id: str) -> Optional[Dict]:
        """Get a conversation by ID."""
        return await self.fetch_dict(
            "SELECT * FROM conversations WHERE id = ?",
            (conv_id,)
        )

    async def get_conversation_by_session(self, session_uuid: str) -> Optional[Dict]:
        """Get active conversation by session UUID."""
        return await self.fetch_dict(
            "SELECT * FROM conversations WHERE session_uuid = ? AND status = 'active'",
            (session_uuid,)
        )

    async def list_conversations(
        self,
        limit: int = 50,
        offset: int = 0,
        status: Optional[str] = None
    ) -> List[Dict]:
        """List conversations with pagination."""
        if status:
            return await self.fetch_all_dicts(
                """SELECT * FROM conversations WHERE status = ?
                   ORDER BY updated_at DESC LIMIT ? OFFSET ?""",
                (status, limit, offset)
            )
        return await self.fetch_all_dicts(
            "SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ? OFFSET ?",
            (limit, offset)
        )

    async def update_conversation_status(self, conv_id: str, status: str) -> None:
        """Update conversation status."""
        await self.execute(
            "UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?",
            (status, datetime.now().isoformat(), conv_id)
        )

    # Message operations

    async def add_message(
        self,
        conversation_id: str,
        role: str,
        content: str,
        attachments: Optional[List[Dict]] = None
    ) -> str:
        """Add a message to a conversation."""
        msg_id = str(uuid.uuid4())
        now = datetime.now().isoformat()

        await self.execute(
            """INSERT INTO messages (id, conversation_id, role, content, timestamp, attachments)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (msg_id, conversation_id, role, content, now, json.dumps(attachments) if attachments else None)
        )

        # Update conversation timestamp
        await self.execute(
            "UPDATE conversations SET updated_at = ? WHERE id = ?",
            (now, conversation_id)
        )

        return msg_id

    async def get_messages(
        self,
        conversation_id: str,
        limit: int = 50,
        offset: int = 0
    ) -> List[Dict]:
        """Get messages for a conversation."""
        messages = await self.fetch_all_dicts(
            """SELECT * FROM messages WHERE conversation_id = ?
               ORDER BY timestamp ASC LIMIT ? OFFSET ?""",
            (conversation_id, limit, offset)
        )

        # Parse JSON attachments
        for msg in messages:
            if msg.get('attachments'):
                try:
                    msg['attachments'] = json.loads(msg['attachments'])
                except (json.JSONDecodeError, ValueError):
                    msg['attachments'] = []

        return messages

    # Session operations

    async def create_session(self, session_uuid: Optional[str] = None) -> str:
        """Create a new session."""
        if not session_uuid:
            session_uuid = str(uuid.uuid4())

        now = datetime.now().isoformat()
        expires_at = datetime.fromtimestamp(time.time() + 300).isoformat()  # 5 minutes

        await self.execute(
            """INSERT INTO sessions (uuid, created_at, updated_at, status, expires_at, heartbeat_at)
               VALUES (?, ?, ?, 'active', ?, ?)""",
            (session_uuid, now, now, expires_at, now)
        )

        return session_uuid

    async def get_session(self, session_uuid: str) -> Optional[Dict]:
        """Get a session by UUID."""
        return await self.fetch_dict(
            "SELECT * FROM sessions WHERE uuid = ?",
            (session_uuid,)
        )

    async def update_session_heartbeat(self, session_uuid: str) -> None:
        """Update session heartbeat timestamp."""
        await self.execute(
            "UPDATE sessions SET heartbeat_at = ?, updated_at = ? WHERE uuid = ?",
            (datetime.now().isoformat(), datetime.now().isoformat(), session_uuid)
        )

    async def cleanup_stale_sessions(self, timeout_seconds: int = 30) -> int:
        """Mark sessions as stale if no heartbeat received within timeout."""
        cutoff = datetime.fromtimestamp(time.time() - timeout_seconds).isoformat()

        await self.execute(
            """UPDATE sessions SET status = 'stale'
               WHERE status = 'active' AND heartbeat_at < ?""",
            (cutoff,)
        )

        result = await self.fetch_one("SELECT changes() as count")
        return result[0] if result else 0

    async def cleanup_old_sessions(self, age_hours: int = 1) -> int:
        """Delete sessions older than specified hours."""
        cutoff = datetime.fromtimestamp(time.time() - (age_hours * 3600)).isoformat()

        await self.execute(
            "DELETE FROM sessions WHERE created_at < ?",
            (cutoff,)
        )

        result = await self.fetch_one("SELECT changes() as count")
        return result[0] if result else 0

    # Template operations

    async def create_template(
        self,
        name: str,
        title: str,
        prompt_template: str,
        description: Optional[str] = None,
        category: Optional[str] = None,
        arguments_schema: Optional[Dict] = None
    ) -> str:
        """Create a new prompt template."""
        template_id = str(uuid.uuid4())
        now = datetime.now().isoformat()

        await self.execute(
            """INSERT INTO templates (id, name, title, description, category, prompt_template, arguments_schema, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (template_id, name, title, description, category, prompt_template,
             json.dumps(arguments_schema) if arguments_schema else None, now, now)
        )

        return template_id

    async def get_template(self, name: str) -> Optional[Dict]:
        """Get a template by name."""
        template = await self.fetch_dict(
            "SELECT * FROM templates WHERE name = ?",
            (name,)
        )

        if template and template.get('arguments_schema'):
            try:
                template['arguments_schema'] = json.loads(template['arguments_schema'])
            except (json.JSONDecodeError, ValueError):
                template['arguments_schema'] = {}

        return template

    async def list_templates(self, category: Optional[str] = None) -> List[Dict]:
        """List all templates."""
        if category:
            return await self.fetch_all_dicts(
                "SELECT * FROM templates WHERE category = ? ORDER BY name",
                (category,)
            )
        return await self.fetch_all_dicts(
            "SELECT * FROM templates ORDER BY name"
        )

    async def initialize_default_templates(self) -> None:
        """Initialize default prompt templates if they don't exist."""
        default_templates = [
            {
                "name": "code_review",
                "title": "Code Review",
                "description": "Comprehensive code review for quality, maintainability, and best practices",
                "category": "review",
                "prompt_template": """Please review the following code for:

1. **Code Quality**: Maintainability, readability, and adherence to best practices
2. **Security**: Potential security vulnerabilities or injection risks
3. **Performance**: Performance bottlenecks or optimization opportunities
4. **Error Handling**: Proper error handling and edge case coverage
5. **Testing**: Test coverage and test quality

{{#if focus_areas}}
Focus areas: {{focus_areas}}
{{/if}}

{{#if severity_level}}
Report issues with severity level: {{severity_level}} or higher
{{/if}}

Provide specific, actionable feedback with code examples where appropriate.""",
                "arguments_schema": {
                    "type": "object",
                    "properties": {
                        "focus_areas": {
                            "type": "array",
                            "description": "Specific areas to focus on (e.g., ['security', 'performance'])"
                        },
                        "severity_level": {
                            "type": "string",
                            "enum": ["error", "warning", "info"],
                            "description": "Minimum severity level to report"
                        }
                    }
                }
            },
            {
                "name": "security_review",
                "title": "Security Review",
                "description": "Security-focused code review with threat modeling",
                "category": "review",
                "prompt_template": """Please perform a comprehensive security review of the following code:

1. **Injection Vulnerabilities**: SQL injection, XSS, command injection, etc.
2. **Authentication & Authorization**: Proper access controls and authentication mechanisms
3. **Data Protection**: Sensitive data handling, encryption, and secure storage
4. **Input Validation**: Proper validation and sanitization of user input
5. **Cryptography**: Proper use of cryptographic functions and key management

{{#if threat_model}}
Include threat modeling analysis for potential attack vectors.
{{/if}}

Report findings with severity ratings (Critical/High/Medium/Low) and remediation steps.""",
                "arguments_schema": {
                    "type": "object",
                    "properties": {
                        "threat_model": {
                            "type": "boolean",
                            "description": "Include threat modeling analysis"
                        }
                    }
                }
            },
            {
                "name": "performance_review",
                "title": "Performance Review",
                "description": "Performance optimization review",
                "category": "review",
                "prompt_template": """Please review the following code for performance optimization opportunities:

1. **Algorithmic Complexity**: Time and space complexity analysis
2. **I/O Operations**: Database queries, file operations, network calls
3. **Caching**: Opportunities for caching frequently accessed data
4. **Concurrency**: Opportunities for parallelization or async operations
5. **Resource Usage**: Memory usage, connection pooling, resource cleanup

{{#if profile_data}}
Consider the following performance profile data:
{{profile_data}}
{{/if}}

Provide specific optimization suggestions with estimated impact.""",
                "arguments_schema": {
                    "type": "object",
                    "properties": {
                        "profile_data": {
                            "type": "string",
                            "description": "Performance profiling data to consider"
                        }
                    }
                }
            },
            {
                "name": "documentation_check",
                "title": "Documentation Check",
                "description": "Documentation completeness and quality review",
                "category": "review",
                "prompt_template": """Please review the documentation for the following code:

1. **Docstrings**: Are all functions, classes, and modules documented?
2. **Comments**: Is complex logic explained with clear comments?
3. **Type Hints**: Are type annotations present and accurate?
4. **README**: Is there adequate documentation for usage?
5. **Examples**: Are usage examples provided?

{{#if standards}}
Standards to follow: {{standards}}
{{/if}}

Identify gaps and provide suggestions for improvement.""",
                "arguments_schema": {
                    "type": "object",
                    "properties": {
                        "standards": {
                            "type": "string",
                            "description": "Documentation standard to follow"
                        }
                    }
                }
            },
            {
                "name": "testing_review",
                "title": "Testing Review",
                "description": "Test coverage and quality review",
                "category": "review",
                "prompt_template": """Please review the test coverage for the following code:

1. **Coverage**: What percentage of code is covered by tests?
2. **Unit Tests**: Are there adequate unit tests for individual functions?
3. **Integration Tests**: Are integration tests covering key workflows?
4. **Edge Cases**: Are edge cases and error conditions tested?
5. **Test Quality**: Are tests clear, maintainable, and meaningful?

{{#if coverage_threshold}}
Minimum coverage threshold: {{coverage_threshold}}%
{{/if}}

Identify untested areas and suggest additional test cases.""",
                "arguments_schema": {
                    "type": "object",
                    "properties": {
                        "coverage_threshold": {
                            "type": "number",
                            "description": "Minimum coverage percentage expected"
                        }
                    }
                }
            }
        ]

        for template in default_templates:
            existing = await self.get_template(template["name"])
            if not existing:
                await self.create_template(**template)
                logger.info(f"✅ Created default template: {template['name']}")

    # Checkpoint operations

    async def create_checkpoint(
        self,
        conversation_id: str,
        name: str,
        snapshot_data: Dict
    ) -> str:
        """Create a checkpoint for rollback."""
        checkpoint_id = str(uuid.uuid4())
        now = datetime.now().isoformat()

        await self.execute(
            """INSERT INTO checkpoints (id, conversation_id, name, snapshot_data, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (checkpoint_id, conversation_id, name, json.dumps(snapshot_data), now)
        )

        return checkpoint_id

    async def get_checkpoint(self, checkpoint_id: str) -> Optional[Dict]:
        """Get a checkpoint by ID."""
        checkpoint = await self.fetch_dict(
            "SELECT * FROM checkpoints WHERE id = ?",
            (checkpoint_id,)
        )

        if checkpoint and checkpoint.get('snapshot_data'):
            try:
                checkpoint['snapshot_data'] = json.loads(checkpoint['snapshot_data'])
            except (json.JSONDecodeError, ValueError):
                checkpoint['snapshot_data'] = {}

        return checkpoint

    async def list_checkpoints(self, conversation_id: str) -> List[Dict]:
        """List all checkpoints for a conversation."""
        checkpoints = await self.fetch_all_dicts(
            "SELECT * FROM checkpoints WHERE conversation_id = ? ORDER BY created_at DESC",
            (conversation_id,)
        )

        for checkpoint in checkpoints:
            if checkpoint.get('snapshot_data'):
                try:
                    checkpoint['snapshot_data'] = json.loads(checkpoint['snapshot_data'])
                except (json.JSONDecodeError, ValueError):
                    checkpoint['snapshot_data'] = {}

        return checkpoints

    # Progress operations

    async def update_progress(
        self,
        conversation_id: str,
        percent: int,
        status_message: Optional[str] = None,
        step_name: Optional[str] = None
    ) -> None:
        """Update progress for a conversation."""
        await self.execute(
            """INSERT INTO progress (conversation_id, percent, status_message, step_name, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (conversation_id) DO UPDATE SET
               percent = excluded.percent,
               status_message = excluded.status_message,
               step_name = excluded.step_name,
               updated_at = excluded.updated_at""",
            (conversation_id, percent, status_message, step_name, datetime.now().isoformat())
        )

    async def get_progress(self, conversation_id: str) -> Optional[Dict]:
        """Get progress for a conversation."""
        return await self.fetch_dict(
            "SELECT * FROM progress WHERE conversation_id = ?",
            (conversation_id,)
        )

    # Config operations

    async def set_config(self, key: str, value: Any, value_type: str = "string") -> None:
        """Set a configuration value."""
        await self.execute(
            """INSERT INTO config (key, value, type, updated_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT (key) DO UPDATE SET
               value = excluded.value,
               type = excluded.type,
               updated_at = excluded.updated_at""",
            (key, json.dumps(value) if value_type in ["json", "array"] else str(value),
             value_type, datetime.now().isoformat())
        )

    async def get_config(self, key: str) -> Optional[Any]:
        """Get a configuration value."""
        result = await self.fetch_dict(
            "SELECT * FROM config WHERE key = ?",
            (key,)
        )

        if not result:
            return None

        value = result['value']
        value_type = result['type']

        if value_type == 'json':
            return json.loads(value)
        elif value_type == 'number':
            return float(value)
        elif value_type == 'boolean':
            return value.lower() == 'true'
        return value

    async def get_all_config(self) -> Dict[str, Any]:
        """Get all configuration as a dictionary."""
        results = await self.fetch_all_dicts("SELECT * FROM config")

        config = {}
        for row in results:
            value = row['value']
            value_type = row['type']

            if value_type == 'json':
                config[row['key']] = json.loads(value)
            elif value_type == 'number':
                config[row['key']] = float(value)
            elif value_type == 'boolean':
                config[row['key']] = value.lower() == 'true'
            else:
                config[row['key']] = value

        return config


# Global database instance and lock
_db: Optional[Database] = None
_db_lock = asyncio.Lock()


async def get_database() -> Database:
    """Get or create the global database instance."""
    global _db

    async with _db_lock:
        if _db is None:
            _db = Database()
            await _db.initialize()
            # Initialize default templates
            await _db.initialize_default_templates()

    return _db
