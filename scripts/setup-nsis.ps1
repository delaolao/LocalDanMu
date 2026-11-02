# One-time setup: put the NSIS toolchain where the Tauri bundler expects it.
#
# Why this exists: `cargo tauri build` downloads NSIS from GitHub, which times out
# from mainland China and leaves you with "failed to bundle project: timeout: global".
# This script pre-seeds the exact files the bundler validates.
#
# The bundler considers a local NSIS install valid only when BOTH of these exist:
#   %LOCALAPPDATA%\tauri\NSIS\makensis.exe
#   %LOCALAPPDATA%\tauri\NSIS\Plugins\x86-unicode\additional\nsis_tauri_utils.dll
# If either is missing it wipes the directory and tries to re-download.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-nsis.ps1
#
# ASCII-only on purpose: Windows PowerShell 5.1 parses .ps1 as ANSI.

$ErrorActionPreference = 'Stop'

$nsisVersion = '3.13'
$utilsVersion = 'nsis_tauri_utils-v0.5.3'
$utilsSha1 = '75197FEE3C6A814FE035788D1C34EAD39349B860'

$nsisUrl = "https://github.com/tauri-apps/binary-releases/releases/download/nsis-$nsisVersion/nsis-$nsisVersion.zip"
$utilsUrl = "https://github.com/tauri-apps/nsis-tauri-utils/releases/download/$utilsVersion/nsis_tauri_utils.dll"

# GitHub proxies that actually work from here; first success wins.
$proxies = @('https://ghfast.top/', 'https://gh-proxy.com/', 'https://github.moeyy.xyz/', '')

$dest = Join-Path $env:LOCALAPPDATA 'tauri\NSIS'
$pluginDir = Join-Path $dest 'Plugins\x86-unicode\additional'

function Fetch([string]$url, [string]$outFile, [int]$minBytes) {
    foreach ($p in $proxies) {
        $candidate = "$p$url"
        Write-Host "  try $candidate"
        & curl.exe -sS -L --fail --connect-timeout 10 --max-time 300 -o $outFile $candidate
        if ($LASTEXITCODE -eq 0 -and (Test-Path $outFile) -and (Get-Item $outFile).Length -ge $minBytes) {
            Write-Host ("  ok ({0} bytes)" -f (Get-Item $outFile).Length)
            return $true
        }
        Remove-Item $outFile -Force -ErrorAction SilentlyContinue
    }
    return $false
}

Write-Host 'NSIS toolchain setup'
Write-Host "  target: $dest"

if (Test-Path (Join-Path $dest 'makensis.exe') -and (Test-Path (Join-Path $pluginDir 'nsis_tauri_utils.dll'))) {
    Write-Host '  already installed, nothing to do.'
    exit 0
}

$tmpZip = Join-Path $env:TEMP "nsis-$nsisVersion.zip"
Write-Host '  downloading NSIS...'
if (-not (Fetch $nsisUrl $tmpZip 500000)) { throw 'failed to download NSIS (all mirrors)' }

Write-Host '  extracting...'
$extractDir = Join-Path $env:TEMP "nsis-extract-$nsisVersion"
if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
Expand-Archive -Path $tmpZip -DestinationPath $extractDir -Force
$inner = Join-Path $extractDir "nsis-$nsisVersion"
if (-not (Test-Path (Join-Path $inner 'makensis.exe'))) { throw "unexpected archive layout: $inner" }

if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Path "$inner\*" -Destination $dest -Recurse -Force

Write-Host '  downloading nsis_tauri_utils.dll...'
$tmpDll = Join-Path $env:TEMP 'nsis_tauri_utils.dll'
if (-not (Fetch $utilsUrl $tmpDll 10000)) { throw 'failed to download nsis_tauri_utils.dll (all mirrors)' }

$actual = (Get-FileHash $tmpDll -Algorithm SHA1).Hash
Write-Host "  sha1: $actual"
if ($actual -ne $utilsSha1) { throw "sha1 mismatch, expected $utilsSha1" }

New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
Copy-Item $tmpDll (Join-Path $pluginDir 'nsis_tauri_utils.dll') -Force

Write-Host ''
Write-Host 'done. verify:'
Write-Host ("  makensis.exe : {0}" -f (Test-Path (Join-Path $dest 'makensis.exe')))
Write-Host ("  plugin dll   : {0}" -f (Test-Path (Join-Path $pluginDir 'nsis_tauri_utils.dll')))
