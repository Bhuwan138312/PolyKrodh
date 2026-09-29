<#
.SYNOPSIS
    Build the game and push it to the Azure VM.

.DESCRIPTION
    Frontend-only changes  ->  .\deploy.ps1
    Backend (server.js)    ->  .\deploy.ps1 -Restart

    Only index.html and assets/ are uploaded (~0.9 MB). The 78 MB of
    models/, pictures/ and sounds/ stay on the server, so this stays fast
    even though the whole dist/ folder is 79 MB.

    Static file changes need no restart because Express reads from disk on
    every request. Only server.js lives in the Node process's memory, so
    that needs -Restart.

.PARAMETER Restart
    Copies server.js and restarts the systemd service.

.PARAMETER Server
    SSH target in user@host form.

.EXAMPLE
    .\deploy.ps1
    .\deploy.ps1 -Restart
#>
param(
    [switch]$Restart,
    [string]$Server = "BhuwanShrestha@40.83.88.50",
    [string]$RemoteDir = "/home/BhuwanShrestha/game-backend"
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

function Send-File {
    param([string]$Local, [string]$Remote, [string]$Label)
    Write-Host "  $Label" -NoNewline
    scp -q $Local "${Server}:$Remote"
    if ($LASTEXITCODE -ne 0) { throw "Upload failed: $Label" }
    Write-Host "  ok" -ForegroundColor DarkGreen
}

Write-Host "`n==> Building" -ForegroundColor Cyan
Push-Location $root
try { npm run build } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }

# Vite rewrites these asset filenames with a content hash on every build, so
# assets/ must be re-sent even when you only touched a .js or .css file.
Write-Host "==> Uploading (~0.9 MB)" -ForegroundColor Cyan
Send-File "$root\dist\index.html"  "${RemoteDir}/dist/index.html"  "index.html "
Send-File "$root\dist\assets"     "${RemoteDir}/dist/"             "assets/    "
Send-File "$root\server.js"       "${RemoteDir}/server.js"         "server.js  "

if ($Restart) {
    Write-Host "==> Restarting service" -ForegroundColor Cyan
    $state = ssh $Server "sudo systemctl restart polykrodh && systemctl is-active polykrodh"
    if ($state -ne "active") { throw "Service did not come back up. Check: sudo journalctl -u polykrodh -n 30" }
    Write-Host "  polykrodh is $state" -ForegroundColor DarkGreen
} else {
    Write-Host "==> No restart needed (static files are read from disk per request)" -ForegroundColor DarkGray
}

Write-Host "==> Checking live site" -ForegroundColor Cyan
$code = curl.exe -sS -o NUL -w "%{http_code}" -m 25 https://polykrodh.me/
Write-Host "  https://polykrodh.me/  ->  $code" -ForegroundColor $(if ($code -eq "200") { "DarkGreen" } else { "Red" })
Write-Host ""
