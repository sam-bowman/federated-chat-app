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
  - Generates the Prisma client if it is missing (npm install does not) and applies
    Prisma migrations to both chat_a and chat_b.
  - Starts both servers and both clients as background processes, logging to
    .run\*.log and writing PID files so stop-federation-demo.ps1 can tear
    them down cleanly. Does NOT touch the single-instance start.ps1/stop.ps1
    PID files or processes.
  - Only says it is up once both servers answer /healthz and both clients serve their page.

  Safe to re-run: leaves a service that is already running alone. A port held by
  something that is not this app is an error.
#>

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$pidDir = Join-Path $root ".run"
New-Item -ItemType Directory -Force -Path $pidDir | Out-Null

. (Join-Path $PSScriptRoot "common.ps1")

# Decide about all four ports before anything is started, so a conflict stops the script
# up front instead of leaving half the demo running.
$running = @{
    "server-a" = Resolve-Port "server-a" 4000 { Test-ChatServer 4000 }
    "server-b" = Resolve-Port "server-b" 4001 { Test-ChatServer 4001 }
    "client-a" = Resolve-Port "client-a" 5173 { Test-ChatClient 5173 }
    "client-b" = Resolve-Port "client-b" 5174 { Test-ChatClient 5174 }
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

# --- Prisma client + database migrations ---------------------------------------------

# Nothing in `npm install` or `migrate deploy` generates the client, and without it both
# servers die on startup. Only generate when it is missing or older than the schema (Prisma 7 has
# no query engine DLL to lock, so running servers do not stop this: they reload).
if (Test-PrismaClientCurrent) {
    Write-Host "Prisma client is up to date."
} else {
    Write-Host "Generating the Prisma client..."
    npm run prisma:generate --workspace server
    if ($LASTEXITCODE -ne 0) { throw "prisma generate failed." }
}

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

# Returns the process it started, or $null when that service was already running.
function Start-Demo-Process([string]$name, [int]$port, [string]$workDir, [string]$cmdLine) {
    if ($running[$name]) { return $null }
    Write-Host "Starting $name on http://localhost:$port ..."
    $proc = Start-Process -FilePath "cmd.exe" `
        -ArgumentList "/c", $cmdLine `
        -WorkingDirectory $workDir `
        -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $pidDir "$name.log") `
        -RedirectStandardError (Join-Path $pidDir "$name.err.log")
    $proc.Id | Out-File -FilePath (Join-Path $pidDir "$name.pid") -Encoding ascii
    return $proc
}

$procs = @{}
$procs["server-a"] = Start-Demo-Process "server-a" 4000 (Join-Path $root "server") "set DOTENV_CONFIG_PATH=.env.a&& npm run dev"
$procs["server-b"] = Start-Demo-Process "server-b" 4001 (Join-Path $root "server") "set DOTENV_CONFIG_PATH=.env.b&& npm run dev"
$procs["client-a"] = Start-Demo-Process "client-a" 5173 (Join-Path $root "client") "npm run dev -- --mode a --port 5173"
$procs["client-b"] = Start-Demo-Process "client-b" 5174 (Join-Path $root "client") "npm run dev -- --mode b --port 5174"

# All four are started before any is waited for, so they boot in parallel.
$checks = @(
    @("server-a", { Test-ChatServer 4000 }),
    @("server-b", { Test-ChatServer 4001 }),
    @("client-a", { Test-ChatClient 5173 }),
    @("client-b", { Test-ChatClient 5174 })
)
foreach ($check in $checks) {
    $name = $check[0]
    if (-not $running[$name]) {
        Wait-ForService $name $check[1] $procs[$name] (Join-Path $pidDir "$name.err.log")
    }
}

Write-Host ""
Write-Host "Federation demo is up:"
Write-Host "  Alice's server (alice.test):  http://localhost:4000  |  client: http://localhost:5173"
Write-Host "  Bob's server   (bob.test):    http://localhost:4001  |  client: http://localhost:5174"
Write-Host ""
Write-Host "Register one user on each client, then friend/DM across servers - see docs/federation-demo.md."
Write-Host "Logs:  .run\server-a.log  .run\server-b.log  .run\client-a.log  .run\client-b.log"
Write-Host "Stop:  scripts\stop-federation-demo.ps1"
