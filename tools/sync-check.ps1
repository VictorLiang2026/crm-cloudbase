# ============================================================
# sync-check.ps1 — 三方一致性体检（本地工作区 / GitHub / 线上托管）
# 用法:  powershell -File tools\sync-check.ps1
# 退出码: 0 = 全部一致；1 = 发现漂移（未提交 / 未推送 / 标签缺失 / 线上 MD5 不一致）
# 说明: admin.html 可直接 MD5 比对；云函数由助手通过 CloudBase MCP 部署，
#       若最近提交涉及 cloudfunctions/，请确认已部署（部署记录见会话/MCP 日志）。
# ============================================================
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$drift = 0
function Ok($m)  { Write-Host "[OK]   $m" -ForegroundColor Green }
function Bad($m) { Write-Host "[漂移] $m" -ForegroundColor Red; $script:drift = 1 }
function Sub($m) { Write-Host "       $m" -ForegroundColor DarkGray }

Write-Host "===== 三方一致性体检 =====" -ForegroundColor Cyan

# 1) 本地工作区是否有未提交改动
$status = @(git status --porcelain)
if ($status.Count -gt 0) {
  Bad "工作区有未提交改动（共 $($status.Count) 项）："
  $status | ForEach-Object { Sub $_ }
} else {
  Ok "工作区干净，无未提交改动"
}

# 2) 本地 master 与 GitHub origin/master
git fetch origin --quiet 2>$null
$ahead  = @(git log origin/master..master --oneline)
$behind = @(git log master..origin/master --oneline)
if ($ahead.Count -gt 0) {
  Bad "本地领先 GitHub，有 $($ahead.Count) 个提交未推送："
  $ahead | ForEach-Object { Sub $_ }
} elseif ($behind.Count -gt 0) {
  Bad "GitHub 领先本地，有 $($behind.Count) 个提交未拉取："
  $behind | ForEach-Object { Sub $_ }
} else {
  Ok "本地 master 与 GitHub origin/master 一致"
}

# 3) 标签本地 vs GitHub
$localTags  = @(git tag -l)
$remoteRaw  = @(git ls-remote --tags origin)
$remoteTags = $remoteRaw | ForEach-Object {
  $n = ($_ -split "`t")[1] -replace '^refs/tags/', ''
  $n -replace '\^\{\}$', ''
} | Sort-Object -Unique
$missingTags = @($localTags | Where-Object { $remoteTags -notcontains $_ })
if ($missingTags.Count -gt 0) {
  Bad "以下标签未推送到 GitHub：$($missingTags -join ', ')"
} else {
  Ok "版本标签本地与 GitHub 一致（共 $($localTags.Count) 个：$($localTags -join ', ')）"
}

# 4) 线上 admin.html MD5 vs 本地
# 注意：托管在 /crm-v1/ 子目录；tcbgw 网关对带查询参数的 URL 返回 404，故不加时间戳
# admin.html 已设置 no-store/no-cache meta，无需防缓存
$onlineUrl = 'https://crm-d1gkae8ddc930d151-1434199662.tcloudbaseapp.com/crm-v1/admin.html'
$tmp = Join-Path $env:TEMP ('sync_check_' + [guid]::NewGuid().ToString('N') + '.html')
try {
  Invoke-WebRequest -Uri $onlineUrl -OutFile $tmp -UseBasicParsing | Out-Null
  $onlineHash = (Get-FileHash $tmp -Algorithm MD5).Hash.ToLower()
  $localHash  = (Get-FileHash (Join-Path $repo 'admin.html') -Algorithm MD5).Hash.ToLower()
  if ($onlineHash -eq $localHash) {
    Ok "线上 admin.html 与本地一致（MD5 $localHash）"
  } else {
    Bad "admin.html 不一致：线上 $onlineHash / 本地 $localHash"
    Sub "可能原因：本地改动尚未部署到托管 /crm-v1/ 目录"
  }
} catch {
  Bad "无法获取线上 admin.html：$($_.Exception.Message)"
} finally {
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}

# 5) 提示：最近提交是否涉及云函数（提醒人工确认部署）
$cfCommits = @(git log origin/master -5 --oneline -- cloudfunctions)
if ($cfCommits.Count -gt 0) {
  Write-Host "[提示] 最近 5 个提交中有 $($cfCommits.Count) 个涉及 cloudfunctions/，请确认云函数已通过 MCP 部署：" -ForegroundColor Yellow
  $cfCommits | ForEach-Object { Sub $_ }
}

Write-Host ""
if ($drift -eq 0) {
  Write-Host "===== 体检结果：全部一致 =====" -ForegroundColor Green
  exit 0
} else {
  Write-Host "===== 体检结果：发现漂移，请按上述项处理 =====" -ForegroundColor Red
  exit 1
}
