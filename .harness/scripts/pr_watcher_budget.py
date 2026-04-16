#!/usr/bin/env python3
"""Monthly budget pre-flight for the PR watcher.

Counts `pr_watch_run` events in .harness/yolo_log.jsonl for the current
UTC calendar month. Writes `over_budget=true|false` to $GITHUB_OUTPUT
and prints a summary. Exits 0 in both cases (the workflow reads the
output to decide whether to run Claude).
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
LOG = REPO_ROOT / ".harness" / "yolo_log.jsonl"

MONTHLY_CAP = int(os.environ.get("MONTHLY_CAP", "150"))


def current_month_key() -> str:
    now = datetime.now(timezone.utc)
    return f"{now.year:04d}-{now.month:02d}"


def count_watcher_runs_this_month() -> int:
    if not LOG.exists():
        return 0
    month = current_month_key()
    n = 0
    for raw in LOG.read_text(encoding="utf-8").splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            entry = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if entry.get("event") != "pr_watch_run":
            continue
        ts = entry.get("ts", "")
        if ts.startswith(month):
            n += 1
    return n


def write_output(key: str, value: str) -> None:
    gh_out = os.environ.get("GITHUB_OUTPUT")
    if gh_out:
        with open(gh_out, "a", encoding="utf-8") as fh:
            fh.write(f"{key}={value}\n")
    print(f"[budget] {key}={value}")


def main() -> int:
    used = count_watcher_runs_this_month()
    over = used >= MONTHLY_CAP
    write_output("used", str(used))
    write_output("cap", str(MONTHLY_CAP))
    write_output("over_budget", "true" if over else "false")
    if over:
        print(
            f"[budget] cap exhausted ({used}/{MONTHLY_CAP}); watcher will skip this run.",
            file=sys.stderr,
        )
    else:
        print(f"[budget] ok: {used}/{MONTHLY_CAP} runs this month.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
