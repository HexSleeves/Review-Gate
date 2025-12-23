import asyncio
import json
import time
from datetime import datetime
from typing import Optional, List

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import (
    Tool,
    TextContent,
    ImageContent,
    CallToolRequest,
)

from .config import logger
from .ipc import IPCManager
from .speech import SpeechHandler

class ReviewGateServer:
    def __init__(self):
        self.server = Server("review-gate-v2")
        self.ipc = IPCManager()
        self.shutdown_requested = False
        self.shutdown_reason = ""
        self._last_attachments = []
        
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
                            }
                        }
                    }
                )
            ]
            logger.info(f"✅ Listed {len(tools)} Review Gate tools for Cursor Agent")
            return tools

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
        
        logger.info(f"💬 ACTIVATING Review Gate chat popup IMMEDIATELY for Cursor Agent")
        
        # Create trigger file for Cursor extension IMMEDIATELY
        trigger_id = f"review_{int(time.time() * 1000)}"
        
        data = {
            "tool": "review_gate_chat",
            "message": message,
            "title": title,
            "context": context,
            "urgent": urgent,
            "trigger_id": trigger_id,
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
                
                response_content = [TextContent(type="text", text=f"User Response: {user_input}")]
                
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
                response = f"TIMEOUT: No user input received for review gate within 5 minutes"
                logger.warning("⚠️ Review Gate timed out waiting for user input after 5 minutes")
                return [TextContent(type="text", text=response)]
        else:
            response = f"ERROR: Failed to trigger Review Gate popup"
            logger.error("❌ Failed to trigger Review Gate popup")
            return [TextContent(type="text", text=response)]

    async def run(self):
        """Run the Review Gate server with immediate activation capability and shutdown monitoring"""
        logger.info("🚀 Starting Review Gate 2.0 MCP Server for IMMEDIATE Cursor integration...")
        
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
