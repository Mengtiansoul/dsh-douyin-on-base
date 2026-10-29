// lib/automation.mjs —— 宿主内的自动化（守卫 / 日报 / 主动刷）
//
// 为什么放宿主里跑：以前这些靠 Windows 计划任务 + PowerShell 脚本，用户装完还得自己
// 去建任务，否则「到点关浏览器」「每晚写日记」全不生效。塞进宿主后，装完两行命令就能用。
//
// 三条都是幂等的：本机原有的计划任务还开着也不会互相打架（关浏览器重复执行无害，
// 日报按「当天是否已有产物」判重）。
//
// 平台：关浏览器那段只在 Windows 上做（该项目目标平台就是 Windows），其他平台跳过。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const SOCIAL_DIR = path.join(import.meta.dirname, '..', 'social');
const BASE = path.join(import.meta.dirname, '..');

const kill = (p) => { try { fs.rmSync(p, { force: true }); } catch {} };
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function appendLog(file, line) {
  try {
    const s = new Date().toISOString() + ' ' + line + '\n';
    fs.appendFileSync(path.join(SOCIAL_DIR, file), s, 'utf8');
  } catch { /* 日志失败不影响主流程 */ }
}

const pad = (n) => (n < 10 ? '0' + n : String(n));
const today = () => {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
};

