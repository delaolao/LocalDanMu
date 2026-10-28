# GitHub 不可达时反复重试：push 分支和 tag，成功后再发 release、传附件
$ErrorActionPreference = 'Continue'
$env:GIT_TERMINAL_PROMPT = '0'
$env:GCM_INTERACTIVE = 'never'

$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$log = Join-Path $root 'scripts\out\sync-github.log'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null

function Log($msg) {
  $line = "$(Get-Date -Format 'HH:mm:ss') $msg"
  Add-Content -Path $log -Value $line -Encoding UTF8
  Write-Output $line
}

$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$tag = "v$version"
Log "目标版本 $tag"

for ($i = 1; $i -le 40; $i++) {
  $push = git push origin main 2>&1
  if ($LASTEXITCODE -ne 0) {
    Log "第 $i 次 push 失败：$($push | Select-Object -Last 1)"
    Start-Sleep -Seconds 30
    continue
  }
  $tagPush = git push origin $tag 2>&1
  Log "push 成功（第 $i 次）；tag: $(if ($LASTEXITCODE -eq 0) { 'ok' } else { '已存在或失败' })"

  Log '创建/更新 release…'
  $rel = node scripts/publish-release.js 2>&1
  Log ($rel -join ' | ')

  Log '上传三个附件（约 370MB，可能要几分钟）…'
  $up = powershell -NoProfile -ExecutionPolicy Bypass -File scripts/upload-release-asset.ps1 2>&1
  Log ($up | Select-Object -Last 6 | Out-String)
  Log '完成'
  exit 0
}

Log '重试 40 次仍未成功，GitHub 一直不可达'
exit 1
