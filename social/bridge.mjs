import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createClient, configureLogger, segment } from 'douyin-im';

const DIR = process.env.DOUYIN_SOCIAL_DIR || path.dirname(fileURLToPath(import.meta.url));
const LOG = DIR + '/bridge.log';
const STATE = DIR + '/bridge-state.json';
const BRIDGE = 'http://127.0.0.1:3099/chat';
const CFG_FILE = process.env.DOUYIN_CFG_FILE || path.join(DIR, '..', 'config.json');

// 每次处理消息前重读配置 —— 面板保存后立刻生效，不用重启桥
let CFG = {};
function loadCfg() {
  try { CFG = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch (e) { CFG = {}; }
  return CFG;
}
function socialCfg() { return (CFG && CFG.social) || {}; }
loadCfg();

/** 把社交专用人设写进会话 cwd 的 AGENTS.md（会话会自己读它），不再污染每条消息 */
function applyPersona() {
  const S = socialCfg();
  const src = String(S.personaFile || '').trim();
  if (!src) return;
  try {
    const cwd = String(process.env.DOUYIN_CWD || path.join(DIR, '..', 'workspace'));
    const dst = path.join(cwd, 'AGENTS.md');
    const body = fs.readFileSync(src, 'utf8');
    if (!body.trim()) return;
    try { if (fs.existsSync(dst) && !fs.existsSync(dst + '.before-persona')) fs.copyFileSync(dst, dst + '.before-persona'); } catch (e0) {}
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(dst, body, 'utf8');
    log('PERSONA_APPLIED ' + src + ' -> ' + dst);
  } catch (e) { log('PERSONA_APPLY_FAIL ' + (e && e.message || e)); }
}
let lastPersonaApplied = '';
function applyPersonaIfChanged() {
  const cur = String((socialCfg() || {}).personaFile || '').trim();
  if (cur === lastPersonaApplied) return;
  lastPersonaApplied = cur;
  if (cur) applyPersona();
}
applyPersonaIfChanged();
let SELF_UID = '';                      // 登录后从 account.uid 自动取，不写死

const SEND_GAP_MS = 400;     // 多段之间的间隔
const DEBOUNCE_MS = 1500;    // 同一会话连发合并窗口
const REPLY_LIMIT = 40;      // 每日回复上限（对齐 on-base 原值）
const MAX_SEGMENTS = 8;      // 单轮最多发几段（防刷屏）
const FALLBACK = '等会儿，我这会儿有点卡';

/** 超过 5MB 就切成 .1，避免日志无限长 */
function rotateIfBig(f) {
  try {
    if (fs.existsSync(f) && fs.statSync(f).size > 5 * 1024 * 1024) {
      const old = f + '.1';
      try { fs.rmSync(old, { force: true }); } catch (e0) {}
      fs.renameSync(f, old);
    }
  } catch (e) {}
}
rotateIfBig(LOG);

function log(s) {
  const line = new Date().toISOString() + ' ' + s;
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
  console.log(line);
}

// ---- 每日计数（跨重启保留）----
function today() { return new Date().toISOString().slice(0, 10); }
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; }
}
function saveState(s) { try { fs.writeFileSync(STATE, JSON.stringify(s)); } catch {} }
let state = loadState();
if (state.date !== today()) { state = { date: today(), replies: 0 }; saveState(state); }
function countReply() { state.replies = (state.replies || 0) + 1; saveState(state); }

// ---- 防误归档：会话被归档后，回合在 pre-step 就被拒（表现只是"没有产出文本"），
//      这里提前认出来，回一句人话并把恢复标记交给看门狗，别让用户对着兜底话术猜。
const ARCHIVE_FLAG = path.join(DIR, 'archived.flag');
let archivedCacheAt = 0;
let archivedCache = new Set();

