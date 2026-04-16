#!/usr/bin/env bash
# Append a {event: "pr_watch_run", ...} entry to .harness/yolo_log.jsonl
# and refresh .harness/session_state.json's last_pr_watch block.
# Called from the PR watcher workflow's final step.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

LOG=".harness/yolo_log.jsonl"
STATE=".harness/session_state.json"

PR="${PR_NUMBER:-unknown}"
TRIG="${TRIGGER:-unknown}"
OVER="${OVER_BUDGET:-false}"
TS="$(date -u +%Y-%m-%dT%H:%M:%S+00:00)"

# Append log line (jsonl).
python3 - <<PY
import json, os
entry = {
    "ts": "$TS",
    "event": "pr_watch_run",
    "pr": "$PR",
    "trigger": "$TRIG",
    "over_budget": "$OVER" == "true",
}
with open("$LOG", "a", encoding="utf-8") as fh:
    fh.write(json.dumps(entry) + "\n")
PY

# Update session_state.last_pr_watch without clobbering other fields.
python3 - <<PY
import json, os
from pathlib import Path
p = Path("$STATE")
state = {}
if p.exists():
    try:
        state = json.loads(p.read_text() or "{}")
    except json.JSONDecodeError:
        state = {}
state["last_pr_watch"] = {
    "ts": "$TS",
    "pr": "$PR",
    "trigger": "$TRIG",
    "over_budget": "$OVER" == "true",
}
p.write_text(json.dumps(state, indent=2) + "\n")
PY
