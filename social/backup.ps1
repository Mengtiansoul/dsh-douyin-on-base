<#
 每日备份：登录态 / 配置 / 会话映射，保留最近 7 份
#>
$ErrorActionPreference = 'Continue'
$Root = Split-Path $PSScriptRoot -Parent
$Dest = Join-Path $Root 'backups'
$Log  = Join-Path $Dest 'backup.log'
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$dir = Join-Path $Dest $stamp

function W([string]$m) {
  $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $m + "`r`n"
  [System.IO.File]::AppendAllText($Log, $line, (New-Object System.Text.UTF8Encoding($false)))
}

try {
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  if (Test-Path (Join-Path $Root 'data')) { Copy-Item (Join-Path $Root 'data') (Join-Path $dir 'data') -Recurse -Force }
  foreach ($f in @('config.json', 'state.json')) {
    $src = Join-Path $Root $f
    if (Test-Path $src) { Copy-Item $src (Join-Path $dir $f) -Force }
  }
  $sess = Join-Path $Root 'social\sessions.json'
  if (Test-Path $sess) { Copy-Item $sess (Join-Path $dir 'sessions.json') -Force }
  W ('OK ' + $stamp)

  # 只留最近 7 份
  Get-ChildItem $Dest -Directory | Sort-Object Name -Descending | Select-Object -Skip 7 | ForEach-Object {
    Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    W ('PRUNED ' + $_.Name)
  }
} catch {
  W ('ERROR ' + $_.Exception.Message)
}