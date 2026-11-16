#!/bin/sh
cd -- "$(dirname -- "$0")" || exit 1
if command -v python3 >/dev/null 2>&1; then
    python3 serve.py
else
    echo "Install Python 3, then run this launcher again."
fi
