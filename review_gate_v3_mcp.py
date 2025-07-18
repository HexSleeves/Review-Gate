#!/usr/bin/env python3
"""
Review Gate V3 - Advanced MCP Server with Cursor Integration
Author: Lakshman Turlapati & HexSleeves
Provides popup chat, quick input, and file picker tools that automatically trigger Cursor extension.

Features:
- Secure input validation and sanitization
- Configurable timeouts and polling intervals
- Cross-platform compatibility
- Structured logging
- Resource management with context managers
- Simplified error handling

Requirements:
- mcp>=1.9.2 (latest stable version)
- Python 3.8+
"""

import asyncio
import json
import sys
import logging
import os
import time
import uuid
import glob
import tempfile
import re
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional, Sequence

# Speech-to-text imports
try:
    from faster_whisper import WhisperModel
    WHISPER_AVAILABLE = True
except ImportError:
    WHISPER_AVAILABLE = False

from mcp.server import Server
from mcp.server.models import InitializationOptions
from mcp.server.stdio import stdio_server
from mcp.types import (
    CallToolRequest,
    ListToolsRequest,
    TextContent,
    Tool,
    CallToolResult,
    Resource,
    ImageContent,
    EmbeddedResource,
)

# Cross-platform temp directory helper
def get_temp_path(filename: str) -> str:
    """Get cross-platform temporary file path"""
    # Use /tmp/ for macOS and Linux, system temp for Windows
    if os.name == 'nt':  # Windows
        temp_dir = tempfile.gettempdir()
    else:  # macOS and Linux
        temp_dir = '/tmp'
    return os.path.join(temp_dir, filename)

def sanitize_input(input_text: str, max_length: int = None) -> str:
    """Sanitize user input to prevent injection attacks and ensure reasonable length"""
    if not isinstance(input_text, str):
        return ""
    
    # Use default max_length if not provided
    if max_length is None:
        max_length = 10000
    
    # Remove null bytes and other problematic characters
    sanitized = input_text.replace('\0', '').replace('\r', '\n')
    
    # Limit length to prevent DoS attacks
    if len(sanitized) > max_length:
        sanitized = sanitized[:max_length] + "...[truncated]"
    
    # Remove potential script injection patterns
    sanitized = re.sub(r'<script[^>]*>.*?</script>', '', sanitized, flags=re.IGNORECASE | re.DOTALL)
    sanitized = re.sub(r'javascript:', '', sanitized, flags=re.IGNORECASE)
    
    return sanitized.strip()

def validate_filename(filename: str, max_length: int = None) -> str:
    """Validate and sanitize filename to prevent path traversal attacks"""
    if not isinstance(filename, str):
        return "unknown"
    
    # Use default max_length if not provided
    if max_length is None:
        max_length = 255
    
    # Remove path traversal attempts
    sanitized = filename.replace('..', '').replace('/', '').replace('\\', '')
    
    # Remove problematic characters
    sanitized = re.sub(r'[<>:"|?*]', '', sanitized)
    
    # Ensure it's not empty and not too long
    if not sanitized or len(sanitized) > max_length:
        sanitized = f"file_{int(time.time())}"
    
    return sanitized

@contextmanager
def safe_file_operation(file_path: str, mode: str = 'r', encoding: str = 'utf-8'):
    """Context manager for safe file operations with proper error handling and cleanup"""
    file_obj = None
    try:
        file_obj = open(file_path, mode, encoding=encoding)
        yield file_obj
    except (IOError, OSError) as e:
        logger.error(f"❌ File operation failed for {file_path}: {e}")
        raise
    finally:
        if file_obj:
            try:
                file_obj.close()
            except Exception as e:
                logger.warning(f"⚠️ Error closing file {file_path}: {e}")

@contextmanager
def safe_temp_file(prefix: str = "review_gate_", suffix: str = ".tmp", content: str = None):
    """Context manager for safe temporary file operations"""
    temp_file = None
    temp_path = None
    try:
        # Create temporary file
        temp_file = tempfile.NamedTemporaryFile(
            mode='w+',
            prefix=prefix,
            suffix=suffix,
            delete=False,
            encoding='utf-8'
        )
        temp_path = temp_file.name
        
        if content:
            temp_file.write(content)
            temp_file.flush()
        
        yield temp_file, temp_path
    except Exception as e:
        logger.error(f"❌ Temporary file operation failed: {e}")
        raise
    finally:
        # Clean up temporary file
        if temp_file:
            try:
                temp_file.close()
            except Exception as e:
                logger.warning(f"⚠️ Error closing temp file: {e}")
        
        if temp_path and os.path.exists(temp_path):
            try:
                os.unlink(temp_path)
                logger.debug(f"🗑️ Cleaned up temp file: {temp_path}")
            except Exception as e:
                logger.warning(f"⚠️ Error cleaning up temp file {temp_path}: {e}")

# Configure logging with immediate flush
log_file_path = get_temp_path('review_gate_v3.log')

# Create handlers separately to handle Windows file issues
handlers = []
try:
    # File handler - may fail on Windows if file is locked
    file_handler = logging.FileHandler(log_file_path, mode='a', encoding='utf-8')
    file_handler.setLevel(logging.INFO)
    handlers.append(file_handler)
except Exception as e:
    # If file logging fails, just use stderr
    print(f"Warning: Could not create log file: {e}", file=sys.stderr)

# Always add stderr handler
stderr_handler = logging.StreamHandler(sys.stderr)
stderr_handler.setLevel(logging.INFO)
handlers.append(stderr_handler)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - [%(funcName)s:%(lineno)d] - %(message)s',
    handlers=handlers
)
logger = logging.getLogger(__name__)

