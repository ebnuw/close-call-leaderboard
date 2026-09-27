#!/usr/bin/env bash
# Archive the referee's rooms, commit what's new and push it to GitHub Pages.
# Run by the close-call-archive systemd user timer. A failed push is retried
# on the next run, since commits stay local until one succeeds.
set -euo pipefail
cd "$(dirname "$0")/.."
NODE="${NODE:-$HOME/.hermes/tools/node-26.7.0-linux-x64/bin/node}"

exec 9>"$(git rev-parse --git-dir)/publish.lock"
flock -n 9 || { echo "another run is in progress"; exit 0; }

"$NODE" tools/archive.mjs

if ! git diff --quiet -- data; then
  sweep=$("$NODE" -p 'require("./data/latest.json").sweep')
  git add data
  git commit -q -m "archive: sweep $sweep"
fi

if [ -n "$(git log origin/gh-pages..gh-pages --oneline 2>/dev/null || echo unpushed)" ]; then
  if git push -q origin gh-pages; then
    echo "pushed"
  else
    echo "push failed; commits stay local until the next run"
  fi
fi
