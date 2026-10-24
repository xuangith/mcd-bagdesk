@echo off
setlocal
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or later is required. Please use the installed Node.js path.
  pause
  exit /b 1
)
pushd "%~dp0"
if errorlevel 1 (
  echo Cannot open the prototype directory.
  pause
  exit /b 1
)
if exist ..\.env (
  node.exe --env-file=..\.env group-server.mjs --host 0.0.0.0 --port 45075 --token-file ..\token.txt
) else (
  node.exe group-server.mjs --host 0.0.0.0 --port 45075 --token-file ..\token.txt
)
popd
pause
