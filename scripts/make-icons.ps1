# Icon pipeline: build the full Tauri icon set from the 512x512 master.
#
# NOTE: this script is deliberately ASCII-only. Windows PowerShell 5.1 parses
# .ps1 files as ANSI unless they carry a BOM, so non-ASCII text here turns into
# mojibake (and can even break the parser). Keep user-facing Chinese out of the
# scripts; it belongs in README/docs.
#
# Usage: pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\make-icons.ps1
#
# Outputs:
#   src-tauri/icons/32x32.png, 128x128.png, 128x128@2x.png, icon.png
#   src-tauri/icons/icon.ico             (multi-size, PNG-compressed, for exe + NSIS)
#   assets/tray-16.png, tray-32.png, tray-48.png

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path $PSScriptRoot -Parent
$master = Join-Path $root 'assets\LocalDanMu-512x512.png'
if (-not (Test-Path $master)) { throw "icon master not found: $master" }

$iconDir = Join-Path $root 'src-tauri\icons'
$assetDir = Join-Path $root 'assets'
New-Item -ItemType Directory -Force -Path $iconDir | Out-Null
New-Item -ItemType Directory -Force -Path $assetDir | Out-Null

$src = [System.Drawing.Image]::FromFile($master)

function New-SquareBitmap {
    param([int]$Size)
    $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($src, 0, 0, $Size, $Size)
    $g.Dispose()
    return $bmp
}

function Save-Resized {
    param([int]$Size, [string]$Path)
    $bmp = New-SquareBitmap -Size $Size
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output ("  {0} ({1}x{1})" -f $Path, $Size)
}

function Get-PngBytes {
    param([int]$Size)
    $bmp = New-SquareBitmap -Size $Size
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $bytes = $ms.ToArray()
    $ms.Dispose()
    # Unary comma: hand the byte[] back as ONE object instead of letting
    # PowerShell unroll it into N pipeline items (the classic gotcha).
    return , $bytes
}

Write-Output 'window icons:'
Save-Resized -Size 32  -Path (Join-Path $iconDir '32x32.png')
Save-Resized -Size 128 -Path (Join-Path $iconDir '128x128.png')
Save-Resized -Size 256 -Path (Join-Path $iconDir '128x128@2x.png')
Save-Resized -Size 512 -Path (Join-Path $iconDir 'icon.png')

Write-Output 'tray icons:'
Save-Resized -Size 16 -Path (Join-Path $assetDir 'tray-16.png')
Save-Resized -Size 32 -Path (Join-Path $assetDir 'tray-32.png')
Save-Resized -Size 48 -Path (Join-Path $assetDir 'tray-48.png')

Write-Output 'icon.ico (multi-size, embedded PNG frames):'
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$frames = @()
foreach ($s in $sizes) {
    [byte[]]$png = Get-PngBytes -Size $s
    if ($png.Length -lt 200) { throw ("frame $s suspiciously small: " + $png.Length + " bytes") }
    $frames += , $png
    Write-Output ("  frame {0,3}x{0,-3} = {1} bytes" -f $s, $png.Length)
}

$icoPath = Join-Path $iconDir 'icon.ico'
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([uint16]0)                # reserved
$bw.Write([uint16]1)                # type = icon
$bw.Write([uint16]$frames.Count)    # image count

$offset = 6 + 16 * $frames.Count
for ($i = 0; $i -lt $frames.Count; $i++) {
    $s = $sizes[$i]
    $dim = if ($s -ge 256) { 0 } else { $s }   # 256 is encoded as 0
    $bw.Write([byte]$dim)           # width
    $bw.Write([byte]$dim)           # height
    $bw.Write([byte]0)              # palette size
    $bw.Write([byte]0)              # reserved
    $bw.Write([uint16]1)            # planes
    $bw.Write([uint16]32)           # bits per pixel
    $bw.Write([uint32]$frames[$i].Length)
    $bw.Write([uint32]$offset)
    $offset += $frames[$i].Length
}
foreach ($f in $frames) { $bw.Write([byte[]]$f, 0, $f.Length) }
$bw.Flush(); $bw.Dispose(); $fs.Dispose()
Write-Output ("  {0} ({1} bytes, sizes: {2})" -f $icoPath, (Get-Item $icoPath).Length, ($sizes -join '+'))

# Sanity check: the icon must load back with all frames readable.
$ico = New-Object System.Drawing.Icon($icoPath)
Write-Output ("  verify: default frame {0}x{1}" -f $ico.Width, $ico.Height)
$ico.Dispose()

$src.Dispose()
Write-Output 'done.'
