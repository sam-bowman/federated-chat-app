<#
.SYNOPSIS
  Starts the two-server federation demo: two independent homeservers
  (alice.test on :4000/:5173, bob.test on :4001/:5174) sharing one Postgres
  container but using separate databases, so they talk to each other purely
  over the signed federation HTTP protocol - the same way two real,
  independently-run homeservers would.

.DESCRIPTION
  - Makes sure Docker Desktop + the Postgres container (the same one
    scripts\start.ps1 uses) are running.
  - Creates the chat_a / chat_b databases on that container if missing.
  - Creates server/.env.a, server/.env.b, client/.env.a, client/.env.b from
    their .example templates if missing (dev-only secrets - never used for
    anything but this local demo).
  - Installs npm dependencies if node_modules is missing.
  - Applies Prisma migrations to both chat_a and chat_b.
  - Starts both servers and both clients as background processes, logging to
    .run\*.log and writing PID files so stop-federation-demo.ps1 can tear
    them down cleanly. Does NOT touch the single-instance start.ps1/stop.ps1
    PID files or processes.

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
# Deliberately not redirecting stderr - see scripts\start.ps1 for why.
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
    $status = (docker inspect --format='{{.State.Health.Status}}' my-chat-app-postgres-1)
} while ($status -ne "healthy" -and (Get-Date) -lt $deadline)
if ($status -ne "healthy") { throw "PostgreSQL did not become healthy in time. Check: docker compose logs postgres" }
Write-Host "PostgreSQL is healthy."

# --- chat_a / chat_b databases --------------------------------------------------

function Test-DbExists([string]$dbName) {
    $result = docker exec my-chat-app-postgres-1 psql -U chat -d chat -tAc "SELECT 1 FROM pg_database WHERE datname='$dbName'"
    return ($result | Out-String).Trim() -eq "1"
}

foreach ($db in @("chat_a", "chat_b")) {
    if (Test-DbExists $db) {
        Write-Host "Database $db already exists."
    } else {
        Write-Host "Creating database $db..."
        docker exec my-chat-app-postgres-1 psql -U chat -d chat -c "CREATE DATABASE $db" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Failed to create database $db." }
    }
}

# --- Env files -----------------------------------------------------------------

$envFiles = @(
    @{ Path = "server\.env.a"; Example = "server\.env.a.example" },
    @{ Path = "server\.env.b"; Example = "server\.env.b.example" },
    @{ Path = "client\.env.a"; Example = "client\.env.a.example" },
    @{ Path = "client\.env.b"; Example = "client\.env.b.example" }
)
foreach ($f in $envFiles) {
    if (-not (Test-Path $f.Path)) {
        Copy-Item $f.Example $f.Path
        Write-Host "Created $($f.Path) from $($f.Example)"
    }
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

function Get-EnvValue([string]$path, [string]$key) {
    $line = Get-Content $path | Where-Object { $_ -match "^$key=" } | Select-Object -First 1
    return ($line -replace "^$key=", "").Trim()
}

Write-Host "Applying database migrations to chat_a..."
Push-Location server
$env:DATABASE_URL = Get-EnvValue "..\server\.env.a" "DATABASE_URL"
npx prisma migrate deploy
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "prisma migrate deploy failed for chat_a." }
Pop-Location

Write-Host "Applying database migrations to chat_b..."
Push-Location server
$env:DATABASE_URL = Get-EnvValue "..\server\.env.b" "DATABASE_URL"
npx prisma migrate deploy
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "prisma migrate deploy failed for chat_b." }
Pop-Location
Remove-Item Env:\DATABASE_URL -ErrorAction SilentlyContinue

# --- Servers + clients -------------------------------------------------------------

function Start-Demo-Process([string]$name, [int]$port, [string]$workDir, [string]$cmdLine) {
    if (Test-PortListening $port) {
        Write-Host "Something is already listening on port $port - leaving it alone ($name likely already running)."
        return
    }
    Write-Host "Starting $name on http://localhost:$port ..."
    $proc = Start-Process -FilePath "cmd.exe" `
        -ArgumentList "/c", $cmdLine `
        -WorkingDirectory $workDir `
        -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $pidDir "$name.log") `
        -RedirectStandardError (Join-Path $pidDir "$name.err.log")
    $proc.Id | Out-File -FilePath (Join-Path $pidDir "$name.pid") -Encoding ascii
}

Start-Demo-Process "server-a" 4000 (Join-Path $root "server") "set DOTENV_CONFIG_PATH=.env.a&& npm run dev"
Start-Demo-Process "server-b" 4001 (Join-Path $root "server") "set DOTENV_CONFIG_PATH=.env.b&& npm run dev"
Start-Demo-Process "client-a" 5173 (Join-Path $root "client") "npm run dev -- --mode a --port 5173"
Start-Demo-Process "client-b" 5174 (Join-Path $root "client") "npm run dev -- --mode b --port 5174"

Start-Sleep -Seconds 2
Write-Host ""
Write-Host "Federation demo is up:"
Write-Host "  Alice's server (alice.test):  http://localhost:4000  |  client: http://localhost:5173"
Write-Host "  Bob's server   (bob.test):    http://localhost:4001  |  client: http://localhost:5174"
Write-Host ""
Write-Host "Register one user on each client, then friend/DM across servers - see README's 'Federation demo' section."
Write-Host "Logs:  .run\server-a.log  .run\server-b.log  .run\client-a.log  .run\client-b.log"
Write-Host "Stop:  scripts\stop-federation-demo.ps1"
