@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js is not installed or not in PATH.
  pause
  exit /b 1
)
node scripts/set-version.mjs
if errorlevel 1 (
  pause
  exit /b 1
)
echo.
echo Done. Run build.bat to test and pack.
pause
