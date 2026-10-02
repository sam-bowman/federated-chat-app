<#
.SYNOPSIS
  Starts My Chat App: PostgreSQL (Docker), the API/WebSocket server, and the web client.

.DESCRIPTION
  - Makes sure Docker Desktop is running, then starts the Postgres container.
  - Creates server/.env and client/.env from their .env.example files if missing.
  - Installs npm dependencies if node_modules is missing.
  - Applies any pending Prisma migrations.
  - Starts the server (http://localhost:4000) and client (http://localhost:5173)
    as background processes, logging to .run\server.log and .run\client.log.
  - Writes PID files to .run\ so scripts\stop.ps1 can cleanly tear everything down.

  Safe to re-run: skips starting a service whose port is already listening.
#>

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$pidDir = Join-Path $root ".run"
New-Item -ItemType Directory -Force -Path $pidDir | Out-Null

function Test-PortListening([int]$port) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    return $null -ne $conn
}

# --- Docker Desktop + Postgres ------------------------------------------------

Write-Host "Checking Docker..."
# Note: deliberately NOT redirecting stderr here (e.g. "docker info 2>$null").
# In Windows PowerShell 5.1, redirecting a native command's stderr wraps each
# line as a NativeCommandError and makes $? false even on exit code 0 - which
# would make a harmless Docker warning look like a real failure.
docker info 1> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Docker Desktop doesn't seem to be running. Launching it..."
    $dockerDesktop = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    if (Test-Path $dockerDesktop) {
        Start-Process $dockerDesktop
    } else {
        throw "Could not find Docker Desktop at '$dockerDesktop'. Start it manually, then re-run this script."
    }

    Write-Host "Waiting for the Docker engine to come up (this can take a minute)..."
    $deadline = (Get-Date).AddSeconds(90)
    do {
        Start-Sleep -Seconds 5
        docker info 1> $null
    } while ($LASTEXITCODE -ne 0 -and (Get-Date) -lt $deadline)
    if ($LASTEXITCODE -ne 0) { throw "Docker engine did not become ready in time." }
}

Write-Host "Starting PostgreSQL container..."
docker compose up -d postgres
if ($LASTEXITCODE -ne 0) { throw "docker compose up failed." }

Write-Host "Waiting for PostgreSQL to report healthy..."
$deadline = (Get-Date).AddSeconds(60)
$status = ""
do {
    Start-Sleep -Seconds 2
    # No stderr redirection here either, for the same reason as above - the
    # container already exists at this point (docker compose up ran above),
    # so this shouldn't normally write to stderr anyway.
    $status = (docker inspect --format='{{.State.Health.Status}}' my-chat-app-postgres-1)
} while ($status -ne "healthy" -and (Get-Date) -lt $deadline)
if ($status -ne "healthy") { throw "PostgreSQL did not become healthy in time. Check: docker compose logs postgres" }
Write-Host "PostgreSQL is healthy."

# --- Env files -----------------------------------------------------------------

if (-not (Test-Path "server\.env")) {
    Copy-Item "server\.env.example" "server\.env"
    Write-Host "Created server\.env from .env.example"
}
if (-not (Test-Path "client\.env")) {
    Copy-Item "client\.env.example" "client\.env"
    Write-Host "Created client\.env from .env.example"
}

# --- Dependencies ----------------------------------------------------------------

if (-not (Test-Path "server\node_modules")) {
    Write-Host "Installing server dependencies..."
    npm install --workspace server
    if ($LASTEXITCODE -ne 0) { throw "npm install (server) failed." }
}
if (-not (Test-Path "client\node_modules")) {
    Write-Host "Installing client dependencies..."
    npm install --workspace client
    if ($LASTEXITCODE -ne 0) { throw "npm install (client) failed." }
}

# --- Database migrations ---------------------------------------------------------

Write-Host "Applying database migrations..."
Push-Location server
npx prisma migrate deploy
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "prisma migrate deploy failed." }
Pop-Location

# --- Server + client -------------------------------------------------------------

if (Test-PortListening 4000) {
    Write-Host "Something is already listening on port 4000 - leaving it alone (server likely already running)."
} else {
    Write-Host "Starting server on http://localhost:4000 ..."
    $serverProc = Start-Process -FilePath "cmd.exe" `
        -ArgumentList "/c", "npm run dev" `
        -WorkingDirectory (Join-Path $root "server") `
        -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $pidDir "server.log") `
        -RedirectStandardError (Join-Path $pidDir "server.err.log")
    $serverProc.Id | Out-File -FilePath (Join-Path $pidDir "server.pid") -Encoding ascii
}

if (Test-PortListening 5173) {
    Write-Host "Something is already listening on port 5173 - leaving it alone (client likely already running)."
} else {
    Write-Host "Starting client on http://localhost:5173 ..."
    $clientProc = Start-Process -FilePath "cmd.exe" `
        -ArgumentList "/c", "npm run dev -- --port 5173" `
        -WorkingDirectory (Join-Path $root "client") `
        -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $pidDir "client.log") `
        -RedirectStandardError (Join-Path $pidDir "client.err.log")
    $clientProc.Id | Out-File -FilePath (Join-Path $pidDir "client.pid") -Encoding ascii
}

Start-Sleep -Seconds 2
Write-Host ""
Write-Host "My Chat App is up:"
Write-Host "  Server:  http://localhost:4000"
Write-Host "  Client:  http://localhost:5173"
Write-Host ""
Write-Host "Logs:  .run\server.log  /  .run\client.log"
Write-Host "Stop:  scripts\stop.ps1"
