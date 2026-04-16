#!/usr/bin/env bash
# Install harness git hooks by pointing core.hooksPath at .harness/hooks.
# Run once after cloning the repo.

set -eu

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"
if [ -z "$REPO_ROOT" ]; then
  echo "[install_hooks] Not inside a git repo. Run from within the checkout." >&2
  exit 1
fi

cd "$REPO_ROOT"

if [ ! -d .harness/hooks ]; then
  echo "[install_hooks] .harness/hooks not found at $REPO_ROOT/.harness/hooks" >&2
  exit 1
fi

# Make hooks executable (permissions can be dropped by some git operations).
chmod +x .harness/hooks/post-commit

git config core.hooksPath .harness/hooks

echo "[install_hooks] core.hooksPath set to .harness/hooks"
echo "[install_hooks] Installed: post-commit"
echo "[install_hooks] To uninstall: git config --unset core.hooksPath"
