# 用 curl 上传大文件（PowerShell 的 Invoke-RestMethod 在 100MB+ 上会断）
$ErrorActionPreference = 'Stop'
$owner = 'delaolao'
$repo = 'LocalDanMu'
$tag = 'v0.1.0'
$assetName = 'LocalDanMu-Setup-0.1.0.exe'
$assetPath = Join-Path (Split-Path $PSScriptRoot -Parent) "dist\$assetName"

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

$release = Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$repo/releases/tags/$tag" -Headers $headers
$assetList = Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$repo/releases/$($release.id)/assets" -Headers $headers

# 清掉之前失败留下的同名残片
foreach ($a in @($assetList)) {
  if ($a.name -eq $assetName -and $a.state -ne 'uploaded') {
    Write-Output "删除残片: $($a.name) state=$($a.state)"
    Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$repo/releases/assets/$($a.id)" -Headers $headers -Method Delete
  }
  if ($a.name -eq $assetName -and $a.state -eq 'uploaded') {
    Write-Output "已存在且完整: $($a.browser_download_url)"
    exit 0
  }
}

if (-not (Test-Path $assetPath)) { throw "找不到安装包: $assetPath" }

# token 只写进临时 curl 配置，命令行里不出现
$cfg = Join-Path $env:TEMP 'github-upload.cfg'
@(
  "header = `"Authorization: Bearer $token`"",
  'header = "Content-Type: application/octet-stream"',
  'header = "User-Agent: LocalDanMu-release"'
) | Set-Content $cfg -Encoding ASCII

try {
  $url = "https://uploads.github.com/repos/$owner/$repo/releases/$($release.id)/assets?name=$assetName"
  $sizeMB = [math]::Round((Get-Item $assetPath).Length / 1MB, 1)
  Write-Output "上传 $sizeMB MB -> $url"
  $resp = & curl.exe -sS --ssl-no-revoke --retry 3 --retry-delay 5 --max-time 1800 -K $cfg -X POST --data-binary "@$assetPath" $url
  Write-Output $resp
} finally {
  Remove-Item $cfg -Force -ErrorAction SilentlyContinue
}
