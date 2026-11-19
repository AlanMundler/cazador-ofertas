# Corre el pipeline de markets en tu PC (donde la IP no esta bloqueada).
# Uso: powershell -ExecutionPolicy Bypass -File scripts/run-local.ps1
# Programar cada 30 min:
#   schtasks /Create /TN "Cazador Markets" /SC MINUTE /MO 30 /TR "powershell -ExecutionPolicy Bypass -File E:\Proyectos\PEDIDOYA\cazador-ofertas\scripts\run-local.ps1" /F

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format 'yyyy-MM-dd_HH-mm'
$log = Join-Path $logDir "markets_$stamp.log"

node src/run.js --send --max-stores=50 --py-stores=23 *> $log
$code = $LASTEXITCODE

# Mantener solo los ultimos 30 logs
Get-ChildItem $logDir -Filter 'markets_*.log' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -Skip 30 |
  Remove-Item -Force -ErrorAction SilentlyContinue

exit $code
