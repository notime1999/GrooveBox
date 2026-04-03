# Copy this file to deploy.ps1 and fill in your values before running.
#
# One-time SSH key setup (no more password prompts):
#   ssh-keygen -t ed25519 -C "nas-deploy" -f "$env:USERPROFILE\.ssh\id_ed25519_nas" -N '""'
#   type "$env:USERPROFILE\.ssh\id_ed25519_nas.pub" | ssh your_user@192.168.x.x "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"

param(
    [string]$NasHost = "192.168.x.x",            # IP of your server
    [string]$NasUser = "your_user",
    [string]$NasPath = "/path/to/docker",         # Path on server where Docker data lives
    [string]$DockerBin = "/path/to/docker/bin",   # Full path to docker binary. On Synology: /volume1/@appstore/ContainerManager/usr/bin/docker
    [string]$ImageName = "groovebox",
    [string]$StackName = "groovebox",
    [string]$SshKey = "$env:USERPROFILE\.ssh\id_ed25519_nas",  # SSH key for passwordless auth
    [switch]$ForceBuild,
    [switch]$SetupSudoers   # run once to configure passwordless sudo for docker
)

$ErrorActionPreference = "Stop"
$TarFile = "$ImageName.tar"

# SSH helper — uses key if it exists, otherwise falls back to password
$SshOpts = if (Test-Path $SshKey) { @("-i", $SshKey, "-o", "StrictHostKeyChecking=no") } else { @() }
function Ssh-Run([string]$cmd) {
    & ssh @SshOpts "${NasUser}@${NasHost}" $cmd
}

# === SETUP ONE-TIME: configure passwordless sudo for docker ===
if ($SetupSudoers) {
    Write-Host "`n=== SETUP SUDOERS (one-time) ===" -ForegroundColor Magenta
    $sudoersLine = "${NasUser} ALL=(ALL) NOPASSWD: ${DockerBin}"
    & ssh @SshOpts -t "${NasUser}@${NasHost}" "echo '$sudoersLine' | sudo tee /etc/sudoers.d/${NasUser}-docker && sudo chmod 440 /etc/sudoers.d/${NasUser}-docker && echo 'Done.'"
    Write-Host "Sudoers configured. You can now run .\deploy.ps1 without -SetupSudoers." -ForegroundColor Green
    exit 0
}

# Source files that determine whether a rebuild is needed
$SourceFiles = @(
    "Dockerfile",
    "package.json",
    "package-lock.json"
) + (Get-ChildItem "src" -Recurse -File | Select-Object -ExpandProperty FullName)

function NeedsBuild {
    if ($ForceBuild) { return $true }
    if (-not (Test-Path $TarFile)) {
        Write-Host "Tar not found, build required." -ForegroundColor Yellow
        return $true
    }
    $tarTime = (Get-Item $TarFile).LastWriteTime
    foreach ($f in $SourceFiles) {
        if (Test-Path $f) {
            if ((Get-Item $f).LastWriteTime -gt $tarTime) {
                Write-Host "Modified after tar: $f" -ForegroundColor Yellow
                return $true
            }
        }
    }
    return $false
}

# BUILD (skipped if tar is up to date)
if (NeedsBuild) {
    Write-Host "`n=== BUILD ===" -ForegroundColor Cyan
    $swBuild = [System.Diagnostics.Stopwatch]::StartNew()
    $buildDate = (Get-Date -Format "yyyy-MM-dd_HH:mm:ss")
    docker build --provenance=false --build-arg "BUILD_DATE=$buildDate" -t "${ImageName}:latest" .
    $swBuild.Stop()
    if ($LASTEXITCODE -ne 0) { Write-Error "Build failed"; exit 1 }
    Write-Host "Build completed in $([math]::Round($swBuild.Elapsed.TotalSeconds, 1))s" -ForegroundColor Green

    Write-Host "`n=== EXPORT TAR ===" -ForegroundColor Cyan
    $swSave = [System.Diagnostics.Stopwatch]::StartNew()
    docker save "${ImageName}:latest" -o $TarFile
    if ($LASTEXITCODE -ne 0) { Write-Error "docker save failed"; exit 1 }
    $swSave.Stop()
    $savedMB = [math]::Round((Get-Item $TarFile).Length / 1MB, 1)
    Write-Host "Saved: $TarFile ($savedMB MB) in $([math]::Round($swSave.Elapsed.TotalSeconds, 1))s" -ForegroundColor Green
} else {
    Write-Host "`n=== BUILD SKIPPED (no changes detected) ===" -ForegroundColor Green
    $skipMB = [math]::Round((Get-Item $TarFile).Length / 1MB, 1)
    Write-Host "Tar: $TarFile ($skipMB MB) - $((Get-Item $TarFile).LastWriteTime)"
    Write-Host "Use -ForceBuild to force a rebuild." -ForegroundColor DarkGray
}

# UPLOAD + LOAD via SSH pipe
Write-Host "`n=== UPLOAD + LOAD (streaming) ===" -ForegroundColor Cyan
$tarSizeMB   = [math]::Round((Get-Item $TarFile).Length / 1MB, 1)
$tarFullPath = (Resolve-Path $TarFile).Path

$swUpload = [System.Diagnostics.Stopwatch]::StartNew()
$proc = Start-Process "ssh" `
    -ArgumentList (@() + $SshOpts + @("${NasUser}@${NasHost}", "sudo ${DockerBin} load")) `
    -RedirectStandardInput $tarFullPath `
    -PassThru -NoNewWindow -Wait
$swUpload.Stop()

if ($proc.ExitCode -ne 0) { Write-Error "Upload/Load failed (exit $($proc.ExitCode))"; exit 1 }
Write-Host "Completed in $([math]::Round($swUpload.Elapsed.TotalSeconds, 1))s - $tarSizeMB MB" -ForegroundColor Green

# Ensure required directories exist on NAS
Ssh-Run "mkdir -p /path/to/dockge/stacks/${StackName}/data"

# Force-recreate the container with the new image
Write-Host "`n=== RESTART CONTAINER ===" -ForegroundColor Cyan
$composeFile = (Ssh-Run "find / -name 'compose.yaml' -path '*${StackName}*' 2>/dev/null | head -1").Trim()
if (-not $composeFile) {
    $composeFile = (Ssh-Run "find / -name 'compose.yml' -path '*${StackName}*' 2>/dev/null | head -1").Trim()
}
Write-Host "Compose found: $composeFile" -ForegroundColor DarkGray
Ssh-Run "sudo ${DockerBin} compose -f ${composeFile} up -d --force-recreate 2>&1"
if ($LASTEXITCODE -eq 0) {
    Write-Host "Container recreated with new image." -ForegroundColor Green
} else {
    Write-Host "Force-recreate failed — restart manually in Dockge." -ForegroundColor Yellow
}

Write-Host "`n=== DONE ===" -ForegroundColor Green
