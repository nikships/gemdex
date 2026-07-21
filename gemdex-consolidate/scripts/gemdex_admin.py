#!/usr/bin/env python3
"""
gemdex_admin.py — thin admin client for the `gemdex serve` localhost sidecar.

The gemdex MCP surface deliberately exposes NO delete tool: deletion is only
reachable via the sidecar's token-gated `DELETE /memories/:id` route (see
packages/mcp/src/serve.ts). This helper boots that sidecar, performs the
token handshake, and exposes the read + delete primitives the consolidation
skill needs:

    list      → GET  /memories        (summaries, newest-first)
    export    → GET  /export          (full content of every memory, JSONL)
    get       → GET  /memories/:id     (one full memory)
    save      → POST /memories         (create the canonical merged memory)
    update    → PUT  /memories/:id     (rewrite an existing memory in place)
    delete    → DELETE /memories/:id   (HARD, irreversible delete)

The sidecar is booted per invocation, the handshake line
(`PORT=<n> TOKEN=<hex>`) is read from stdout, requests are made against
127.0.0.1 with the `X-Gemdex-Token` header, and the sidecar is torn down on
exit. Local mode requires a validated GEMINI_API_KEY (the sidecar answers
`503 {needsKey:true}` on data routes until one is present); this script
surfaces that clearly instead of hanging.

Usage:
    gemdex_admin.py list [--json]
    gemdex_admin.py export                 # JSONL: one full memory per line
    gemdex_admin.py get <id>
    gemdex_admin.py save   --file <path>   # JSON body: {content,title?,attachments?}
    gemdex_admin.py update <id> --file <path>
    gemdex_admin.py delete <id> [<id> ...] # HARD delete; irreversible

Env:
    GEMDEX_BIN   path to the gemdex CLI/dist entry (default: resolve `gemdex`
                 on PATH, else packages/mcp/dist/index.js via node).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Optional


HANDSHAKE_RE = re.compile(r"PORT=(\d+)\s+TOKEN=([0-9a-f]+)")


def _resolve_launch_cmd() -> list[str]:
    """Return the argv prefix that launches `gemdex serve`."""
    override = os.environ.get("GEMDEX_BIN")
    if override:
        if override.endswith(".js"):
            return ["node", override]
        return [override]
    on_path = shutil.which("gemdex")
    if on_path:
        return [on_path]
    # Fall back to the local monorepo build. This folder lives at the repo root
    # (gemdex/gemdex-consolidate/scripts/), so the built entry is two levels up.
    here = os.path.dirname(os.path.abspath(__file__))
    candidate = os.path.abspath(
        os.path.join(here, "..", "..", "packages", "mcp", "dist", "index.js")
    )
    if os.path.exists(candidate):
        return ["node", candidate]
    raise SystemExit(
        "Could not find the gemdex binary. Install it on PATH, or set "
        "GEMDEX_BIN to the CLI path (or packages/mcp/dist/index.js)."
    )


class Sidecar:
    """Boots `gemdex serve`, reads the PORT/TOKEN handshake, tears it down."""

    def __init__(self) -> None:
        self.proc: Optional[subprocess.Popen] = None
        self.port: Optional[int] = None
        self.token: Optional[str] = None

    def __enter__(self) -> "Sidecar":
        cmd = _resolve_launch_cmd() + ["serve"]
        self.proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        deadline = time.time() + 20
        assert self.proc.stdout is not None
        while time.time() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                if self.proc.poll() is not None:
                    raise SystemExit("gemdex serve exited before handshake.")
                continue
            m = HANDSHAKE_RE.search(line)
            if m:
                self.port = int(m.group(1))
                self.token = m.group(2)
                return self
        raise SystemExit("Timed out waiting for the sidecar PORT/TOKEN handshake.")

    def __exit__(self, *exc: Any) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()

    def _req(self, method: str, path: str, body: Optional[dict] = None) -> Any:
        url = f"http://127.0.0.1:{self.port}{path}"
        data = json.dumps(body).encode() if body is not None else None
        # The sidecar validates a local GEMINI_API_KEY asynchronously on boot and
        # answers 503 {needsKey:true} on data routes until it passes. Retry for a
        # bounded window so a fresh launch doesn't spuriously fail the race.
        deadline = time.time() + 30
        while True:
            req = urllib.request.Request(url, data=data, method=method)
            req.add_header("X-Gemdex-Token", self.token or "")
            if body is not None:
                req.add_header("Content-Type", "application/json")
            try:
                with urllib.request.urlopen(req, timeout=120) as resp:
                    raw = resp.read().decode()
                    return json.loads(raw) if raw.strip() else None
            except urllib.error.HTTPError as e:
                detail = e.read().decode(errors="replace")
                if e.code == 503 and "needsKey" in detail:
                    if time.time() < deadline:
                        time.sleep(1)
                        continue
                    raise SystemExit(
                        "Sidecar has no validated GEMINI_API_KEY (local mode). "
                        "Set one in the desktop app or ~/.gemdex/.env, then retry."
                    )
                raise SystemExit(f"HTTP {e.code} on {method} {path}: {detail}")
            except urllib.error.URLError as e:
                raise SystemExit(f"Request failed on {method} {path}: {e}")

    # --- primitives -----------------------------------------------------
    def list(self) -> Any:
        return self._req("GET", "/memories")

    def export(self) -> str:
        # /export streams JSONL (one record per line).
        url = f"http://127.0.0.1:{self.port}/export"
        req = urllib.request.Request(url, method="GET")
        req.add_header("X-Gemdex-Token", self.token or "")
        with urllib.request.urlopen(req, timeout=300) as resp:
            return resp.read().decode()

    def get(self, mid: str) -> Any:
        return self._req("GET", f"/memories/{mid}")

    def save(self, body: dict) -> Any:
        return self._req("POST", "/memories", body)

    def update(self, mid: str, body: dict) -> Any:
        return self._req("PUT", f"/memories/{mid}", body)

    def delete(self, mid: str) -> Any:
        return self._req("DELETE", f"/memories/{mid}")


def main() -> int:
    ap = argparse.ArgumentParser(description="gemdex sidecar admin client")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_list = sub.add_parser("list")
    p_list.add_argument("--json", action="store_true")

    sub.add_parser("export")

    p_get = sub.add_parser("get")
    p_get.add_argument("id")

    p_save = sub.add_parser("save")
    p_save.add_argument("--file", required=True)

    p_update = sub.add_parser("update")
    p_update.add_argument("id")
    p_update.add_argument("--file", required=True)

    p_del = sub.add_parser("delete")
    p_del.add_argument("ids", nargs="+")

    args = ap.parse_args()

    with Sidecar() as s:
        if args.cmd == "list":
            data = s.list()
            if args.json:
                print(json.dumps(data, indent=2))
            else:
                for m in (data.get("memories", data) if isinstance(data, dict) else data):
                    print(f"{m['id']}\t{m.get('title','')}\t{m.get('updatedAt','')}")
        elif args.cmd == "export":
            sys.stdout.write(s.export())
        elif args.cmd == "get":
            print(json.dumps(s.get(args.id), indent=2))
        elif args.cmd == "save":
            with open(args.file) as f:
                body = json.load(f)
            print(json.dumps(s.save(body), indent=2))
        elif args.cmd == "update":
            with open(args.file) as f:
                body = json.load(f)
            print(json.dumps(s.update(args.id, body), indent=2))
        elif args.cmd == "delete":
            for mid in args.ids:
                s.delete(mid)
                print(f"deleted {mid}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
