# 临时诊断：模拟"另一个激活的置顶全屏窗口"（类似 WPS/PPT 放映），
# 看弹幕层（透明、置顶、不抢焦点）能不能压在它上面。
param(
  [string]$OutDir = "scripts\out",
  [int]$HoldSeconds = 9,
  [string]$Exe = ""
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$rectFile = Join-Path $OutDir 'probe-rect.json'
$resultFile = Join-Path $OutDir 'probe-result.json'
Remove-Item $rectFile, $resultFile -Force -ErrorAction SilentlyContinue

Get-Process LocalDanMu, electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:LDM_CLICKPROBE = '1'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DpiApi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[DpiApi]::SetProcessDPIAware() | Out-Null

if ($Exe) {
  $proc = Start-Process -FilePath $Exe -PassThru
} else {
  $proc = Start-Process -FilePath "node_modules\electron\dist\electron.exe" -ArgumentList '.' -PassThru
}

for ($i = 0; $i -lt 300; $i++) {
  if (Test-Path $rectFile) { break }
  Start-Sleep -Milliseconds 200
}
if (-not (Test-Path $rectFile)) { Write-Output "FAIL: 图片没出现"; exit 1 }
$r = Get-Content $rectFile -Raw | ConvertFrom-Json
$px = [int]$r.click.px
$py = [int]$r.click.py

# 造一个置顶、全屏、带焦点（激活）的窗口，模拟放映中的 WPS/PPT
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.WindowState = 'Maximized'
$form.TopMost = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(255, 0, 255)
$form.ShowInTaskbar = $false
$form.Show()
$form.Activate()
[System.Windows.Forms.Application]::DoEvents()

$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
Write-Output ("fake topmost window: {0}x{1} @ ({2},{3})" -f $screen.Width, $screen.Height, $screen.X, $screen.Y)

# 保持激活并处理消息，同时让弹幕层的置顶循环有机会抢回来
$end = (Get-Date).AddSeconds($HoldSeconds)
$samples = @()
$idx = 0
while ((Get-Date) -lt $end) {
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 40
  $idx++
  if ($idx % 25 -eq 0) {
    $bmpTmp = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
    $gTmp = [System.Drawing.Graphics]::FromImage($bmpTmp)
    $gTmp.CopyFromScreen($screen.X, $screen.Y, 0, 0, $bmpTmp.Size)
    $c = $bmpTmp.GetPixel($px, $py)
    $samples += ("{0},{1},{2}" -f $c.R, $c.G, $c.B)
    $gTmp.Dispose(); $bmpTmp.Dispose()
  }
}
Write-Output ("samples: " + ($samples -join ' | '))

$bmp = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($screen.X, $screen.Y, 0, 0, $bmp.Size)
$shot = Join-Path $OutDir 'topmost-check.png'
$bmp.Save($shot, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
$form.Close(); $form.Dispose()

Write-Output ("screenshot: $shot  sample point=($px,$py)")
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
