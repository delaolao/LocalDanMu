# Build Windows artifacts: NSIS installer + single-exe green build.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-win.ps1
#   ... -SkipBundle        # only build the exe, skip NSIS packaging
#
# Artifacts (in dist\):
#   LocalDanMu-Setup-<ver>.exe   NSIS installer, per-user, start-menu shortcut
#   LocalDanMu-<ver>-green.zip   exe + portable.txt + README.txt, unzip and run
#
# Notes for a fresh machine (this is what actually bites in China):
#   - crates.io goes through a mirror (see ~/.cargo/config.toml).
#   - `cargo tauri build` wants to download NSIS from GitHub, which times out.
#     Pre-seed the toolchain once:
#       %LOCALAPPDATA%\tauri\NSIS\makensis.exe
#       %LOCALAPPDATA%\tauri\NSIS\Plugins\x86-unicode\additional\nsis_tauri_utils.dll
#     (sha1 75197FEE3C6A814FE035788D1C34EAD39349B860)
#     The bundler validates exactly that DLL; if it is missing it wipes the
#     directory and re-downloads. This script checks for it and says so.
#
# ASCII-only on purpose: Windows PowerShell 5.1 parses .ps1 as ANSI.

param(
  [switch]$SkipBundle
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
    $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"

    $manifest = Join-Path $root 'src-tauri\Cargo.toml'
    $version = (Select-String -Path $manifest -Pattern '^version\s*=\s*"([^"]+)"' | Select-Object -First 1).Matches[0].Groups[1].Value
    if (-not $version) { throw "cannot read version from $manifest" }
    Write-Host "version: $version"

    $nsisDir = Join-Path $env:LOCALAPPDATA 'tauri\NSIS'
    $nsisPlugin = Join-Path $nsisDir 'Plugins\x86-unicode\additional\nsis_tauri_utils.dll'
    if (-not (Test-Path (Join-Path $nsisDir 'makensis.exe')) -or -not (Test-Path $nsisPlugin)) {
        Write-Host ''
        Write-Host 'WARNING: local NSIS toolchain is incomplete.' -ForegroundColor Yellow
        Write-Host '         The bundler will try to download it from GitHub and probably time out.'
        Write-Host '         See the header of this script for the two files it needs.'
        Write-Host ''
    }

    Push-Location (Join-Path $root 'src-tauri')
    try {
        if ($SkipBundle) {
            & cargo build --release
            if ($LASTEXITCODE -ne 0) { throw "cargo build failed ($LASTEXITCODE)" }
        } else {
            & cargo tauri build --bundles nsis
            if ($LASTEXITCODE -ne 0) { throw "cargo tauri build failed ($LASTEXITCODE)" }
        }
    } finally {
        Pop-Location
    }

    $exe = Join-Path $root 'src-tauri\target\release\localdanmu.exe'
    if (-not (Test-Path $exe)) { throw "missing $exe" }

    $dist = Join-Path $root 'dist'
    New-Item -ItemType Directory -Force -Path $dist | Out-Null

    # ---- green build: one exe + a portable marker ------------------------
    $greenDir = Join-Path $dist 'green'
    if (Test-Path $greenDir) { Remove-Item $greenDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $greenDir | Out-Null
    Copy-Item $exe (Join-Path $greenDir 'LocalDanMu.exe')
    # Marker: makes the app keep settings.json next to the exe instead of AppData.
    Set-Content -Path (Join-Path $greenDir 'portable.txt') -Value 'portable' -Encoding ASCII
    if (Test-Path (Join-Path $root 'README.md')) {
        Copy-Item (Join-Path $root 'README.md') (Join-Path $greenDir 'README.txt')
    }
    $zip = Join-Path $dist "LocalDanMu-$version-green.zip"
    if (Test-Path $zip) { Remove-Item $zip -Force }
    & tar.exe -a -c -f $zip -C $greenDir .
    if ($LASTEXITCODE -ne 0) {
        Compress-Archive -Path (Join-Path $greenDir '*') -DestinationPath $zip -Force
    }

    # ---- report ---------------------------------------------------------
    $setup = Join-Path $root "src-tauri\target\release\bundle\nsis\LocalDanMu_${version}_x64-setup.exe"
    Write-Host ''
    Write-Host '========================= artifacts ========================='
    $exeMb = [math]::Round((Get-Item $exe).Length / 1MB, 2)
    Write-Host ("  exe     : {0} ({1} MB)" -f 'src-tauri\target\release\localdanmu.exe', $exeMb)
    if (Test-Path $setup) {
        $setupMb = [math]::Round((Get-Item $setup).Length / 1MB, 2)
        $named = Join-Path $dist "LocalDanMu-Setup-$version.exe"
        Copy-Item $setup $named -Force
        Write-Host ("  setup   : {0} ({1} MB)" -f "dist\LocalDanMu-Setup-$version.exe", $setupMb)
    }
    if (Test-Path $zip) {
        $zipMb = [math]::Round((Get-Item $zip).Length / 1MB, 2)
        Write-Host ("  green   : {0} ({1} MB)" -f "dist\LocalDanMu-$version-green.zip", $zipMb)
    }
    Write-Host '============================================================='
} finally {
    Pop-Location
}
