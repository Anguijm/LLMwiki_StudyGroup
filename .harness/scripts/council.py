#!/usr/bin/env python3
"""Gemini-powered council runner for LLMwiki_StudyGroup.

Reads every persona in .harness/council/ (except lead-architect.md and README.md),
dispatches them in parallel against the plan or diff, then runs the Lead Architect
persona to synthesize a single executable plan.

Usage:
    python3 .harness/scripts/council.py --plan .harness/active_plan.md
    python3 .harness/scripts/council.py --diff
    python3 .harness/scripts/council.py --diff --base main

Environment:
    GEMINI_API_KEY (required)
    HARNESS_MODEL  (optional, defaults to gemini-2.5-pro)
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
HARNESS_DIR = REPO_ROOT / ".harness"
COUNCIL_DIR = HARNESS_DIR / "council"
LAST_COUNCIL = HARNESS_DIR / "last_council.md"
YOLO_LOG = HARNESS_DIR / "yolo_log.jsonl"
HALT_FILE = REPO_ROOT / ".harness_halt"
SESSION_STATE = HARNESS_DIR / "session_state.json"

CALL_CAP = 15
DEFAULT_MODEL = os.environ.get("HARNESS_MODEL", "gemini-2.5-pro")
EXCLUDED_PERSONAS = {"lead-architect.md", "README.md"}


def die(msg: str, code: int = 1) -> None:
    print(f"[council] {msg}", file=sys.stderr)
    sys.exit(code)


def check_halt() -> None:
    if HALT_FILE.exists():
        contents = HALT_FILE.read_text().strip() or "(no reason given)"
        die(f"HALT file present at {HALT_FILE}. Remove it to resume.\nReason:\n{contents}", code=2)


def load_personas() -> list[tuple[str, str]]:
    personas = []
    for path in sorted(COUNCIL_DIR.glob("*.md")):
        if path.name in EXCLUDED_PERSONAS:
            continue
        personas.append((path.stem, path.read_text()))
    if not personas:
        die(f"No persona files found in {COUNCIL_DIR}")
    return personas


def load_lead() -> str:
    path = COUNCIL_DIR / "lead-architect.md"
    if not path.exists():
        die(f"Missing Lead Architect persona at {path}")
    return path.read_text()


def load_security_checklist() -> str:
    path = HARNESS_DIR / "scripts" / "security_checklist.md"
    if path.exists():
        return path.read_text()
    return "(security_checklist.md not found — Security reviewer will proceed without it.)"


def _plan_is_tracked(path: Path) -> bool:
    try:
        subprocess.check_output(
            ["git", "ls-files", "--error-unmatch", str(path.relative_to(REPO_ROOT))],
            cwd=REPO_ROOT,
            stderr=subprocess.STDOUT,
        )
        return True
    except subprocess.CalledProcessError:
        return False


def _plan_has_unstaged_changes(path: Path) -> bool:
    try:
        out = subprocess.check_output(
            ["git", "status", "--porcelain", str(path.relative_to(REPO_ROOT))],
            cwd=REPO_ROOT,
            text=True,
        )
        return bool(out.strip())
    except subprocess.CalledProcessError:
        return False


def get_plan_text(args: argparse.Namespace) -> tuple[str, str]:
    if args.plan:
        p = Path(args.plan)
        if not p.is_absolute():
            p = REPO_ROOT / p
        if not p.exists():
            die(f"Plan file not found: {p}")
        if not args.allow_untracked and not _plan_is_tracked(p):
            die(
                f"Plan file is untracked: {p.relative_to(REPO_ROOT)}\n"
                f"  Council refuses to run against a plan that does not exist in git — \n"
                f"  a chat-summary approval is not a council approval. Commit the plan first:\n"
                f"    git add {p.relative_to(REPO_ROOT)} && git commit -m 'docs: add active plan'\n"
                f"  Or pass --allow-untracked if you know what you are doing.",
                code=6,
            )
        if not args.allow_untracked and _plan_has_unstaged_changes(p):
            die(
                f"Plan file has unstaged changes: {p.relative_to(REPO_ROOT)}\n"
                f"  Commit the in-progress edits before running council, so the reviewed \n"
                f"  artifact matches what gets pushed. Or pass --allow-untracked.",
                code=7,
            )
        return f"PLAN FILE: {p.relative_to(REPO_ROOT)}", p.read_text()

    if args.diff:
        base = args.base
        diff = ""
        base_used = base
        missing_ref_markers = (
            "unknown revision",
            "bad revision",
            "ambiguous argument",
            "not a tree object",
        )
        try:
            diff = subprocess.check_output(
                ["git", "diff", f"{base}...HEAD"],
                cwd=REPO_ROOT,
                text=True,
                stderr=subprocess.STDOUT,
            )
        except subprocess.CalledProcessError as e:
            output = (e.output or "").strip()
            if any(m in output.lower() for m in missing_ref_markers):
                tail = output.splitlines()
                reason = tail[-1] if tail else "unknown error"
                print(
                    f"[council] base ref '{base}' unavailable ({reason}); "
                    f"falling back to working-tree diff (git diff HEAD).",
                    file=sys.stderr,
                )
                base_used = "HEAD (working tree, base missing)"
            else:
                die(f"git diff {base}...HEAD failed:\n{output}")
        if not diff.strip():
            try:
                diff = subprocess.check_output(
                    ["git", "diff", "HEAD"],
                    cwd=REPO_ROOT,
                    text=True,
                )
                if base_used == base:
                    base_used = "HEAD (working tree, empty vs base)"
            except subprocess.CalledProcessError as e:
                die(f"git diff HEAD failed: {e}")
        if not diff.strip():
            die("No diff to review (neither vs base nor working tree).")
        return f"DIFF vs {base_used}", diff

    die("Pass --plan <path> or --diff.")


def build_prompt(persona_body: str, source_label: str, source_text: str, extra: str = "") -> str:
    return (
        f"{persona_body}\n\n"
        f"---\n"
        f"CONTEXT SOURCE: {source_label}\n\n"
        f"{source_text}\n"
        f"---\n"
        f"{extra}\n"
        f"Respond in the exact output format specified above. Be concise. Do not restate the plan."
    )


class RequestBudget:
    """Thread-safe counter that bounds total Gemini requests including retries."""

    def __init__(self, cap: int) -> None:
        self.cap = cap
        self.used = 0
        self._lock = threading.Lock()

    def try_charge(self) -> bool:
        with self._lock:
            if self.used >= self.cap:
                return False
            self.used += 1
            return True

    def snapshot(self) -> tuple[int, int]:
        with self._lock:
            return self.used, self.cap


def call_gemini(
    client,
    model: str,
    prompt: str,
    budget: "RequestBudget",
    retries: int = 2,
) -> str:
    last_err: Exception | None = None
    for attempt in range(retries + 1):
        if not budget.try_charge():
            return (
                f"(skipped: global request budget of {budget.cap} exhausted "
                f"before attempt {attempt + 1})"
            )
        try:
            resp = client.generate_content(prompt)
            return (resp.text or "").strip() or "(empty response)"
        except Exception as e:  # noqa: BLE001
            last_err = e
            if attempt < retries:
                time.sleep(2**attempt)
    return f"(gemini call failed after {retries + 1} attempts: {last_err})"


def append_log(entry: dict) -> None:
    entry.setdefault("ts", datetime.now(timezone.utc).isoformat(timespec="seconds"))
    with YOLO_LOG.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")


def extract_score(text: str) -> int | None:
    for line in text.splitlines():
        s = line.strip().lower()
        if s.startswith("score:"):
            tail = s.split(":", 1)[1].strip()
            tail = tail.split("/")[0].split(" ")[0].strip()
            try:
                return int(float(tail))
            except ValueError:
                return None
    return None


def update_session_state_council(scores: dict[str, int | None], source_label: str) -> None:
    state: dict = {}
    if SESSION_STATE.exists():
        try:
            state = json.loads(SESSION_STATE.read_text() or "{}")
        except json.JSONDecodeError:
            state = {}
    state["last_council"] = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source_label,
        "scores": scores,
    }
    SESSION_STATE.write_text(json.dumps(state, indent=2) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="Gemini council runner.")
    parser.add_argument("--plan", help="Path to an active_plan.md to review.")
    parser.add_argument("--diff", action="store_true", help="Review git diff instead of a plan file.")
    parser.add_argument("--base", default="origin/main", help="Diff base (default origin/main).")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Gemini model ID.")
    parser.add_argument(
        "--allow-untracked",
        action="store_true",
        help="Allow council to run against an untracked or dirty plan file (escape hatch; default off).",
    )
    args = parser.parse_args()

    check_halt()

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        die(
            "GEMINI_API_KEY not set. Export it in your shell (see .harness/README.md).\n"
            "Example: export GEMINI_API_KEY=...",
            code=3,
        )

    try:
        import google.generativeai as genai
    except ImportError:
        die(
            "google-generativeai not installed.\n"
            "Run: pip install -r .harness/scripts/requirements.txt",
            code=4,
        )

    source_label, source_text = get_plan_text(args)
    personas = load_personas()

    total_calls = len(personas) + 1  # angles + lead
    if total_calls > CALL_CAP:
        die(
            f"Persona count ({len(personas)}) + Lead Architect exceeds cap ({CALL_CAP}).\n"
            f"Remove or disable angles in .harness/council/.",
            code=5,
        )

    genai.configure(api_key=api_key)
    model_client = genai.GenerativeModel(args.model)

    checklist = load_security_checklist()
    budget = RequestBudget(CALL_CAP)

    print(f"[council] Model: {args.model}")
    print(f"[council] Source: {source_label}")
    print(f"[council] Request budget: {CALL_CAP} (includes retries)")
    print(f"[council] Dispatching {len(personas)} angle reviews in parallel...")

    critiques: dict[str, str] = {}
    with ThreadPoolExecutor(max_workers=min(len(personas), 6)) as pool:
        futures = {}
        for name, body in personas:
            extra = (
                f"\nSECURITY CHECKLIST (for Security reviewer):\n{checklist}\n"
                if name == "security"
                else ""
            )
            prompt = build_prompt(body, source_label, source_text, extra=extra)
            futures[pool.submit(call_gemini, model_client, args.model, prompt, budget)] = name
        for fut in as_completed(futures):
            name = futures[fut]
            critiques[name] = fut.result()
            print(f"[council]   {name}: done")

    scores = {name: extract_score(text) for name, text in critiques.items()}

    print("[council] Running Lead Architect synthesis...")
    lead_body = load_lead()
    synthesis_payload = (
        f"ORIGINAL SOURCE: {source_label}\n\n"
        f"{source_text}\n\n"
        f"---\nREVIEWER CRITIQUES\n"
    )
    for name, text in sorted(critiques.items()):
        synthesis_payload += f"\n### {name}\n{text}\n"
    lead_prompt = build_prompt(lead_body, source_label, synthesis_payload)
    synthesis = call_gemini(model_client, args.model, lead_prompt, budget)
    used, cap = budget.snapshot()
    print(f"[council] Requests consumed: {used}/{cap}")

    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
    report = [
        f"# Council report — {ts}",
        "",
        f"**Source:** {source_label}",
        f"**Requests:** {used}/{cap}",
        "",
        "## Scores",
    ]
    for name in sorted(critiques):
        score = scores[name]
        report.append(f"- `{name}`: {score if score is not None else 'n/a'}")
    report.append("")
    report.append("## Lead Architect synthesis")
    report.append("")
    report.append(synthesis)
    report.append("")
    report.append("## Raw critiques")
    for name in sorted(critiques):
        report.append("")
        report.append(f"### {name}")
        report.append("")
        report.append(critiques[name])

    LAST_COUNCIL.write_text("\n".join(report) + "\n")
    append_log(
        {
            "event": "council_run",
            "source": source_label,
            "model": args.model,
            "scores": scores,
            "requests_used": used,
            "requests_cap": cap,
        }
    )
    update_session_state_council(scores, source_label)

    print(f"[council] Report written to {LAST_COUNCIL.relative_to(REPO_ROOT)}")
    print()
    print("=" * 72)
    print("LEAD ARCHITECT SYNTHESIS")
    print("=" * 72)
    print(synthesis)
    return 0


if __name__ == "__main__":
    sys.exit(main())
