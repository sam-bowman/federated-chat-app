<#
.SYNOPSIS
  Stops the two-server federation demo started by scripts\start-federation-demo.ps1.

.DESCRIPTION
  Kills the two server and two client processes by their PID files. Leaves
  the shared PostgreSQL container running - it's also used by the regular
  single-instance app (scripts\start.ps1/stop.ps1), and the chat_a/chat_b
  databases live in its volume regardless, so there's nothing to lose by
  leaving it up. Run `docker compose down` yourself if you want to stop it.
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

Write-Host ""
Write-Host "Federation demo stopped. PostgreSQL container left running (shared with scripts\start.ps1)."
