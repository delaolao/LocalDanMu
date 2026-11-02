# Feature probe: verify global shortcuts and the two extra full-screen windows.
#
# The end-to-end probe (probe-app.ps1) covers the network/overlay core. This one
# covers the parts that only show up on screen: pressing Ctrl+Alt+K must create
# the word-cloud window, Ctrl+Alt+J must create the join/guide window, and both
# must be real, visible top-level windows of the app process.
#
# It works by injecting REAL keystrokes (keybd_event) and then enumerating the
# process's visible top-level windows. That is the only way to prove a global
# shortcut is actually registered with the OS.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\probe-features.ps1
#
# ASCII-only on purpose: Windows PowerShell 5.1 parses .ps1 as ANSI.

param(
  [string]$Exe = "src-tauri\target\release\localdanmu.exe",
  [string]$OutDir = "scripts\out"
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class FeatProbe {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder buf, int max);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    const uint KEYUP = 0x0002;
    const byte VK_CONTROL = 0x11;
    const byte VK_MENU = 0x12;
    const byte VK_ESCAPE = 0x1B;

    public class WinInfo {
        public long Handle;
        public string Title;
    }

    public static List<WinInfo> VisibleWindows(uint pid) {
        var list = new List<WinInfo>();
        EnumWindows(delegate(IntPtr h, IntPtr p) {
            uint wpid;
            GetWindowThreadProcessId(h, out wpid);
            if (wpid == pid && IsWindowVisible(h)) {
                var sb = new StringBuilder(512);
                GetWindowTextW(h, sb, 512);
                var info = new WinInfo();
                info.Handle = h.ToInt64();
                info.Title = sb.ToString();
                list.Add(info);
            }
            return true;
        }, IntPtr.Zero);
        return list;
    }

    public static void Chord(byte vk) {
        keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
        keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(30);
        keybd_event(vk, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(40);
        keybd_event(vk, 0, KEYUP, UIntPtr.Zero);
        keybd_event(VK_MENU, 0, KEYUP, UIntPtr.Zero);
        keybd_event(VK_CONTROL, 0, KEYUP, UIntPtr.Zero);
    }

    public static void Esc() {
        keybd_event(VK_ESCAPE, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(40);
        keybd_event(VK_ESCAPE, 0, KEYUP, UIntPtr.Zero);
    }
}
"@
[FeatProbe]::SetProcessDPIAware() | Out-Null

$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    $resultFile = Join-Path $OutDir 'probe-features-result.json'
    Remove-Item $resultFile -Force -ErrorAction SilentlyContinue

    $exePath = if ([System.IO.Path]::IsPathRooted($Exe)) { $Exe } else { Join-Path $root $Exe }
    if (-not (Test-Path $exePath)) { throw "exe not found: $exePath" }

    Get-Process localdanmu -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 400
    Remove-Item (Join-Path $env:TEMP 'localdanmu-debug') -Recurse -Force -ErrorAction SilentlyContinue

    $env:LDM_BIND = '127.0.0.1'
    $env:LDM_PROBE = '1'
    $env:LDM_TOKEN = 'featprobe'

    Write-Output "starting: $exePath"
    $proc = Start-Process -FilePath $exePath -PassThru
    $pid_ = [uint32]$proc.Id

    # wait for the control window to show up
    $deadline = (Get-Date).AddSeconds(60)
    $initial = @()
    while ((Get-Date) -lt $deadline) {
        $initial = [FeatProbe]::VisibleWindows($pid_)
        if ($initial.Count -ge 2) { break }
        Start-Sleep -Milliseconds 300
    }
    Start-Sleep -Milliseconds 800
    $initial = [FeatProbe]::VisibleWindows($pid_)
    Write-Output ("initial visible windows: {0}" -f $initial.Count)
    foreach ($w in $initial) { Write-Output ("  - {0}" -f $w.Title) }

    # Ctrl+Alt+K -> word cloud
    [FeatProbe]::Chord(0x4B)
    Start-Sleep -Milliseconds 1800
    $afterCloud = [FeatProbe]::VisibleWindows($pid_)
    Write-Output ("after Ctrl+Alt+K: {0}" -f $afterCloud.Count)
    foreach ($w in $afterCloud) { Write-Output ("  - {0}" -f $w.Title) }

    $shotCloud = Join-Path $OutDir 'app-cloud.png'
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
    $g.Dispose()
    $bmp.Save($shotCloud, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()

    # back to scroll
    [FeatProbe]::Chord(0x4B)
    Start-Sleep -Milliseconds 1200

    # Ctrl+Alt+J -> join / guide screen
    [FeatProbe]::Chord(0x4A)
    Start-Sleep -Milliseconds 2000
    $afterJoin = [FeatProbe]::VisibleWindows($pid_)
    Write-Output ("after Ctrl+Alt+J: {0}" -f $afterJoin.Count)
    foreach ($w in $afterJoin) { Write-Output ("  - {0}" -f $w.Title) }

    $shotJoin = Join-Path $OutDir 'app-join.png'
    $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
    $g.Dispose()
    $bmp.Save($shotJoin, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()

    # close the guide screen again
    [FeatProbe]::Chord(0x4A)
    Start-Sleep -Milliseconds 1000
    $afterClose = [FeatProbe]::VisibleWindows($pid_)

    $initialTitlesFlat = @($initial | ForEach-Object { $_.Title })
    $results = [ordered]@{
        exe            = $exePath
        initialCount   = $initial.Count
        afterCloud     = $afterCloud.Count
        afterJoin      = $afterJoin.Count
        afterClose     = $afterClose.Count
        initialTitles  = @($initial | ForEach-Object { $_.Title })
        cloudTitles    = @($afterCloud | ForEach-Object { $_.Title })
        joinTitles     = @($afterJoin | ForEach-Object { $_.Title })
        # Compare title SETS, not counts: switching to the word cloud also hides the
        # overlay, so the window count can stay the same while a new window appears.
        cloudWindow    = (@($afterCloud | Where-Object { $initialTitlesFlat -notcontains $_.Title }).Count -ge 1)
        joinWindow     = (@($afterJoin  | Where-Object { $initialTitlesFlat -notcontains $_.Title }).Count -ge 1)
        cloudClosed    = ($afterClose.Count -le $afterJoin.Count)
        pass           = $false
        screenshots    = @($shotCloud, $shotJoin)
    }
    $results.pass = [bool]($results.cloudWindow -and $results.joinWindow)

    $results | ConvertTo-Json -Depth 5 | Set-Content $resultFile -Encoding UTF8

    Write-Output ''
    Write-Output '============ feature probe (shortcuts/windows) ===='
    Write-Output ("  Ctrl+Alt+K opens word cloud : {0}" -f $results.cloudWindow)
    Write-Output ("  Ctrl+Alt+J opens guide page : {0}" -f $results.joinWindow)
    Write-Output ("  RESULT                      : {0}" -f $(if ($results.pass) { 'PASS' } else { 'FAIL' }))
    Write-Output '=================================================='
    Write-Output "result : $resultFile"

    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    if ($results.pass) { exit 0 } else { exit 1 }
} finally {
    Remove-Item Env:LDM_BIND -ErrorAction SilentlyContinue
    Remove-Item Env:LDM_PROBE -ErrorAction SilentlyContinue
    Remove-Item Env:LDM_TOKEN -ErrorAction SilentlyContinue
    Pop-Location
}
