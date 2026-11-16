# Find My Type — portable local font studio

Copy this entire folder to another computer. No npm packages, account, or hosted site are required.

## Requirements
Python 3.9 or newer, and a modern desktop browser. If Python is missing, install it from https://www.python.org/downloads/ . This package does not bundle Python.

## Start the app
- Mac: double-click Launch Find My Type.command.
- Windows: double-click Launch Find My Type.bat.
- Linux: run sh "Launch Find My Type.sh" in a terminal.
- Alternatively, run python3 serve.py (Windows: py -3 serve.py).

The launcher opens http://127.0.0.1:8765/ in your browser. Keep the terminal open while using the app. Press Ctrl+C to stop. If port 8765 is already in use, close the other app/server before starting. On Mac the launcher prefers Chrome if installed.

## Installed fonts
Click “Click here once to connect local fonts”.
- Windows and Linux: open the app in desktop Chrome or Edge and grant the font permission.
- Mac: Chrome/Edge use the browser permission. Safari and other browsers use the Mac local font service; the first scan can take about a minute.
- Import fonts works with TTF, OTF, WOFF and WOFF2 files; imported fonts must be imported again after reloading.

The tool reads fonts installed on the computer where it runs. Font files from your current computer are not included. Local categories, Tall and Condensed use name-based estimates; italics may be synthesized.

## Offline and storage
Installed/imported font previews work offline. Google Fonts previews need internet; the included catalog contains 1,950 families. Favourites and settings stay in the current browser on that computer and do not automatically transfer with this folder.

Export shortlist produces PNG sheets of favourite cards and a TXT file with font details. Allow multiple downloads if prompted. Reconnect fonts before exporting saved local favourites.

The local server binds only to 127.0.0.1. Font API requests from other websites are rejected. Fonts retain their own licenses.
