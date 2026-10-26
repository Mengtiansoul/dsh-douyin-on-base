Start-Sleep -Seconds 12
try { Restart-Service dsh-web -Force -ErrorAction Stop } catch { }