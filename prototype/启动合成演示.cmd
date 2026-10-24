@echo off
setlocal
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or later is required.
  pause
  exit /b 1
)
pushd "%~dp0"
if errorlevel 1 (
  echo Cannot open the prototype directory.
  pause
  exit /b 1
)
node.exe group-server.mjs --demo --host 0.0.0.0 --port 45076
popd
pause
