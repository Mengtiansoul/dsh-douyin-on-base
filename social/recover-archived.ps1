# recover-archived.ps1 — 把被归档的社交会话捞回来（由看门狗排的一次性任务调用）
#
# 为什么必须走这条重路径：归档状态活在 DSH 宿主内存里，改 workspace.json 会被它在
# 退出时写回覆盖，所以只能「停宿主 → 改文件 → 起宿主」。代价是中断几十秒，
# 故默认延迟 60 秒再开始，让正在进行的对话先说完。
param(
  [int]$DelaySeconds = 60,
  [int]$Port = 3080,
  [string]$ServiceName = 'dsh-web'
)

$ErrorActionPreference = 'Continue'
$Dir = $PSScriptRoot
$Log = Join-Path $Dir 'recover.log'
$Flag = Join-Path $Dir 'archived.flag'
$Cfg = Join-Path (Split-Path $PSScriptRoot -Parent) 'config.json'
$TaskName = 'dsh-douyin-recover-archived-once'

function W([string]$m) {
  [System.IO.File]::AppendAllText($Log, ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $m + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
}
function PortListen([int]$p) { [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) }

try {
  if (-not (Test-Path $Flag)) { W 'no archived.flag, nothing to do'; exit 0 }
  $info = $null
  try { $info = Get-Content $Flag -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
  $sid = if ($info -and $info.sessionId) { [string]$info.sessionId } else { '' }
  if (-not $sid) { W 'flag has no sessionId, drop it'; Remove-Item $Flag -Force -ErrorAction SilentlyContinue; exit 1 }

  # 配置用 node 读，避免 PowerShell 的 JSON 类型坑
  $dshHome = ''
  try {
    $dshHome = & node -e "const fs=require('fs');try{const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(String(j.dshHome||''))}catch(e){process.stdout.write('')}" $Cfg
  } catch { $dshHome = '' }
  if ($null -eq $dshHome) { $dshHome = '' }
  if ($dshHome -eq 'null') { $dshHome = '' }

  if ($dshHome) { W ("start sid=" + $sid + " dshHome=" + $dshHome + " delay=" + $DelaySeconds) }
  else { W ("start sid=" + $sid + " dshHome=(empty，需在 config.json 填 dshHome)" + " delay=" + $DelaySeconds) }
  Start-Sleep -Seconds $DelaySeconds

  # 睡醒先看一眼：用户可能在这段时间里自己点了「撤销归档」。
  # 那种情况下状态已经对了，再停一次宿主就是白折腾（还白断一次所有会话）。
  if ($dshHome) {
    $wsJson = Join-Path $dshHome 'storages\workspace.json'
    if (Test-Path $wsJson) {
      try {
        $archived = (Get-Content $wsJson -Raw -Encoding UTF8 | ConvertFrom-Json).global.archivedSessionIds
        if (-not ($archived -contains $sid)) {
          W 'already unarchived by user -> stand down（不停宿主）'
          Remove-Item $Flag -Force -ErrorAction SilentlyContinue
          exit 0
        }
      } catch { W ('precheck failed: ' + $_.Exception.Message) }
    }
  }

  W 'stopping host'
  Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 40; $i++) { if (-not (PortListen $Port)) { break }; Start-Sleep -Seconds 1 }

  # 服务没停干净时端口还占着，此时改文件等于白改（旧进程退出会写回内存状态）。
  # 只杀 node 进程：3080 上还可能挂着系统服务的端口共享项，别手滑动它们。
  if (PortListen $Port) {
    foreach ($conn in @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
      if (-not $conn) { continue }
      $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($conn.OwningProcess)" -ErrorAction SilentlyContinue
      if ($proc -and $proc.Name -eq 'node.exe') {
        W ('port still busy by node pid=' + $proc.ProcessId + ' -> kill')
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
      }
    }
    Start-Sleep -Seconds 5
  }
  W ('stopped; port free=' + (-not (PortListen $Port)))

  $nodeArgs = @((Join-Path $Dir 'register-workspace.mjs'), '--unarchive', $sid, '--port', "$Port")
  if ($dshHome) { $nodeArgs += @('--dsh-home', $dshHome) }
  & node @nodeArgs 2>&1 | ForEach-Object { W ('node: ' + $_) }
  $rc = $LASTEXITCODE
  W "node exit=$rc"

  W 'starting host'
  Start-Service $ServiceName
  for ($i = 0; $i -lt 90; $i++) { if (PortListen $Port) { break }; Start-Sleep -Seconds 1 }
  W ('host up=' + (PortListen $Port))

  if ($rc -eq 0) { Remove-Item $Flag -Force -ErrorAction SilentlyContinue; W 'flag cleared' }
} catch {
  W ('ERROR ' + $_.Exception.Message)
  try { if (-not (PortListen $Port)) { Start-Service $ServiceName; W 'recovered: started host' } } catch { W 'recover failed' }
}

try { schtasks /delete /tn $TaskName /f 2>&1 | ForEach-Object { W ('cleanup: ' + $_) } } catch {}
