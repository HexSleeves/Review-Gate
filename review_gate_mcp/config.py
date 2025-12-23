import os
import sys
import logging
import tempfile
from pathlib import Path

# Cross-platform temp directory helper
def get_temp_path(filename: str) -> str:
    """Get cross-platform temporary file path"""
    # Use /tmp/ for macOS and Linux, system temp for Windows
    if os.name == 'nt':  # Windows
        temp_dir = tempfile.gettempdir()
    else:  # macOS and Linux
        temp_dir = '/tmp'
    return os.path.join(temp_dir, filename)

def setup_logging():
    log_file_path = get_temp_path('review_gate_v2.log')

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
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        handlers=handlers
    )
    logger = logging.getLogger("review_gate_mcp")
    logger.info(f"🔧 Log file path: {log_file_path}")
    
    return logger

logger = setup_logging()
