"""Read-only access to the deployed MCP outcome-feedback ledger.

The MCP service owns writes to this file. The web manager mounts the same
persistent volume read-only and uses only the stale tally for filtering and
display. Missing, unreadable, or corrupt telemetry must not break memory CRUD.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


class MemoryStatsReader:
    def __init__(self, file_path: Path) -> None:
        self.file_path = file_path

    def stale_counts(self) -> dict[str, int]:
        try:
            parsed: Any = json.loads(self.file_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        if not isinstance(parsed, dict) or parsed.get("version") != 1:
            return {}
        memories = parsed.get("memories")
        if not isinstance(memories, dict):
            return {}

        counts: dict[str, int] = {}
        for memory_id, raw_stats in memories.items():
            if not isinstance(memory_id, str) or not isinstance(raw_stats, dict):
                continue
            stale_count = raw_stats.get("staleCount")
            if isinstance(stale_count, int) and not isinstance(stale_count, bool) and stale_count > 0:
                counts[memory_id] = stale_count
        return counts
