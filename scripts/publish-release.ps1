# 创建 GitHub Release 并上传安装包（token 从本机 git 凭据里取，不落盘、不打印）
$ErrorActionPreference = 'Stop'
$owner = 'delaolao'
$repo = 'LocalDanMu'
$tag = 'v0.1.0'
$assetPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'dist\LocalDanMu-Setup-0.1.0.exe'

$f = Join-Path $env:TEMP 'cred-in.txt'
"protocol=https`nhost=github.com`n`n" | Set-Content $f -NoNewline -Encoding ASCII
$out = cmd /c "git credential fill < `"$f`"" 2>&1
Remove-Item $f -Force -ErrorAction SilentlyContinue
$token = (($out | Select-String '^password=') -replace '^password=', '')
if (-not $token) { throw '没有取到 GitHub 凭据' }

$headers = @{
  Authorization          = "Bearer $token"
  Accept                 = 'application/vnd.github+json'
  'X-GitHub-Api-Version' = '2022-11-28'
  'User-Agent'           = 'LocalDanMu-release'
}

$body = @{
  tag_name         = $tag
  name             = '培训弹幕 v0.1.0'
  target_commitish = 'main'
  draft            = $false
  prerelease       = $false
  body             = @'
## 培训弹幕 v0.1.0

线下培训用的局域网弹幕系统：讲师电脑本地运行，观众扫码即用，消息不出局域网。

### 包含功能
- 透明置顶弹幕层：点击穿透、悬停冻结、图片点击放大
- 词云模式：短句聚合 + 螺旋布局，右侧可回溯消息流
- 投屏引导页：大二维码 + 现场 WiFi 账密
- 关键词过滤：联系方式 / 广告 / 脏话规则 + 自定义词表导入
- 深色 / 浅色 / 跟随系统
- 置顶加固：WPS / PowerPoint 放映时弹幕仍在上层

### 安装
下载 `LocalDanMu-Setup-0.1.0.exe` 双击安装。未做代码签名，SmartScreen 提示时选「更多信息 → 仍要运行」。

### 首次使用
1. 手机与电脑连同一个 WiFi
2. 手机打不开：把 Windows 网络设为「专用」，或用面板上的「打开网络设置」
3. 场地 WiFi 若开了设备隔离，改用电脑开热点

> 消息只存在讲师电脑内存里，不落盘、不联网；结束培训即清空。
'@
} | ConvertTo-Json -Depth 5

try {
  $existing = Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$repo/releases/tags/$tag" -Headers $headers -Method Get
  Write-Output "release 已存在: $($existing.html_url)"
  $release = $existing
} catch {
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$repo/releases" -Headers $headers -Method Post -Body $body -ContentType 'application/json'
  Write-Output "release 已创建: $($release.html_url)"
}

$assets = Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$repo/releases/$($release.id)/assets" -Headers $headers -Method Get
if ($assets | Where-Object { $_.name -eq 'LocalDanMu-Setup-0.1.0.exe' }) {
  Write-Output '安装包已存在，跳过上传'
} else {
  if (-not (Test-Path $assetPath)) { throw "找不到安装包: $assetPath" }
  $sizeMB = [math]::Round((Get-Item $assetPath).Length / 1MB, 1)
  Write-Output "开始上传 $sizeMB MB ..."
  $up = Invoke-RestMethod -Uri "https://uploads.github.com/repos/$owner/$repo/releases/$($release.id)/assets?name=LocalDanMu-Setup-0.1.0.exe" `
    -Headers $headers -Method Post -ContentType 'application/octet-stream' -InFile $assetPath -TimeoutSec 900
  Write-Output "上传完成: $($up.browser_download_url)  ($([math]::Round($up.size/1MB,1)) MB)"
}
