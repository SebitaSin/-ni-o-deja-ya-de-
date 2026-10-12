@echo off
rem San Rafael Sentinel: abre la app (servidor local + ventana de Chrome o Edge) y se cierra.
set "DIR=%~dp0"
set "LOGDIR=%LOCALAPPDATA%\SanRafaelSentinel"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
echo %date% %time% abrir >> "%LOGDIR%\abrir.log"
start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%DIR%iniciar.ps1"
