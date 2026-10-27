# 临时诊断脚本：用真实鼠标事件点击弹幕层上的图片，验证"悬停→接管→大图"链路
#   dev:       -Exe ""                        -OutDir "scripts\out"
#   packaged:  -Exe "dist\...\LocalDanMu.exe"  -OutDir "$env:TEMP\localdanmu-smoke"
param(
  [int]$DelayMs = 600,
  [string]$Exe = "",
  [string]$OutDir = "scripts\out"
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$rectFile = Join-Path $OutDir 'probe-rect.json'
$resultFile = Join-Path $OutDir 'probe-result.json'
$hoverPng = Join-Path $OutDir 'probe-hover.png'

Get-Process LocalDanMu, electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:LDM_CLICKPROBE = '1'
Remove-Item $rectFile, $resultFile, $hoverPng -Force -ErrorAction SilentlyContinue

$devExe = "node_modules\electron\dist\electron.exe"
if ($Exe) {
  $proc = Start-Process -FilePath $Exe -PassThru
} else {
  $proc = Start-Process -FilePath $devExe -ArgumentList '.' -PassThru
}

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MouseProbe {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
}
"@
[MouseProbe]::SetProcessDPIAware() | Out-Null

for ($i = 0; $i -lt 300; $i++) {
  if (Test-Path $rectFile) { break }
  Start-Sleep -Milliseconds 200
}
if (-not (Test-Path $rectFile)) {
  Write-Output "FAIL: 没有拿到矩形信息"
  if ($proc) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  exit 1
}

$r = Get-Content $rectFile -Raw | ConvertFrom-Json
$rect = @($r.rects)[0]
if (-not $rect -or -not $r.click) {
  Write-Output "FAIL: 屏幕上没有图片"
  if ($proc) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  exit 2
}

$px = [int]$r.click.px
$py = [int]$r.click.py
Write-Output ("image dip=({0:N0},{1:N0}) size={2}x{3}  scale={4}  click physical=({5},{6})" -f $r.click.dipX, $r.click.dipY, $rect.w, $rect.h, $r.scale, $px, $py)

# 先挪一下再点，确保产生真实的 mousemove
[MouseProbe]::SetCursorPos($px - 60, $py) | Out-Null
Start-Sleep -Milliseconds 350
[MouseProbe]::SetCursorPos($px, $py) | Out-Null
Start-Sleep -Milliseconds $DelayMs
[MouseProbe]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 90
[MouseProbe]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)

for ($i = 0; $i -lt 150; $i++) {
  if (Test-Path $resultFile) { break }
  Start-Sleep -Milliseconds 200
}
if (-not (Test-Path $resultFile)) { Write-Output "FAIL: 没有结果"; exit 3 }
Get-Content $resultFile -Raw
Write-Output ""
Write-Output ("hover 截图: " + (Test-Path $hoverPng))
