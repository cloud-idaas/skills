# Install-Broker-Windows.ps1
# Install the alibaba-cloud-idaas broker on Windows. The caller (skill flow A0)
# picks the release asset and passes its browser_download_url; this script only
# downloads, verifies, installs, and appends the install dir to the User PATH.
# Companion of Install-AliYunCLI-Windows.ps1 and Install-AWSCLI-Windows.ps1
# (same install layout under LOCALAPPDATA).

#Requires -Version 5.1

[CmdletBinding()]
param (
    [string]$DownloadUrl,
    [string]$InstallDir = "$env:LOCALAPPDATA\alibaba-cloud-idaas"
)

# Input validation runs before $ErrorActionPreference='Stop': under 'Stop',
# Write-Error is terminating and the exit after it would never run.
if (-not $DownloadUrl) {
    Write-Error 'Usage: powershell -ExecutionPolicy Bypass -File Install-Broker-Windows.ps1 -DownloadUrl <browser_download_url of the release asset>'
    exit 1
}
# Hard boundary 4: install only from the official repo's GitHub releases.
if ($DownloadUrl -notmatch '^https://github\.com/aliyunidaas/alibaba-cloud-idaas/releases/download/.+') {
    throw "Refusing to download: not an official release asset URL: $DownloadUrl"
}

$ErrorActionPreference = 'Stop'
# GitHub requires TLS 1.2+; PS 5.1 on older Windows defaults lower.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$temp = Join-Path $env:TEMP ("idaas-broker-" + [Guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $temp -Force | Out-Null
    $zip = Join-Path $temp 'broker.zip'
    Write-Output "Downloading: $DownloadUrl"
    # Start-BitsTransfer shows a native progress bar without the 10x slowdown of
    # Invoke-WebRequest's progress UI on PS 5.1, and BITS handles retries itself.
    Start-BitsTransfer -Source $DownloadUrl -Destination $zip
    Expand-Archive -Path $zip -DestinationPath $temp -Force

    $exe = Get-ChildItem -Path $temp -Recurse -Filter 'alibaba-cloud-idaas.exe' | Select-Object -First 1
    if (-not $exe) { throw 'alibaba-cloud-idaas.exe not found in the archive.' }
    $bytes = New-Object byte[] 2
    $fs = [IO.File]::OpenRead($exe.FullName)
    try { $null = $fs.Read($bytes, 0, 2) } finally { $fs.Close() }
    if ($bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) { throw 'Downloaded file is not a PE executable (missing MZ header); archive may be corrupted.' }

    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    $exePath = Join-Path $InstallDir $exe.Name
    Move-Item -Path $exe.FullName -Destination $exePath -Force
} catch {
    throw "Install failed: $_"
} finally {
    if (Test-Path $temp) { Remove-Item -Path $temp -Recurse -Force -ErrorAction SilentlyContinue }
}

# Functional verification is left to skill flow A0 (<bin> version, run by the
# agent): executing the freshly downloaded unsigned exe here made the whole
# script hang opaquely when Defender/AV scanned the first launch.

# Idempotent User PATH append. SetEnvironmentVariable broadcasts WM_SETTINGCHANGE
# itself, so newly opened terminals see the PATH. (It rewrites the value as REG_SZ
# with %VARS% expanded - functionally harmless for a per-user PATH.)
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$already = @($userPath -split ';') | Where-Object { $_ -and $_.TrimEnd('\') -ieq $InstallDir.TrimEnd('\') }
if (-not $already) {
    if ($userPath) { $userPath = "$userPath;$InstallDir" } else { $userPath = $InstallDir }
    [Environment]::SetEnvironmentVariable('Path', $userPath, 'User')
    Write-Output "Appended $InstallDir to the user PATH (effective in newly opened terminals)."
} else {
    Write-Output "$InstallDir is already on the user PATH."
}

Write-Output "Install complete: $exePath"
Write-Output "Note: the current shell keeps its old PATH; invoke the broker by full path: $exePath"