def log_structured(level, event, **kwargs):
    """Log structured messages with consistent formatting"""
    message_parts = [f"EVENT:{event}"]
    
    for key, value in kwargs.items():
        if isinstance(value, str) and len(value) > 100:
            value = value[:100] + "...[truncated]"
        message_parts.append(f"{key}={value}")
    
    message = " | ".join(message_parts)
    logger.log(level, message)

# Log startup information
log_structured(logging.INFO, "SERVER_STARTUP", log_file=log_file_path)

# Force immediate log flushing
for handler in logger.handlers:
    if hasattr(handler, 'flush'):
        handler.flush()

class ReviewGateConfig:
    """Configuration class for Review Gate server"""
    def __init__(self):
        # Timeout configurations (in seconds)
        self.CHAT_TIMEOUT = int(os.getenv("REVIEW_GATE_CHAT_TIMEOUT", "300"))  # 5 minutes
        self.QUICK_TIMEOUT = int(os.getenv("REVIEW_GATE_QUICK_TIMEOUT", "90"))  # 1.5 minutes
        self.FILE_TIMEOUT = int(os.getenv("REVIEW_GATE_FILE_TIMEOUT", "90"))  # 1.5 minutes
        self.INGEST_TIMEOUT = int(os.getenv("REVIEW_GATE_INGEST_TIMEOUT", "120"))  # 2 minutes
        self.SHUTDOWN_TIMEOUT = int(os.getenv("REVIEW_GATE_SHUTDOWN_TIMEOUT", "60"))  # 1 minute
        self.ACK_TIMEOUT = int(os.getenv("REVIEW_GATE_ACK_TIMEOUT", "30"))  # 30 seconds
        
        # Polling intervals (in seconds)
        self.POLL_INTERVAL = float(os.getenv("REVIEW_GATE_POLL_INTERVAL", "0.5"))  # 500ms
        self.SPEECH_POLL_INTERVAL = float(os.getenv("REVIEW_GATE_SPEECH_POLL_INTERVAL", "1.0"))  # 1 second
        self.HEARTBEAT_INTERVAL = int(os.getenv("REVIEW_GATE_HEARTBEAT_INTERVAL", "30"))  # 30 seconds
        
        # Input validation
        self.MAX_INPUT_LENGTH = int(os.getenv("REVIEW_GATE_MAX_INPUT_LENGTH", "10000"))
        self.MAX_FILENAME_LENGTH = int(os.getenv("REVIEW_GATE_MAX_FILENAME_LENGTH", "255"))

