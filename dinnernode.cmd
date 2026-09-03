@echo off
rem DinnerNode node, one command. Windows; Linux and macOS are ./dinnernode.
rem
rem   git clone <repo> && cd dinnernode && dinnernode.cmd
rem
rem Double-clickable from Explorer as well as runnable from a terminal, which is
rem why it pauses at the end instead of closing the window on an error nobody
rem got to read. .cmd rather than .ps1 deliberately: a PowerShell script a
rem stranger downloads is blocked by the default execution policy, and telling a
rem new operator to change their execution policy is not an onboarding step.
rem
rem It holds no logic of its own. Dependency freshness is scripts\deps-stale.mjs
rem and the public tunnel is src\tunnel.ts, both shared with the POSIX launcher.
setlocal
cd /d "%~dp0"

where node >nul 2>&1 || (
  echo [X] node is not installed. Get it from https://nodejs.org ^(version 20 or newer^).
  echo     or: winget install OpenJS.NodeJS.LTS
  goto :fail
)
where npm >nul 2>&1 || (
  echo [X] npm is not installed. It ships with node: https://nodejs.org
  goto :fail
)

rem ---- dependencies ---------------------------------------------------------
node scripts\deps-stale.mjs
if not errorlevel 1 (
  echo installing dependencies ^(first run takes a minute^)
  call npm install --no-audit --no-fund || goto :fail
)

rem ---- setup ----------------------------------------------------------------
rem Interactive and idempotent. Exits nonzero if the node is not ready to serve,
rem having already printed what to fix.
call npm run --silent setup || goto :fail

rem ---- serve ----------------------------------------------------------------
echo.
call npm run --silent host
goto :done

:fail
echo.
rem Only pause when launched from Explorer, where the window closes on exit and
rem takes the message with it. From a terminal the operator can already read it.
echo %CMDCMDLINE% | find /i "/c" >nul && pause
endlocal
exit /b 1

:done
endlocal
exit /b 0
