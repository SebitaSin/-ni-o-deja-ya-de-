@echo off
title San Rafael Sentinel
set "APP=C:\Users\sebas\Documents\San Rafael Sentinel"
set "LOGDIR=%LOCALAPPDATA%\SanRafaelSentinel"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
echo.
echo   Abriendo San Rafael Sentinel...
echo.
if not exist "%APP%\windows\iniciar.ps1" (
  echo   No encuentro la app en "%APP%".
  pause
  exit /b 1
)
start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%APP%\windows\iniciar.ps1"
set "OK="
for /l %%i in (1,1,12) do (
  if not defined OK (
    timeout /t 1 /nobreak >nul
    powershell.exe -NoProfile -Command "try { if ((Invoke-WebRequest -Uri 'http://localhost:8765/__sentinel' -UseBasicParsing -TimeoutSec 2).Content -eq 'ok') { exit 0 } } catch { }; exit 1" >nul 2>&1 && set "OK=1"
  )
)
if not defined OK (
  echo   La app no arranco. Detalle:
  echo.
  if exist "%LOGDIR%\iniciar.log" (type "%LOGDIR%\iniciar.log") else (echo   PowerShell no llego a ejecutar el lanzador.)
  echo.
  echo   Saca una foto de esta ventana y mandasela a Claude.
  pause
  exit /b 1
)
echo   La app esta abierta. Creando el icono definitivo en el escritorio...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'San Rafael Sentinel.lnk')); $s.TargetPath=(Join-Path $env:APP 'windows\abrir.cmd'); $s.WorkingDirectory=(Join-Path $env:APP 'windows'); $s.IconLocation=(Join-Path $env:APP 'icons\sentinel.ico')+',0'; $s.WindowStyle=7; $s.Description='San Rafael Sentinel'; $s.Save()"
timeout /t 2 /nobreak >nul
(goto) 2>nul & del "%~f0"