function mapFile() {
  const p = String(socialCfg().mapFile || '').trim();
  return p || path.join(DIR, 'sessions.json');
}
function boundSessionId(key) {
  try {
    const m = JSON.parse(fs.readFileSync(mapFile(), 'utf8'));
    return typeof m[key] === 'string' ? m[key] : '';
  } catch (e) { return ''; }
}
function archivedSet() {
  if (Date.now() - archivedCacheAt < 30000) return archivedCache;
  let set = new Set();
  const home = String(CFG.dshHome || process.env.DSH_HOME || '').trim();
  if (home) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8'));
      set = new Set((j.global && j.global.archivedSessionIds || []).map(String));
    } catch (e) {}
  }
  archivedCacheAt = Date.now();
  archivedCache = set;
  return set;
}
/** 归档了就返回那个 sessionId，否则空串 */
function archivedSessionOf(key) {
  if (socialCfg().autoUnarchive === false) return '';
  const sid = boundSessionId(key);
  return sid && archivedSet().has(sid) ? sid : '';
}
function flagArchived(sid, key) {
  try {
    fs.writeFileSync(ARCHIVE_FLAG, JSON.stringify({ sessionId: sid, key: key, at: new Date().toISOString() }, null, 2), 'utf8');
  } catch (e) {}
  kickRecovery();
}

/** 顺手把恢复任务排上，别等看门狗那一轮（5 分钟）；排不上就算了，看门狗会兜底 */
function kickRecovery() {
  if (process.platform !== 'win32') return;
  const task = 'dsh-douyin-recover-archived-once';
  const script = path.join(DIR, 'recover-archived.ps1');
  const pwsh = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  execFile('schtasks', ['/query', '/tn', task], (err) => {
    if (!err) return;                       // 已经排着一次了
    const tr = '"' + pwsh + '" -NoProfile -ExecutionPolicy Bypass -File "' + script + '"';
    execFile('schtasks', ['/create', '/tn', task, '/tr', tr, '/sc', 'once', '/st', '00:00', '/ru', 'SYSTEM', '/rl', 'HIGHEST', '/f'], (e2) => {
      if (e2) { log('RECOVER_TASK_CREATE_FAIL ' + (e2.message || e2)); return; }
      execFile('schtasks', ['/run', '/tn', task], (e3) => {
        log('RECOVER_TASK_RUN ' + (e3 ? (e3.message || e3) : 'ok'));
      });
    });
  });
}

// ---- 去抖：同一会话短时间内只处理最后一条 ----
const lastAt = new Map();
function debounced(threadId) {
  const now = Date.now();
  const prev = lastAt.get(threadId) || 0;
  lastAt.set(threadId, now);
  return now - prev < DEBOUNCE_MS;
}

// ---- 只按段落切，不改写内容（文本风格由专用人设负责）----
function splitParagraphs(text) {
  return String(text || '')
    .replace(/\[(表情|图片|语音|视频|贴纸)[:：][^\]]*\]/g, '')
    .split(/\n+/)
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; });
}

