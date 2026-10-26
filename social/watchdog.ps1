$ErrorActionPreference = 'Continue'
$Dir = $PSScriptRoot
$Cfg = Join-Path (Split-Path $PSScriptRoot -Parent) 'config.json'
$Log = Join-Path $Dir 'watchdog.log'

function Rotate([string]$f) {
  try {
    if ((Test-Path $f) -and ((Get-Item $f).Length -gt 5MB)) {
      if (Test-Path ($f + '.1')) { Remove-Item ($f + '.1') -Force -ErrorAction SilentlyContinue }
      Move-Item $f ($f + '.1') -Force
    }
  } catch {}
}
Rotate $Log
Rotate (Join-Path $Dir 'bridge.out.log')

function W([string]$m) {
  $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $m + "`r`n"
  [System.IO.File]::AppendAllText($Log, $line, (New-Object System.Text.UTF8Encoding($false)))
}

# 用 node 读配置，避免 PowerShell 的 JSON 类型坑
$socialOff = 'false'
try {
  $socialOff = & node -e "const fs=require('fs');try{const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(String(!!(j.modules&&j.modules.social===false)))}catch(e){process.stdout.write('false')}" $Cfg
} catch { $socialOff = 'false' }

$found = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
           Where-Object { $_.CommandLine -like '*bridge.mjs*' })

if ($socialOff -eq 'true') {
  foreach ($p in $found) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($found.Count -gt 0) { W ('SOCIAL_OFF killed=' + $found.Count) }
  exit 0
}

# ---- 防误归档：桥写了 archived.flag 就排一次恢复任务（桥活着也可能被归档，所以放在存活检查前）----
$Flag = Join-Path $Dir 'archived.flag'
if (Test-Path $Flag) {
  # 用户可能已经自己点了「撤销归档」。先核对一眼再决定要不要排任务，
  # 不然就是排一条「白停一次宿主」的任务出来。
  $sid = ''
  try { $sid = [string]((Get-Content $Flag -Raw -Encoding UTF8 | ConvertFrom-Json).sessionId) } catch {}
  $dshHome = ''
  try {
    $dshHome = & node -e "const fs=require('fs');try{const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(String(j.dshHome||''))}catch(e){process.stdout.write('')}" $Cfg
  } catch {}
  if ($sid -and $dshHome -and $dshHome -ne 'null') {
    $wsJson = Join-Path $dshHome 'storages\workspace.json'
    if (Test-Path $wsJson) {
      try {
        $archived = (Get-Content $wsJson -Raw -Encoding UTF8 | ConvertFrom-Json).global.archivedSessionIds
        if (-not ($archived -contains $sid)) {
          W 'ARCHIVED_FLAG stale (user already unarchived) -> drop'
          Remove-Item $Flag -Force -ErrorAction SilentlyContinue
          exit 0
        }
      } catch {}
    }
  }

  $TaskName = 'dsh-douyin-recover-archived-once'
  $exist = (schtasks /query /tn $TaskName 2>$null)
  if ($LASTEXITCODE -ne 0) {
    W 'ARCHIVED_FLAG -> scheduling recovery'
    $pwsh = Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'
    if (-not (Test-Path $pwsh)) { $pwsh = 'powershell.exe' }
    $tr = '"' + $pwsh + '" -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $Dir 'recover-archived.ps1') + '"'
    (schtasks /create /tn $TaskName /tr $tr /sc once /st 00:00 /ru SYSTEM /rl HIGHEST /f 2>&1) | ForEach-Object { W ('create: ' + $_) }
    (schtasks /run /tn $TaskName 2>&1) | ForEach-Object { W ('run: ' + $_) }
  } else {
    W 'ARCHIVED_FLAG pending (recovery task already scheduled)'
  }
  exit 0
}

if ($found.Count -gt 0) { exit 0 }

W 'DOWN -> restarting'
try {
  Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' `
    -ArgumentList 'bridge.mjs' `
    -WorkingDirectory $Dir `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $Dir 'bridge.out.log') `
    -RedirectStandardError  (Join-Path $Dir 'bridge.err.log')
  Start-Sleep -Seconds 10
  $back = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like '*bridge.mjs*' })
  if ($back.Count -gt 0) { W ('RESTARTED pid=' + ($back.ProcessId -join ',')) }
  else { W 'RESTART_FAILED' }
} catch {
  W ('ERROR ' + $_.Exception.Message)
}