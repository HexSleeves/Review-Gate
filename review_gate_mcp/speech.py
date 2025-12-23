import json
import os
import time
import threading
import glob
from pathlib import Path
from datetime import datetime

try:
    from faster_whisper import WhisperModel
    WHISPER_AVAILABLE = True
except ImportError:
    WHISPER_AVAILABLE = False
    WhisperModel = None

from .config import logger, get_temp_path

class SpeechHandler:
    def __init__(self, shutdown_event=None):
        self._whisper_model = None
        self._whisper_error = None
        self._speech_monitoring_active = False
        self._speech_thread = None
        # shutdown_event can be a threading.Event or a simple lambda check
        self.shutdown_check = shutdown_event if shutdown_event else (lambda: False)

        if WHISPER_AVAILABLE:
            self._whisper_model = self._initialize_whisper_model()
        else:
            logger.warning("⚠️ Faster-Whisper not available - speech-to-text will be disabled")
            logger.warning("💡 To enable speech features, install: pip install faster-whisper")
            self._whisper_error = "faster-whisper package not installed"

    def _initialize_whisper_model(self):
        """Initialize Whisper model with comprehensive error handling and fallbacks"""
        try:
            logger.info("🎤 Loading Faster-Whisper model for speech-to-text...")
            
            # Try different model configurations in order of preference
            model_configs = [
                {"model": "base", "device": "cpu", "compute_type": "int8"},
                {"model": "tiny", "device": "cpu", "compute_type": "int8"},
                {"model": "base", "device": "cpu", "compute_type": "float32"},
                {"model": "tiny", "device": "cpu", "compute_type": "float32"},
            ]
            
            for i, config in enumerate(model_configs):
                try:
                    logger.info(f"🔄 Attempting to load {config['model']} model (attempt {i+1}/{len(model_configs)})")
                    model = WhisperModel(config['model'], device=config['device'], compute_type=config['compute_type'])
                    
                    # Test the model with a quick inference to ensure it works
                    logger.info(f"✅ Successfully loaded {config['model']} model with {config['compute_type']}")
                    logger.info(f"📊 Model info - Device: {config['device']}, Compute: {config['compute_type']}")
                    return model
                    
                except Exception as model_error:
                    logger.warning(f"⚠️ Failed to load {config['model']} model: {model_error}")
                    if i == len(model_configs) - 1:
                        # This was the last attempt
                        raise model_error
                    continue
            
        except Exception as e:
            error_msg = f"Whisper model initialization failed: {e}"
            logger.error(f"❌ {error_msg}")
            
            if "CUDA" in str(e):
                logger.error("💡 CUDA issue detected - make sure you have CPU-only version")
                error_msg += " (CUDA compatibility issue)"
            elif "Visual Studio" in str(e) or "MSVC" in str(e):
                logger.error("💡 Visual C++ issue detected on Windows")
                error_msg += " (Visual C++ dependency missing)"
            elif "Permission" in str(e):
                logger.error("💡 Permission issue - check file access")
                error_msg += " (Permission denied)"
            elif "disk space" in str(e).lower():
                logger.error("💡 Disk space issue")
                error_msg += " (Insufficient disk space)"
            
            self._whisper_error = error_msg
            return None

    def start_monitoring(self):
        """Start monitoring for speech-to-text trigger files"""
        self._speech_monitoring_active = False
        self._speech_thread = None
        
        try:
            # Start monitoring in background thread
            self._speech_thread = threading.Thread(target=self._monitor_loop, daemon=True)
            self._speech_thread.name = "ReviewGate-SpeechMonitor"
            self._speech_thread.start()
            
            time.sleep(0.1)  # Give thread time to start
            if self._speech_thread.is_alive():
                logger.info("✅ Speech-to-text monitoring started successfully")
            else:
                logger.error("❌ Speech monitoring thread failed to start")
                self._speech_monitoring_active = False
                
        except Exception as e:
            logger.error(f"❌ Failed to start speech monitoring thread: {e}")
            self._speech_monitoring_active = False

    def _monitor_loop(self):
        """Enhanced speech monitoring with health checks and better error handling"""
        monitor_start_time = time.time()
        processed_count = 0
        error_count = 0
        last_heartbeat = time.time()
        
        logger.info("🎤 Speech monitoring thread started successfully")
        self._speech_monitoring_active = True
        
        while not self.shutdown_check():
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
                
                time.sleep(0.5)  # Check every 500ms
                
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
            with open(response_file, 'w') as f:
                json.dump(response_data, f, indent=2)
            
            logger.info(f"📝 Speech response written: {response_file}")
            
        except Exception as e:
            logger.error(f"❌ Failed to write speech response: {e}")
            
    def get_status(self):
        """Get comprehensive status of speech monitoring system"""
        status = {
            "speech_monitoring_active": getattr(self, '_speech_monitoring_active', False),
            "speech_thread_alive": getattr(self, '_speech_thread', None) and self._speech_thread.is_alive(),
            "whisper_model_loaded": self._whisper_model is not None,
            "whisper_error": getattr(self, '_whisper_error', None),
            "faster_whisper_available": WHISPER_AVAILABLE
        }
        return status
