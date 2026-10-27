# 一键打包（国内网络）：安装包 + 单文件便携版 + 绿色解压版
#
# 用法：npm run dist:cn
#   或： powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-win.ps1
#
# 产物：
#   dist\LocalDanMu-Setup-<ver>.exe        安装版
#   dist\LocalDanMu-Portable-<ver>.exe     单文件便携版（双击即用）
#   dist\LocalDanMu-<ver>-win-x64.zip      绿色解压版（解压后双击 LocalDanMu.exe）

$ErrorActionPreference = 'Stop'

# 国内直连 GitHub 拉 Electron / NSIS 会超时，统一走镜像
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
if (Test-Path Env:ELECTRON_RUN_AS_NODE) { Remove-Item Env:ELECTRON_RUN_AS_NODE }

$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
    npx electron-builder --win
    if ($LASTEXITCODE -ne 0) { throw "electron-builder 失败（退出码 $LASTEXITCODE）" }

    $pkg = Get-Content package.json -Raw | ConvertFrom-Json
    $version = $pkg.version
    $name = "LocalDanMu-$version-win-x64"
    $src = Join-Path $root 'dist\win-unpacked'
    $dst = Join-Path $root "dist\$name"
    $zip = Join-Path $root "dist\$name.zip"

    if (-not (Test-Path $src)) { throw "找不到 $src" }
    if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
    if (Test-Path $zip) { Remove-Item $zip -Force }

    Copy-Item $src $dst -Recurse

    # 便携标记：程序看到它就把 settings.json 写在 exe 旁边
    Set-Content -Path (Join-Path $dst 'portable.txt') -Value 'portable' -Encoding ASCII
    Copy-Item (Join-Path $root 'README.md') (Join-Path $dst 'README.txt')

    # 系统自带 tar（bsdtar）打 zip，比 Compress-Archive 快一个数量级
    & tar.exe -a -c -f $zip -C $dst .
    if ($LASTEXITCODE -ne 0) {
        Compress-Archive -Path (Join-Path $dst '*') -DestinationPath $zip -Force
    }

    Write-Host ''
    Write-Host "安装包   : dist\LocalDanMu-Setup-$version.exe"
    Write-Host "单文件版 : dist\LocalDanMu-Portable-$version.exe"
    Write-Host "绿色版   : dist\$name.zip"
} finally {
    Pop-Location
}
