@echo off
title Hash API
REM Change directory to the project path
cd /d "C:\Users\Administrator\Documents\GitHub\okal-gateway"

REM Start the Node.js application with PM2
pm2 start hashAPI.js

REM Save the current PM2 process list
pm2 save

REM Setup PM2 to run on startup (make sure to run this as administrator)
pm2 startup
pause