# 上传 Release 附件（安装版 / 便携版 / 绿色 zip）
# 大文件用 curl：PowerShell 的 Invoke-RestMethod 在 100MB+ 会断，且 schannel 需要 --ssl-no-revoke
$ErrorActionPreference = 'Stop'
$owner = 'delaolao'
$repo = 'LocalDanMu'

$root = Split-Path $PSScriptRoot -Parent
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$tag = "v$version"
$assets = @(
  "LocalDanMu-Setup-$version.exe",
  "LocalDanMu-Portable-$version.exe",
  "LocalDanMu-$version-win-x64.zip"
)

# 取 token（只写进临时 curl 配置，命令行里不出现）
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

$cfg = Join-Path $env:TEMP 'github-upload.cfg'
@(
  "header = `"Authorization: Bearer $token`"",
  'header = "Content-Type: application/octet-stream"',
  'header = "User-Agent: LocalDanMu-release"'
) | Set-Content $cfg -Encoding ASCII

try {
  foreach ($name in $assets) {
    $path = Join-Path $root "dist\$name"
    $current = @(Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$repo/releases/$($release.id)/assets" -Headers $headers) |
      Where-Object { $_.name -eq $name }

    if ($current -and $current.state -eq 'uploaded') {
      Write-Output "跳过（已上传）: $name  $([math]::Round($current.size/1MB,1)) MB"
      continue
    }
    if ($current) {
      Write-Output "清理残片: $name state=$($current.state)"
      Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$repo/releases/assets/$($current.id)" -Headers $headers -Method Delete
    }
    if (-not (Test-Path $path)) { Write-Output "缺失，跳过: $path"; continue }

    $sizeMB = [math]::Round((Get-Item $path).Length / 1MB, 1)
    $url = "https://uploads.github.com/repos/$owner/$repo/releases/$($release.id)/assets?name=$name"
    Write-Output "上传 $name  $sizeMB MB ..."
    $resp = & curl.exe -sS --ssl-no-revoke --retry 3 --retry-delay 5 --max-time 1800 -K $cfg -X POST --data-binary "@$path" $url
    if ($LASTEXITCODE -ne 0) { Write-Output "curl 失败: $resp"; continue }
    $id = ($resp | ConvertFrom-Json).id
    if ($id) {
      $check = Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$repo/releases/assets/$id" -Headers $headers
      Write-Output "  完成: $($check.state)  $([math]::Round($check.size/1MB,1)) MB"
    } else {
      Write-Output "  未知结果: $resp"
    }
  }
} finally {
  Remove-Item $cfg -Force -ErrorAction SilentlyContinue
}

$final = Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$repo/releases/$($release.id)/assets" -Headers $headers
Write-Output '--- 当前附件'
$final | Select-Object name, @{n = 'MB'; e = { [math]::Round($_.size / 1MB, 1) } }, state | Format-Table -AutoSize