// ---- 群成员昵称：member 资料常没预载，按需 refresh 一次并缓存 ----
const nickCache = new Map();
async function resolveGroupName(ev) {
  const uid = ev.senderUid;
  if (nickCache.has(uid)) return nickCache.get(uid);
  let name = (ev.member && (ev.member.nickname || ev.member.alias)) || '';
  if (!name && ev.member && typeof ev.member.refresh === 'function') {
    try {
      await Promise.race([
        ev.member.refresh(),
        new Promise(function (r) { setTimeout(r, 2500); }),
      ]);
      name = ev.member.nickname || ev.member.alias || '';
    } catch (e) { log('NICK_REFRESH_FAIL ' + uid + ' ' + (e && e.message || e)); }
  }
  if (!name) name = uid;
  nickCache.set(uid, name);
  log('NICK_RESOLVED ' + uid + ' -> ' + name);
  return name;
}
// ---- 收藏表情缓存（发 sticker 用）----
let collectedStickers = [];
async function refreshStickers(account) {
  try {
    const r = await account.getCollectedEmojis({ firstPage: true });
    const list = (r && r.page && r.page.stickers) || [];
    collectedStickers = list;
    log('STICKERS_LOADED count=' + list.length + ' enabled=' + (r && r.page && r.page.stickerEnabledStatus));
  } catch (e) { log('STICKERS_FAIL ' + (e && e.message || e)); }
}
// ---- 出站投递箱：outbox.json = { target:'group:<id>'|'private:<uid>', text?, card?{itemId,title,authorName} } ----
async function drainOutbox(account) {
  const S0 = socialCfg();
  if (S0.allowOutbox === false) return;          // 主动投递总开关
  const f = DIR + '/outbox.json';
  if (!fs.existsSync(f)) return;
  let spec = null;
  try { spec = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return; }
  try { fs.unlinkSync(f); } catch (e) {}
  try {
    const t = String(spec.target || '');
    let contact = null;
    if (t.startsWith('group:')) contact = account.pickGroup(t.slice(6));
    else if (t.startsWith('private:')) contact = account.pickFriend(t.slice(8));
    if (!contact) { log('OUTBOX_NO_CONTACT ' + t); return; }
    if (spec.card && S0.allowCard === false) { log('OUTBOX_CARD_BLOCKED'); return; }
    const msg = spec.card
      ? segment.share({ itemId: String(spec.card.itemId), title: spec.card.title, authorName: spec.card.authorName })
      : String(spec.text || '');
    const r = await contact.sendMsg(msg);
    log('OUTBOX_SENT target=' + t + ' resp=' + JSON.stringify(r || {}).slice(0, 160));
  } catch (e) {
    log('OUTBOX_FAIL ' + (e && e.message || e));
  }
}
// ---- 导出群/好友清单，给设置页做白名单勾选 ----
async function dumpChannels(account) {
  try {
    const groups = await (account.getGroupList ? account.getGroupList(true) : Promise.resolve([])).catch(function () { return []; });
    const friends = await (account.getFriendList ? account.getFriendList() : Promise.resolve([])).catch(function () { return []; });
    const out = {
      updatedAt: new Date().toISOString(),
      groups: (groups || []).map(function (g) {
        return { id: String(g.groupId || g.id || ''), name: String(g.name || g.displayName || g.groupId || '') };
      }).filter(function (x) { return x.id; }),
      friends: (friends || []).map(function (f) {
        return { id: String(f.uid || f.id || ''), name: String(f.remark || f.nickname || f.displayName || f.uid || '') };
      }).filter(function (x) { return x.id; }),
    };
    fs.writeFileSync(DIR + '/channels.json', JSON.stringify(out, null, 2));
    log('CHANNELS_DUMPED groups=' + out.groups.length + ' friends=' + out.friends.length);
  } catch (e) { log('CHANNELS_FAIL ' + (e && e.message || e)); }
}

configureLogger({ level: 'info', color: false });
const client = createClient({ dataDir: process.env.DOUYIN_DATA_DIR || path.join(DIR, '..', 'data') });

client.on('system.online', function (p) {
  const a = p && p.account;
  if (a && a.uid) SELF_UID = String(a.uid);
  log('ONLINE nick=' + ((a && a.nickname) || '?') + ' uid=' + ((a && a.uid) || '?') + (SELF_UID ? ' (selfUid 已就绪)' : ''));
  if (a) { refreshStickers(a); dumpChannels(a); }
});
client.on('system.login.sms', function () { log('SMS_NEEDED（不应出现，登录态应自动恢复）'); });
client.on('system.login.error', function (p) { log('LOGIN_ERROR ' + ((p && p.error && p.error.message) || p)); });

