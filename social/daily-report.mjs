import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));

const BASE = path.join(HERE, '..');
const LOGF = path.join(BASE, 'browse-log.jsonl');
const STATE = path.join(BASE, 'state.json');
const GUIDE = path.join(HERE, 'daily-report-guide.md');
const OUTDIR = path.join(HERE, '..', 'reports');
const BRIDGE = 'http://127.0.0.1:3099/chat';
const SELF = path.join(HERE, 'daily-report.log');

const log = (s) => {
  const line = new Date().toISOString() + ' ' + s;
  try { fs.appendFileSync(SELF, line + '\n'); } catch {}
  console.log(line);
};
const today = () => new Date().toISOString().slice(0, 10);

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } }
function readBrowse() {
  try {
    return fs.readFileSync(LOGF, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((x) => x && String(x.t || '').startsWith(today()));
  } catch { return []; }
}

const st = readJson(STATE);
const items = readBrowse();
const mins = Math.round((st.browseSeconds || 0) / 60);

const seen = [];
const uniq = new Set();
for (const it of items) {
  const key = (it.desc || '') + '|' + (it.digg || '');
  if (uniq.has(key)) continue;
  uniq.add(key);
  seen.push(it);
}

const material = [
  '【今天的原始素材，仅供你写日记参考，不要原样罗列】',
  '累计刷了约 ' + mins + ' 分钟。',
  '看过的视频（按时间顺序，最多 12 条）：',
  ...(seen.slice(0, 12).map((it, i) =>
    (i + 1) + '. ' + ((it.desc || '(无文案)').replace(/\s+/g, ' ').slice(0, 80)) +
    (it.digg ? ' —— ' + it.digg + ' 赞' : ''))),
  '今天点了 ' + (st.likes || 0) + ' 个赞、收藏 ' + (st.favorites || 0) + ' 个、评论 ' + (st.comments || 0) + ' 条。',
].join('\n');

let guide = '';
try { guide = fs.readFileSync(GUIDE, 'utf8'); } catch { guide = '用第一人称写一段一百多字的日记，别列清单、别堆数字。'; }

let diary = '';
try {
  const r = await fetch(BRIDGE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'report:daily', text: guide + '\n\n' + material + '\n\n现在，写今天这一篇。只输出日记正文。' }),
    signal: AbortSignal.timeout(280000),
  });
  const d = await r.json();
  if (!d.ok) throw new Error(d.error || 'bridge not ok');
  diary = d.reply;
  log('日记生成成功（' + diary.length + ' 字）');
} catch (e) {
  log('生成失败，退回素材原文：' + (e && e.message || e));
  diary = material;
}

fs.mkdirSync(OUTDIR, { recursive: true });
const file = path.join(OUTDIR, 'douyin-diary-' + today() + '.txt');
fs.writeFileSync(file, diary, 'utf8');
log('已写入 ' + file);

// 投递不在这里做：插件是通用的，使用者接什么渠道（QQ/飞书/网页/无）由他们自己决定。
// 需要投递的话，由宿主那侧的定时任务/会话读取这个 txt 再发。
console.log('----- 日记正文 -----');
console.log(diary);