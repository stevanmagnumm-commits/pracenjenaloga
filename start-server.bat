@echo off
title Tracker Dev Server
cd /d "%~dp0"

echo Killing any existing node processes...
taskkill /F /IM node.exe >nul 2>&1
timeout /t 2 /nobreak >nul
del /f /q ".next\dev\lock" >nul 2>&1

echo Initializing database...
npx prisma generate >nul 2>&1
npx prisma db push --skip-generate >nul 2>&1

echo Starting server at http://localhost:3000
echo Scheduler will activate automatically.
echo Press Ctrl+C to stop.
echo.

start "" /B cmd /c "timeout /t 8 /nobreak >nul && curl -s http://localhost:3000/api/snapchat/check >nul 2>&1 && echo [startup] Scheduler activated."
npx next dev -H 0.0.0.0
pause