client.on('message', async function (ev) {
  try {
    if (!ev) return;
    loadCfg();
    if (CFG.modules && CFG.modules.social === false) return;   // 社交模块总开关
    if (SELF_UID && ev.senderUid === SELF_UID) return;     // 防自回
    const text = String(ev.text || '').trim();
    if (!text) {
      // 非文本消息（表情/图片/卡片）：抓原始结构，用来学发送格式
      try {
        log('NON_TEXT type=' + ev.messageType
          + ' raw=' + String(ev.rawContent || '').slice(0, 900)
          + ' content=' + JSON.stringify(ev.content || null).slice(0, 900));
      } catch (e2) { log('NON_TEXT_LOG_FAIL ' + (e2 && e2.message || e2)); }
      return;
    }

    const isGroup = ev.isGroup === true || ev.type === 'message.group';

    // 有消息进来 = 内容模块必须让路（社交 > 内容）。
    // 只写一个 flag，由内容侧守卫脚本去关浏览器 —— 社交侧永不碰浏览器。
    try { fs.writeFileSync(DIR + '/interrupt.flag', new Date().toISOString()); } catch (eF) {}
    const S = socialCfg();
    const CH = S.channels || {};
    if (isGroup && CH.group === false) { return; }               // 群聊通道关
    if (!isGroup && CH.private === false) { return; }            // 私信通道关
    if (isGroup) {
      const wl = Array.isArray(S.groupWhitelist) ? S.groupWhitelist : [];
      if (wl.length && wl.indexOf(String(ev.threadId)) < 0) { log('SKIP_NOWHITELIST group ' + ev.threadId); return; }
    } else {
      const wf = Array.isArray(S.friendWhitelist) ? S.friendWhitelist : [];
      if (wf.length && wf.indexOf(String(ev.senderUid)) < 0) { log('SKIP_NOWHITELIST friend ' + ev.senderUid); return; }
    }
    const triggerMode = S.trigger === 'auto' ? 'auto' : 'mention';
    if (isGroup && triggerMode === 'mention' && !ev.isMentionMe) return;   // 仅@模式
    if (debounced(ev.threadId)) return;                    // 去抖
    if (state.date !== today()) { state = { date: today(), replies: 0 }; saveState(state); log('QUOTA_RESET ' + state.date); }
    const capReply = Number(S.dailyReplyLimit) || 40;
    if ((state.replies || 0) >= capReply) { log('LIMIT_HIT ' + state.replies + '/' + capReply); return; }

    try {
      log('DIAG type=' + ev.messageType + ' text=' + JSON.stringify(text).slice(0, 60)
        + ' content=' + JSON.stringify(ev.content || null).slice(0, 700)
        + ' raw=' + String(ev.rawContent || '').slice(0, 500));
    } catch (e3) {}

    const who = isGroup
      ? await resolveGroupName(ev)
      : ((ev.friend && (ev.friend.remark || ev.friend.nickname)) || ev.senderUid);
    if (isGroup) log('WHO_DIAG member=' + (ev.member ? 'yes' : 'no') + ' nick=' + ((ev.member && ev.member.nickname) || '-') + ' display=' + ((ev.member && ev.member.displayName) || '-'));
    log('RECV ' + (isGroup ? 'group' : 'private') + ' thread=' + ev.threadId + ' from=' + who + ' len=' + text.length);

    // 一次性自测：存在 flag 就多发一条 [呲牙]，验完自动删 flag
    // 转发测试：share-test.json = {itemId,title,authorName,coverUrl}
    if (fs.existsSync(DIR + '/share-test.json')) {
      try {
        const spec = JSON.parse(fs.readFileSync(DIR + '/share-test.json', 'utf8'));
        fs.unlinkSync(DIR + '/share-test.json');
        await ev.reply(segment.share({
          itemId: String(spec.itemId),
          title: spec.title,
          authorName: spec.authorName,
          coverUrl: spec.coverUrl,
        }));
        log('TEST_SHARE_SENT itemId=' + spec.itemId);
      } catch (e6) { log('TEST_SHARE_FAIL ' + (e6 && e6.message || e6)); }
    }

    if (fs.existsSync(DIR + '/sticker-test.flag')) {
      try {
        fs.unlinkSync(DIR + '/sticker-test.flag');
        if (collectedStickers.length > 0) {
          await ev.reply(segment.sticker(collectedStickers[0]));
          log('TEST_STICKER_SENT id=' + (collectedStickers[0].id || '?'));
        } else {
          log('TEST_STICKER_NONE');
        }
      } catch (e5) { log('TEST_STICKER_FAIL ' + (e5 && e5.message || e5)); }
    }

    if (fs.existsSync(DIR + '/emoji-test.flag')) {
      try {
        fs.unlinkSync(DIR + '/emoji-test.flag');
        await ev.reply('[呲牙]');
        log('TEST_EMOJI_SENT [呲牙]');
      } catch (e4) { log('TEST_EMOJI_FAIL ' + (e4 && e4.message || e4)); }
    }

    const key = (isGroup ? 'group:' : 'private:') + ev.threadId;
    let payload = isGroup ? ('[' + who + '] ' + text) : text;
    if (isGroup && triggerMode === 'auto') {
      payload = payload + '\n\n（如果这条你判断不需要回，就只输出 [SKIP] 四个字符，不要输出任何别的。）';
    }
    // 人设不再塞进消息正文 —— 启动时已经写进会话 cwd 的 AGENTS.md（见 applyPersona）

    // 绑定的会话被归档了？先认出来：这种情况 DSH 那边一个字都不会生成，
    // 再往下走只会拿到"没有产出文本"，用户对着兜底话术根本猜不到原因。
    const archivedSid = archivedSessionOf(key);
    if (archivedSid) {
      log('ARCHIVED_DETECTED key=' + key + ' session=' + archivedSid);
      flagArchived(archivedSid, key);
      await ev.reply('我这边会话被归档了，正在恢复，过一会儿再发我一句就行');
      return;
    }

    let reply;
    try {
      const r = await fetch(BRIDGE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: key, text: payload }),
        signal: AbortSignal.timeout(200000),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'bridge not ok');
      reply = d.reply;
      if (triggerMode === 'auto' && /^\s*[\[【]?\s*SKIP\s*[\]】]?\s*$/i.test(String(reply || ''))) {
        log('SKIP_DECIDED thread=' + ev.threadId);
        return;
      }
      log('BRIDGE_OK session=' + d.sessionId + ' len=' + String(reply || '').length);
    } catch (e) {
      log('BRIDGE_FAIL ' + (e && e.message || e));
      await ev.reply(FALLBACK);
      return;
    }

    const segs = splitParagraphs(reply);
    const maxSeg = Number(S.maxSegments) || 8;
    const gapMs = Number(S.sendGapMs) || 400;
    const send = segs.slice(0, maxSeg);
    if (segs.length > MAX_SEGMENTS) log('TRUNCATED ' + segs.length + ' -> ' + MAX_SEGMENTS);
    let lastSent = '';
    for (const s of send) {
      if (s === lastSent) { log('DEDUPE_SKIP ' + JSON.stringify(s).slice(0, 40)); continue; }
      lastSent = s;
      await ev.reply(s);
      await new Promise(function (r) { setTimeout(r, gapMs); });
    }
    countReply();
    log('SENT ' + send.length + ' 段');
  } catch (e) {
    log('HANDLER_FAIL ' + (e && e.message || e));
  }
});

client.on('system.handler.error', function (p) { log('HANDLER_ERROR ' + ((p && p.error && p.error.message) || p)); });

try {
  log('BOOT 恢复登录态…');
  await client.login();
  log('LOGIN_RESOLVED（桥上就绪）');
} catch (e) {
  log('LOGIN_THROW ' + (e && e.message || e));
}
// 每 2 秒看一次投递箱
setInterval(function () {
  try {
    loadCfg();
    if (CFG.modules && CFG.modules.social === false) { log('SOCIAL_MODULE_OFF -> exit'); process.exit(0); }
    applyPersonaIfChanged();
    const a = client.pickAccount();
    if (a) drainOutbox(a);
  } catch (e) {}
}, 2000);

setInterval(function () {}, 1 << 30);