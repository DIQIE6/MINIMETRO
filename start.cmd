@echo off
rem Starts the local server and opens the game in the default browser.
cd /d "%~dp0"
start "" http://127.0.0.1:8123/
node tools\serve.mjs
