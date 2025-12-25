import asyncio
import json
import time
import uuid
from datetime import datetime
from typing import Optional, List

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import (
    Tool,
    TextContent,
    ImageContent,
    CallToolRequest,
    Resource,
    Prompt,
)

from .config import logger
from .database import get_database
from .ipc import IPCManager
from .resources import get_resource_manager
from .speech import SpeechHandler
from .prompts import get_prompt_manager

class ReviewGateServer:
    def __init__(self):
        self.server = Server("review-gate-v2")
        self.ipc = IPCManager()
        self.shutdown_requested = False
        self.shutdown_reason = ""
        self._last_attachments = []
        self._db = None
        self._sessions: dict = {}  # Track active sessions

        # Initialize speech handler
        # We pass a lambda to check for shutdown status
        self.speech_handler = SpeechHandler(shutdown_event=lambda: self.shutdown_requested)
        self.speech_handler.start_monitoring()

        self.setup_handlers()

        logger.info("🚀 Review Gate 2.0 server initialized for Cursor integration")

    def setup_handlers(self):
        """Set up MCP request handlers"""
        
        @self.server.list_tools()
        async def list_tools() -> List[Tool]:
            """List available Review Gate tools for Cursor Agent"""
            logger.info("🔧 Cursor Agent requesting available tools")
            tools = [
                Tool(
                    name="review_gate_chat",
                    description="Open Review Gate chat popup in Cursor for feedback and reviews. Use this when you need user input, feedback, or review from the human user. The popup will appear in Cursor and wait for user response for up to 5 minutes.",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "message": {
                                "type": "string",
                                "description": "The message to display in the Review Gate popup - this is what the user will see",
                                "default": "Please provide your review or feedback:"
                            },
                            "title": {
                                "type": "string",
                                "description": "Title for the Review Gate popup window",
                                "default": "Review Gate V2 - ゲート"
                            },
                            "context": {
                                "type": "string",
                                "description": "Additional context about what needs review (code, implementation, etc.)",
                                "default": ""
                            },
                            "urgent": {
                                "type": "boolean",
                                "description": "Whether this is an urgent review request",
                                "default": False
                            },
                            "session_uuid": {
                                "type": "string",
                                "description": "Session UUID for continuing an existing conversation (optional, auto-generated if not provided)"
                            }
                        }
                    }
                ),
                Tool(
                    name="review_gate_update_progress",
                    description="Update progress indicator in the Review Gate popup. Shows a progress bar and status message to the user.",
                    inputSchema={
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
                            },
                            "session_uuid": {
                                "type": "string",
                                "description": "Session UUID for the conversation"
                            }
                        },
                        "required": ["progress_percent", "session_uuid"]
                    }
                ),
                Tool(
                    name="review_gate_get_context",
                    description="Get current conversation context including previous messages and feedback. Useful for understanding what has been discussed.",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "session_uuid": {
                                "type": "string",
                                "description": "Session UUID for the conversation",
                                "default": ""
                            }
                        }
                    }
                ),
                Tool(
                    name="review_gate_create_checkpoint",
                    description="Create a named checkpoint for potential rollback. Saves the current state for later restoration.",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "name": {
                                "type": "string",
                                "description": "Checkpoint name"
                            },
                            "description": {
                                "type": "string",
                                "description": "Checkpoint description"
                            },
                            "session_uuid": {
                                "type": "string",
                                "description": "Session UUID for the conversation"
                            }
                        },
                        "required": ["name", "session_uuid"]
                    }
                ),
                Tool(
                    name="review_gate_list_checkpoints",
                    description="List all checkpoints for the current conversation.",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "session_uuid": {
                                "type": "string",
                                "description": "Session UUID for the conversation"
                            }
                        },
                        "required": ["session_uuid"]
                    }
                ),
                Tool(
                    name="review_gate_get_status",
                    description="Get Review Gate server status and statistics including active conversations and available features.",
                    inputSchema={
                        "type": "object",
                        "properties": {}
                    }
                )
            ]
            logger.info(f"✅ Listed {len(tools)} Review Gate tools for Cursor Agent")
            return tools

        @self.server.list_resources()
        async def list_resources() -> List[Resource]:
            """List available Review Gate resources for Cursor Agent"""
            logger.info("📚 Cursor Agent requesting available resources")
            resource_manager = get_resource_manager()
            resources = await resource_manager.list_resources()
            logger.info(f"✅ Listed {len(resources)} Review Gate resources")
            return resources

        @self.server.read_resource()
        async def read_resource(uri: str) -> TextContent:
            """Read a Review Gate resource by URI"""
            logger.info(f"📖 Reading resource: {uri}")
            resource_manager = get_resource_manager()
            try:
                content = await resource_manager.read_resource(uri)
                logger.info(f"✅ Resource read successfully: {uri}")
                return content
            except ValueError as e:
                logger.error(f"❌ Resource read error for {uri}: {e}")
                return TextContent(type="text", text=f"ERROR: {e}")
            except Exception as e:
                logger.error(f"❌ Unexpected error reading resource {uri}: {e}")
                return TextContent(type="text", text=f"ERROR: Failed to read resource")

        @self.server.list_prompts()
        async def list_prompts() -> List[Prompt]:
            """List available Review Gate prompts for Cursor Agent"""
            logger.info("📝 Cursor Agent requesting available prompts")
            prompt_manager = get_prompt_manager()
            prompts = await prompt_manager.list_prompts()
            logger.info(f"✅ Listed {len(prompts)} Review Gate prompts")
            return prompts

        @self.server.get_prompt()
        async def get_prompt(name: str, arguments: dict) -> List[TextContent]:
            """Get a Review Gate prompt by name with arguments"""
            logger.info(f"📝 Getting prompt: {name} with args: {arguments}")
            prompt_manager = get_prompt_manager()
            try:
                messages = await prompt_manager.get_prompt(name, arguments)
                # Convert PromptMessage to TextContent
                result = []
                for msg in messages:
                    if hasattr(msg, 'content'):
                        if hasattr(msg.content, 'text'):
                            result.append(TextContent(type="text", text=msg.content.text))
                        else:
                            result.append(TextContent(type="text", text=str(msg.content)))
                    else:
                        result.append(TextContent(type="text", text=str(msg)))
                logger.info(f"✅ Prompt retrieved successfully: {name}")
                return result
            except ValueError as e:
                logger.error(f"❌ Prompt error for {name}: {e}")
                return [TextContent(type="text", text=f"ERROR: {e}")]
            except Exception as e:
                logger.error(f"❌ Unexpected error getting prompt {name}: {e}")
                return [TextContent(type="text", text=f"ERROR: Failed to get prompt")]

        @self.server.call_tool()
        async def call_tool(name: str, arguments: dict) -> List[TextContent]:
            """Handle tool calls from Cursor Agent with immediate activation"""
            logger.info(f"🎯 CURSOR AGENT CALLED TOOL: {name}")
            logger.info(f"📋 Tool arguments: {arguments}")

            # Add processing delay to ensure proper handling
            await asyncio.sleep(0.5)  # Wait 500ms for proper processing
            logger.info(f"⚙️ Processing tool call: {name}")

            # Immediately log that we're processing
            for handler in logger.handlers:
                if hasattr(handler, 'flush'):
                    handler.flush()

            try:
                if name == "review_gate_chat":
                    return await self._handle_review_gate_chat(arguments)
                elif name == "review_gate_update_progress":
                    return await self._handle_update_progress(arguments)
                elif name == "review_gate_get_context":
                    return await self._handle_get_context(arguments)
                elif name == "review_gate_create_checkpoint":
                    return await self._handle_create_checkpoint(arguments)
                elif name == "review_gate_list_checkpoints":
                    return await self._handle_list_checkpoints(arguments)
                elif name == "review_gate_get_status":
                    return await self._handle_get_status(arguments)
                else:
                    logger.error(f"❌ Unknown tool: {name}")
                    await asyncio.sleep(1.0)
                    raise ValueError(f"Unknown tool: {name}")
            except Exception as e:
                logger.error(f"💥 Tool call error for {name}: {e}")
                await asyncio.sleep(1.0)
                return [TextContent(type="text", text=f"ERROR: Tool {name} failed: {str(e)}")]

    async def _handle_review_gate_chat(self, args: dict) -> List[TextContent]:
        """Handle Review Gate chat popup and wait for user input with 5 minute timeout"""
        message = args.get("message", "Please provide your review or feedback:")
        title = args.get("title", "Review Gate V2 - ゲート")
        context = args.get("context", "")
        urgent = args.get("urgent", False)
        session_uuid = args.get("session_uuid", "")

        logger.info(f"💬 ACTIVATING Review Gate chat popup IMMEDIATELY for Cursor Agent")

        # Get or create session
        if not session_uuid:
            session_uuid = await self._get_or_create_session()
            logger.info(f"🔑 Using session: {session_uuid}")
        else:
            await self._update_session_heartbeat(session_uuid)

        # Get or create conversation for this session
        conversation_id = await self._get_or_create_conversation(session_uuid, title, context)
        logger.info(f"💾 Conversation ID: {conversation_id}")

        # Store assistant message in database
        if self._db:
            try:
                await self._db.add_message(
                    conversation_id=conversation_id,
                    role="assistant",
                    content=message
                )
                logger.info("💾 Assistant message stored in database")
            except Exception as e:
                logger.warning(f"⚠️ Could not store message: {e}")

        # Create trigger file for Cursor extension IMMEDIATELY
        trigger_id = f"review_{int(time.time() * 1000)}"

        data = {
            "tool": "review_gate_chat",
            "message": message,
            "title": title,
            "context": context,
            "urgent": urgent,
            "trigger_id": trigger_id,
            "session_uuid": session_uuid,
            "conversation_id": conversation_id,
            "timestamp": datetime.now().isoformat(),
            "immediate_activation": True
        }

        success = await self.ipc.trigger_cursor_popup_immediately(data)

        if success:
            logger.info(f"🔥 POPUP TRIGGERED IMMEDIATELY - waiting for user input (trigger_id: {trigger_id})")

            # Wait for extension acknowledgement first
            ack_received = await self.ipc.wait_for_extension_acknowledgement(trigger_id, timeout=30)
            if ack_received:
                logger.info("📨 Extension acknowledged popup activation")
            else:
                logger.warning("⚠️ No extension acknowledgement received - popup may not have opened")

            # Wait for user input from the popup with 5 MINUTE timeout
            logger.info("⏳ Waiting for user input for up to 5 minutes...")
            result = await self.ipc.wait_for_user_input(trigger_id, timeout=300)

            if result:
                user_input, attachments = result
                # Return user input directly to MCP client
                logger.info(f"✅ RETURNING USER REVIEW TO MCP CLIENT: {user_input[:100]}...")

                # Store user message in database
                if self._db:
                    try:
                        await self._db.add_message(
                            conversation_id=conversation_id,
                            role="user",
                            content=user_input,
                            attachments=attachments
                        )
                        logger.info("💾 User message stored in database")
                    except Exception as e:
                        logger.warning(f"⚠️ Could not store user message: {e}")

                response_content = [
                    TextContent(type="text", text=f"User Response: {user_input}"),
                    TextContent(type="text", text=f"Session: {session_uuid}")
                ]

                # If we have stored attachment data, include images
                if attachments:
                    for attachment in attachments:
                        if attachment.get('mimeType', '').startswith('image/'):
                            try:
                                image_content = ImageContent(
                                    type="image",
                                    data=attachment['base64Data'],
                                    mimeType=attachment['mimeType']
                                )
                                response_content.append(image_content)
                                logger.info(f"📸 Added image to response: {attachment.get('fileName', 'unknown')}")
                            except Exception as e:
                                logger.error(f"❌ Error adding image to response: {e}")

                return response_content
            else:
                # Update conversation status to timeout
                if self._db and conversation_id:
                    await self._db.update_conversation_status(conversation_id, "timeout")

                response = f"TIMEOUT: No user input received for review gate within 5 minutes"
                logger.warning("⚠️ Review Gate timed out waiting for user input after 5 minutes")
                return [TextContent(type="text", text=response)]
        else:
            response = f"ERROR: Failed to trigger Review Gate popup"
            logger.error("❌ Failed to trigger Review Gate popup")
            return [TextContent(type="text", text=response)]

    async def _get_or_create_session(self) -> str:
        """Get existing session or create a new one."""
        # For simplicity, create a new session for each conversation
        # In production, you might want to reuse sessions within a time window
        if self._db:
            try:
                session_uuid = await self._db.create_session()
                self._sessions[session_uuid] = {"created_at": time.time()}
                return session_uuid
            except Exception as e:
                logger.warning(f"⚠️ Could not create session in database: {e}")

        # Fallback to in-memory session
        import uuid
        session_uuid = str(uuid.uuid4())
        self._sessions[session_uuid] = {"created_at": time.time()}
        return session_uuid

    async def _update_session_heartbeat(self, session_uuid: str) -> None:
        """Update session heartbeat timestamp."""
        if session_uuid in self._sessions:
            self._sessions[session_uuid]["heartbeat_at"] = time.time()

        if self._db:
            try:
                await self._db.update_session_heartbeat(session_uuid)
            except Exception as e:
                logger.warning(f"⚠️ Could not update session heartbeat: {e}")

    async def _get_or_create_conversation(
        self,
        session_uuid: str,
        title: str,
        context: str
    ) -> str:
        """Get existing conversation for session or create a new one."""
        if not self._db:
            # Fallback: generate a fake conversation ID
            import uuid
            return str(uuid.uuid4())

        try:
            # Check for existing active conversation
            conv = await self._db.get_conversation_by_session(session_uuid)
            if conv:
                return conv['id']

            # Create new conversation
            conv_id = await self._db.create_conversation(
                session_uuid=session_uuid,
                title=title,
                context=context
            )
            return conv_id
        except Exception as e:
            logger.warning(f"⚠️ Could not get/create conversation: {e}")
            import uuid
            return str(uuid.uuid4())

    async def _handle_update_progress(self, args: dict) -> List[TextContent]:
        """Handle progress update requests."""
        progress_percent = args.get("progress_percent", 0)
        status_message = args.get("status_message", "Processing...")
        step_name = args.get("step_name", "Working...")
        session_uuid = args.get("session_uuid", "")

        logger.info(f"📊 Progress update: {progress_percent}% - {step_name}")

        # Determine status based on percentage
        status = "completed" if progress_percent >= 100 else "active"

        # Send progress update to webview via IPC
        try:
            await self.ipc.send_progress_update(
                title=status_message,
                percentage=float(progress_percent),
                step=step_name,
                status=status
            )
            logger.debug("✅ Progress sent to webview")
        except Exception as e:
            logger.warning(f"⚠️ Could not send progress to webview: {e}")

        # Also save to database if session is provided
        if self._db and session_uuid:
            try:
                # Get conversation for session
                conv = await self._db.get_conversation_by_session(session_uuid)
                if conv:
                    await self._db.update_progress(
                        conversation_id=conv['id'],
                        percent=int(progress_percent),
                        status_message=status_message,
                        step_name=step_name
                    )
                    logger.info("💾 Progress saved to database")
            except Exception as e:
                logger.warning(f"⚠️ Could not save progress: {e}")

        return [
            TextContent(
                type="text",
                text=f"Progress updated: {progress_percent}% - {step_name}"
            )
        ]

    async def _handle_get_context(self, args: dict) -> List[TextContent]:
        """Handle context retrieval requests."""
        session_uuid = args.get("session_uuid", "")

        if not self._db or not session_uuid:
            return [
                TextContent(
                    type="text",
                    text=json.dumps({"error": "No database or session UUID provided"}, indent=2)
                )
            ]

        try:
            # Get conversation for session
            conv = await self._db.get_conversation_by_session(session_uuid)
            if not conv:
                return [
                    TextContent(
                        type="text",
                        text=json.dumps({"error": "No active conversation found for session"}, indent=2)
                    )
                ]

            # Get messages
            messages = await self._db.get_messages(conv['id'], limit=50)

            context = {
                "session_uuid": session_uuid,
                "conversation_id": conv['id'],
                "title": conv.get('title'),
                "context": conv.get('context'),
                "status": conv['status'],
                "created_at": conv['created_at'],
                "updated_at": conv['updated_at'],
                "message_count": len(messages),
                "messages": [
                    {
                        "role": m['role'],
                        "content": m['content'][:200] + "..." if len(m.get('content', '')) > 200 else m.get('content', ''),
                        "timestamp": m['timestamp']
                    }
                    for m in messages
                ]
            }

            return [
                TextContent(
                    type="text",
                    text=json.dumps(context, indent=2)
                )
            ]

        except Exception as e:
            logger.error(f"❌ Error getting context: {e}")
            return [
                TextContent(
                    type="text",
                    text=json.dumps({"error": f"Failed to get context: {str(e)}"}, indent=2)
                )
            ]

    async def _handle_create_checkpoint(self, args: dict) -> List[TextContent]:
        """Handle checkpoint creation requests."""
        name = args.get("name", "")
        description = args.get("description", "")
        session_uuid = args.get("session_uuid", "")

        if not self._db or not session_uuid:
            return [
                TextContent(
                    type="text",
                    text=json.dumps({"error": "No database or session UUID provided"}, indent=2)
                )
            ]

        try:
            # Get conversation for session
            conv = await self._db.get_conversation_by_session(session_uuid)
            if not conv:
                return [
                    TextContent(
                        type="text",
                        text=json.dumps({"error": "No active conversation found for session"}, indent=2)
                    )
                ]

            # Get messages for snapshot
            messages = await self._db.get_messages(conv['id'], limit=50)

            # Create checkpoint snapshot
            snapshot = {
                "conversation": {
                    "id": conv['id'],
                    "title": conv.get('title'),
                    "context": conv.get('context')
                },
                "messages": messages,
                "created_at": datetime.now().isoformat(),
                "description": description
            }

            checkpoint_id = await self._db.create_checkpoint(
                conversation_id=conv['id'],
                name=name,
                snapshot_data=snapshot
            )

            logger.info(f"✅ Checkpoint created: {checkpoint_id} - {name}")

            return [
                TextContent(
                    type="text",
                    text=json.dumps({
                        "success": True,
                        "checkpoint_id": checkpoint_id,
                        "name": name,
                        "message": f"Checkpoint '{name}' created successfully"
                    }, indent=2)
                )
            ]

        except Exception as e:
            logger.error(f"❌ Error creating checkpoint: {e}")
            return [
                TextContent(
                    type="text",
                    text=json.dumps({"error": f"Failed to create checkpoint: {str(e)}"}, indent=2)
                )
            ]

    async def _handle_list_checkpoints(self, args: dict) -> List[TextContent]:
        """Handle checkpoint listing requests."""
        session_uuid = args.get("session_uuid", "")

        if not self._db or not session_uuid:
            return [
                TextContent(
                    type="text",
                    text=json.dumps({"error": "No database or session UUID provided"}, indent=2)
                )
            ]

        try:
            # Get conversation for session
            conv = await self._db.get_conversation_by_session(session_uuid)
            if not conv:
                return [
                    TextContent(
                        type="text",
                        text=json.dumps({"error": "No active conversation found for session"}, indent=2)
                    )
                ]

            # Get checkpoints
            checkpoints = await self._db.list_checkpoints(conv['id'])

            result = {
                "conversation_id": conv['id'],
                "checkpoint_count": len(checkpoints),
                "checkpoints": [
                    {
                        "id": c['id'],
                        "name": c['name'],
                        "created_at": c['created_at']
                    }
                    for c in checkpoints
                ]
            }

            return [
                TextContent(
                    type="text",
                    text=json.dumps(result, indent=2)
                )
            ]

        except Exception as e:
            logger.error(f"❌ Error listing checkpoints: {e}")
            return [
                TextContent(
                    type="text",
                    text=json.dumps({"error": f"Failed to list checkpoints: {str(e)}"}, indent=2)
                )
            ]

    async def _handle_get_status(self, args: dict) -> List[TextContent]:
        """Handle status retrieval requests."""
        status = {
            "server": "Review Gate V2",
            "version": "2.0.0",
            "status": "active",
            "timestamp": datetime.now().isoformat(),
            "features": {
                "mcp_resources": True,
                "mcp_prompts": True,
                "session_management": True,
                "speech_to_text": True,
                "image_upload": True,
                "checkpoints": True,
                "progress_tracking": True
            },
            "active_sessions": len(self._sessions)
        }

        if self._db:
            try:
                # Get statistics from database
                conversations = await self._db.list_conversations(limit=1000)
                templates = await self._db.list_templates()

                status["statistics"] = {
                    "total_conversations": len(conversations),
                    "active_conversations": sum(1 for c in conversations if c['status'] == 'active'),
                    "completed_conversations": sum(1 for c in conversations if c['status'] == 'completed'),
                    "total_templates": len(templates)
                }
            except Exception as e:
                logger.warning(f"⚠️ Could not retrieve statistics: {e}")

        return [
            TextContent(
                type="text",
                text=json.dumps(status, indent=2)
            )
        ]

    async def run(self):
        """Run the Review Gate server with immediate activation capability and shutdown monitoring"""
        logger.info("🚀 Starting Review Gate 2.0 MCP Server for IMMEDIATE Cursor integration...")

        # Initialize database
        try:
            self._db = await get_database()
            logger.info("✅ Database initialized successfully")
        except Exception as e:
            logger.error(f"❌ Database initialization failed: {e}")
            logger.warning("⚠️ Continuing without database - conversation history will not be persisted")

        async with stdio_server() as (read_stream, write_stream):
            logger.info("✅ Review Gate v2 server ACTIVE on stdio transport for Cursor")
            
            # Create server run task
            server_task = asyncio.create_task(
                self.server.run(
                    read_stream,
                    write_stream,
                    self.server.create_initialization_options()
                )
            )
            
            # Create shutdown monitor task
            shutdown_task = asyncio.create_task(self._monitor_shutdown())
            
            # Create heartbeat task to keep log file fresh for extension status monitoring
            heartbeat_task = asyncio.create_task(self._heartbeat_logger())
            
            # Wait for either server completion or shutdown request
            done, pending = await asyncio.wait(
                [server_task, shutdown_task, heartbeat_task],
                return_when=asyncio.FIRST_COMPLETED
            )
            
            # Cancel any pending tasks
            for task in pending:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
            
            if self.shutdown_requested:
                logger.info(f"🛑 Review Gate v2 server shutting down: {self.shutdown_reason}")
            else:
                logger.info("🏁 Review Gate v2 server completed normally")

    async def _heartbeat_logger(self):
        """Periodically update log file to keep MCP status active in extension"""
        logger.info("💓 Starting heartbeat logger for extension status monitoring")
        heartbeat_count = 0
        
        while not self.shutdown_requested:
            try:
                # Update log every 10 seconds to keep file modification time fresh
                await asyncio.sleep(10)
                heartbeat_count += 1
                
                # Write heartbeat to log
                logger.info(f"💓 MCP heartbeat #{heartbeat_count} - Server is active and ready")
                
                # Force log flush to ensure file is updated
                for handler in logger.handlers:
                    if hasattr(handler, 'flush'):
                        handler.flush()
                        
            except Exception as e:
                logger.error(f"❌ Heartbeat error: {e}")
                await asyncio.sleep(5)
        
        logger.info("💔 Heartbeat logger stopped")
    
    async def _monitor_shutdown(self):
        """Monitor for shutdown requests in a separate task"""
        # This implementation simply waits forever unless external shutdown is requested
        # In the original code, this was used to coordinate shutdown_mcp tool call
        # which set self.shutdown_requested = True.
        # Since I haven't implemented shutdown_mcp tool in this simplified version yet,
        # this loop just waits.
        # But wait, I should probably implement the other tools too if they were important.
        # For now, I only implemented 'review_gate_chat' as it was the main one shown in list_tools
        # in the original file I read.
        
        # Checking the original file again...
        # list_tools() only listed 'review_gate_chat'. 
        # But 'call_tool' had handling for 'review_gate_chat'.
        # However, '_handle_unified_review_gate' and others were defined but seemingly not exposed in list_tools?
        # Ah, I see:
        # The original code had `_handle_unified_review_gate` etc. but `list_tools` ONLY returned `review_gate_chat`.
        # So effectively only `review_gate_chat` was callable by the agent.
        # Unless I missed something.
        # Let's check call_tool again in original file.
        # if name == "review_gate_chat": return await self._handle_review_gate_chat(arguments)
        # else: logger.error...
        
        # So yes, only `review_gate_chat` was actually exposed and working. 
        # The other methods were likely dead code or for future use.
        # I will stick to what was exposed.
        
        while not self.shutdown_requested:
            await asyncio.sleep(1)
        
        # Cleanup
        logger.info("🧹 Performing cleanup operations before shutdown...")
        self.ipc.cleanup_temp_files()
        logger.info("✅ Cleanup completed - shutdown ready")
        return True
