@echo off
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel% equ 0 (
    py -3 serve.py
) else (
    where python >nul 2>nul
    if errorlevel 1 (
        echo Install Python 3 from python.org, then run this launcher again.
    ) else (
        python serve.py
    )
)
pause