function minutesOf(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function inAnyWindow(windows) {
  if (!Array.isArray(windows) || windows.length === 0) return true;
  const d = new Date();
  const cur = d.getHours() * 60 + d.getMinutes();
  for (const w of windows) {
    const s = minutesOf(w && w.start);
    const e = minutesOf(w && w.end);
    if (s == null || e == null) continue;
    if (s <= e) { if (cur >= s && cur < e) return true; }
    else if (cur >= s || cur < e) return true;
  }
  return false;
}

/** 关掉「管家专用 profile」的 Edge（不碰用户自己的浏览器） */
function closeButlerEdge(profile, tag) {
  if (process.platform !== 'win32') return;
  if (!profile) return;
  const norm = String(profile).replace(/\//g, '\\').replace(/\\+$/, '');
  const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\'" -ErrorAction SilentlyContinue | ' +
    'Where-Object { $_.CommandLine -like \'*' + norm.replace(/'/g, "''") + '*\' } | ' +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
  const run = (bin) => execFile(bin, ['-NoProfile', '-Command', ps], { windowsHide: true }, (err) => {
    if (err && bin === 'pwsh') run('powershell');
  });
  run('pwsh');
  appendLog('content-guard.log', 'CLOSED(in-host) reason=' + tag);
}

/**
 * 起一轮自动化。返回 dispose 函数。
 * @param {{getConfig: () => any, logger: any, dshBin?: string}} opts
 */
export function startAutomation(opts) {
  const logger = opts.logger || { info() {}, warn() {} };
  const getConfig = opts.getConfig || (() => ({}));
  const timers = [];
  let stopped = false;

  const cfgOn = (key, fallback = true) => {
    try {
      const a = getConfig()?.automation || {};
      return typeof a[key] === 'boolean' ? a[key] : fallback;
    } catch { return fallback; }
  };

  /* ---------- ① 守卫：每 5 秒 ---------- */
  if (cfgOn('guard', true)) {
    const tick = () => {
      if (stopped) return;
      try {
        // 有人要插队（来消息/有任务）→ 让路
        if (exists(path.join(SOCIAL_DIR, 'interrupt.flag'))) {
          kill(path.join(SOCIAL_DIR, 'interrupt.flag'));
          appendLog('content-guard.log', 'INTERRUPT detected(in-host)');
          try { closeButlerEdge(getConfig()?.browserProfile, 'interrupt'); } catch {}
          return;
        }
        if (exists(path.join(SOCIAL_DIR, 'stop.flag'))) {
          kill(path.join(SOCIAL_DIR, 'stop.flag'));
          appendLog('content-guard.log', 'STOP requested(in-host)');
          try { closeButlerEdge(getConfig()?.browserProfile, 'done'); } catch {}
          return;
        }

        const cfg = getConfig() || {};
        const st = readJson(path.join(BASE, 'state.json'));
        const day = today();

        // 每日上限到了：关浏览器 + 生成日报（每天一次）
        const capSec = Math.max(1, Number(cfg.limits?.browseMinutes || 60)) * 60;
        const capFlag = path.join(SOCIAL_DIR, 'cap-closed-' + day + '.flag');
        if (st.date === day && Number(st.browseSeconds || 0) >= capSec && !exists(capFlag)) {
          try { closeButlerEdge(cfg.browserProfile, 'cap ' + st.browseSeconds + 's/' + capSec + 's'); } catch {}
          try { fs.writeFileSync(capFlag, new Date().toISOString(), 'utf8'); } catch {}
          runDailyReport('cap');
        }

        // 出了可刷时段：关浏览器（每天一次）
        const wins = cfg.schedule?.windows || [];
        const winFlag = path.join(SOCIAL_DIR, 'window-closed-' + day + '.flag');
        if (wins.length > 0 && !inAnyWindow(wins)) {
          if (!exists(winFlag)) {
            try { closeButlerEdge(cfg.browserProfile, 'window'); } catch {}
            try { fs.writeFileSync(winFlag, new Date().toISOString(), 'utf8'); } catch {}
          }
        } else if (exists(winFlag)) {
          kill(winFlag);
        }
      } catch (e) {
        appendLog('content-guard.log', 'ERROR(in-host) ' + ((e && e.message) || e));
      }
    };
    tick();
    timers.push(setInterval(tick, 5000));
    logger.info('[douyin-on-base] 宿主内守卫已启动（5 秒一次）');
  }

  /* ---------- ② 日报：每分钟看一次，23:59 之后当天没产物就补 ---------- */
  let reportRunning = false;
  function runDailyReport(reason) {
    if (reportRunning) return;
    reportRunning = true;
    const script = path.join(SOCIAL_DIR, 'daily-report.mjs');
    if (!exists(script)) { reportRunning = false; return; }
    execFile(process.execPath, [script], { cwd: SOCIAL_DIR, windowsHide: true }, (err, stdout) => {
      reportRunning = false;
      if (err) { appendLog('daily-report.log', 'in-host failed: ' + ((err && err.message) || err)); return; }
      appendLog('daily-report.log', 'in-host ok (' + reason + ')' + (stdout ? ' ' + String(stdout).trim().slice(0, 120) : ''));
    });
  }

  if (cfgOn('dailyReport', true)) {
    const tick = () => {
      if (stopped) return;
      try {
        const d = new Date();
        const dueHour = 23;
        const dueMin = 59;
        const nowMin = d.getHours() * 60 + d.getMinutes();
        if (nowMin < dueHour * 60 + dueMin) return;          // 还没到点
        const day = today();
        const out = path.join(BASE, 'reports', 'douyin-diary-' + day + '.txt');
        if (exists(out)) return;                              // 今天已经有日记
        const flag = path.join(SOCIAL_DIR, 'report-done-' + day + '.flag');
        if (exists(flag)) return;
        try { fs.writeFileSync(flag, new Date().toISOString(), 'utf8'); } catch {}
        runDailyReport('schedule');
      } catch { /* 忽略 */ }
    };
    tick();
    timers.push(setInterval(tick, 60000));
    logger.info('[douyin-on-base] 宿主内日报已启动（每天 23:59 兜底）');
  }

  /* ---------- ③ 主动刷：每 15 分钟粗筛一次（默认关） ---------- */
  if (cfgOn('autoBrowse', false)) {
    const dshBin = opts.dshBin || process.argv[1];
    const tick = () => {
      if (stopped) return;
      const script = path.join(SOCIAL_DIR, 'douyin-desire.mjs');
      if (!exists(script)) return;
      const env = { ...process.env, DSH_BIN: 'node' };
      execFile(process.execPath, [script], { cwd: SOCIAL_DIR, windowsHide: true, env }, (err) => {
        if (err) appendLog('content-guard.log', 'desire failed: ' + ((err && err.message) || err));
      });
    };
    timers.push(setInterval(tick, 15 * 60 * 1000));
    logger.info('[douyin-on-base] 宿主内主动刷已启动（15 分钟一筛）');
  }

  return () => {
    stopped = true;
    for (const t of timers) { try { clearInterval(t); } catch {} }
  };
}
