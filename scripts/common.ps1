<#
  Helpers shared by start.ps1 and start-federation-demo.ps1 (dot-sourced; not run on its own).

  The point of them: a script must not say "up" about a server that is not. A port that is
  merely listening proves nothing (it may be some other program), and a process that was
  merely launched may have crashed a second later, so both are checked by asking the
  service itself.
#>

function Test-PortListening([int]$port) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    return $null -ne $conn
}

# Has `prisma generate` been run for the current schema? The generated client (TypeScript source in
# server\src\generated\prisma, since Prisma 7) is older than the schema on a fresh clone (missing)
# or after a pull that changed it.
function Test-PrismaClientCurrent {
    $client = "server\src\generated\prisma\client.ts"
    if (-not (Test-Path $client)) { return $false }
    return (Get-Item $client).LastWriteTime -ge (Get-Item "server\prisma\schema.prisma").LastWriteTime
}

# The body of a successful GET, or $null for any failure (refused, timeout, 4xx/5xx).
function Get-HttpBody([string]$url) {
    try {
        return (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3).Content
    } catch {
        return $null
    }
}

# Is this port the chat server? /healthz answers {"ok":true}.
function Test-ChatServer([int]$port) {
    $body = Get-HttpBody "http://localhost:$port/healthz"
    return ($null -ne $body) -and ($body -match '"ok"\s*:\s*true')
}

# Is this port the chat client? Its page (Vite in dev, nginx in Docker) is titled "My Chat App".
function Test-ChatClient([int]$port) {
    $body = Get-HttpBody "http://localhost:$port/"
    return ($null -ne $body) -and ($body -match '<title>My Chat App</title>')
}

# Decides what to do about a port before anything is started:
#   free                      -> $false (go ahead and start it)
#   listening and $isOurs     -> $true  (already running, leave it alone)
#   listening, not ours       -> throws, naming the port
# A service that is still booting is listening before it answers, so give it a few seconds
# to start answering before calling it foreign.
function Resolve-Port([string]$name, [int]$port, [scriptblock]$isOurs) {
    if (-not (Test-PortListening $port)) { return $false }
    $deadline = (Get-Date).AddSeconds(5)
    do {
        if (& $isOurs) {
            Write-Host "$name is already running on port $port - leaving it alone."
            return $true
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw "Port $port is in use by something that is not the $name (it did not answer as the chat app does). Stop whatever is using port $port, then run this script again."
}

# Waits until $test passes. Fails early, with the end of the error log, if the process we started
# has already exited, and otherwise after $timeoutSec, naming the log to read.
function Wait-ForService([string]$name, [scriptblock]$test, $process, [string]$errLog, [int]$timeoutSec = 90) {
    Write-Host "Waiting for the $name to answer..."
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (& $test) { return }
        if ($process -and $process.HasExited) {
            $tail = ""
            if (Test-Path $errLog) { $tail = (Get-Content $errLog -Tail 15) -join [Environment]::NewLine }
            throw "The $name exited before it started answering. Last lines of ${errLog}:`n$tail"
        }
        Start-Sleep -Seconds 1
    }
    throw "The $name did not start answering within $timeoutSec seconds. See $errLog and the matching .log file in .run\."
}
