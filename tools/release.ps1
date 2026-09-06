# ============================================================
# release.ps1 — 一键发布存档：提交全部改动 → 推送 master → （可选）打版本标签
# 用法:
#   powershell -File tools\release.ps1 -Message "feat: 功能说明"
#   powershell -File tools\release.ps1 -Message "feat: 功能说明" -Tag v1.0.5
# 流程约定（方案 B）:
#   1. 助手完成代码改动后，先通过 CloudBase MCP 部署 admin.html 托管 / 云函数；
#   2. 运行本脚本：git 提交 + 推送 + 打标签（GitHub 与本地同时留版本，可回滚）；
#   3. 脚本末尾自动调用 sync-check.ps1 做三方一致性体检。
# 注意: 本脚本只做 git 版本存档，不执行 CloudBase 部署（部署需 MCP 权限）。
# ============================================================
param(
  [string]$Message,
  [string]$Tag
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

# 1) 提交改动
$status = @(git status --porcelain)
if ($status.Count -eq 0) {
  Write-Host "工作区无改动，跳过提交。" -ForegroundColor Yellow
} else {
  if (-not $Message) {
    Write-Host "有 $($status.Count) 项未提交改动，但未提供 -Message，已中止。" -ForegroundColor Red
    Write-Host "用法: powershell -File tools\release.ps1 -Message `"提交说明`" [-Tag v1.0.5]" -ForegroundColor DarkGray
    exit 1
  }
  Write-Host "提交 $($status.Count) 项改动..." -ForegroundColor Cyan
  git add -A
  git commit -m $Message
}

# 2) 推送 master
Write-Host "推送 master 到 GitHub..." -ForegroundColor Cyan
git push origin master

# 3) 可选版本标签
if ($Tag) {
  if ($Tag -notmatch '^v\d+\.\d+\.\d+$') {
    Write-Host "标签格式错误：'$Tag'，应为 vX.Y.Z（如 v1.0.5）。代码已推送，但未打标签。" -ForegroundColor Red
    exit 1
  }
  $existing = @(git tag -l $Tag)
  if ($existing.Count -gt 0) {
    Write-Host "标签 $Tag 已存在，跳过打标签。" -ForegroundColor Yellow
  } else {
    $tagMsg = if ($Message) { "$Tag`: $Message" } else { "$Tag release" }
    Write-Host "打标签 $Tag 并推送..." -ForegroundColor Cyan
    git tag -a $Tag HEAD -m $tagMsg
    git push origin $Tag
  }
}

# 4) 一致性体检
Write-Host ""
& (Join-Path $PSScriptRoot 'sync-check.ps1')
exit $LASTEXITCODE
