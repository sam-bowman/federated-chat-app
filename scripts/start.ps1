<#
.SYNOPSIS
  Starts My Chat App: PostgreSQL (Docker), the API/WebSocket server, and the web client.

.DESCRIPTION
  - Makes sure Docker Desktop is running, then starts the Postgres container.
  - Creates server/.env and client/.env from their .env.example files if missing.
  - Installs npm dependencies if node_modules is missing.
  - Generates the Prisma client (npm install does not) and applies any pending migrations.
  - Starts the server (http://localhost:4000) and client (http://localhost:5173)
    as background processes, logging to .run\server.log and .run\client.log.
  - Writes PID files to .run\ so scripts\stop.ps1 can cleanly tear everything down.
  - Only says it is up once the server answers /healthz and the client serves its page.
    If either process dies on startup, it stops and shows the end of the error log.

  Safe to re-run: leaves a service that is already running alone. A port held by something
  that is not this app is an error, not something to quietly work around.
#>

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$pidDir = Join-Path $root ".run"
New-Item -ItemType Directory -Force -Path $pidDir | Out-Null

. (Join-Path $PSScriptRoot "common.ps1")

# Decide about the two ports before anything is started, so a conflict stops the script
# up front instead of leaving a half-started app.
$serverRunning = Resolve-Port "server" 4000 { Test-ChatServer 4000 }
$clientRunning = Resolve-Port "client" 5173 { Test-ChatClient 5173 }

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

# --- Prisma client + database migrations ---------------------------------------------

# Nothing in `npm install` or `migrate deploy` generates the client, and without it the server
# dies on startup with "@prisma/client did not initialize yet". Only generate when it is missing
# or older than the schema (a fresh clone, or a schema change after a `git pull`): on Windows
# a running server has the query engine DLL loaded, and generating over it fails with EPERM.
if (Test-PrismaClientCurrent) {
    Write-Host "Prisma client is up to date."
} else {
    if ($serverRunning) {
        throw "The Prisma client is out of date (the schema changed), but the server is running and Windows locks its query engine. Run scripts\stop.ps1, then run this script again."
    }
    Write-Host "Generating the Prisma client..."
    npx prisma generate --schema server/prisma/schema.prisma
    if ($LASTEXITCODE -ne 0) { throw "prisma generate failed." }
}

Write-Host "Applying database migrations..."
Push-Location server
npx prisma migrate deploy
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "prisma migrate deploy failed." }
Pop-Location

# --- Server + client -------------------------------------------------------------

$serverProc = $null
if (-not $serverRunning) {
    Write-Host "Starting server on http://localhost:4000 ..."
    $serverProc = Start-Process -FilePath "cmd.exe" `
        -ArgumentList "/c", "npm run dev" `
        -WorkingDirectory (Join-Path $root "server") `
        -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $pidDir "server.log") `
        -RedirectStandardError (Join-Path $pidDir "server.err.log")
    $serverProc.Id | Out-File -FilePath (Join-Path $pidDir "server.pid") -Encoding ascii
}

$clientProc = $null
if (-not $clientRunning) {
    Write-Host "Starting client on http://localhost:5173 ..."
    $clientProc = Start-Process -FilePath "cmd.exe" `
        -ArgumentList "/c", "npm run dev -- --port 5173" `
        -WorkingDirectory (Join-Path $root "client") `
        -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $pidDir "client.log") `
        -RedirectStandardError (Join-Path $pidDir "client.err.log")
    $clientProc.Id | Out-File -FilePath (Join-Path $pidDir "client.pid") -Encoding ascii
}

# Both are started before either is waited for, so they boot in parallel.
if (-not $serverRunning) {
    Wait-ForService "server" { Test-ChatServer 4000 } $serverProc (Join-Path $pidDir "server.err.log")
}
if (-not $clientRunning) {
    Wait-ForService "client" { Test-ChatClient 5173 } $clientProc (Join-Path $pidDir "client.err.log")
}

Write-Host ""
Write-Host "My Chat App is up:"
Write-Host "  Server:  http://localhost:4000"
Write-Host "  Client:  http://localhost:5173"
Write-Host ""
Write-Host "Logs:  .run\server.log  /  .run\client.log"
Write-Host "Stop:  scripts\stop.ps1"
