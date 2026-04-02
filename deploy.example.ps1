# Copy this file to deploy.ps1 and fill in your values before running.

param(
    [string]$NasHost = "192.168.x.x",           # IP of your server
    [string]$NasUser = "your_user",
    [string]$NasPath = "/path/to/docker",        # Path on server where the tar will be uploaded
    [string]$DockerBin = "/path/to/docker/bin",  # Full path to docker binary. On Synology: /volume1/@appstore/ContainerManager/usr/bin/docker
    [string]$ImageName = "groovebox",
    [string]$StackName = "groovebox",
    [switch]$ForceBuild,
    [switch]$SetupSudoers   # run once to configure passwordless sudo for docker
)

$ErrorActionPreference = "Stop"
$TarFile = "$ImageName.tar"

# === SETUP ONE-TIME: configure passwordless sudo for docker ===
if ($SetupSudoers) {
    Write-Host "`n=== SETUP SUDOERS (one-time) ===" -ForegroundColor Magenta
    $sudoersLine = "${NasUser} ALL=(ALL) NOPASSWD: ${DockerBin}"
    ssh -t "${NasUser}@${NasHost}" "echo '$sudoersLine' | sudo tee /etc/sudoers.d/${NasUser}-docker && sudo chmod 440 /etc/sudoers.d/${NasUser}-docker && echo 'Done.'"
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
    docker build -t "${ImageName}:latest" .
    if ($LASTEXITCODE -ne 0) { Write-Error "Build failed"; exit 1 }

    Write-Host "`n=== EXPORT TAR ===" -ForegroundColor Cyan
    docker save "${ImageName}:latest" -o $TarFile
    Write-Host "Saved: $TarFile ($([math]::Round((Get-Item $TarFile).Length/1MB, 1)) MB)"
} else {
    Write-Host "`n=== BUILD SKIPPED (no changes detected) ===" -ForegroundColor Green
    Write-Host "Tar: $TarFile ($([math]::Round((Get-Item $TarFile).Length/1MB, 1)) MB) - $((Get-Item $TarFile).LastWriteTime)"
    Write-Host "Use -ForceBuild to force a rebuild." -ForegroundColor DarkGray
}

# UPLOAD
Write-Host "`n=== UPLOAD TAR ===" -ForegroundColor Cyan
scp $TarFile "${NasUser}@${NasHost}:${NasPath}/${TarFile}"
if ($LASTEXITCODE -ne 0) { Write-Error "Upload failed"; exit 1 }

# LOAD + CLEANUP
Write-Host "`n=== LOAD + CLEANUP ON NAS ===" -ForegroundColor Cyan
ssh -t "${NasUser}@${NasHost}" "sudo ${DockerBin} load -i ${NasPath}/${TarFile} && sudo rm ${NasPath}/${TarFile} && echo 'Done.'"

Write-Host "`n=== DONE ===" -ForegroundColor Green
Write-Host "Go to Dockge and restart the '$StackName' stack." -ForegroundColor Yellow
