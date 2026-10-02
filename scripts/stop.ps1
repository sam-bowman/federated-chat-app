<#
.SYNOPSIS
  Stops My Chat App: kills the server/client processes started by scripts\start.ps1
  and stops (and removes) the PostgreSQL container.

.DESCRIPTION
  Database data is NOT deleted - it lives in the 'my-chat-app_postgres-data' Docker
  volume, which this script leaves alone. Re-run scripts\start.ps1 to bring
  everything back up with your data intact.
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
                # taskkill /T kills the whole process tree (cmd.exe -> npm -> node),
                # which Stop-Process alone would not do.
                taskkill /PID $procId /T /F *> $null
            } else {
                Write-Host "$name (PID $procId) is not running."
            }
        }
        Remove-Item $pidFile -ErrorAction SilentlyContinue
    } else {
        Write-Host "No PID file for $name - skipping (already stopped, or started outside start.ps1)."
    }
}

Stop-ByPidFile "server"
Stop-ByPidFile "client"

Write-Host "Stopping PostgreSQL container..."
docker compose down

Write-Host ""
Write-Host "Everything stopped. Database data is preserved (Docker volume 'my-chat-app_postgres-data')."
Write-Host "Run scripts\start.ps1 to bring it back up."
