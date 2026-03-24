import json
import os
import time
import asyncio
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, Any
import glob
import tempfile

from .config import logger, get_temp_path
from .utils import sync_file_system, write_json_atomic


TRIGGER_FILE_NAME = "review_gate_trigger.json"
PROGRESS_FILE_NAME = "review_gate_progress.json"

class IPCManager:
    """Handles file-based IPC between MCP server and Cursor Extension"""

    def _trigger_file(self) -> Path:
        return Path(get_temp_path(TRIGGER_FILE_NAME))

    def _ack_file(self, trigger_id: str) -> Path:
        return Path(get_temp_path(f"review_gate_ack_{trigger_id}.json"))

    def _response_file(self, trigger_id: str) -> Path:
        return Path(get_temp_path(f"review_gate_response_{trigger_id}.json"))

    def _progress_file(self) -> Path:
        return Path(get_temp_path(PROGRESS_FILE_NAME))

    async def trigger_cursor_popup_immediately(self, data: dict) -> bool:
        """Create trigger file for Cursor extension with immediate activation"""
        try:
            # Add delay before creating trigger to ensure readiness
            await asyncio.sleep(0.1)  # Wait 100ms before trigger creation

            trigger_file = self._trigger_file()
            self._cleanup_request_files(data.get("trigger_id"))

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

            write_json_atomic(str(trigger_file), trigger_data)
            
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
            
            # Force file system sync with retry
            for attempt in range(3):
                try:
                    sync_file_system()
                    break
                except Exception as sync_error:
                    logger.warning(f"⚠️ Sync attempt {attempt + 1} failed: {sync_error}")
                    await asyncio.sleep(0.1)  # Wait 100ms between attempts
            
            logger.info(f"🔥 IMMEDIATE trigger created for Cursor: {trigger_file}")
            logger.info(f"📁 Trigger file path: {trigger_file.absolute()}")
            logger.info(f"📊 Trigger file size: {file_size} bytes")

            # Add small delay to allow extension to process
            await asyncio.sleep(0.2)  # Wait 200ms for extension to process
            
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

    async def wait_for_extension_acknowledgement(self, trigger_id: str, timeout: int = 30) -> bool:
        """Wait for extension acknowledgement that popup was activated"""
        ack_file = self._ack_file(trigger_id)
        
        logger.info(f"🔍 Monitoring for extension acknowledgement: {ack_file}")
        
        start_time = time.time()
        check_interval = 0.1  # Check every 100ms for fast response
        
        while time.time() - start_time < timeout:
            try:
                if ack_file.exists():
                    data = json.loads(ack_file.read_text())
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

    async def wait_for_user_input(self, trigger_id: str, timeout: int = 120) -> Optional[tuple[str, list]]:
        """
        Wait for user input from the Cursor extension popup.
        Returns: Tuple[user_input_string, attachments_list] or None
        """
        response_file = self._response_file(trigger_id)

        logger.info(f"👁️ Monitoring for response file: {response_file}")
        logger.info(f"🔍 Trigger ID: {trigger_id}")
        
        start_time = time.time()
        check_interval = 0.1  # Check every 100ms for faster response
        
        while time.time() - start_time < timeout:
            try:
                if response_file.exists():
                    try:
                        file_content = response_file.read_text().strip()
                        logger.info(f"📄 Found response file {response_file}: {file_content[:200]}...")

                        attachments = []
                        user_input = ""

                        if file_content.startswith('{'):
                            data = json.loads(file_content)
                            response_trigger_id = data.get("trigger_id", "")
                            if response_trigger_id and response_trigger_id != trigger_id:
                                logger.warning(
                                    f"⚠️ Ignoring mismatched response trigger: expected {trigger_id}, got {response_trigger_id}"
                                )
                                await asyncio.sleep(check_interval)
                                continue

                            user_input = data.get(
                                "user_input", data.get("response", data.get("message", ""))
                            ).strip()
                            attachments = data.get("attachments", [])
                        else:
                            user_input = file_content

                        try:
                            response_file.unlink()
                            logger.info(f"🧹 Response file cleaned up: {response_file}")
                        except Exception as cleanup_error:
                            logger.warning(f"⚠️ Cleanup error: {cleanup_error}")

                        if attachments:
                            logger.info(f"📎 Found {len(attachments)} attachments")

                        if user_input:
                            logger.info(f"🎉 RECEIVED USER INPUT for trigger {trigger_id}: {user_input[:100]}...")
                            return user_input, attachments

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
        
    async def get_any_user_input(self, timeout: int = 10) -> Optional[str]:
        """Retrieve user input from any available response files (for get_user_input tool)"""
        logger.info(f"🔍 CHECKING for user input (timeout: {timeout}s)")
        
        response_patterns = [
            os.path.join(tempfile.gettempdir(), "review_gate_response_*.json"),
        ]
        
        start_time = time.time()
        
        while time.time() - start_time < timeout:
            try:
                for pattern in response_patterns:
                    matching_files = glob.glob(pattern)
                    for response_file_path in matching_files:
                        response_file = Path(response_file_path)
                        if response_file.exists():
                            try:
                                file_content = response_file.read_text().strip()
                                logger.info(f"📄 Found response file {response_file}: {file_content[:200]}...")
                                
                                if file_content.startswith('{'):
                                    data = json.loads(file_content)
                                    user_input = data.get("user_input", data.get("response", data.get("message", ""))).strip()
                                else:
                                    user_input = file_content
                                
                                if user_input:
                                    try:
                                        response_file.unlink()
                                        logger.info(f"🧹 Response file cleaned up: {response_file}")
                                    except Exception as cleanup_error:
                                        logger.warning(f"⚠️ Cleanup error: {cleanup_error}")
                                    
                                    logger.info(f"✅ RETRIEVED USER INPUT: {user_input[:100]}...")
                                    return user_input
                                    
                            except Exception as e:
                                logger.error(f"❌ Error processing response file {response_file}: {e}")
                
                await asyncio.sleep(0.5)
                
            except Exception as e:
                logger.error(f"❌ Error in get_any_user_input loop: {e}")
                await asyncio.sleep(1)
                
        return None

    def cleanup_temp_files(self):
        """Clean up temporary trigger and audio files"""
        try:
            temp_files = [
                get_temp_path(TRIGGER_FILE_NAME),
                get_temp_path(PROGRESS_FILE_NAME),
            ]
            for temp_file in temp_files:
                if Path(temp_file).exists():
                    Path(temp_file).unlink()
                    logger.info(f"🗑️ Cleaned up: {os.path.basename(temp_file)}")
                    
            # Clean up old audio files
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

    async def send_progress_update(
        self,
        title: str = "Processing...",
        percentage: float = 0,
        step: str = "Starting...",
        status: str = "active"
    ) -> bool:
        """
        Send a progress update to the Cursor extension webview.

        Args:
            title: Overall task title (e.g., "Analyzing Code")
            percentage: Progress percentage (0-100)
            step: Current step description (e.g., "Scanning files...")
            status: Status - 'active' or 'completed'

        Returns:
            True if progress update was sent successfully
        """
        try:
            progress_file = Path(get_temp_path("review_gate_progress.json"))

            progress_data = {
                "timestamp": datetime.now().isoformat(),
                "system": "review-gate-v3",
                "type": "progress_update",
                "data": {
                    "title": title,
                    "percentage": percentage,
                    "step": step,
                    "status": status
                }
            }

            logger.debug(f"📊 Sending progress update: {percentage}% - {step}")

            write_json_atomic(str(progress_file), progress_data)

            # Force sync
            try:
                sync_file_system()
            except:
                pass

            return True

        except Exception as e:
            logger.error(f"❌ Failed to send progress update: {e}")
            return False

    async def clear_progress(self) -> bool:
        """Clear the progress indicator in the Cursor extension."""
        try:
            progress_file = Path(get_temp_path("review_gate_progress.json"))
            if progress_file.exists():
                progress_file.unlink()
            return True
        except Exception as e:
            logger.error(f"❌ Failed to clear progress: {e}")
            return False

    def _cleanup_request_files(self, trigger_id: Optional[str]) -> None:
        """Remove stale files for a specific trigger before reusing its identifier."""
        if not trigger_id:
            return

        for file_path in (self._ack_file(trigger_id), self._response_file(trigger_id)):
            try:
                if file_path.exists():
                    file_path.unlink()
                    logger.info(f"🧹 Removed stale IPC file: {file_path.name}")
            except Exception as cleanup_error:
                logger.warning(f"⚠️ Could not remove stale IPC file {file_path}: {cleanup_error}")
