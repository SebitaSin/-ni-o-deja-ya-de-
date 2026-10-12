# San Rafael Sentinel: abre la app en su propia ventana.
# Sirve la carpeta de la app solo en esta PC (http://localhost:8765) y abre Chrome o Edge en modo aplicación.
# Si la app ya está abierta, solo abre otra ventana.

$ErrorActionPreference = 'Stop'
$Log = Join-Path $PSScriptRoot 'iniciar.log'
function Write-Log($t) { try { Add-Content -LiteralPath $Log -Value ('{0}  {1}' -f (Get-Date -Format o), $t) } catch { } }
trap { Write-Log ('ERROR: ' + $_.Exception.Message); continue }
Write-Log 'inicio'

$Root = Split-Path -Parent $PSScriptRoot
$Port = 8765
$Url  = "http://localhost:$Port/"

function Open-AppWindow {
  $candidatos = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
  )
  $exe = $candidatos | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  if ($exe) { Start-Process -FilePath $exe -ArgumentList "--app=$Url" }
  else { Start-Process $Url }
}

function Show-Error($texto) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show($texto, 'San Rafael Sentinel') | Out-Null
}

# Ya está corriendo: abrir ventana y salir
try {
  $r = Invoke-WebRequest -Uri ($Url + '__sentinel') -UseBasicParsing -TimeoutSec 2
  if ($r.Content -eq 'ok') { Open-AppWindow; exit 0 }
} catch { }

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($Url)
try { $listener.Start() }
catch {
  Show-Error "No se pudo usar el puerto $Port de esta PC. Otro programa lo está usando.`n`n$($_.Exception.Message)"
  exit 1
}

Write-Log 'servidor escuchando en el puerto 8765'
Open-AppWindow

# Busca la versión nueva en GitHub en segundo plano (como mucho una vez por hora)
$upd = Join-Path $PSScriptRoot 'actualizar.ps1'
if (Test-Path -LiteralPath $upd) {
  Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$upd`"")
}

$tipos = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json; charset=utf-8'; '.webmanifest' = 'application/manifest+json'
  '.png' = 'image/png'; '.ico' = 'image/x-icon'; '.svg' = 'image/svg+xml'; '.md' = 'text/plain; charset=utf-8'
}
$raiz = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
$limiteInactivo = [TimeSpan]::FromHours(3)   # sin pedidos durante 3 h (app cerrada): se apaga solo
$ultimo = Get-Date
$pendiente = $null

while ($listener.IsListening) {
  if (-not $pendiente) { $pendiente = $listener.BeginGetContext($null, $null) }
  if (-not $pendiente.AsyncWaitHandle.WaitOne(30000)) {
    if (((Get-Date) - $ultimo) -gt $limiteInactivo) { break }
    continue
  }
  $ctx = $listener.EndGetContext($pendiente); $pendiente = $null; $ultimo = Get-Date
  $req = $ctx.Request; $res = $ctx.Response
  try {
    $ruta = [Uri]::UnescapeDataString($req.Url.AbsolutePath)
    if ($ruta -eq '/__sentinel') {
      $bytes = [Text.Encoding]::UTF8.GetBytes('ok'); $res.ContentType = 'text/plain'
    } else {
      if ($ruta.EndsWith('/')) { $ruta += 'index.html' }
      $archivo = $null
      try { $archivo = [System.IO.Path]::GetFullPath($raiz + ($ruta.TrimStart('/') -replace '/', '\')) } catch { }
      if (-not $archivo -or -not $archivo.StartsWith($raiz, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $archivo -PathType Leaf)) {
        $res.StatusCode = 404; $res.ContentType = 'text/plain; charset=utf-8'
        $bytes = [Text.Encoding]::UTF8.GetBytes('No encontrado')
      } else {
        $bytes = [System.IO.File]::ReadAllBytes($archivo)
        $ext = [System.IO.Path]::GetExtension($archivo).ToLowerInvariant()
        $res.ContentType = $(if ($tipos.ContainsKey($ext)) { $tipos[$ext] } else { 'application/octet-stream' })
        $res.AddHeader('Cache-Control', 'no-cache')
      }
    }
    $res.ContentLength64 = $bytes.Length
    if ($req.HttpMethod -ne 'HEAD') { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
  } catch {
    try { $res.StatusCode = 500 } catch { }
  } finally {
    try { $res.OutputStream.Close() } catch { }
  }
}
$listener.Stop()
