@echo off
setlocal
cd /d "%~dp0"
echo === ADB plugin: full build ===

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js is not installed or not in PATH.
  goto fail
)

echo [0/7] Installing dependencies (SDK 2.x required)...
call npm install
if errorlevel 1 goto fail
node -e "const v=require('./node_modules/@termix-ssh/plugin-sdk/package.json').version;if(parseInt(v)<2){console.error('Old SDK '+v+' installed. Delete node_modules and package-lock.json, run again.');process.exit(1)}"
if errorlevel 1 goto fail

echo [1/7] Typecheck...
call npm run typecheck
if errorlevel 1 goto fail

echo [2/7] Tests...
call npm test
if errorlevel 1 goto fail

echo [3/7] Build...
call npm run build
if errorlevel 1 goto fail

echo [4/7] Validate...
call npm run validate
if errorlevel 1 goto fail

echo [5/7] Pack...
call npm run pack
if errorlevel 1 goto fail

echo [6/7] SHA-256...
node scripts/sha256.mjs
if errorlevel 1 goto fail

echo [7/7] Done.
echo.
echo SUCCESS. The .tmxplug file is in this folder.
pause
exit /b 0

:fail
echo.
echo FAILED. Fix the problem above and run build.bat again. No package was produced by this run.
pause
exit /b 1
