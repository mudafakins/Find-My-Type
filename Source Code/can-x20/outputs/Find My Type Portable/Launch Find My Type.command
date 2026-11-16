#!/bin/zsh
cd -- "${0:A:h}"
if command -v python3 >/dev/null 2>&1; then
    python3 serve.py
else
    print "Install Python 3 from python.org, then open this launcher again."
fi
print "Press Return to close this window."
read
