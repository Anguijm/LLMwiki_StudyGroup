# Learnings

Append-only knowledge base. Every completed task ends with a block below. Do not rewrite history; add new entries.

## Block format

```
## <YYYY-MM-DD HH:MM UTC> — <task title>
### KEEP
- <what worked; pattern worth repeating>
### IMPROVE
- <what to change next time>
### INSIGHT
- <non-obvious thing worth remembering; architecture lesson, cost gotcha, a user-truth, etc.>
### COUNCIL
- <notable feedback from the Gemini council run, if any; link to .harness/last_council.md snapshot if useful>
```

Keep each bullet tight. The goal is fast recall for the next session, not a blog post.

---

## 2026-04-16 — harness scaffolding landed
### KEEP
- Personas-as-files pattern from harness-cli lets the council stay version-controlled and PR-reviewable.
- Durable session split — human-readable `learnings.md`, machine-readable `session_state.json`, immutable `yolo_log.jsonl` — mirrors yolo-projects and holds up.
- Local-only Gemini runner avoids GitHub-secret rotation overhead and keeps council output out of PR comment noise.
### IMPROVE
- Quality gates deferred until Next.js scaffolding exists; revisit after the first few real commits.
- Post-commit hook only captures commit metadata; could later also summarize the diff via Haiku if cost allows.
### INSIGHT
- yolo-projects ships 210+ single-file HTML apps, so its tick/tock cron made sense there; here we are *one* complex app, so the hourly-propose pattern is a trap. Kept the council, dropped the cron.
- Cost cap of 15 Gemini calls per council run is a hard safety net, not a target — normal runs will use 7 (6 angles + Lead Architect).
### COUNCIL
- Not yet run. First invocation will be against the kickoff prompt once the user provides it.
