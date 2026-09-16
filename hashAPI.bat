@echo off
title Hash API
REM Change directory to the project path
cd /d "C:\Users\Administrator\Documents\GitHub\okal-hash-api"

REM Conservative upstream limits: protect Hashavshevet from background bursts.
set NODE_ENV=production
set HASH_MAX_CONCURRENT_REQUESTS=4
set HASH_MAX_BACKGROUND_REQUESTS=1
set AUTH_SERVICE_LOG_URL=http://localhost:3000/api/internal/upstream-log

REM Restart the existing named process; start it only on first setup.
pm2 restart hashAPI --update-env
if errorlevel 1 pm2 start hashAPI.js --name hashAPI --update-env

REM Save the current PM2 process list
pm2 save

REM PM2 startup is a one-time Windows setup, not a command to run on every release.
pause
