# Review Gate MCP Server - Enhancement Plan

## Requirements

### Functional Requirements

1. **Add MCP Resources Support**: Expose conversation history, review templates, and configuration as MCP resources
2. **Add MCP Prompts Support**: Provide pre-built prompt templates for common review scenarios
3. **Enhanced Agent Integration**: Add tools for agent state management, progress tracking, and task orchestration
4. **Conversation Persistence**: Store and retrieve review history across sessions
5. **Multi-Agent Coordination**: Support multiple concurrent agents with separate review contexts
6. **Real-time Status Updates**: Provide agent feedback during long-running operations
7. **Enhanced Error Handling**: Graceful degradation when MCP server is unavailable
8. **Configuration UI**: Allow users to customize Review Gate behavior without editing files

### Non-Functional Requirements

- **Performance**: Sub-100ms response time for tool calls, <5s for resource retrieval
- **Reliability**: Handle network failures, extension crashes, and MCP server restarts gracefully
- **Security**: Validate all inputs, sanitize user data, prevent injection attacks
- **Cross-platform**: Maintain support for macOS, Linux, and Windows
- **Backward Compatibility**: Existing installations should continue to work without migration

### Constraints

- Must maintain compatibility with Cursor IDE's MCP implementation
- Must work within Cursor's extension sandbox limitations
- Cannot add native dependencies beyond existing Python/Node.js requirements

### Success Criteria

- Agents can access review history through MCP resources
- Users can invoke pre-built review prompts via slash commands
- Multiple agents can operate independently with separate contexts
- Zero data loss when MCP server restarts during active review
- All existing functionality continues to work unchanged

## Dependencies

### Existing Code/Systems Affected

- `review_gate_mcp/server.py` - Core MCP server implementation
- `review_gate_mcp/ipc.py` - File-based IPC layer
- `cursor-extension/src/webview.js` - Popup UI
- `cursor-extension/src/ipc.js` - File watcher and trigger handler
- `ReviewGateV2.mdc` - Cursor agent rules

### External Services/APIs

- None currently - all communication is local file-based IPC

### Database Changes Needed

- Add SQLite database for conversation persistence (`review_gate.db`)
- Tables: `conversations`, `messages`, `attachments`, `agent_states`
- Schema migrations will be needed for future updates

### Configuration Changes

- Add `config.yaml` for user-customizable settings:
  - Timeout values
  - Storage location
  - Speech-to-text engine selection
  - Default prompts and templates

## Risks & Mitigation

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| File-based IPC race conditions | High | Medium | Add file locking, implement retry logic with exponential backoff |
| SQLite database corruption | High | Low | Use WAL mode, implement backup/restore, add integrity checks |
| MCP protocol breaking changes | Medium | Low | Pin to specific MCP version, implement version detection |
| Extension memory leak from conversation history | Medium | Medium | Implement pagination, add cleanup on extension dispose |
| Speech-to-text service unavailability | Low | Medium | Graceful fallback to text-only, clear error messaging |
| Cursor extension sandbox limitations | Medium | Low | Research limitations early, implement feature detection |
| Multi-agent context confusion | High | Medium | Use unique agent IDs, implement context isolation per agent |

## Implementation Stages

### Stage 1: MCP Resources Implementation

**Goal**: Enable agents to access review history and configuration as MCP resources

**Tasks**:
1. Add `resources` capability to server initialization
2. Implement `resources/list` handler to expose:
   - Conversation history resources
   - Review templates
   - Configuration resources
3. Implement `resources/read` handler for:
   - Individual conversations (by URI)
   - Review templates
   - Current configuration
4. Add `resources/subscribe` support for real-time updates
5. Create SQLite database schema for persistence
6. Implement conversation storage in `_handle_review_gate_chat`
7. Add resource URI templates for dynamic access
8. Write unit tests for resource handlers

**Done when**:
- Cursor can enumerate Review Gate resources
- Agent can read conversation history via `resources/read`
- Subscribed clients receive update notifications
- All tests pass

---

### Stage 2: MCP Prompts Implementation

**Goal**: Provide pre-built prompt templates for common review scenarios

**Tasks**:
1. Add `prompts` capability to server initialization
2. Implement `prompts/list` handler to expose:
   - `code_review` - Comprehensive code review prompt
   - `security_review` - Security-focused review prompt
   - `performance_review` - Performance optimization review
   - `documentation_check` - Documentation completeness check
   - `testing_review` - Test coverage and quality review
3. Implement `prompts/get` handler with argument support:
   - `file_path` - Specific file to review
   - `focus_areas` - Array of areas to focus on
   - `severity_level` - Minimum severity to report
