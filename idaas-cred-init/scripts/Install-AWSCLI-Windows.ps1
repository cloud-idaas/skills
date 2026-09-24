# Install-AWSCLI-Windows.ps1
# Purpose: Install AWS CLI v2 on Windows per-user via msiexec direct URL.

[CmdletBinding()]
param (
    [string]$MsiUrl = "https://awscli.amazonaws.com/AWSCLIV2-User.msi",
    [switch]$Help
)

if ($PSBoundParameters['Help']) {
    Write-Output "AWS CLI v2 User Installer (msiexec direct URL)`n  -MsiUrl URL  Custom MSI URL"
    exit 0
}

Write-Output "=== AWS CLI v2 User Installer ==="

Write-Output "Installing from $MsiUrl ..."
$proc = Start-Process -FilePath "msiexec.exe" `
    -ArgumentList "/i", "`"$MsiUrl`"", "/qn", "/norestart" `
    -Wait -PassThru
$code = $proc.ExitCode
Write-Output "msiexec exit code: $code"

# msiexec reports failure in its exit code, not in stdout: 0 = success,
# 3010 = success but a reboot is pending, anything else = the install did not happen.
if ($code -eq 3010) {
    Write-Output "Note: a reboot is required to complete the installation (3010)."
} elseif ($code -ne 0) {
    Write-Error "msiexec failed with exit code $code."
    exit 1
}

# Verify placement only. Functional verification (aws --version) belongs to the
# caller: executing a freshly installed exe here can hang the script with no output
# while Defender/AV runs its first-launch cloud lookup.
$paths = @(
    "$env:LOCALAPPDATA\Programs\Amazon\AWSCLIV2\aws.exe",
    "$env:ProgramFiles\Amazon\AWSCLIV2\aws.exe"
)
$found = $null
foreach ($p in $paths) {
    if (Test-Path $p) { $found = $p; break }
}
if (-not $found) {
    Write-Error "aws.exe not found in any expected location after msiexec reported success."
    exit 1
}

Write-Output "Installed: $found"
