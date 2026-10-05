<#
.SYNOPSIS
  Stops the two-server federation demo started by scripts\start-federation-demo.ps1.

.DESCRIPTION
  Kills the two server and two client processes by their PID files, then
  stops/removes the PostgreSQL container (same `docker compose down` as
  scripts\stop.ps1). Data is NOT deleted - chat_a/chat_b live in the
  'my-chat-app_postgres-data' Docker volume, which this leaves alone. Note
  this container is shared with the regular single-instance app
  (scripts\start.ps1/stop.ps1), so stopping it here also stops that app if
  it happened to be running.
#>

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$pidDir = Join-Path $root ".run"

function Stop-ByPidFile([string]$name) {
    $pidFile = Join-Path $pidDir "$name.pid"
    if (Test-Path $pidFile) {
        $procId = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ($procId) {
            $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
            if ($proc) {
                Write-Host "Stopping $name (PID $procId)..."
                taskkill /PID $procId /T /F *> $null
            } else {
                Write-Host "$name (PID $procId) is not running."
            }
        }
        Remove-Item $pidFile -ErrorAction SilentlyContinue
    } else {
        Write-Host "No PID file for $name - skipping (already stopped, or started outside start-federation-demo.ps1)."
    }
}

Stop-ByPidFile "server-a"
Stop-ByPidFile "server-b"
Stop-ByPidFile "client-a"
Stop-ByPidFile "client-b"

Write-Host "Stopping PostgreSQL container..."
docker compose down

Write-Host ""
Write-Host "Federation demo stopped. Database data is preserved (Docker volume 'my-chat-app_postgres-data')."
Write-Host "Run scripts\start-federation-demo.ps1 to bring it back up."