class ReviewGateServer:
    def __init__(self):
        self.config = ReviewGateConfig()
        self.server = Server("review-gate-v3")
        self.setup_handlers()
        self.shutdown_requested = False
        self.shutdown_reason = ""
        self._last_attachments = []
        self._whisper_model = None

        # Initialize Whisper model with comprehensive error handling
        self._whisper_error = None
        if WHISPER_AVAILABLE:
            self._whisper_model = self._initialize_whisper_model()
        else:
            logger.warning("⚠️ Faster-Whisper not available - speech-to-text will be disabled")
            logger.warning("💡 To enable speech features, install: pip install faster-whisper")
            self._whisper_error = "faster-whisper package not installed"

        # Start speech trigger monitoring
        self._start_speech_monitoring()

        log_structured(logging.INFO, "SERVER_INITIALIZED", 
                      whisper_available=WHISPER_AVAILABLE, 
                      whisper_error=self._whisper_error,
                      speech_monitoring=hasattr(self, '_speech_monitoring_active'))
        # Ensure log is written immediately
        for handler in logger.handlers:
            if hasattr(handler, 'flush'):
                handler.flush()

    def _initialize_whisper_model(self):
        """Initialize Whisper model with simplified error handling"""
        try:
            logger.info("🎤 Loading Faster-Whisper model for speech-to-text...")

            # Try models in order of preference (smaller models first for better compatibility)
            model_configs = [
                {"model": "tiny", "device": "cpu", "compute_type": "int8"},
                {"model": "base", "device": "cpu", "compute_type": "int8"},
                {"model": "tiny", "device": "cpu", "compute_type": "float32"},
            ]

            for config in model_configs:
                try:
                    logger.info(f"🔄 Attempting to load {config['model']} model")
                    model = WhisperModel(config['model'], device=config['device'], compute_type=config['compute_type'])
                    logger.info(f"✅ Successfully loaded {config['model']} model")
                    return model

                except Exception as model_error:
                    logger.warning(f"⚠️ Failed to load {config['model']} model: {model_error}")
                    continue

            # If all models failed, raise the last error
            raise Exception("All Whisper model configurations failed")

        except Exception as e:
            error_msg = f"Whisper model initialization failed: {e}"
            logger.error(f"❌ {error_msg}")
            
            # Provide basic guidance for common issues
            error_str = str(e).lower()
            if "cuda" in error_str:
                logger.error("💡 CUDA issue - try: pip install faster-whisper --no-deps")
            elif "visual studio" in error_str or "msvc" in error_str:
                logger.error("💡 Visual C++ dependency missing - install Visual Studio Build Tools")
            elif "permission" in error_str:
                logger.error("💡 Permission issue - check file access and antivirus")
            elif "disk space" in error_str or "no space" in error_str:
                logger.error("💡 Insufficient disk space for model download")

            self._whisper_error = error_msg
            return None

    def setup_handlers(self):
        """Set up MCP request handlers"""

        @self.server.list_tools()
        async def list_tools():
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
                                "default": "Review Gate V3 - ゲート"
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
        async def call_tool(name: str, arguments: dict):
            """Handle tool calls from Cursor Agent with immediate activation"""
            log_structured(logging.INFO, "TOOL_CALL", tool_name=name, arguments=str(arguments))

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
                    # Wait before returning error
                    await asyncio.sleep(1.0)  # Wait 1 second before error response
                    raise ValueError(f"Unknown tool: {name}")
            except Exception as e:
                logger.error(f"💥 Tool call error for {name}: {e}")
                # Wait before returning error
                await asyncio.sleep(1.0)  # Wait 1 second before error response
                return [TextContent(type="text", text=f"ERROR: Tool {name} failed: {str(e)}")]


    async def _handle_review_gate_chat(self, args: dict) -> list[TextContent]:
        """Handle Review Gate chat popup and wait for user input with 5 minute timeout"""
        # Sanitize inputs to prevent injection attacks
        message = sanitize_input(args.get("message", "Please provide your review or feedback:"), self.config.MAX_INPUT_LENGTH)
        title = sanitize_input(args.get("title", "Review Gate V3 - ゲート"), self.config.MAX_INPUT_LENGTH)
        context = sanitize_input(args.get("context", ""), self.config.MAX_INPUT_LENGTH)
        urgent = bool(args.get("urgent", False))

        logger.info(f"💬 ACTIVATING Review Gate chat popup IMMEDIATELY for Cursor Agent")
        logger.info(f"📝 Title: {title}")
        logger.info(f"📄 Message: {message}")

        # Create trigger file for Cursor extension IMMEDIATELY
        trigger_id = f"review_{int(time.time() * 1000)}"  # Use milliseconds for uniqueness

        # Force immediate trigger creation with enhanced debugging
        success = await self._trigger_cursor_popup_immediately({
            "tool": "review_gate_chat",
            "message": message,
            "title": title,
            "context": context,
            "urgent": urgent,
            "trigger_id": trigger_id,
            "timestamp": datetime.now().isoformat(),
            "immediate_activation": True
        })

        if success:
            logger.info(f"🔥 POPUP TRIGGERED IMMEDIATELY - waiting for user input (trigger_id: {trigger_id})")

            # Wait for extension acknowledgement first
            ack_received = await self._wait_for_extension_acknowledgement(trigger_id, timeout=self.config.ACK_TIMEOUT)
            if ack_received:
                logger.info("📨 Extension acknowledged popup activation")
            else:
                logger.warning("⚠️ No extension acknowledgement received - popup may not have opened")

            # Wait for user input from the popup
            logger.info(f"⏳ Waiting for user input for up to {self.config.CHAT_TIMEOUT} seconds...")
            user_input = await self._wait_for_user_input(trigger_id, timeout=self.config.CHAT_TIMEOUT)

            if user_input:
                # Sanitize user input before processing
                sanitized_input = sanitize_input(user_input)
                log_structured(logging.INFO, "USER_INPUT_RECEIVED", 
                              trigger_id=trigger_id, 
                              input_length=len(sanitized_input),
                              has_attachments=bool(hasattr(self, '_last_attachments') and self._last_attachments))

                # Check for images in the last response data
                response_content = [TextContent(type="text", text=f"User Response: {sanitized_input}")]

                # If we have stored attachment data, include images
                if hasattr(self, '_last_attachments') and self._last_attachments:
                    for attachment in self._last_attachments:
                        if attachment.get('mimeType', '').startswith('image/'):
                            try:
                                image_content = ImageContent(
                                    type="image",
                                    data=attachment['base64Data'],
                                    mimeType=attachment['mimeType']
                                )
                                response_content.append(image_content)
                                safe_filename = validate_filename(attachment.get('fileName', 'unknown'))
                                logger.info(f"📸 Added image to response: {safe_filename}")
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

    async def _handle_get_user_input(self, args: dict) -> list[TextContent]:
        """Retrieve user input from any available response files"""
        timeout = args.get("timeout", 10)

        logger.info(f"🔍 CHECKING for user input (timeout: {timeout}s)")

        # Check all possible response file patterns
        response_patterns = [
            os.path.join(tempfile.gettempdir(), "review_gate_response_*.json"),
            get_temp_path("review_gate_response.json"),
            os.path.join(tempfile.gettempdir(), "mcp_response_*.json"),
            get_temp_path("mcp_response.json")
        ]

        import glob
        start_time = time.time()

        while time.time() - start_time < timeout:
            try:
                # Check all response patterns
                for pattern in response_patterns:
                    matching_files = glob.glob(pattern)
                    for response_file_path in matching_files:
                        response_file = Path(response_file_path)
                        if response_file.exists():
                            try:
                                file_content = response_file.read_text().strip()
                                logger.info(f"📄 Found response file {response_file}: {file_content[:200]}...")

                                # Handle JSON format
                                if file_content.startswith('{'):
                                    data = json.loads(file_content)
                                    user_input = data.get("user_input", data.get("response", data.get("message", ""))).strip()
                                # Handle plain text format
                                else:
                                    user_input = file_content

                                if user_input:
                                    # Clean up response file
                                    try:
                                        response_file.unlink()
                                        logger.info(f"🧹 Response file cleaned up: {response_file}")
                                    except Exception as cleanup_error:
                                        logger.warning(f"⚠️ Cleanup error: {cleanup_error}")

                                    logger.info(f"✅ RETRIEVED USER INPUT: {user_input[:100]}...")

                                    result_message = f"✅ User Input Retrieved\n\n"
                                    result_message += f"💬 User Response: {user_input}\n"
                                    result_message += f"📁 Source File: {response_file.name}\n"
                                    result_message += f"⏰ Retrieved at: {datetime.now().isoformat()}\n\n"
                                    result_message += f"🎯 User input successfully captured from Review Gate."

                                    return [TextContent(type="text", text=result_message)]

                            except json.JSONDecodeError as e:
                                logger.error(f"❌ JSON decode error in {response_file}: {e}")
                            except Exception as e:
                                logger.error(f"❌ Error processing response file {response_file}: {e}")

                # Short sleep to avoid excessive CPU usage
                await asyncio.sleep(0.5)

            except Exception as e:
                logger.error(f"❌ Error in get_user_input loop: {e}")
                await asyncio.sleep(1)

        # No input found within timeout
        no_input_message = f"⏰ No user input found within {timeout} seconds\n\n"
        no_input_message += f"🔍 Checked patterns: {', '.join(response_patterns)}\n"
        no_input_message += f"💡 User may not have provided input yet, or the popup may not be active.\n\n"
        no_input_message += f"🎯 Try calling this tool again after the user provides input."

        logger.warning(f"⏰ No user input found within {timeout} seconds")
        return [TextContent(type="text", text=no_input_message)]

    async def _handle_quick_review(self, args: dict) -> list[TextContent]:
        """Handle quick review request and wait for response with immediate activation"""
        prompt = args.get("prompt", "Quick feedback needed:")
        context = args.get("context", "")

        logger.info(f"⚡ ACTIVATING Quick Review IMMEDIATELY for Cursor Agent: {prompt}")

        # Create trigger for quick input IMMEDIATELY
        trigger_id = f"quick_{int(time.time() * 1000)}"
        success = await self._trigger_cursor_popup_immediately({
            "tool": "quick_review",
            "prompt": prompt,
            "context": context,
            "title": "Quick Review - Review Gate v3",
            "trigger_id": trigger_id,
            "timestamp": datetime.now().isoformat(),
            "immediate_activation": True
        })

        if success:
            logger.info(f"🔥 QUICK POPUP TRIGGERED - waiting for user input (trigger_id: {trigger_id})")

            # Wait for quick user input
            user_input = await self._wait_for_user_input(trigger_id, timeout=90)  # 1.5 minute timeout for quick review

            if user_input:
                # Return user input directly to MCP client
                logger.info(f"✅ RETURNING QUICK REVIEW TO MCP CLIENT: {user_input}")
                return [TextContent(type="text", text=user_input)]
            else:
                response = f"TIMEOUT: No quick review input received within 1.5 minutes"
                logger.warning("⚠️ Quick review timed out")
                return [TextContent(type="text", text=response)]
        else:
            response = f"ERROR: Failed to trigger quick review popup"
            return [TextContent(type="text", text=response)]

    async def _handle_file_review(self, args: dict) -> list[TextContent]:
        """Handle file review request and wait for file selection with immediate activation"""
        instruction = args.get("instruction", "Please select file(s) for review:")
        file_types = args.get("file_types", ["*"])

        logger.info(f"📁 ACTIVATING File Review IMMEDIATELY for Cursor Agent: {instruction}")

        # Create trigger for file picker IMMEDIATELY
        trigger_id = f"file_{int(time.time() * 1000)}"
        success = await self._trigger_cursor_popup_immediately({
            "tool": "file_review",
            "instruction": instruction,
            "file_types": file_types,
            "title": "File Review - Review Gate v3",
            "trigger_id": trigger_id,
            "timestamp": datetime.now().isoformat(),
            "immediate_activation": True
        })

        if success:
            logger.info(f"🔥 FILE POPUP TRIGGERED - waiting for selection (trigger_id: {trigger_id})")

            # Wait for file selection
            user_input = await self._wait_for_user_input(trigger_id, timeout=90)  # 1.5 minute timeout

            if user_input:
                response = f"📁 File Review completed!\n\n**Selected Files:** {user_input}\n\n**Instruction:** {instruction}\n**Allowed Types:** {', '.join(file_types)}\n\nYou can now proceed to analyze the selected files."
                logger.info(f"✅ FILES SELECTED: {user_input}")
            else:
                response = f"⏰ File Review timed out.\n\n**Instruction:** {instruction}\n\nNo files selected within 1.5 minutes. Try again or proceed with current workspace files."
                logger.warning("⚠️ File review timed out")
        else:
            response = f"⚠️ File Review trigger failed. Manual activation may be needed."

        logger.info("🏁 File review processing complete")
        return [TextContent(type="text", text=response)]

    async def _handle_ingest_text(self, args: dict) -> list[TextContent]:
        """
        Handle text ingestion with immediate activation and user input capture
        """
        text_content = args.get("text_content", "")
        source = args.get("source", "extension")
        context = args.get("context", "")
        processing_mode = args.get("processing_mode", "immediate")

        logger.info(f"🚀 ACTIVATING ingest_text IMMEDIATELY for Cursor Agent: {text_content[:100]}...")
        logger.info(f"📍 Source: {source}, Context: {context}, Mode: {processing_mode}")

        # Create trigger for ingest_text IMMEDIATELY (consistent with other tools)
        trigger_id = f"ingest_{int(time.time() * 1000)}"
        success = await self._trigger_cursor_popup_immediately({
            "tool": "ingest_text",
            "text_content": text_content,
            "source": source,
            "context": context,
            "processing_mode": processing_mode,
            "title": "Text Ingestion - Review Gate v3",
            "message": f"Text to process: {text_content}",
            "trigger_id": trigger_id,
            "timestamp": datetime.now().isoformat(),
            "immediate_activation": True
        })

        if success:
            logger.info(f"🔥 INGEST POPUP TRIGGERED - waiting for user input (trigger_id: {trigger_id})")

            # Wait for user input with appropriate timeout
            user_input = await self._wait_for_user_input(trigger_id, timeout=120)  # 2 minute timeout

            if user_input:
                # Return the user input for further processing
                result_message = f"✅ Text ingestion completed!\n\n"
                result_message += f"📝 Original Text: {text_content}\n"
                result_message += f"💬 User Response: {user_input}\n"
                result_message += f"📍 Source: {source}\n"
                result_message += f"💭 Context: {context}\n"
                result_message += f"⚙️ Processing Mode: {processing_mode}\n\n"
                result_message += f"🎯 The text has been processed and user feedback collected successfully."

                logger.info(f"✅ INGEST SUCCESS: User provided feedback for text ingestion")
                return [TextContent(type="text", text=result_message)]
            else:
                result_message = f"⏰ Text ingestion timed out.\n\n"
                result_message += f"📝 Text Content: {text_content}\n"
                result_message += f"📍 Source: {source}\n\n"
                result_message += f"No user response received within 2 minutes. The text content is noted but no additional processing occurred."

                logger.warning("⚠️ Text ingestion timed out")
                return [TextContent(type="text", text=result_message)]
        else:
            result_message = f"⚠️ Text ingestion trigger failed.\n\n"
            result_message += f"📝 Text Content: {text_content}\n"
            result_message += f"Manual activation may be needed."

            logger.error("❌ Failed to trigger text ingestion popup")
            return [TextContent(type="text", text=result_message)]

    async def _handle_shutdown_mcp(self, args: dict) -> list[TextContent]:
        """Handle shutdown_mcp request and wait for confirmation with immediate activation"""
        reason = args.get("reason", "Task completed successfully")
        immediate = args.get("immediate", False)
        cleanup = args.get("cleanup", True)

        logger.info(f"🛑 ACTIVATING shutdown_mcp IMMEDIATELY for Cursor Agent: {reason}")

        # Create trigger for shutdown_mcp IMMEDIATELY
        trigger_id = f"shutdown_{int(time.time() * 1000)}"
        success = await self._trigger_cursor_popup_immediately({
            "tool": "shutdown_mcp",
            "reason": reason,
            "immediate": immediate,
            "cleanup": cleanup,
            "title": "Shutdown - Review Gate v3",
            "trigger_id": trigger_id,
            "timestamp": datetime.now().isoformat(),
            "immediate_activation": True
        })

        if success:
            logger.info(f"🛑 SHUTDOWN TRIGGERED - waiting for confirmation (trigger_id: {trigger_id})")

            # Wait for confirmation
            user_input = await self._wait_for_user_input(trigger_id, timeout=60)  # 1 minute timeout for shutdown confirmation

            if user_input:
                # Check if user confirmed shutdown
                if user_input.upper().strip() in ['CONFIRM', 'YES', 'Y', 'SHUTDOWN', 'PROCEED']:
                    self.shutdown_requested = True
                    self.shutdown_reason = f"User confirmed: {user_input.strip()}"
                    response = f"🛑 shutdown_mcp CONFIRMED!\n\n**User Confirmation:** {user_input}\n\n**Reason:** {reason}\n**Immediate:** {immediate}\n**Cleanup:** {cleanup}\n\n✅ MCP server will now shut down gracefully..."
                    logger.info(f"✅ SHUTDOWN CONFIRMED BY USER: {user_input[:100]}...")
                    logger.info(f"🛑 Server shutdown initiated - reason: {self.shutdown_reason}")
                else:
                    response = f"💡 shutdown_mcp CANCELLED - Alternative instructions received!\n\n**User Response:** {user_input}\n\n**Original Reason:** {reason}\n\nShutdown cancelled. User provided alternative instructions instead of confirmation."
                    logger.info(f"💡 SHUTDOWN CANCELLED - user provided alternative: {user_input[:100]}...")
            else:
                response = f"⏰ shutdown_mcp timed out.\n\n**Reason:** {reason}\n\nNo response received within 1 minute. Shutdown cancelled due to timeout."
                logger.warning("⚠️ Shutdown timed out - shutdown cancelled")
        else:
            response = f"⚠️ shutdown_mcp trigger failed. Manual activation may be needed."

        logger.info("🏁 shutdown_mcp processing complete")
        return [TextContent(type="text", text=response)]

    async def _wait_for_extension_acknowledgement(self, trigger_id: str, timeout: int = 30) -> bool:
        """Wait for extension acknowledgement that popup was activated"""
        ack_file = Path(get_temp_path(f"review_gate_ack_{trigger_id}.json"))

        logger.info(f"🔍 Monitoring for extension acknowledgement: {ack_file}")

        start_time = time.time()
        check_interval = self.config.POLL_INTERVAL

        while time.time() - start_time < timeout:
            try:
                if ack_file.exists():
                    with safe_file_operation(str(ack_file), mode='r') as f:
                        data = json.load(f)
                        ack_status = data.get("acknowledged", False)

                    # Clean up acknowledgement file immediately
                    try:
                        ack_file.unlink()
                        logger.info(f"🧹 Acknowledgement file cleaned up")
                    except:
                        pass

                    if ack_status:
                        logger.info(f"📨 EXTENSION ACKNOWLEDGED popup activation for trigger {trigger_id}")
                        return True

                # Check frequently for faster response
                await asyncio.sleep(check_interval)

            except Exception as e:
                logger.error(f"❌ Error reading acknowledgement file: {e}")
                await asyncio.sleep(0.5)

        logger.warning(f"⏰ TIMEOUT waiting for extension acknowledgement (trigger_id: {trigger_id})")
        return False

    async def _wait_for_user_input(self, trigger_id: str, timeout: int = 120) -> Optional[str]:
        """Wait for user input from the Cursor extension popup with frequent checks and multiple response patterns"""
        response_patterns = [
            Path(get_temp_path(f"review_gate_response_{trigger_id}.json")),
            Path(get_temp_path("review_gate_response.json")),  # Fallback generic response
            Path(get_temp_path(f"mcp_response_{trigger_id}.json")),  # Alternative pattern
            Path(get_temp_path("mcp_response.json"))  # Generic MCP response
        ]

        logger.info(f"👁️ Monitoring for response files: {[str(p) for p in response_patterns]}")
        logger.info(f"🔍 Trigger ID: {trigger_id}")

        start_time = time.time()
        check_interval = self.config.POLL_INTERVAL

        while time.time() - start_time < timeout:
            try:
                # Check all possible response file patterns
                for response_file in response_patterns:
                    if response_file.exists():
                        try:
                            with safe_file_operation(str(response_file), mode='r') as f:
                                file_content = f.read().strip()
                                logger.info(f"📄 Found response file {response_file}: {file_content[:200]}...")

                            # Handle JSON format
                            if file_content.startswith('{'):
                                data = json.loads(file_content)
                                user_input = data.get("user_input", data.get("response", data.get("message", ""))).strip()
                                attachments = data.get("attachments", [])

                                # Also check if trigger_id matches (if specified)
                                response_trigger_id = data.get("trigger_id", "")
                                if response_trigger_id and response_trigger_id != trigger_id:
                                    logger.info(f"⚠️ Trigger ID mismatch: expected {trigger_id}, got {response_trigger_id}")
                                    continue

                                # Process attachments if present
                                if attachments:
                                    logger.info(f"📎 Found {len(attachments)} attachments")
                                    # Store attachments for use in response
                                    self._last_attachments = attachments
                                    attachment_descriptions = []
                                    for att in attachments:
                                        if att.get('mimeType', '').startswith('image/'):
                                            safe_filename = validate_filename(att.get('fileName', 'unknown'))
                                            attachment_descriptions.append(f"Image: {safe_filename}")

                                    if attachment_descriptions:
                                        user_input += f"\n\nAttached: {', '.join(attachment_descriptions)}"
                                else:
                                    self._last_attachments = []

                            # Handle plain text format
                            else:
                                user_input = file_content
                                attachments = []
                                self._last_attachments = []

                            # Clean up response file immediately
                            try:
                                response_file.unlink()
                                logger.info(f"🧹 Response file cleaned up: {response_file}")
                            except Exception as cleanup_error:
                                logger.warning(f"⚠️ Cleanup error: {cleanup_error}")

                            if user_input:
                                logger.info(f"🎉 RECEIVED USER INPUT for trigger {trigger_id}: {user_input[:100]}...")
                                return user_input
                            else:
                                logger.warning(f"⚠️ Empty user input in file: {response_file}")

                        except json.JSONDecodeError as e:
                            logger.error(f"❌ JSON decode error in {response_file}: {e}")
                        except Exception as e:
                            logger.error(f"❌ Error processing response file {response_file}: {e}")

                # Check more frequently for faster response
                await asyncio.sleep(check_interval)

            except Exception as e:
                logger.error(f"❌ Error in wait loop: {e}")
                await asyncio.sleep(0.5)

        logger.warning(f"⏰ TIMEOUT waiting for user input (trigger_id: {trigger_id})")
        return None

    async def _trigger_cursor_popup_immediately(self, data: dict) -> bool:
        """Create trigger file for Cursor extension with immediate activation and enhanced debugging"""
        try:
            # Add delay before creating trigger to ensure readiness
            await asyncio.sleep(0.1)  # Wait 100ms before trigger creation

            trigger_file = Path(get_temp_path("review_gate_trigger.json"))

            trigger_data = {
                "timestamp": datetime.now().isoformat(),
                "system": "review-gate-v3",
                "editor": "cursor",
                "data": data,
                "pid": os.getpid(),
                "active_window": True,
                "mcp_integration": True,
                "immediate_activation": True
            }

            logger.info(f"🎯 CREATING trigger file with data: {json.dumps(trigger_data, indent=2)}")

            # Write trigger file with context manager for safe operation
            with safe_file_operation(str(trigger_file), mode='w') as f:
                json.dump(trigger_data, f, indent=2)
                f.flush()
                os.fsync(f.fileno())  # Force write to disk

            # Verify file was written successfully
            if not trigger_file.exists():
                logger.error(f"❌ Failed to create trigger file: {trigger_file}")
                return False

            try:
                file_size = trigger_file.stat().st_size
                if file_size == 0:
                    logger.error(f"❌ Trigger file is empty: {trigger_file}")
                    return False
            except FileNotFoundError:
                # File may have been consumed by the extension already - this is OK
                logger.info(f"✅ Trigger file was consumed immediately by extension: {trigger_file}")
                file_size = len(json.dumps(trigger_data, indent=2))

            # Force file system sync with cross-platform compatibility
            try:
                # Use fsync on the file descriptor for better cross-platform support
                with open(trigger_file, 'r') as f:
                    os.fsync(f.fileno())
            except (OSError, AttributeError) as sync_error:
                # fsync may not be available on all platforms or file systems
                logger.debug(f"File sync not available: {sync_error}")
                await asyncio.sleep(0.1)  # Small delay to ensure file is written

            logger.info(f"🔥 IMMEDIATE trigger created for Cursor: {trigger_file}")
            logger.info(f"📁 Trigger file path: {trigger_file.absolute()}")
            logger.info(f"📊 Trigger file size: {file_size} bytes")

            # Create multiple backup trigger files for reliability
            await self._create_backup_triggers(data)

            # Add small delay to allow extension to process
            await asyncio.sleep(0.2)  # Wait 200ms for extension to process

            # Note: Trigger file may have been consumed by extension already, which is good!
            try:
                if trigger_file.exists():
                    logger.info(f"✅ Trigger file still exists: {trigger_file}")
                else:
                    logger.info(f"✅ Trigger file was consumed by extension: {trigger_file}")
                    logger.info(f"🎯 This is expected behavior - extension is working properly")
            except Exception as check_error:
                logger.info(f"✅ Cannot check trigger file status (likely consumed): {check_error}")
                logger.info(f"🎯 This is expected behavior - extension is working properly")

            # Check if extension might be watching
            log_file = Path(get_temp_path("review_gate_v3.log"))
            if log_file.exists():
                logger.info(f"📝 MCP log file exists: {log_file}")
            else:
                logger.warning(f"⚠️ MCP log file missing: {log_file}")

            # Force log flush
            for handler in logger.handlers:
                if hasattr(handler, 'flush'):
                    handler.flush()

            return True

        except Exception as e:
            logger.error(f"❌ CRITICAL: Failed to create Review Gate trigger: {e}")
            import traceback
            logger.error(f"🔍 Full traceback: {traceback.format_exc()}")
            # Wait before returning failure
            await asyncio.sleep(1.0)  # Wait 1 second before confirming failure
            return False

    async def _create_backup_triggers(self, data: dict):
        """Create backup trigger files for better reliability"""
        try:
            # Create multiple backup trigger files
            for i in range(3):
                backup_trigger = Path(get_temp_path(f"review_gate_trigger_{i}.json"))
                backup_data = {
                    "backup_id": i,
                    "timestamp": datetime.now().isoformat(),
                    "system": "review-gate-v3",
                    "data": data,
                    "mcp_integration": True,
                    "immediate_activation": True
                }
                with safe_file_operation(str(backup_trigger), mode='w') as f:
                    json.dump(backup_data, f, indent=2)

            logger.info("🔄 Backup trigger files created for reliability")

        except Exception as e:
            logger.warning(f"⚠️ Backup trigger creation failed: {e}")

    async def run(self):
        """Run the Review Gate server with immediate activation capability and shutdown monitoring"""
        logger.info("🚀 Starting Review Gate 3.0 MCP Server for IMMEDIATE Cursor integration...")


        async with stdio_server() as (read_stream, write_stream):
            logger.info("✅ Review Gate v3 server ACTIVE on stdio transport for Cursor")

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
                logger.info(f"🛑 Review Gate v3 server shutting down: {self.shutdown_reason}")
            else:
                logger.info("🏁 Review Gate v3 server completed normally")

    async def _heartbeat_logger(self):
        """Periodically update log file to keep MCP status active in extension"""
        logger.info("💓 Starting heartbeat logger for extension status monitoring")
        heartbeat_count = 0

        while not self.shutdown_requested:
            try:
                # Update log to keep file modification time fresh
                await asyncio.sleep(self.config.HEARTBEAT_INTERVAL)
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
        while not self.shutdown_requested:
            await asyncio.sleep(1)  # Check every second

        # Cleanup operations before shutdown
        logger.info("🧹 Performing cleanup operations before shutdown...")

        # Clean up any temporary files
        try:
            temp_files = [
                get_temp_path("review_gate_trigger.json"),
                get_temp_path("review_gate_trigger_0.json"),
                get_temp_path("review_gate_trigger_1.json"),
                get_temp_path("review_gate_trigger_2.json")
            ]
            for temp_file in temp_files:
                if Path(temp_file).exists():
                    Path(temp_file).unlink()
                    logger.info(f"🗑️ Cleaned up: {os.path.basename(temp_file)}")

            # Clean up any orphaned audio files (older than 5 minutes)
            import time
            current_time = time.time()
            temp_dir = get_temp_path("")
            audio_pattern = os.path.join(temp_dir, "review_gate_audio_*.wav")

            for audio_file in glob.glob(audio_pattern):
                try:
                    file_age = current_time - os.path.getmtime(audio_file)
                    if file_age > 300:  # 5 minutes
                        Path(audio_file).unlink()
                        logger.info(f"🗑️ Cleaned up old audio file: {os.path.basename(audio_file)}")
                except Exception as cleanup_error:
                    logger.warning(f"⚠️ Could not clean up audio file {audio_file}: {cleanup_error}")

        except Exception as e:
            logger.warning(f"⚠️ Cleanup warning: {e}")

        logger.info("✅ Cleanup completed - shutdown ready")
        return True

    def _start_speech_monitoring(self):
        """Start monitoring for speech-to-text trigger files with enhanced error handling"""
        self._speech_monitoring_active = False
        self._speech_thread = None

        def monitor_speech_triggers():
            """Enhanced speech monitoring with health checks and better error handling"""
            monitor_start_time = time.time()
            processed_count = 0
            error_count = 0
            last_heartbeat = time.time()

            logger.info("🎤 Speech monitoring thread started successfully")
            self._speech_monitoring_active = True

            while not self.shutdown_requested:
                try:
                    current_time = time.time()

                    # Heartbeat logging every 60 seconds
                    if current_time - last_heartbeat > 60:
                        uptime = int(current_time - monitor_start_time)
                        logger.info(f"💓 Speech monitor heartbeat - Uptime: {uptime}s, Processed: {processed_count}, Errors: {error_count}")
                        last_heartbeat = current_time

                    # Look for speech trigger files using cross-platform temp path
                    temp_dir = get_temp_path("")
                    speech_triggers = glob.glob(os.path.join(temp_dir, "review_gate_speech_trigger_*.json"))

                    for trigger_file in speech_triggers:
                        try:
                            # Validate file exists and is readable
                            if not os.path.exists(trigger_file):
                                continue

                            with open(trigger_file, 'r', encoding='utf-8') as f:
                                trigger_data = json.load(f)

                            if trigger_data.get('data', {}).get('tool') == 'speech_to_text':
                                logger.info(f"🎤 Processing speech-to-text request: {os.path.basename(trigger_file)}")
                                self._process_speech_request(trigger_data)
                                processed_count += 1

                                # Clean up trigger file safely
                                try:
                                    Path(trigger_file).unlink()
                                    logger.debug(f"🗑️ Cleaned up trigger file: {os.path.basename(trigger_file)}")
                                except Exception as cleanup_error:
                                    logger.warning(f"⚠️ Could not clean up trigger file: {cleanup_error}")

                        except json.JSONDecodeError as json_error:
                            logger.error(f"❌ Invalid JSON in speech trigger {trigger_file}: {json_error}")
                            error_count += 1
                            try:
                                Path(trigger_file).unlink()  # Remove invalid file
                            except:
                                pass

                        except Exception as e:
                            logger.error(f"❌ Error processing speech trigger {trigger_file}: {e}")
                            error_count += 1
                            try:
                                Path(trigger_file).unlink()
                            except:
                                pass

                    time.sleep(self.config.SPEECH_POLL_INTERVAL)  # Configurable speech polling interval

                except Exception as e:
                    logger.error(f"❌ Critical speech monitoring error: {e}")
                    error_count += 1
                    time.sleep(2)  # Longer wait on critical errors

                    # If too many errors, consider restarting
                    if error_count > 10:
                        logger.warning("⚠️ Too many speech monitoring errors - attempting recovery")
                        time.sleep(5)
                        error_count = 0  # Reset error count after recovery pause

            self._speech_monitoring_active = False
            logger.info("🛑 Speech monitoring thread stopped")

        try:
            # Start monitoring in background thread
            import threading
            self._speech_thread = threading.Thread(target=monitor_speech_triggers, daemon=True)
            self._speech_thread.name = "ReviewGate-SpeechMonitor"
            self._speech_thread.start()

            # Verify thread started successfully
            time.sleep(0.1)  # Give thread time to start
            if self._speech_thread.is_alive():
                logger.info("✅ Speech-to-text monitoring started successfully")
            else:
                logger.error("❌ Speech monitoring thread failed to start")
                self._speech_monitoring_active = False

        except Exception as e:
            logger.error(f"❌ Failed to start speech monitoring thread: {e}")
            self._speech_monitoring_active = False

    def _process_speech_request(self, trigger_data):
        """Process speech-to-text request"""
        try:
            audio_file = trigger_data.get('data', {}).get('audio_file')
            trigger_id = trigger_data.get('data', {}).get('trigger_id')

            if not audio_file or not trigger_id:
                logger.error("❌ Invalid speech request - missing audio_file or trigger_id")
                return

            if not self._whisper_model:
                error_detail = self._whisper_error or "Whisper model not available"
                logger.error(f"❌ Whisper model not available: {error_detail}")
                self._write_speech_response(trigger_id, "", f"Speech-to-text unavailable: {error_detail}")
                return

            if not os.path.exists(audio_file):
                logger.error(f"❌ Audio file not found: {audio_file}")
                self._write_speech_response(trigger_id, "", "Audio file not found")
                return

            logger.info(f"🎤 Transcribing audio: {audio_file}")

            # Transcribe audio using Faster-Whisper
            segments, info = self._whisper_model.transcribe(audio_file, beam_size=5)
            transcription = " ".join(segment.text for segment in segments).strip()

            logger.info(f"✅ Speech transcribed: '{transcription}'")

            # Write response
            self._write_speech_response(trigger_id, transcription)

            # Clean up audio file (MCP server is responsible for this)
            try:
                # Small delay to ensure any pending file operations complete
                import time
                time.sleep(0.1)

                if Path(audio_file).exists():
                    Path(audio_file).unlink()
                    logger.info(f"🗑️ Cleaned up audio file: {os.path.basename(audio_file)}")
                else:
                    logger.debug(f"Audio file already cleaned up: {os.path.basename(audio_file)}")
            except Exception as e:
                logger.warning(f"⚠️ Could not clean up audio file: {e}")

        except Exception as e:
            logger.error(f"❌ Speech transcription failed: {e}")
            trigger_id = trigger_data.get('data', {}).get('trigger_id', 'unknown')
            self._write_speech_response(trigger_id, "", str(e))

    def _write_speech_response(self, trigger_id, transcription, error=None):
        """Write speech-to-text response"""
        try:
            response_data = {
                'timestamp': datetime.now().isoformat(),
                'trigger_id': trigger_id,
                'transcription': transcription,
                'success': error is None,
                'error': error,
                'source': 'review_gate_whisper'
            }

            response_file = get_temp_path(f"review_gate_speech_response_{trigger_id}.json")
            with safe_file_operation(response_file, mode='w') as f:
                json.dump(response_data, f, indent=2)

            logger.info(f"📝 Speech response written: {response_file}")

        except Exception as e:
            logger.error(f"❌ Failed to write speech response: {e}")

    def get_speech_monitoring_status(self):
        """Get comprehensive status of speech monitoring system"""
        status = {
            "speech_monitoring_active": getattr(self, '_speech_monitoring_active', False),
            "speech_thread_alive": getattr(self, '_speech_thread', None) and self._speech_thread.is_alive(),
            "whisper_model_loaded": self._whisper_model is not None,
            "whisper_error": getattr(self, '_whisper_error', None),
            "faster_whisper_available": WHISPER_AVAILABLE
        }

        # Log status if there are issues
        if not status["speech_monitoring_active"]:
            logger.warning("⚠️ Speech monitoring is not active")
        if not status["speech_thread_alive"]:
            logger.warning("⚠️ Speech monitoring thread is not running")
        if not status["whisper_model_loaded"]:
            logger.warning(f"⚠️ Whisper model not loaded: {status['whisper_error']}")

        return status

async def main():
    """Main entry point for Review Gate v3 with immediate activation"""
    logger.info("🎬 STARTING Review Gate v3 MCP Server...")
    logger.info(f"Python version: {sys.version}")
    logger.info(f"Platform: {sys.platform}")
    logger.info(f"OS name: {os.name}")
    logger.info(f"Working directory: {os.getcwd()}")

    try:
        server = ReviewGateServer()
        await server.run()
    except Exception as e:
        logger.error(f"❌ Fatal error in MCP server: {e}")
        import traceback
        logger.error(traceback.format_exc())
        raise

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("🛑 Server stopped by user")
    except Exception as e:
        logger.error(f"❌ Server crashed: {e}")
        sys.exit(1)