4. Create prompt template system with variable substitution
5. Store templates in database for user customization
6. Add `list_changed` notification support
7. Write unit tests for prompt handlers

**Done when**:
- Prompts appear as slash commands in Cursor
- Each prompt returns properly formatted messages
- Arguments are correctly validated and substituted
- All tests pass

---

### Stage 3: Session Management

**Goal**: Support UUID-based session management with isolated conversation contexts

**Tasks**:
1. Create `SessionManager` class to manage session state:
   - Generate UUID on first tool call per conversation
   - Store session in database with created_at timestamp
   - Implement session timeout (5 minutes inactivity)
2. Implement session lifecycle:
   - Session creation on first tool call (auto-generate UUID)
   - Session heartbeat via extension heartbeat file
   - Session cleanup on timeout or completion
3. Add `session_uuid` parameter to all tool calls (optional, auto-generated if missing)
4. Implement heartbeat monitoring:
   - Server reads heartbeat file every 5 seconds
   - Mark sessions as stale after 30 seconds without heartbeat
   - Cleanup stale sessions after 1 hour
5. Update file naming to use session UUID:
   - `review_gate_trigger_{session_uuid}.json`
   - `review_gate_response_{session_uuid}.json`
6. Add session status endpoint for webview
7. Write tests for session management

**Done when**:
- Sessions are automatically created on first tool call
- Sessions properly timeout and cleanup
- Heartbeat detection works for extension disconnect
- All tests pass

**Note**: Since Cursor MCP doesn't provide agent identity, we use UUID-based sessions that are implicitly per-conversation. This simplifies the design while maintaining isolation.

---

### Stage 4: Enhanced Agent Tools

**Goal**: Add tools for agent state management and progress tracking

**Tasks**:
1. Implement `review_gate_update_progress` tool:
   - Parameters: `progress_percent`, `status_message`, `step_name`
   - Updates popup with progress bar
   - Stores progress in database
2. Implement `review_gate_get_context` tool:
   - Returns current conversation context
   - Includes previous feedback and decisions
3. Implement `review_gate_set_checkpoint` tool:
   - Saves named checkpoint for rollback
   - Useful for iterative development
4. Implement `review_gate_list_checkpoints` tool
5. Add progress visualization to webview:
   - Progress bar component
   - Step-by-step indicator
   - Current status message
6. Add checkpoint restore capability
7. Write unit and integration tests

**Done when**:
- Agents can report progress visible to users
- Checkpoints can be created and restored
- Context tool returns accurate history
- All tests pass

---

### Stage 5: Configuration UI and User Customization

**Goal**: Allow users to customize Review Gate without editing files

**Tasks**:
1. Create `config.yaml` structure with:
   - Timeout settings
   - Storage paths
   - Speech-to-text configuration
   - Default prompts
   - UI preferences
2. Implement configuration loading/saving
3. Add `review_gate_get_config` tool
4. Add `review_gate_update_config` tool
5. Create settings UI in webview:
   - Tab-based settings panel
   - Form validation
   - Live preview of changes
6. Add configuration import/export
7. Implement configuration versioning for migrations
8. Write tests for configuration handling

**Done when**:
- Users can change settings via UI
- Configuration persists across sessions
- Invalid values are rejected with helpful messages
- All tests pass

---

## Architecture Overview

### Current Architecture

```
┌─────────────────┐    file-based IPC    ┌──────────────────┐
│   MCP Server    │ ◄─────────────────► │ Cursor Extension │
│  (Python)       │                      │   (Node.js)      │
└─────────────────┘                      └──────────────────┘
        │                                           │
        │ Tools                                     │ Webview
        ▼                                           ▼
┌─────────────────┐                      ┌──────────────────┐
│  review_gate_   │                      │   Review Gate    │
│    chat tool    │                      │     Popup UI     │
└─────────────────┘                      └──────────────────┘
```

### Proposed Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Review Gate V3                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐       │
│  │   Tools      │   │  Resources   │   │   Prompts    │       │
│  │              │   │              │   │              │       │
│  │ • chat       │   │ • history    │   │ • code_rev   │       │
│  │ • progress   │   │ • templates  │   │ • sec_rev    │       │
│  │ • session    │   │ • config     │   │ • perf_rev   │       │
│  │ • checkpoint │   │ • state      │   │ • doc_check  │       │
│  └──────┬───────┘   └──────┬───────┘   └──────┬───────┘       │
│         │                  │                  │                │
│         └──────────────────┼──────────────────┘                │
│                            │                                   │
│                  ┌─────────▼─────────┐                         │
│                  │  Core Server      │                         │
│                  │                   │                         │
│                  │  • Agent Sessions │                         │
│                  │  • IPC Manager    │                         │
│                  │  • Speech Handler │                         │
│                  └─────────┬─────────┘                         │
│                            │                                   │
│                            ▼                                   │
│                  ┌─────────────────┐                           │
│                  │  SQLite Store   │                           │
│                  │                 │                           │
│                  │  • conversations│                           │
│                  │  • messages     │                           │
│                  │  • templates    │                           │
│                  │  • config       │                           │
│                  └─────────────────┘                           │
│                                                            │
└────────────────────────────────────────────────────────────┘
                            │ file-based IPC
                            ▼
