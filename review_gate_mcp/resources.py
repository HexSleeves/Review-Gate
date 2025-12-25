"""
MCP Resources implementation for Review Gate V2.
Exposes conversation history, templates, and configuration as MCP resources.
"""
import json
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

from mcp.types import Resource, ResourceContents, TextContent

from .config import logger
from .database import get_database


class ResourceManager:
    """Manages MCP resources for conversation history, templates, and config."""

    def __init__(self):
        self._resources_cache: Optional[List[Resource]] = None
        self._cache_timestamp: float = 0
        self._cache_ttl: float = 5.0  # Cache for 5 seconds

    async def list_resources(self) -> List[Resource]:
        """List all available MCP resources."""
        # Check cache
        if time.time() - self._cache_timestamp < self._cache_ttl:
            return self._resources_cache or []

        db = await get_database()

        resources = [
            # Static resources
            Resource(
                uri="file://review-gate/conversations",
                name="conversations",
                description="List all Review Gate conversations (paginated, max 50)",
                mimeType="application/json",
                metadata={
                    "audience": ["user", "assistant"],
                    "priority": 0.5,
                    "lastModified": datetime.now().isoformat()
                }
            ),
            Resource(
                uri="file://review-gate/conversations/active",
                name="active_conversation",
                description="Get the currently active conversation",
                mimeType="application/json",
                metadata={
                    "audience": ["user", "assistant"],
                    "priority": 0.8,
                    "lastModified": datetime.now().isoformat()
                }
            ),
            Resource(
                uri="file://review-gate/templates",
                name="templates",
                description="List all available prompt templates",
                mimeType="application/json",
                metadata={
                    "audience": ["user", "assistant"],
                    "priority": 0.6,
                    "lastModified": datetime.now().isoformat()
                }
            ),
            Resource(
                uri="file://review-gate/config",
                name="config",
                description="Current Review Gate configuration",
                mimeType="application/json",
                metadata={
                    "audience": ["user"],
                    "priority": 0.4,
                    "lastModified": datetime.now().isoformat()
                }
            ),
            Resource(
                uri="file://review-gate/status",
                name="status",
                description="Review Gate server status and statistics",
                mimeType="application/json",
                metadata={
                    "audience": ["user", "assistant"],
                    "priority": 0.7,
                    "lastModified": datetime.now().isoformat()
                }
            )
        ]

        # Dynamic resources - individual conversations
        try:
            conversations = await db.list_conversations(limit=50)
            for conv in conversations:
                resources.append(Resource(
                    uri=f"file://review-gate/conversations/{conv['id']}",
                    name=f"conversation_{conv['id'][:8]}",
                    description=f"Conversation: {conv.get('title') or conv['id'][:8]}",
                    mimeType="application/json",
                    metadata={
                        "audience": ["user", "assistant"],
                        "priority": 0.5,
                        "lastModified": conv.get('updated_at', conv.get('created_at'))
                    }
                ))
        except Exception as e:
            logger.warning(f"⚠️ Could not load conversation resources: {e}")

        # Dynamic resources - templates
        try:
            templates = await db.list_templates()
            for template in templates:
                resources.append(Resource(
                    uri=f"file://review-gate/templates/{template['name']}",
                    name=f"template_{template['name']}",
                    description=template.get('description') or template['title'],
                    mimeType="application/json",
                    metadata={
                        "audience": ["user", "assistant"],
                        "priority": 0.6,
                        "category": template.get('category'),
                        "lastModified": template.get('updated_at')
                    }
                ))
        except Exception as e:
            logger.warning(f"⚠️ Could not load template resources: {e}")

        # Cache the results
        self._resources_cache = resources
        self._cache_timestamp = time.time()

        return resources

    async def read_resource(self, uri: str) -> ResourceContents:
        """Read a resource by URI and return its contents."""
        db = await get_database()

        # Parse the URI
        # Format: file://review-gate/{type}/{id}
        if not uri.startswith("file://review-gate/"):
            raise ValueError(f"Invalid Review Gate resource URI: {uri}")

        path = uri[len("file://review-gate/"):].strip('/')
        parts = path.split('/')

        resource_type = parts[0] if parts else ""
        resource_id = parts[1] if len(parts) > 1 else None

        logger.info(f"📖 Reading resource: {resource_type} (id: {resource_id})")

        # Handle different resource types
        if resource_type == "conversations":
            if resource_id == "active":
                return await self._get_active_conversation()
            elif resource_id:
                return await self._get_conversation(resource_id)
            else:
                return await self._list_conversations()

        elif resource_type == "templates":
            if resource_id:
                return await self._get_template(resource_id)
            else:
                return await self._list_templates()

        elif resource_type == "config":
            return await self._get_config()

        elif resource_type == "status":
            return await self._get_status()

        elif resource_type == "sessions":
            if resource_id:
                return await self._get_session(resource_id)
            else:
                return await self._list_sessions()

        elif resource_type == "checkpoints":
            if resource_id:
                return await self._list_checkpoints(resource_id)

        else:
            raise ValueError(f"Unknown resource type: {resource_type}")

    async def _get_active_conversation(self) -> ResourceContents:
        """Get the currently active conversation."""
        db = await get_database()

        # Try to get the most recently updated active conversation
        conversations = await db.list_conversations(limit=1, status="active")

        if not conversations:
            return TextContent(
                type="text",
                text=json.dumps({
                    "error": "No active conversation found",
                    "message": "Start a new conversation using the review_gate_chat tool"
                }, indent=2)
            )

        conv = conversations[0]
        messages = await db.get_messages(conv['id'])

        result = {
            "id": conv['id'],
            "session_uuid": conv['session_uuid'],
            "title": conv.get('title'),
            "context": conv.get('context'),
            "status": conv['status'],
            "created_at": conv['created_at'],
            "updated_at": conv['updated_at'],
            "message_count": len(messages),
            "messages": messages
        }

        return TextContent(
            type="text",
            text=json.dumps(result, indent=2)
        )

    async def _get_conversation(self, conv_id: str) -> ResourceContents:
        """Get a specific conversation by ID."""
        db = await get_database()
        conv = await db.get_conversation(conv_id)

        if not conv:
            return TextContent(
                type="text",
                text=json.dumps({
                    "error": "Conversation not found",
                    "id": conv_id
                }, indent=2)
            )

        messages = await db.get_messages(conv_id)

        result = {
            "id": conv['id'],
            "session_uuid": conv['session_uuid'],
            "title": conv.get('title'),
            "context": conv.get('context'),
            "status": conv['status'],
            "created_at": conv['created_at'],
            "updated_at": conv['updated_at'],
            "message_count": len(messages),
            "messages": messages
        }

        return TextContent(
            type="text",
            text=json.dumps(result, indent=2)
        )

    async def _list_conversations(self) -> ResourceContents:
        """List all conversations."""
        db = await get_database()
        conversations = await db.list_conversations(limit=50)

        result = {
            "count": len(conversations),
            "conversations": [
                {
                    "id": c['id'],
                    "session_uuid": c['session_uuid'],
                    "title": c.get('title'),
                    "status": c['status'],
                    "created_at": c['created_at'],
                    "updated_at": c['updated_at']
                }
                for c in conversations
            ]
        }

        return TextContent(
            type="text",
            text=json.dumps(result, indent=2)
        )

    async def _get_template(self, name: str) -> ResourceContents:
        """Get a specific template by name."""
        db = await get_database()
        template = await db.get_template(name)

        if not template:
            return TextContent(
                type="text",
                text=json.dumps({
                    "error": "Template not found",
                    "name": name
                }, indent=2)
            )

        result = {
            "name": template['name'],
            "title": template['title'],
            "description": template.get('description'),
            "category": template.get('category'),
            "prompt_template": template['prompt_template'],
            "arguments_schema": template.get('arguments_schema'),
            "created_at": template['created_at'],
            "updated_at": template['updated_at']
        }

        return TextContent(
            type="text",
            text=json.dumps(result, indent=2)
        )

    async def _list_templates(self) -> ResourceContents:
        """List all templates."""
        db = await get_database()
        templates = await db.list_templates()

        result = {
            "count": len(templates),
            "templates": [
                {
                    "name": t['name'],
                    "title": t['title'],
                    "description": t.get('description'),
                    "category": t.get('category')
                }
                for t in templates
            ]
        }

        return TextContent(
            type="text",
            text=json.dumps(result, indent=2)
        )

    async def _get_config(self) -> ResourceContents:
        """Get current configuration."""
        db = await get_database()
        config = await db.get_all_config()

        # Add default values for keys not in database
        defaults = {
            "timeout_seconds": 300,
            "storage_path": "/tmp",
            "polling_interval_ms": 250,
            "heartbeat_interval_seconds": 10,
            "session_timeout_seconds": 300,
            "max_conversation_history": 50
        }

        for key, value in defaults.items():
            if key not in config:
                config[key] = value

        result = {
            "config": config,
            "updated_at": datetime.now().isoformat()
        }

        return TextContent(
            type="text",
            text=json.dumps(result, indent=2)
        )

    async def _get_status(self) -> ResourceContents:
        """Get server status and statistics."""
        db = await get_database()

        # Get statistics
        conversations = await db.list_conversations(limit=1000)
        templates = await db.list_templates()

        active_count = sum(1 for c in conversations if c['status'] == 'active')
        completed_count = sum(1 for c in conversations if c['status'] == 'completed')

        result = {
            "status": "active",
            "version": "2.0.0",
            "timestamp": datetime.now().isoformat(),
            "statistics": {
                "total_conversations": len(conversations),
                "active_conversations": active_count,
                "completed_conversations": completed_count,
                "total_templates": len(templates)
            },
            "features": {
                "mcp_resources": True,
                "mcp_prompts": True,
                "session_management": True,
                "speech_to_text": True,
                "image_upload": True,
                "checkpoints": True,
                "progress_tracking": True
            }
        }

        return TextContent(
            type="text",
            text=json.dumps(result, indent=2)
        )

    async def _get_session(self, session_uuid: str) -> ResourceContents:
        """Get session information by UUID."""
        db = await get_database()
        session = await db.get_session(session_uuid)

        if not session:
            return TextContent(
                type="text",
                text=json.dumps({
                    "error": "Session not found",
                    "session_uuid": session_uuid
                }, indent=2)
            )

        # Get associated conversation
        conv = await db.get_conversation_by_session(session_uuid)

        result = {
            "uuid": session['uuid'],
            "status": session['status'],
            "created_at": session['created_at'],
            "updated_at": session['updated_at'],
            "expires_at": session.get('expires_at'),
            "heartbeat_at": session.get('heartbeat_at'),
            "conversation": {
                "id": conv['id'],
                "title": conv.get('title')
            } if conv else None
        }

        return TextContent(
            type="text",
            text=json.dumps(result, indent=2)
        )

    async def _list_sessions(self) -> ResourceContents:
        """List all active sessions."""
        db = await get_database()
        sessions = await db.fetch_all_dicts(
            "SELECT * FROM sessions WHERE status = ? ORDER BY created_at DESC",
            ('active',)
        )

        result = {
            "count": len(sessions),
            "sessions": [
                {
                    "uuid": s['uuid'],
                    "created_at": s['created_at'],
                    "updated_at": s['updated_at'],
                    "expires_at": s.get('expires_at'),
                    "heartbeat_at": s.get('heartbeat_at')
                }
                for s in sessions
            ]
        }

        return TextContent(
            type="text",
            text=json.dumps(result, indent=2)
        )

    async def _list_checkpoints(self, conversation_id: str) -> ResourceContents:
        """List checkpoints for a conversation."""
        db = await get_database()
        checkpoints = await db.list_checkpoints(conversation_id)

        result = {
            "conversation_id": conversation_id,
            "count": len(checkpoints),
            "checkpoints": [
                {
                    "id": c['id'],
                    "name": c['name'],
                    "created_at": c['created_at']
                }
                for c in checkpoints
            ]
        }

        return TextContent(
            type="text",
            text=json.dumps(result, indent=2)
        )

    def invalidate_cache(self) -> None:
        """Invalidate the resources cache."""
        self._cache_timestamp = 0


# Global resource manager instance
_resource_manager: Optional[ResourceManager] = None


def get_resource_manager() -> ResourceManager:
    """Get or create the global resource manager instance."""
    global _resource_manager
    if _resource_manager is None:
        _resource_manager = ResourceManager()
    return _resource_manager
