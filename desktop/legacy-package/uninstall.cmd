@echo off
chcp 936 >nul
setlocal
title Chaoxing Helper Uninstall / 学习通助手 卸载

set "DST=%LOCALAPPDATA%\ChaoxingHelper"
set "DATA=%APPDATA%\chaoxing-helper-desktop"

echo.
echo  即将卸载学习通助手 / Uninstall Chaoxing Helper
echo.
set /p OK="  确认卸载? Confirm (Y/N): "
if /i not "%OK%"=="Y" exit /b 0

taskkill /f /im "ChaoxingHelper.exe" >nul 2>&1
timeout /t 1 >nul

if exist "%DST%" rd /s /q "%DST%"
del "%USERPROFILE%\Desktop\ChaoxingHelper.lnk" >nul 2>&1
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\ChaoxingHelper.lnk" >nul 2>&1

echo.
echo  程序已删除。/ Program removed.
set /p DELDATA="  同时删除登录数据? Delete login data too? (Y/N): "
if /i "%DELDATA%"=="Y" (
  if exist "%DATA%" rd /s /q "%DATA%"
  echo  登录数据已删除。/ Login data removed.
) else (
  echo  登录数据已保留。/ Login data kept.
)

echo.
echo  卸载完成。/ Done.
pause
