# End-to-end probe for the real Tauri app (not the P1 spike).
#
# Verifies, with no human in the loop:
#   1. the session service really comes up and serves the viewer page;
#   2. the room token gate works (right token 200, wrong token 403);
#   3. static assets are embedded in the exe and served correctly;
#   4. the WebSocket protocol works (hello / ack / item / filtered);
#   5. the danmaku overlay is transparent, topmost, click-through, and never
#      steals the foreground focus.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\probe-app.ps1
#   ... -Exe "src-tauri\target\release\localdanmu.exe"
#
# ASCII-only on purpose: Windows PowerShell 5.1 parses .ps1 as ANSI.

param(
  [string]$Exe = "src-tauri\target\debug\localdanmu.exe",
  [string]$Token = "probetok",
  [int]$ReadyTimeoutSec = 90,
  [string]$OutDir = "scripts\out"
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Threading;
using System.Runtime.InteropServices;

public class AppProbe {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, IntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
    public const uint GW_HWNDPREV = 3;
    public const uint GW_HWNDNEXT = 2;
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtrW(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    public const int GWL_EXSTYLE = -20;
    public const long WS_EX_TRANSPARENT = 0x20;
    public const long WS_EX_TOOLWINDOW  = 0x80;
    public const long WS_EX_TOPMOST     = 0x8;
    public const long WS_EX_LAYERED     = 0x80000;
    public const long WS_EX_NOACTIVATE  = 0x8000000;

    public const uint LEFTDOWN = 0x0002;
    public const uint LEFTUP   = 0x0004;

    public static void ClickAt(int x, int y) {
        SetCursorPos(x, y);
        Thread.Sleep(80);
        mouse_event(LEFTDOWN, 0, 0, 0, IntPtr.Zero);
        Thread.Sleep(50);
        mouse_event(LEFTUP, 0, 0, 0, IntPtr.Zero);
    }

    public static long ExStyle(IntPtr h) { return (long)GetWindowLongPtrW(h, GWL_EXSTYLE); }
}
"@
[AppProbe]::SetProcessDPIAware() | Out-Null

$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    $debugDir = Join-Path $env:TEMP 'localdanmu-debug'
    $resultFile = Join-Path $OutDir 'probe-app-result.json'
    Remove-Item $resultFile -Force -ErrorAction SilentlyContinue

    $exePath = if ([System.IO.Path]::IsPathRooted($Exe)) { $Exe } else { Join-Path $root $Exe }
    if (-not (Test-Path $exePath)) { throw "exe not found: $exePath" }

    Get-Process localdanmu -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 400
    Remove-Item $debugDir -Recurse -Force -ErrorAction SilentlyContinue

    $results = [ordered]@{
        exe          = $exePath
        startedAt    = (Get-Date).ToString('o')
        http         = $null
        tokenGate    = $null
        assets       = $null
        websocket    = $null
        transparent  = $null
        topmost      = $null
        clickThrough = $null
        noFocusSteal = $null
        pass         = $false
        detail       = @()
        session      = $null
    }

    Write-Output "starting: $exePath"
    $env:LDM_TOKEN = $Token
    $env:LDM_PROBE = '1'
    # Loopback-only bind: a non-loopback listener makes Windows pop the firewall
    # dialog, which dims the desktop and swallows input, breaking the pixel and
    # click assertions below.
    $env:LDM_BIND = '127.0.0.1'
    $proc = Start-Process -FilePath $exePath -PassThru
    $results.detail += "pid=$($proc.Id)"

    # --- wait for the session info the app writes in debug builds -----------
    $sessionFile = Join-Path $debugDir 'session.json'
    $deadline = (Get-Date).AddSeconds($ReadyTimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path $sessionFile) { break }
        if ($proc.HasExited) { throw "app exited early (code $($proc.ExitCode))" }
        Start-Sleep -Milliseconds 250
    }
    if (-not (Test-Path $sessionFile)) { throw 'session.json never appeared' }
    $session = [System.IO.File]::ReadAllText($sessionFile) | ConvertFrom-Json
    $results.session = $session
    $port = [int]$session.port
    Write-Output "session: port=$port token=$($session.token)"
    $results.detail += "port=$port"

    Start-Sleep -Milliseconds 1200   # let windows settle

    function Pump([int]$ms) {
        $end = (Get-Date).AddMilliseconds($ms)
        while ((Get-Date) -lt $end) {
            [System.Windows.Forms.Application]::DoEvents()
            Start-Sleep -Milliseconds 12
        }
    }

    function Http-Get([string]$url) {
        try {
            $req = [System.Net.HttpWebRequest]::Create($url)
            # .NET defaults to the system proxy, which hijacks 127.0.0.1 requests
            $req.Proxy = $null
            $req.Timeout = 5000
            $req.AllowAutoRedirect = $false
            try {
                $res = $req.GetResponse()
            } catch [System.Net.WebException] {
                $res = $_.Exception.Response
            }
            if ($null -eq $res) { return @(-1, '') }
            $status = [int]$res.StatusCode
            $sr = New-Object System.IO.StreamReader($res.GetResponseStream())
            $body = $sr.ReadToEnd()
            $sr.Close(); $res.Close()
            return @($status, $body)
        } catch {
            return @(-1, $_.Exception.Message)
        }
    }

    # --- 1. HTTP ------------------------------------------------------------
    $base = "http://127.0.0.1:$port"
    $health = Http-Get "$base/healthz"
    $results.http = ($health[0] -eq 200 -and $health[1] -match '"ok":true')
    $results.detail += "healthz: status=$($health[0])"

    # --- 2. room token gate -------------------------------------------------
    $good = Http-Get "$base/j/$($session.token)"
    $bad = Http-Get "$base/j/wrongtoken"
    $results.tokenGate = ($good[0] -eq 200 -and $good[1] -match 'theme-boot\.js' -and $bad[0] -eq 403)
    $results.detail += "join page: good=$($good[0]) bad=$($bad[0])"

    # --- 3. embedded assets -------------------------------------------------
    $js = Http-Get "$base/assets/app.js"
    $css = Http-Get "$base/assets/style.css"
    $missing = Http-Get "$base/assets/nope.js"
    $results.assets = ($js[0] -eq 200 -and $js[1].Length -gt 1000 -and $css[0] -eq 200 -and $missing[0] -eq 404)
    $results.detail += "assets: app.js=$($js[0])($($js[1].Length)b) css=$($css[0]) missing=$($missing[0])"

    # --- 4. WebSocket protocol ---------------------------------------------
    $wsOk = $false
    try {
        $ws = New-Object System.Net.WebSockets.ClientWebSocket
        $ws.Options.Proxy = $null
        $cts = New-Object System.Threading.CancellationTokenSource
        $cts.CancelAfter(8000)
        $ws.ConnectAsync([Uri]"ws://127.0.0.1:$port/ws?t=$($session.token)", $cts.Token).GetAwaiter().GetResult() | Out-Null

        function Receive-Frame($socket) {
            $buf = New-Object byte[] 262144
            $seg = New-Object System.ArraySegment[byte] -ArgumentList @(,$buf)
            $c = New-Object System.Threading.CancellationTokenSource
            $c.CancelAfter(8000)
            $task = $socket.ReceiveAsync($seg, $c.Token)
            $task.GetAwaiter().GetResult() | Out-Null
            $len = $task.Result.Count
            return [System.Text.Encoding]::UTF8.GetString($buf, 0, $len)
        }
        function Send-Frame($socket, [string]$text) {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
            $seg = New-Object System.ArraySegment[byte] -ArgumentList @(,$bytes)
            $c = New-Object System.Threading.CancellationTokenSource
            $c.CancelAfter(8000)
            $socket.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $c.Token).GetAwaiter().GetResult() | Out-Null
        }

        $hello = Receive-Frame $ws | ConvertFrom-Json
        $results.detail += "ws hello: proto=$($hello.proto) intervalSec=$($hello.intervalSec)"

        # (a) Filtered content must be rejected WITHOUT consuming send quota.
        Send-Frame $ws '{"type":"message","msgId":"p1","contentType":"text","payload":"13800138000","clientId":"probe"}'
        $blocked = Receive-Frame $ws | ConvertFrom-Json

        # (b) The very next message must go through -> proves (a) cost no quota.
        Send-Frame $ws '{"type":"message","msgId":"p2","contentType":"text","payload":"probe hello","clientId":"probe"}'
        $ack = Receive-Frame $ws | ConvertFrom-Json
        $item = Receive-Frame $ws | ConvertFrom-Json

        # (c) Immediately after a successful send the per-user interval must bite.
        Send-Frame $ws '{"type":"message","msgId":"p3","contentType":"text","payload":"too soon","clientId":"probe"}'
        $tooFast = Receive-Frame $ws | ConvertFrom-Json

        $results.detail += "ws filtered=$($blocked.reason) thenOk=$($ack.status) seq=$($ack.seq) item=$($item.text) thenLimited=$($tooFast.status)"

        $wsOk = ($hello.proto -eq 1 -and
                 $blocked.reason -eq 'filtered' -and
                 $ack.status -eq 'ok' -and
                 $item.text -eq 'probe hello' -and
                 $tooFast.status -eq 'rate_limited')
        $ws.Dispose()
    } catch {
        $results.detail += "ws error: $($_.Exception.Message)"
    }
    $results.websocket = $wsOk

    # --- 5. overlay window properties --------------------------------------
    $overlayFile = Join-Path $debugDir 'overlay.txt'
    if (-not (Test-Path $overlayFile)) { throw 'overlay.txt never appeared' }
    $hwndVal = [int64]([System.IO.File]::ReadAllText($overlayFile).Trim())
    $hwnd = [IntPtr]$hwndVal
    $ex = [AppProbe]::ExStyle($hwnd)
    $results.detail += ("overlay hwnd=0x{0:x} ex_style=0x{1:x8}" -f $hwndVal, $ex)

    $hasNoActivate = ($ex -band [AppProbe]::WS_EX_NOACTIVATE) -ne 0
    $hasLayered = ($ex -band [AppProbe]::WS_EX_LAYERED) -ne 0
    $hasTransparent = ($ex -band [AppProbe]::WS_EX_TRANSPARENT) -ne 0
    $hasTopmost = ($ex -band [AppProbe]::WS_EX_TOPMOST) -ne 0
    $visible = [AppProbe]::IsWindowVisible($hwnd)
    $results.detail += "overlay style: noactivate=$hasNoActivate layered=$hasLayered transparent=$hasTransparent topmost=$hasTopmost visible=$visible"

    # --- transparency + topmost against an ACTIVATED topmost window -------
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $script:formClicks = 0
    $form = New-Object System.Windows.Forms.Form
    $form.FormBorderStyle = 'None'
    $form.WindowState = 'Maximized'
    $form.TopMost = $true
    $form.BackColor = [System.Drawing.Color]::FromArgb(255, 0, 255)
    $form.ShowInTaskbar = $false
    $form.Add_MouseClick({ $script:formClicks += 1 })
    $form.Show()
    $form.Activate()
    Pump 2200

    # The control panel sits in the middle; sample near the edges instead.
    $points = @(
        @([int]($bounds.Width * 0.05), [int]($bounds.Height * 0.85)),
        @([int]($bounds.Width * 0.95), [int]($bounds.Height * 0.70)),
        @([int]($bounds.Width * 0.10), [int]($bounds.Height * 0.30))
    )
    $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bmp.Size)
    $g.Dispose()
    $shot = Join-Path $OutDir 'app-main.png'
    $bmp.Save($shot, [System.Drawing.Imaging.ImageFormat]::Png)

    $magenta = 0
    foreach ($p in $points) {
        $c = $bmp.GetPixel($p[0], $p[1])
        if ([Math]::Abs($c.R - 255) -le 20 -and $c.G -le 20 -and [Math]::Abs($c.B - 255) -le 20) { $magenta += 1 }
    }
    $bmp.Dispose()
    $results.transparent = ($magenta -eq $points.Count)
    $results.detail += "transparent samples: $magenta/$($points.Count) magenta"

    # We must end up as the topmost window in the whole z-order.
    # Compare z-order against the fake PPT window specifically:
    # our own control panel legitimately sits above the overlay, so "nothing above" is wrong.
    # Walk DOWN the z-order from the overlay; the fake PPT window must appear below it.
    $formHwnd = $form.Handle
    $onTop = $false
    for ($i = 0; $i -lt 14; $i++) {
        $cursor = $hwnd
        for ($j = 0; $j -lt 400; $j++) {
            $cursor = [AppProbe]::GetWindow($cursor, [AppProbe]::GW_HWNDNEXT)
            if ($cursor -eq [IntPtr]::Zero) { break }
            if ($cursor -eq $formHwnd) { $onTop = $true; break }
        }
        if ($onTop) { break }
        Pump 250
    }
    $results.topmost = ($onTop -and $hasTopmost)
    $results.detail += "overlay is above the fake topmost PPT window: $onTop"

    # --- click-through ------------------------------------------------------
    $script:formClicks = 0
    $cx = [int]($bounds.Width * 0.05)
    $cy = [int]($bounds.Height * 0.85)
    [AppProbe]::ClickAt($cx, $cy)
    Pump 500
    $results.clickThrough = ($script:formClicks -ge 1)
    $results.detail += "click-through: form got $($script:formClicks) click(s)"

    # --- focus --------------------------------------------------------------
    $fg = [AppProbe]::GetForegroundWindow()
    $results.noFocusSteal = ($fg -ne $hwnd)
    $results.detail += ("foreground=0x{0:x} overlay=0x{1:x} (must differ)" -f $fg.ToInt64(), $hwndVal)

    $form.Close(); $form.Dispose()

    $results.pass = [bool]($results.http -and $results.tokenGate -and $results.assets -and
                           $results.websocket -and $results.transparent -and $results.topmost -and
                           $results.clickThrough -and $results.noFocusSteal)

    $results | ConvertTo-Json -Depth 6 | Set-Content $resultFile -Encoding UTF8

    Write-Output ''
    Write-Output '============== app end-to-end probe =============='
    Write-Output ("  http service             : {0}" -f $results.http)
    Write-Output ("  room token gate          : {0}" -f $results.tokenGate)
    Write-Output ("  embedded assets          : {0}" -f $results.assets)
    Write-Output ("  websocket protocol       : {0}" -f $results.websocket)
    Write-Output ("  overlay transparent      : {0}" -f $results.transparent)
    Write-Output ("  overlay above topmost win: {0}" -f $results.topmost)
    Write-Output ("  overlay click-through    : {0}" -f $results.clickThrough)
    Write-Output ("  never steals focus       : {0}" -f $results.noFocusSteal)
    Write-Output ("  RESULT                   : {0}" -f $(if ($results.pass) { 'PASS' } else { 'FAIL' }))
    Write-Output '=================================================='
    Write-Output "result : $resultFile"
    Write-Output "shot   : $shot"

    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    if ($results.pass) { exit 0 } else { exit 1 }
} finally {
    Remove-Item Env:LDM_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:LDM_PROBE -ErrorAction SilentlyContinue
    Remove-Item Env:LDM_BIND -ErrorAction SilentlyContinue
    Pop-Location
}
