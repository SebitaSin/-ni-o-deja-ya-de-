# San Rafael Sentinel: trae la última versión publicada en GitHub (app y datos del vigía).
# Lo lanza iniciar.ps1 en segundo plano. Si falla, deja todo como estaba y lo anota en actualizar.log.

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$marca = Join-Path $PSScriptRoot '.ultima-actualizacion'
if ((Test-Path -LiteralPath $marca) -and (((Get-Date) - (Get-Item -LiteralPath $marca).LastWriteTime).TotalMinutes -lt 60)) { exit 0 }

$tmp = Join-Path $env:TEMP ('sentinel-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $zip = Join-Path $tmp 'app.zip'
  Invoke-WebRequest -Uri 'https://codeload.github.com/SebitaSin/-ni-o-deja-ya-de-/zip/refs/heads/main' -OutFile $zip -UseBasicParsing -TimeoutSec 60
  Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
  $src = Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1
  if (-not $src -or -not (Test-Path -LiteralPath (Join-Path $src.FullName 'index.html')) -or -not (Test-Path -LiteralPath (Join-Path $src.FullName 'js\app.js'))) {
    throw 'La descarga llegó incompleta.'
  }
  Copy-Item -Path (Join-Path $src.FullName '*') -Destination $Root -Recurse -Force
  Set-Content -LiteralPath $marca -Value (Get-Date -Format o)
} catch {
  Add-Content -LiteralPath (Join-Path $PSScriptRoot 'actualizar.log') -Value ('{0}  {1}' -f (Get-Date -Format o), $_.Exception.Message)
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