┌────────────────────────────────────────────────────────────┐
│                    Cursor Extension                         │
├────────────────────────────────────────────────────────────┤
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐  │
│  │ IPC Watcher  │   │ State Manager│   │ Config UI    │  │
│  └──────┬───────┘   └──────┬───────┘   └──────┬───────┘  │
│         │                  │                  │           │
│         └──────────────────┼──────────────────┘           │
│                            │                              │
│                            ▼                              │
│                  ┌─────────────────┐                      │
│                  │   Webview Panel │                      │
│                  │                 │                      │
│                  │  • Chat UI      │                      │
│                  │  • Progress Bar │                      │
│                  │  • Settings Tab │                      │
│                  │  • Session View │                      │
│                  └─────────────────┘                      │
└────────────────────────────────────────────────────────────┘
```

### New File Structure

```
review_gate_mcp/
├── __init__.py
├── server.py              # Main MCP server (enhanced)
├── ipc.py                 # IPC manager (enhanced)
├── speech.py              # Speech handler (existing)
├── config.py              # Configuration (enhanced)
├── main.py                # Entry point (existing)
├── database.py            # NEW: SQLite database layer with aiosqlite
├── resources.py           # NEW: MCP resources handlers
├── prompts.py             # NEW: MCP prompts handlers
├── sessions.py            # NEW: Session management (UUID-based)
├── templates.py           # NEW: Prompt templates
├── validators.py          # NEW: Input validation & sanitization
└── migrations/            # NEW: Database migrations
    ├── runner.py          # Migration execution engine
    ├── 001_initial_schema.sql
    ├── 002_add_sessions.sql
    ├── 003_add_checkpoints.sql
    └── _versions/         # Applied migration tracking

cursor-extension/src/
├── extension.js           # Extension entry (enhanced)
├── webview.js             # Webview panel (enhanced)
├── ipc.js                 # IPC watcher (enhanced with heartbeat)
├── audio.js               # Audio handler (existing)
├── state.js               # State manager (enhanced)
├── utils.js               # Utilities (existing)
├── logger.js              # Logging (existing)
├── heartbeat.js           # NEW: Heartbeat writer to server
├── config-ui.js           # NEW: Settings UI
├── progress-ui.js         # NEW: Progress visualization
└── sessions-ui.js         # NEW: Session management UI
```

## Database Schema

```sql
-- Schema migrations tracking table
CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL,
    description TEXT
);

-- Conversations table (simplified - no agent_id since Cursor doesn't provide it)
CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    session_uuid TEXT NOT NULL UNIQUE,  -- UUID generated per conversation
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    status TEXT NOT NULL,  -- 'active', 'completed', 'timeout', 'stale'
    title TEXT,
    context TEXT
);

-- Messages table
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,  -- 'user' or 'assistant'
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    attachments TEXT,  -- JSON array (validated: max 10MB each)
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

