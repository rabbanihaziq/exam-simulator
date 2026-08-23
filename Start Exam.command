#!/bin/bash
# Double-click this file (macOS) to launch the exam simulator.
cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
  echo "Setting up for the first time (this happens once)…"
  python3 -m venv .venv
  ./.venv/bin/pip install --upgrade pip >/dev/null
  ./.venv/bin/pip install -r app/requirements.txt
fi

echo "Starting the exam simulator… your browser will open shortly."
./.venv/bin/python app/app.py
