#!/bin/bash
# Builds an AgentCRM.app on your Desktop. Double-clicking it starts the dev server
# (when it is not already running) and opens the desktop app, via scripts/start-macos.sh.
# Run this once; run it again after moving the repository. macOS only.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
app="$HOME/Desktop/AgentCRM.app"

mkdir -p "$repo/data/logs"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cat >"$tmp/launch.applescript" <<EOF
do shell script "/bin/zsh -lc 'mkdir -p \"$repo/data/logs\"; nohup \"$repo/scripts/start-macos.sh\" >>\"$repo/data/logs/launcher.log\" 2>&1 &'"
EOF

rm -rf "$app"
osacompile -o "$app" "$tmp/launch.applescript"
echo "Created $app"
echo "Launcher output goes to $repo/data/logs/launcher.log"
echo "First launch: when the repository lives in a protected folder (Desktop, Documents,"
echo "Downloads), macOS asks once to allow AgentCRM access to that folder. Click Allow."
