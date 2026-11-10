@echo off
chcp 936 >nul
setlocal enabledelayedexpansion
title Chaoxing Helper Setup / 学习通助手 安装

set "SRC=%~dp0app"
set "DST=%LOCALAPPDATA%\ChaoxingHelper"

if not exist "%SRC%\ChaoxingHelper.exe" (
  echo.
  echo  [ERROR] app\ChaoxingHelper.exe not found.
  echo  [错误] 找不到 app\ChaoxingHelper.exe
  echo  请确认已完整解压整个压缩包。
  echo.
  pause
  exit /b 1
)

echo.
echo  正在安装学习通助手到 %DST%
echo  Installing to %DST%
echo.

if not exist "%DST%" mkdir "%DST%" >nul 2>&1
robocopy "%SRC%" "%DST%" /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 >nul
if errorlevel 8 (
  echo  [ERROR] copy failed / 复制失败
  pause
  exit /b 1
)

echo  正在创建快捷方式 / Creating shortcuts...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell; $d = [Environment]::GetFolderPath('Desktop'); $l = $ws.CreateShortcut($d + '\ChaoxingHelper.lnk'); $l.TargetPath = '%DST%\ChaoxingHelper.exe'; $l.WorkingDirectory = '%DST%'; $l.Description = 'Chaoxing Helper'; $l.Save()" >nul 2>&1

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell; $p = $env:APPDATA + '\Microsoft\Windows\Start Menu\Programs\ChaoxingHelper.lnk'; $l = $ws.CreateShortcut($p); $l.TargetPath = '%DST%\ChaoxingHelper.exe'; $l.WorkingDirectory = '%DST%'; $l.Save()" >nul 2>&1

echo.
echo  安装完成，正在启动... / Done, launching...
start "" "%DST%\ChaoxingHelper.exe"
timeout /t 2 >nul
exit /b 0
