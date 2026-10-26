@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   找不到 Node.js。请先安装 Node.js（https://nodejs.org）再运行本文件。
  echo.
  pause
  exit /b 1
)
echo.
echo   正在启动联机主机，浏览器会自动打开...
echo   把下面打印的「局域网」地址发给同网络的其他玩家，他们打开就能加入。
echo   关闭这个黑窗口 = 停止主机。
echo.
node tools\net-server.mjs
pause
