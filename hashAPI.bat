@echo off
title Hash API
REM Change directory to the project path
cd /d "C:\Users\Administrator\Documents\GitHub\okal-hash-api"

REM Upstream limits (concurrency, slot wait, breaker, log URL) live in config\default.json
REM under "resilience". A HASH_* environment variable set here would override them.
set NODE_ENV=production

REM Restart the existing named process; start it only on first setup.
pm2 restart hashAPI --update-env
if errorlevel 1 pm2 start hashAPI.js --name hashAPI --update-env

REM Save the current PM2 process list
pm2 save

REM PM2 startup is a one-time Windows setup, not a command to run on every release.
pause
