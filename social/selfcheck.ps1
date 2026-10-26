<#
 自检：计划任务 / 端口 / 配置 / 登录态 / 依赖 / 进程
 用法： powershell -ExecutionPolicy Bypass -File social\selfcheck.ps1
#>
$ErrorActionPreference = 'Continue'
$Root = Split-Path $PSScriptRoot -Parent
$ok = 0; $bad = 0

function Check([string]$name, [bool]$pass, [string]$detail) {
  if ($pass) { $script:ok++; Write-Host ("[OK]   " + $name + $(if($detail){"  - " + $detail}else{""})) -ForegroundColor Green }
  else       { $script:bad++; Write-Host ("[FAIL] " + $name + $(if($detail){"  - " + $detail}else{""})) -ForegroundColor Red }
}

Write-Host "=== 计划任务 ==="
$tasks = @{
  'dsh-douyin-social-bridge'   = 'social\bridge.mjs'
  'dsh-douyin-social-watchdog' = 'social\watchdog.ps1'
  'dsh-douyin-content-guard'   = 'social\content-guard-loop.ps1'
  'dsh-douyin-daily-report'    = 'social\daily-report.mjs'
}
foreach ($t in $tasks.Keys) {
  $q = schtasks /query /tn $t /fo LIST /v 2>$null | Select-String "Task To Run"
  if (-not $q) { Check $t $false "任务不存在"; continue }
  $cmd = ($q.Line -split ':',2)[1].Trim()
  $path = [regex]::Match($cmd, '"([^"]+\.(mjs|ps1))"').Groups[1].Value
  Check $t (Test-Path $path) $(if($path){ Split-Path $path -Leaf } else { '解析不到路径' })
}

Write-Host "=== 端口 ==="
foreach ($p in @(3099, 9443)) {
  $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
  Check ("端口 " + $p) ([bool]$c) $(if($c){'监听中'}else{'未监听'})
}

Write-Host "=== 配置与数据 ==="
Check "config.json" (Test-Path (Join-Path $Root 'config.json'))
Check "data 登录态" (Test-Path (Join-Path $Root 'data'))
Check "social/sessions.json" (Test-Path (Join-Path $Root 'social\sessions.json'))
Check "social/channels.json" (Test-Path (Join-Path $Root 'social\channels.json'))
Check "依赖 douyin-im" (Test-Path (Join-Path $Root 'node_modules\douyin-im\package.json'))

Write-Host "=== 进程 ==="
Check "bridge.mjs 在跑" ([bool]@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*social\bridge.mjs*' }).Count)
Check "content-guard 在跑" ([bool]@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*content-guard-loop*' }).Count)

Write-Host ""
Write-Host ("结果：" + $ok + " 通过 / " + $bad + " 失败")
if ($bad -gt 0) { exit 1 }