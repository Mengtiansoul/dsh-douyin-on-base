# register-workspace.ps1 — 停 DSH → 跑 register-workspace.mjs → 起 DSH
#
# 参数全部透传给 .mjs，例如：
#   powershell -File social\register-workspace.ps1 -Path "D:\Deepseek-Harness\Social\douyin" -Title douyin `
#        -Sessions "douyin-ed84d0ea187f-188v,douyin-54e0b7b050d5-d947" -Unarchive "douyin-9707c5b1e2f1-yfsu"
#
# 为什么要停宿主：DSH 运行中会在退出时把内存里的工作区/归档状态写回 workspace.json，
# 边跑边改会被覆盖。
param(
  [string]$Path = "",
  [string]$Title = "",
  [string]$Sessions = "",
  [string]$Unarchive = "",
  [string]$DshHome = "",
  [string]$ServiceName = "dsh-web",
  [int]$Port = 3080,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$mjs = Join-Path $here "register-workspace.mjs"

$nodeArgs = @($mjs)
if ($Path) { $nodeArgs += @("--path", $Path) }
if ($Title) { $nodeArgs += @("--title", $Title) }
if ($Sessions) { $nodeArgs += @("--sessions", $Sessions) }
if ($Unarchive) { $nodeArgs += @("--unarchive", $Unarchive) }
if ($DshHome) { $nodeArgs += @("--dsh-home", $DshHome) }
$nodeArgs += @("--port", "$Port")
if ($DryRun) { $nodeArgs += "--dry-run" }

if ($DryRun) {
  & node @nodeArgs
  exit $LASTEXITCODE
}

Write-Host "[1/3] 停 $ServiceName（运行中改 workspace.json 会被内存状态覆盖）"
Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue
for ($i = 0; $i -lt 60; $i++) {
  if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Seconds 1
}

Write-Host "[2/3] 改 workspace.json"
& node @nodeArgs
$rc = $LASTEXITCODE

Write-Host "[3/3] 起 $ServiceName"
Start-Service $ServiceName
Write-Host "done (node exit=$rc)"
exit $rc
