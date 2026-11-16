#!/bin/zsh
cd -- "${0:A:h}"
if command -v python3 >/dev/null 2>&1; then
    python3 serve.py
else
    print "Python 3 is needed to run Find My Type."
fi
print "Press Return to close this window."
read
