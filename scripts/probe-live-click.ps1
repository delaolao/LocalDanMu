# 对正在运行的实例做一次"发图 → 找图 → 悬停 → 点击 → 检查大图"的闭环测试
param(
  [string]$Token,
  [int]$HoverMs = 600,
  [int]$AfterClickMs = 900
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Clicker {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
}
"@
[Clicker]::SetProcessDPIAware() | Out-Null

$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

function Grab {
  $w = [Clicker]::GetSystemMetrics(0); $h = [Clicker]::GetSystemMetrics(1)
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen(0, 0, 0, 0, $bmp.Size)
  $g.Dispose()
  return $bmp
}

function FindMagenta($bmp, $maxY = 500) {
  $cols = @{}
  for ($y = 0; $y -lt [Math]::Min($maxY, $bmp.Height); $y += 2) {
    for ($x = 0; $x -lt $bmp.Width; $x += 2) {
      $c = $bmp.GetPixel($x, $y)
      if ($c.R -gt 235 -and $c.G -lt 40 -and $c.B -gt 235) {
        if (-not $cols.ContainsKey($x)) { $cols[$x] = @($y, $y, 1) }
        else {
          $v = $cols[$x]
          if ($y -lt $v[0]) { $v[0] = $y }
          if ($y -gt $v[1]) { $v[1] = $y }
          $v[2]++
          $cols[$x] = $v
        }
      }
    }
  }
  if ($cols.Count -eq 0) { return $null }

  # 按列间隔把像素分成若干块，取像素最多的一块（避免两张图连成一个大框）
  $xs = $cols.Keys | Sort-Object
  $groups = @(); $cur = New-Object System.Collections.ArrayList
  $prev = -999
  foreach ($x in $xs) {
    if ($x - $prev -gt 40 -and $cur.Count -gt 0) { $groups += ,@($cur.ToArray()); $cur.Clear() }
    [void]$cur.Add($x)
    $prev = $x
  }
  if ($cur.Count -gt 0) { $groups += ,@($cur.ToArray()) }

  $best = $null; $bestCount = 0
  foreach ($gItem in $groups) {
    $g = @($gItem)
    $cnt = 0; foreach ($x in $g) { $cnt += $cols[$x][2] }
    if ($cnt -gt $bestCount) { $bestCount = $cnt; $best = $g }
  }
  if ($bestCount -lt 40) { return $null }

  $minX = ($best | Measure-Object -Minimum).Minimum
  $maxX = ($best | Measure-Object -Maximum).Maximum
  $minY = 99999; $maxYv = -1
  foreach ($x in $best) {
    if ($cols[$x][0] -lt $minY) { $minY = $cols[$x][0] }
    if ($cols[$x][1] -gt $maxYv) { $maxYv = $cols[$x][1] }
  }
  return [pscustomobject]@{ X = [int](($minX + $maxX) / 2); Y = [int](($minY + $maxYv) / 2); W = $maxX - $minX; H = $maxYv - $minY; Count = $bestCount }
}

"发送测试图..."
$send = node scripts/send-test-image.js $Token 2>&1
"  $send"

"等待图片进入屏幕..."
$target = $null
$deadline = (Get-Date).AddSeconds(12)
while ((Get-Date) -lt $deadline) {
  $bmp = Grab
  $hit = FindMagenta $bmp
  $bmp.Dispose()
  if ($hit -and $hit.X -lt 2300) { $target = $hit; break }   # 进入画面中部再点
  Start-Sleep -Milliseconds 250
}
if (-not $target) { "FAIL: 屏幕上没找到测试图"; exit 1 }
"找到图片: center=($($target.X),$($target.Y)) size=$($target.W)x$($target.H) count=$($target.Count)"

[Clicker]::SetCursorPos($target.X, $target.Y) | Out-Null
Start-Sleep -Milliseconds $HoverMs

$before = Grab
$bmpBefore = FindMagenta $before
$before.Dispose()

[Clicker]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 80
[Clicker]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds $AfterClickMs

$after = Grab
$shot = "scripts\out\live-click-after.png"
$after.Save((Join-Path $root $shot), [System.Drawing.Imaging.ImageFormat]::Png)

# 大图打开后：画面中央应出现大面积品红
$centerX = [int]($after.Width / 2); $centerY = [int]($after.Height / 2)
$c = $after.GetPixel($centerX, $centerY)
$big = 0
for ($y = $centerY - 200; $y -lt $centerY + 200; $y += 10) {
  for ($x = $centerX - 300; $x -lt $centerX + 300; $x += 10) {
    $p = $after.GetPixel($x, $y)
    if ($p.R -gt 235 -and $p.G -lt 40 -and $p.B -gt 235) { $big++ }
  }
}
$after.Dispose()

"点击后中心像素: $($c.R),$($c.G),$($c.B)；中心区品红采样点数: $big"
if ($big -gt 50) { "RESULT: 大图已打开（正常）" } else { "RESULT: 大图没打开（复现问题）" }
"截图: $shot"
