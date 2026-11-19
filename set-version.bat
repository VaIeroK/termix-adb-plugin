@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js is not installed or not in PATH.
  pause
  exit /b 1
)

for /f "usebackq delims=" %%v in (`node -p "require('./manifest.json').version"`) do set CURV=%%v
for /f "usebackq delims=" %%v in (`node -p "require('./manifest.json').engine.termix"`) do set CURT=%%v
for /f "usebackq delims=" %%v in (`node -p "require('./manifest.json').engine.api"`) do set CURA=%%v

echo Current plugin version: %CURV%
echo Current engine.termix:  %CURT%
echo Current engine.api:     %CURA%
echo (Press Enter on a question to keep the current value)
echo.
set "NEWV="
set /p NEWV=New plugin version [%CURV%]: 
if "%NEWV%"=="" set NEWV=%CURV%
set "NEWT="
set /p NEWT=New engine.termix [%CURT%]: 
set "NEWA="
set /p NEWA=New engine.api [%CURA%]: 

node scripts/set-version.mjs "%NEWV%" "%NEWT%" "%NEWA%"
if errorlevel 1 (
  pause
  exit /b 1
)
echo.
echo Done. Run build.bat to test and pack.
pause