-- Templates table
CREATE TABLE templates (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT,
    prompt_template TEXT NOT NULL,
    arguments_schema TEXT,  -- JSON schema
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Checkpoints table
CREATE TABLE checkpoints (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    name TEXT NOT NULL,
    snapshot_data TEXT NOT NULL,  -- JSON
    created_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

-- Config table
CREATE TABLE config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    type TEXT NOT NULL,  -- 'string', 'number', 'boolean', 'json'
    updated_at TEXT NOT NULL
);

-- Progress tracking table
CREATE TABLE progress (
    conversation_id TEXT PRIMARY KEY,
    percent INTEGER NOT NULL DEFAULT 0,
    status_message TEXT,
    step_name TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

-- Indexes for performance
CREATE INDEX idx_messages_conversation ON messages(conversation_id);
CREATE INDEX idx_messages_timestamp ON messages(timestamp DESC);  -- Latest first
CREATE INDEX idx_conversations_session ON conversations(session_uuid);
CREATE INDEX idx_conversations_status ON conversations(status);
CREATE INDEX idx_checkpoints_conversation ON checkpoints(conversation_id);
```

## MCP Resources Specification

### Resource URIs (MCP-Compliant)

Note: Using standard `file://` scheme with virtual paths per MCP specification.

| URI Pattern | Description | Returns |
|-------------|-------------|---------|
| `file://review-gate/conversations` | List all conversations | JSON array of conversation metadata (paginated, max 50) |
| `file://review-gate/conversations/{id}` | Get specific conversation | Full conversation with messages |
| `file://review-gate/conversations/active` | Get active conversation | Current active conversation |
| `file://review-gate/sessions/{uuid}` | Get session by UUID | Session details with status |
| `file://review-gate/templates` | List all templates | JSON array of templates |
| `file://review-gate/templates/{name}` | Get specific template | Template details |
| `file://review-gate/config` | Current configuration | Config as JSON |
| `file://review-gate/checkpoints/{conversation_id}` | List checkpoints | Checkpoint list for conversation |

### Resource Annotations

- `audience`: `["user", "assistant"]` for most resources
- `priority`: 0.8 for active conversation, 0.5 for history
- `lastModified`: ISO timestamp from database (for cache invalidation)

## MCP Prompts Specification

### Built-in Prompts

#### 1. `code_review`
Reviews code for quality, maintainability, and best practices.

**Arguments**:
- `file_path` (optional): Specific file to review
- `focus_areas` (optional): Array of areas (e.g., ["security", "performance"])
- `severity_level` (optional): "error", "warning", or "info"

#### 2. `security_review`
Security-focused code review.

**Arguments**:
- `file_path` (optional): Specific file to review
- `threat_model` (optional): Include threat modeling analysis

#### 3. `performance_review`
Performance optimization review.

**Arguments**:
- `file_path` (optional): Specific file to review
- `profile_data` (optional): Include performance profiling

#### 4. `documentation_check`
Documentation completeness check.

**Arguments**:
- `file_path` (optional): Specific file to check
- `standards` (optional): Documentation standard to follow

#### 5. `testing_review`
Test coverage and quality review.

**Arguments**:
- `file_path` (optional): Specific file to review
- `coverage_threshold` (optional): Minimum coverage percentage

## API Design

### New Tools

#### `review_gate_update_progress`
```python
{
    "name": "review_gate_update_progress",
    "description": "Update progress indicator in Review Gate popup",
    "inputSchema": {
        "type": "object",
        "properties": {
            "progress_percent": {
                "type": "number",
                "minimum": 0,
                "maximum": 100,
                "description": "Progress percentage (0-100)"
            },
            "status_message": {
                "type": "string",
                "description": "Current status message to display"
            },
            "step_name": {
                "type": "string",
                "description": "Name of current step"
            }
        }
    }
}
```

#### `review_gate_create_checkpoint`
```python
{
    "name": "review_gate_create_checkpoint",
    "description": "Create a named checkpoint for potential rollback",
    "inputSchema": {
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": "Checkpoint name"
            },
            "description": {
                "type": "string",
                "description": "Checkpoint description"
            }
        },
        "required": ["name"]
    }
}
```

#### `review_gate_restore_checkpoint`
```python
{
    "name": "review_gate_restore_checkpoint",
    "description": "Restore a previously created checkpoint",
    "inputSchema": {
        "type": "object",
        "properties": {
            "checkpoint_id": {
                "type": "string",
                "description": "Checkpoint ID to restore"
            }
        },
        "required": ["checkpoint_id"]
    }
}
```

## Testing Strategy

### Unit Tests
- Each MCP handler (tools, resources, prompts)
- Database operations
- Session management
- Template rendering

### Integration Tests
- End-to-end tool call flows
- Multi-agent scenarios
- Resource subscription notifications
- Prompt argument substitution

### Manual Tests
- Cursor extension integration
- Popup UI rendering
- Configuration changes
- Error recovery

## Review Findings

The following issues were identified during plan review and have been addressed:

### Critical Issues (Must Address Before Implementation)

#### 1. Agent ID Source Clarification
**Issue**: Original plan had no clear source for `agent_id` - Cursor MCP doesn't provide agent identity.
**Resolution**:
- Use UUID-based session identifiers instead of agent tracking
- Generate session ID on first tool call from a conversation
- Track sessions by conversation UUID, not agent identity
- Sessions are implicitly per-conversation since Cursor agents operate in single-threaded conversation context

#### 2. SQLite WAL Mode Network Filesystem Incompatibility
**Issue**: WAL mode fails on network filesystems (NFS, SMB).
**Resolution**:
- Detect filesystem type at initialization
- Use WAL mode only on local filesystems
- Fall back to journal mode on network filesystems
- Add filesystem detection utility in `database.py`

#### 3. Custom URI Scheme Non-Compliance
**Issue**: Custom `review-gate://` scheme conflicts with MCP spec recommendation to use standard schemes.
**Resolution**:
- Use `file://` scheme with custom path structure for resources
- Format: `file://review-gate/conversations/{id}`
- Format: `file://review-gate/templates/{name}`
- Maintain compatibility with MCP client expectations

#### 4. Missing Migration Runner
**Issue**: Plan included migration files but no mechanism to run them.
**Resolution**:
- Add migration runner in Stage 1 tasks
- Implement automatic migration on server startup
- Track applied migrations in `schema_migrations` table
- Support both forward and rollback migrations

#### 5. IPC Disconnect Detection
**Issue**: No mechanism to detect when Cursor extension disconnects.
**Resolution**:
- Implement heartbeat file from extension to server
- Server monitors heartbeat file with 30-second timeout
- Missing heartbeat triggers session cleanup
- Extension writes heartbeat every 10 seconds

### Missing Considerations (Now Addressed)

#### 6. Database Connection Pooling
**Added**:
- Use `aiosqlite` for async database operations
- Single connection with async queue is sufficient for single-threaded MCP server
- Connection retry logic with exponential backoff

#### 7. SQL Injection Prevention
**Added**:
- All database operations MUST use parameterized queries
- ORM-like wrapper for common operations to prevent raw SQL
- Input validation layer for all user-provided data

#### 8. Rollback Strategy
**Added**:
- Database transaction wrapper for multi-step operations
- Automatic rollback on exceptions
- Migration rollback support

#### 9. Memory Leak Prevention
**Added**:
- Conversation history pagination (max 50 messages per page)
- Automatic cleanup of completed sessions after 1 hour
- Attachment size limits (max 10MB per attachment)

#### 10. MCP Version Pinning
**Added**:
- Pin `mcp` package to specific version in requirements.txt
- Version compatibility check on server startup
- Graceful degradation if MCP protocol version mismatch

### Updated Architecture Decisions

#### Session Management (Simplified)
```
Original: Track by agent_id (unavailable)
Revised: Track by session_uuid generated per conversation

Flow:
1. First tool call → Generate new session_uuid
2. Store session in database with created_at timestamp
3. All subsequent tool calls include session_uuid in arguments
4. Session expires after 5 minutes of inactivity
```

#### Database Layer (Enhanced)
```python
# New: database.py with migration support
class Database:
    def __init__(self, path: str):
        self.path = path
        self.fs_type = self._detect_filesystem_type()
        self._use_wal = (self.fs_type == "local")

    async def initialize(self):
        # Run pending migrations
        await self._run_migrations()

    async def execute(self, query: str, params: tuple = ()):
        # Parameterized queries only
        async with aiosqlite.connect(self.path) as db:
            await db.execute(query, params)
            await db.commit()
```

#### Resource URIs (Corrected)
```
Original (non-compliant): review-gate://conversations/{id}
Revised (MCP compliant): file://review-gate/conversations/{id}

Implementation detail:
- Use a virtual "review-gate" directory in the URI path
- Server handles these as virtual resources, not actual files
- Maintains clarity while following MCP spec
```

### Additional Implementation Details Added

#### Migration System
```
migrations/
├── runner.py              # Migration execution engine
├── 001_initial_schema.sql
├── 002_add_sessions.sql
├── 003_add_checkpoints.sql
└── _versions/             # Tracking applied migrations
```

#### Heartbeat Protocol
```
Extension → Server: Write to review_gate_heartbeat.json every 10s
Server: Monitor heartbeat file every 5s
Timeout: 30s without update → Mark sessions as stale
```

### Updated Stage 1 Tasks

Modified to include:
- Migration runner implementation
- Filesystem detection for WAL mode decision
- Heartbeat monitoring for disconnect detection
- Parameterized query enforcement
- Virtual file:// URI scheme implementation

## Sources

- [Model Context Protocol Specification](https://modelcontextprotocol.io/specification/2025-11-25)
- [MCP Resources Documentation](https://modelcontextprotocol.io/specification/2025-06-18/server/resources)
- [MCP Prompts Documentation](https://modelcontextprotocol.io/specification/2025-06-18/server/prompts)
- [Cursor MCP Documentation](https://cursor.com/docs/context/mcp)
- [Cursor Rules Documentation](https://cursor.com/docs/context/rules)
- [MCP Complete Guide 2025](https://www.levo.ai/resources/blogs/model-context-protocol-mcp-server-the-complete-guide)
