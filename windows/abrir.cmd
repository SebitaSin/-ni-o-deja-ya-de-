@echo off
rem San Rafael Sentinel: abre la app (servidor local + ventana de Chrome o Edge) y se cierra.
set "DIR=%~dp0"
echo %date% %time% abrir >> "%DIR%abrir.log"
start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%DIR%iniciar.ps1"
