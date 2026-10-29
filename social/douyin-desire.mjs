// social/douyin-desire.mjs —— 「突然想刷一会儿」的粗筛（纯脚本，不调模型）
//
// 用法（自己配一个计划任务，每 15 分钟跑一次）：
//   node social/douyin-desire.mjs           正常判断
//   node social/douyin-desire.mjs --dry-run 只看判断，不真跑
//   node social/douyin-desire.mjs --force   跳过窗口/概率（测链路用）
//
// 判断规则（全部来自设置页「内容模块 → 主动刷时段」）：
//   · 只在配置的时段内才可能刷；一条都不配 = 全天
//   · 每天最多 maxPerDay 次，两次至少隔 cooldownHours 小时
//   · 窗口内按「剩余次数 / 剩余档位」掷骰，不是到点必刷
//   · 命中后起一轮 headless DSH 会话去刷（需要 dsh 命令可用）
//
// 唤起方式：调 `dsh --profile headless <任务文本>`。如果你把 dsh 装在别处，
// 用环境变量 DSH_BIN 指过去，例如 DSH_BIN=/usr/local/bin/dsh。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..');
const CONFIG = path.join(PLUGIN, 'config.json');
const STATE = path.join(HERE, 'desire-state.json');
const TASKFILE = path.join(HERE, 'desire-task.txt');

const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const DSH_BIN = process.env.DSH_BIN || 'dsh';

const TASK = [
  '你突然有点想刷抖音了，没人叫你，是你自己想刷。',
  '打开抖音刷一轮，一般的就划过去。',
  '真觉得好的才点赞，一轮最多点一个，宁可一个都不点。收藏别动。',
  '刷够了自己收手，别一轮刷半小时，也别为了刷而刷。',
  '刷完回一句话：看了什么、有哪条让你停了一下、什么感觉。只写真的，没感觉就写没感觉，别编。',
  '刚才有人私信你的话，顺手看一眼，该回的回。',
  '这轮不用跟主人汇报，除非真碰上值得说的事。',
].join('\n');

const log = (m) => { if (DRY) process.stdout.write(new Date().toISOString() + ' ' + m + '\n'); };

function loadAutoBrowse() {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    const a = j.autoBrowse || {};
    const wins = Array.isArray(a.windows)
      ? a.windows.filter((w) => w && /^\d{2}:\d{2}$/.test(String(w.start || '')) && /^\d{2}:\d{2}$/.test(String(w.end || '')))
      : [];
    return {
      windows: wins,
      maxPerDay: Number.isFinite(Number(a.maxPerDay)) ? Number(a.maxPerDay) : 2,
      cooldownHours: Number.isFinite(Number(a.cooldownHours)) ? Number(a.cooldownHours) : 3,
    };
  } catch {
    return { windows: [], maxPerDay: 2, cooldownHours: 3 };
  }
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { day: '', fired: [] }; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE, JSON.stringify(s, null, 0), 'utf8'); } catch {}
}

const AB = loadAutoBrowse();
const now = new Date();
const day = now.toLocaleDateString('sv-SE');
const hourF = now.getHours() + now.getMinutes() / 60;
let st = loadState();
if (st.day !== day) { st = { day, fired: [] }; saveState(st); }

function inWindow() {
  if (!AB.windows.length) return true;
  const mins = Math.round(hourF * 60);
  for (const w of AB.windows) {
    const [sh, sm] = String(w.start).split(':').map(Number);
    const [eh, em] = String(w.end).split(':').map(Number);
    const s = sh * 60 + sm;
    const e = eh * 60 + em;
    if (s <= e ? mins >= s && mins < e : mins >= s || mins < e) return true;
  }
  return false;
}

if (!FORCE && !inWindow()) { log('skip: 不在主动刷时段内'); process.exit(0); }
if (st.fired.length >= AB.maxPerDay) { log('skip: 今天已经刷过 ' + st.fired.length + ' 次'); process.exit(0); }
if (st.fired.length > 0) {
  const gapH = (now.getTime() - new Date(st.fired[st.fired.length - 1]).getTime()) / 3600000;
  if (gapH < AB.cooldownHours) { log('skip: 距上次 ' + gapH.toFixed(1) + ' 小时'); process.exit(0); }
}

const nextEnd = AB.windows.length
  ? Math.min(...AB.windows.map((w) => {
      const [h, m] = String(w.end).split(':').map(Number);
      const e = h + m / 60;
      return e > hourF ? e : e + 24;
    }))
  : 24;
const slotsLeft = Math.max(Math.round(Math.max(nextEnd - hourF, 0) * 4), 1);
const p = Math.min(0.6, ((AB.maxPerDay - st.fired.length) / slotsLeft) * 1.5);
const roll = Math.random();
if (roll > p && !FORCE) { log('skip: 没冲动 (p=' + p.toFixed(3) + ' roll=' + roll.toFixed(3) + ')'); process.exit(0); }

log('fire: 想刷了 (p=' + p.toFixed(3) + ' roll=' + roll.toFixed(3) + ')');
if (DRY) {
  log('[dry-run] 会跑：' + DSH_BIN + ' --profile headless <任务>');
  log(TASK);
  process.exit(0);
}

try { fs.writeFileSync(TASKFILE, TASK, 'utf8'); } catch (e) { console.error('写任务文件失败:', e.message); process.exit(1); }
st.fired.push(new Date().toISOString());
saveState(st);

execFile(DSH_BIN, ['--profile', 'headless', TASK], { windowsHide: true }, (err, stdout, stderr) => {
  if (err) console.error('唤起失败（dsh 在 PATH 里吗？可以设 DSH_BIN）:', err.message, stderr || '');
  else console.log('唤起完成:', String(stdout || '').slice(0, 200));
});
