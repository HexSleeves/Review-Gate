import json
import os
import tempfile
from pathlib import Path
from typing import Any
from .config import get_temp_path

# Re-exporting get_temp_path for convenience if other modules import from utils
# In this refactor, get_temp_path is defined in config to avoid circular imports 
# (since logging needs it). 
# We can just import it from config.

def write_json_atomic(path: str, payload: Any) -> None:
    """Write JSON to a file atomically using a same-directory temp file."""
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(
        prefix=f".{destination.name}.{os.getpid()}.",
        suffix=".tmp",
        dir=destination.parent,
    )
    os.close(fd)
    temp_path = Path(temp_name)
    try:
        temp_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        os.replace(temp_path, destination)
    finally:
        if temp_path.exists():
            temp_path.unlink(missing_ok=True)


def sync_file_system() -> None:
    """Best-effort file system sync for IPC handoff."""
    sync_fn = getattr(os, "sync", None)
    if sync_fn is not None:
        sync_fn()


__all__ = ["get_temp_path", "sync_file_system", "write_json_atomic"]
