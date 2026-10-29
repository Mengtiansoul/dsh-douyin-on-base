// ============================================================
// 抖音插件（基于 star-browser 基座 v0.3.0）
//
// 能力：
//   · 专属 sessionId、接口 JSON（不走 DOM）、eval 注入滑动/点击
//   · 每日状态存储 + 防沉迷计时 + 转发配额 + 质量闸门
//
// 安装：dsh plugin add link:<包目录>/examples/douyin-on-base
// 依赖：star-browser 管家在线（star-browser --detach）
//
// ════════════════════════════════════════════════════════════
// 实测结论（2026-10-22，Edge 155 + 已登录抖音号；改代码前先看）
// ════════════════════════════════════════════════════════════
// 1) 搜索页走 XHR：/aweme/v1/web/general/search/single/ → data[].aweme_info
//    有 aweme_id / desc / author / statistics，单条约 900KB。
// 2) **推荐流不走 XHR**（React Server Components 首屏直出），网络日志只有
//    danmaku / stats / history 旁路请求，feed 元数据只能读 DOM。
// 3) 滑动：合成 KeyboardEvent(ArrowDown) 有效，被拦退 press。
// 4) 点赞/收藏按钮 **getBoundingClientRect 是 0x0**，Playwright 普通 click 被
//    「element is not visible」拦，必须派发完整鼠标序列（pointerdown →
//    mousedown → pointerup → mouseup → click）。
// 5) 评论框要先点占位符（.comment-input-inner-container 里的 div._x9Gwl7G）
//    才会挂出 Draft.js 编辑器；Draft.js 只认真键盘（管家的 type 可用）。
//    清空 = Control+a + Delete（会剩一个 \n，是空状态）。
// 6) 点赞数在 DOM：`[data-e2e="video-player-digg"]` 的 innerText，
//    实测值是 "7.9万" 这种短单位格式 → 必须写单位解析。
// 7) 分享面板（点 video-player-share）里实测能看到：
//    「分享给朋友」分组 + 群条目（如「某某群 65 分享」）+ 好友条目 +
//    「复制链接」按钮。**但入口存在 ≠ 送达可靠**：旧插件实测点完后群里
//    收不到、回执永远是「未确认」。所以 douyin_share 默认 dryRun，
//   真发送要显式 send:true，且结果标 uncertain（不谎报送达）。
// 8) 点赞/收藏/发评论都是对外可见动作；发评论默认只填草稿。
// 9) **消息列表是 180° 翻转渲染的**（实测 2026-10-22）：滚动容器
//    .messageMessageListlist 带 transform: matrix(-1,0,0,-1,0,0)。
//    → DOM 顺序是「新→旧」，items[0] 才是最新；原来 slice(-10) 读到的是**最旧**的
//      10 条，表现为「读出来的消息和界面对不上、新消息凭空消失」。
//    → 自己/对方不能按气泡 x 坐标判（翻转坐标系里长消息会漂），要看行容器
//      .MessageBoxContentrowBox 的 flex-direction：自己发的 row-reverse，对方的 row。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const name = 'douyin-on-base';
const inject = ['tools', 'agents'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(HERE, 'state.json');
const WAKE_LOG = path.join(HERE, 'wake.log');
/** 抖音会话名（昵称/群名）→ 专属 DSH 会话 ID 的映射 */
const CHAT_AGENTS_FILE = path.join(HERE, 'chat-agents.json');

/** 带时间戳的事件日志：写文件，不依赖宿主日志级别过滤，排查唤醒问题靠它 */
function wakeLog(line) {
  try {
    fs.appendFileSync(WAKE_LOG, new Date().toISOString() + ' ' + line + '\n');
  } catch { /* 日志写不进去也不能拖挂主流程 */ }
}

const HOST = (process.env.STAR_BROWSER_HOST || 'http://127.0.0.1:9443').replace(/\/+$/, '');
const SESSION_ID = process.env.DOUYIN_SESSION_ID || 'douyin-worker-1';
const RPC_TIMEOUT = 60000;

import { loadConfig, DEFAULT_CONFIG } from './lib/config-store.mjs';

/** 两次 douyin_next 间隔在 [1s, 120s] 内才计入浏览时长 */
const MIN_GAP_MS = 1000;
const MAX_GAP_MS = 120000;

/**
 * 运行期配置（config.json）。每次工具调用前调 reloadCfg()，
 * 所以设置面板里点保存后，下一次操作就生效 —— 不用重启宿主。
 * 文件坏了就沿用上一份，不让工具直接崩。
 */
let CFG = DEFAULT_CONFIG;
function reloadCfg() {
  try {
    CFG = loadConfig();
  } catch {
    /* config.json 坏了：保持上一份可用配置 */
  }
  return CFG;
}

/** 限额读数（每次现取，别缓存成常量） */
function lim() {
  const l = (CFG && CFG.limits) || DEFAULT_CONFIG.limits;
  return {
    browseSec: Math.max(1, Number(l.browseMinutes) || 60) * 60,
    group: Number(l.groupForwards ?? 5),
    private: Number(l.privateForwards ?? 3),
    replies: Number(l.replies ?? 10),
    minDigg: Number(l.minDigg ?? 5000),
  };
}

const OUTPUT_TEXT = {
  schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
  render: (_args, value) => [{ type: 'text', text: value.text }],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------
// 状态存储（每日重置）
// ------------------------------------------------------------
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function blankState() {
  return {
    date: today(),
    browseSeconds: 0,
    groupForwards: 0,
    privateForwards: 0,
    lastNextTime: 0,
    likes: 0,
    favorites: 0,
    comments: 0,
    lowQualityWarnings: 0,
    replies: 0,
  };
}

const NUMERIC_KEYS = ['browseSeconds', 'groupForwards', 'privateForwards', 'lastNextTime', 'likes', 'favorites', 'comments', 'lowQualityWarnings', 'replies'];

/** 读 state.json；跨天自动清零 */
function loadState() {
  let s = null;
  try {
    s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch { /* 第一次跑或文件坏了 */ }
  if (!s || typeof s !== 'object' || Array.isArray(s)) {
    s = blankState();
    saveState(s);
    return s;
  }
  if (s.date !== today()) {
    s = blankState();
    saveState(s);
    return s;
  }
  for (const k of NUMERIC_KEYS) {
    if (typeof s[k] !== 'number' || !Number.isFinite(s[k])) s[k] = 0;
  }
  return s;
}

/** 浏览日志文件（日报用） */
const BROWSE_LOG_FILE = path.join(path.dirname(STATE_FILE), 'browse-log.jsonl');

/** 现在在不在可刷时段里（留空 = 不限制；支持跨零点） */
function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}
function scheduleWindows() {
  let sch = {};
  try { sch = (typeof reloadCfg === 'function' ? reloadCfg() : CFG) || {}; } catch { sch = {}; }
  const w = sch.schedule || {};
  const list = Array.isArray(w.windows) ? w.windows : [];
  return list.map(function (x) {
    return { start: minutesOf(x && x.start), end: minutesOf(x && x.end), raw: x || {} };
  }).filter(function (x) { return x.start !== null && x.end !== null; });
}

/** 多个时段里任一时间命中即可；没配 = 不限制 */
function inScheduleWindow(now) {
  const wins = scheduleWindows();
  if (!wins.length) return true;
  const cur = now.getHours() * 60 + now.getMinutes();
  return wins.some(function (w) {
    return w.start <= w.end ? (cur >= w.start && cur < w.end) : (cur >= w.start || cur < w.end);
  });
}
function scheduleRefusal() {
  let sch = {};
  try { sch = (typeof reloadCfg === 'function' ? reloadCfg() : CFG) || {}; } catch { sch = {}; }
  const wins = scheduleWindows();
  const txt = wins.map(function (w) { return w.raw.start + '-' + w.raw.end; }).join('、');
  return '⛔ 现在不在可刷时段（配置 ' + txt + '）。去设置里改。';
}

/** 浏览日志：每滑一条记一行，日报靠它 */
function logBrowse(entry) {
  try {
    fs.appendFileSync(BROWSE_LOG_FILE, JSON.stringify(entry) + '\n');
  } catch { }
}

function saveState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
  } catch { /* 只读环境下不致命，但计时会丢 */ }
}

/** 浏览时长到了没有 */
function browseBlocked(st) {
  return st.browseSeconds >= lim().browseSec;
}

function browseBlockedText(st) {
  const mins = Math.round(st.browseSeconds / 60);
  return `⛔ 今日浏览已达上限（${Math.round(lim().browseSec / 60)} 分钟，已刷 ${mins} 分钟），不再下滑。\n` +
    `明天 0 点自动重置（state.json 的 date 变了就清零）。`;
}

// ------------------------------------------------------------
// 数值解析："7.9万" / "1.2w" / "1,234" / "3.1亿"
// ------------------------------------------------------------
function parseCount(text) {
  const s = String(text == null ? '' : text).replace(/[,，\s]/g, '');
  const m = s.match(/(\d+(?:\.\d+)?)\s*(亿|万|w|W|e|k|K)?/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2];
  if (unit === '万' || unit === 'w' || unit === 'W') n *= 1e4;
  else if (unit === '亿' || unit === 'e') n *= 1e8;
  else if (unit === 'k' || unit === 'K') n *= 1e3;
  return Math.round(n);
}

// ------------------------------------------------------------
// RPC 基础
// ------------------------------------------------------------
async function rpc(op, body = {}) {
  const res = await fetch(HOST + '/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, sessionId: SESSION_ID, ...body }),
    signal: AbortSignal.timeout(RPC_TIMEOUT),
  });
  return await res.json();
}

async function hostAlive() {
  try {
    const r = await fetch(HOST + '/health', { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch { return false; }
}

const HOST_DOWN = '❌ 浏览器基座没在跑。先起它：star-browser --detach';

/** 最近一次搜索的结果（给 douyin_open 按序号打开用） */
let lastAwemes = [];

// 最近一次工具调用时抓到的 agent 实例。工具 execute 的第二个参数 exec 里带 exec.agent，
// agent.id 就是会话 ID，agent.followup(msg) 能把消息喂回给这个会话的模型。
// DSH 的 Agent 接口（typert.host.js）：readonly id: SessionId; readonly options; followup(message)
let activeAgent = null;
let activeAgentAt = 0;
let pendingWake = false;

function rememberAgent(exec) {
  if (!exec || !exec.agent) return;
  if (typeof exec.agent.followup !== 'function') return;
  activeAgent = exec.agent;
  activeAgentAt = Date.now();
}

/** 造一条 plugin 来源的 user message（优先用 DSH 自己的构造器，解析不到就按结构手搓） */
async function buildUserMessage(text) {
  const source = { kind: 'plugin:douyin-on-base' };
  try {
    const mod = await import('@deepseek-ai/dsh-llm');
    if (mod && typeof mod.createUserMessage === 'function') {
      return mod.createUserMessage({ content: [{ type: 'text', text }], source });
    }
  } catch { /* 包解析不到，走手搓 */ }
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source,
  };
}

/**
 * 页面有新消息 → **按会话分发**到各自的 DSH 会话。
 *
 * 旧做法是把所有动静 followup 给「最近调过工具的那个 agent」，
 * 结果群、私信、QQ 会话全搅在一起，还可能喂给子会话没人回。
 * 现在：读会话列表的未读角标，谁的未读谁自己去处理，
 * 每个昵称/群名对应一个独立 DSH 会话（见 lib/chat-agents.mjs）。
 */
let chatAgentsRef = null;
let dispatching = false;
/** 同一会话名最近一次投递时间：只防同一条消息被重复投递，不是分钟级冷却 */
const lastChatWakeAt = new Map();
/** 会话名 → 上次看到的「最后一条消息预览」，用来在角标消失时也能发现新动静 */
const chatPreview = new Map();

/** 会话名归一化：抖音群标题常带成员数（「某某群(14)」） */
function normChatName(raw) {
  return String(raw || '').replace(/\s+/g, ' ').replace(/\(\d+\)\s*$/, '').trim();
}

async function wakeOnNewMessage(ev, logger) {
  if (dispatching) return;
  if (!chatAgentsRef) {
    wakeLog('有新消息（added=' + (ev.added || 1) + '）但会话池还没初始化，跳过');
    return;
  }
  dispatching = true;
  try {
    if (!(await ensureImPanel())) {
      wakeLog('有新消息（added=' + (ev.added || 1) + '）但消息面板打不开，跳过');
      return;
    }
    const raw = await evalOnPage(IM_LIST_EXPR, 10000);
    let list = [];
    try { list = JSON.parse(raw); } catch { list = []; }
    // ⚠️ 只看未读角标会漏消息（实测 2026-10-22）：消息面板一打开，抖音就把会话
    //    标成已读、角标直接消失，日志里全是「没有未读角标，跳过」。群里有人 @ 也读不到。
    //    所以再加一道「会话预览文本变了」的判断：预览变了 = 这个会话有新动静。
    //    （首次扫描只登记、不投递，避免启动时把所有旧会话全喂一遍。）
    const fresh = [];
    for (const c of list) {
      const nm = normChatName(c.name);
      if (!nm) continue;
      const sig = String(c.preview || '');
      const known = chatPreview.has(nm);
      const changed = known && chatPreview.get(nm) !== sig;
      chatPreview.set(nm, sig);
      if ((c.unread || 0) > 0 || changed) fresh.push({ ...c, name: nm, changed });
    }
    if (!fresh.length) {
      wakeLog('有新消息（added=' + (ev.added || 1) + '）但会话预览没变化，跳过');
      return;
    }
    for (const c of fresh) {
      const name = c.name;
      if (!name) continue;
      const now = Date.now();
      if (now - (lastChatWakeAt.get(name) || 0) < 12000) continue;  // 同一条消息不重复投递
      lastChatWakeAt.set(name, now);
      try {
        const agent = await chatAgentsRef.ensure(name);
        if (!agent) { wakeLog('会话「' + name + '」拿不到 agent，跳过'); continue; }
        // 回复规则（主人 2026-10-22 定）：私信一定回；群聊只有 @ 才回。
        const isGroup = c.isGroup === true;
        const text = isGroup
          ? '抖音群「' + name + '」有 ' + c.unread + ' 条新消息。\n' +
            '先 douyin_read_chat target="' + name + '" 看一眼**最后几条**：有没有 @ 你、有没有人在直接叫你。\n' +
            '有 → douyin_send_chat target="' + name + '" text="..." send=true 回；\n' +
            '没有 → 一个字都别发，这次当没看见。不要点评聊天记录、不要审稿式评论。\n' +
            '群聊看清是谁说的，别张冠李戴。'
          : '抖音私信「' + name + '」有 ' + c.unread + ' 条新消息。\n' +
            '你在抖音上收到一条私信。\n' +
            '先 douyin_read_chat target="' + name + '" 看一眼，**只针对最新那几条回应**——不要点评更早的聊天记录、不要审稿式评论。\n' +
            '私信一定要回（对方发「1」你就回「1」，这种也照回）。别把话推回去、别说教。\n' +
            '回就 douyin_send_chat target="' + name + '" text="..." send=true（对外可见）。';
        const msg = await buildUserMessage(text);
        agent.followup(msg);
        wakeLog('已投递「' + name + '」' + (isGroup ? '（群）' : '（私信）') + ' → ' + String(agent.id || '?') + '（' + c.unread + ' 条未读；气泡触发 ' + (ev.added || 1) + ' 条）');
      } catch (e) {
        wakeLog('投递「' + name + '」失败: ' + String((e && e.message) || e).slice(0, 300));
        logger.warn('[douyin-on-base] 投递「' + name + '」失败: ' + String((e && e.message) || e));
      }
    }
  } catch (e) {
    wakeLog('分发失败: ' + String((e && e.stack) || e).slice(0, 400));
    logger.warn('[douyin-on-base] 分发失败: ' + String((e && e.message) || e));
  } finally {
    dispatching = false;
  }
}

// ------------------------------------------------------------
// 页面脚本片段
// ------------------------------------------------------------
/** 派发完整鼠标序列（0x0 的隐藏按钮也能触发 React） */
const fireClick = (e2e) => `(() => {
  const d = document.querySelector('[data-e2e="${e2e}"]');
  if (!d) return { ok: false, error: '元素不存在: ${e2e}' };
  const r = d.getBoundingClientRect();
  const o = {
    bubbles: true, cancelable: true, view: window,
    clientX: r.x + Math.max(1, r.width / 2),
    clientY: r.y + Math.max(1, r.height / 2),
    button: 0,
  };
  d.dispatchEvent(new PointerEvent('pointerdown', o));
  d.dispatchEvent(new MouseEvent('mousedown', o));
  d.dispatchEvent(new PointerEvent('pointerup', o));
  d.dispatchEvent(new MouseEvent('mouseup', o));
  d.dispatchEvent(new MouseEvent('click', o));
  return { ok: true, rect: [Math.round(r.width), Math.round(r.height)] };
})()`;

const reactionState = (e2e) => `(() => {
  const d = document.querySelector('[data-e2e="${e2e}"]');
  return d ? (d.getAttribute('data-e2e-state') || '') : '';
})()`;

/** 点赞数字文本（"7.9万" 这种） */
const DIGG_TEXT_EXPR = `(() => {
  const d = document.querySelector('[data-e2e="video-player-digg"]');
  return d ? (d.innerText || '').trim() : '';
})()`;

const STATE_EXPR = `(() => {
  const vids = [...document.querySelectorAll('video')];
  const v = vids.find((x) => !x.paused) || vids[0] || null;
  const diggEl = document.querySelector('[data-e2e="video-player-digg"]');
  return {
    url: location.href,
    title: document.title || '',
    playing: v ? !v.paused : false,
    currentTime: v ? Math.round(v.currentTime) : 0,
    duration: v ? Math.round(v.duration || 0) : 0,
    videoCount: vids.length,
    diggText: diggEl ? (diggEl.innerText || '').trim() : '',
    diggState: diggEl ? (diggEl.getAttribute('data-e2e-state') || '') : '',
    collectState: document.querySelector('[data-e2e="video-player-collect"]')?.getAttribute('data-e2e-state') || '',
    desc: (() => { const sels = ['[data-e2e="video-desc"]', '.video-info-detail', '.xg-video-container h1']; for (const s of sels) { const el = document.querySelector(s); if (el && el.innerText && el.innerText.trim()) return el.innerText.trim().slice(0, 200); } return ''; })(),
    commentOpen: !!document.querySelector('.comment-input-inner-container [contenteditable="true"]'),
  };
})()`;

/**
 * 视频元素的**页面坐标**（截图 clip 用的就是这套坐标，所以要加 scroll 偏移）。
 * 拿不到（视频没渲染/尺寸过小）就返回 null，由调用方退化成整视口截图。
 */
const VIDEO_RECT_EXPR = `(() => {
  const vids = [...document.querySelectorAll('video')];
  const v = vids.find((x) => !x.paused) || vids[0];
  if (!v) return null;
  const r = v.getBoundingClientRect();
  if (r.width < 50 || r.height < 50) return null;
  return {
    x: Math.round(r.x + window.scrollX),
    y: Math.round(r.y + window.scrollY),
    width: Math.round(r.width),
    height: Math.round(r.height),
    playing: !v.paused,
    currentTime: Math.round(v.currentTime),
    duration: Math.round(v.duration || 0),
  };
})()`;

/** 合成 ArrowDown：抖音网页版靠这个换下一条 */
const SLIDE_EXPR = `(() => {
  const ev = { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40, bubbles: true, cancelable: true };
  window.dispatchEvent(new KeyboardEvent('keydown', ev));
  document.dispatchEvent(new KeyboardEvent('keydown', ev));
  const v = document.querySelector('video');
  if (v && v.paused) v.play().catch(() => {});
  return true;
})()`;

async function evalOnPage(expression, timeout = 15000) {
  const r = await rpc('eval', { expression, timeout });
  if (!r.ok) throw new Error(r.error || 'eval failed');
  return r.result;
}

async function pageState() {
  return await evalOnPage(STATE_EXPR, 8000);
}

// ------------------------------------------------------------
// 视觉感知：截视频画面
// ------------------------------------------------------------
/**
 * 截一张当前视频的画面（只截 video 元素那块，拿不到就当整视口截）。
 * 返回本地 PNG 绝对路径，模型用 read_image 打开就能看见。
 */
async function lookAtVideo({ mode = 'video' } = {}) {
  let rect = null;
  if (mode !== 'viewport') {
    rect = await evalOnPage(VIDEO_RECT_EXPR, 8000).catch(() => null);
  }
  const clip = rect
    ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    : null;
  const safeSid = SESSION_ID.replace(/[^\w-]/g, '');
  const nm = `dy-${safeSid}-${Date.now()}`;
  const r = await rpc('screenshot', { name: nm, clip });
  if (!r.ok) throw new Error(r.error || 'screenshot failed');
  sweepShots(r.path);
  return { path: r.path, rect, mode: clip ? 'video' : 'viewport' };
}

/** 自己的截图别堆成山：超过 40 张先删最老的 */
function sweepShots(samplePath) {
  try {
    const dir = path.dirname(samplePath);
    const mine = fs.readdirSync(dir)
      .filter((f) => f.startsWith('dy-') && f.endsWith('.png'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => a.t - b.t);
    while (mine.length > 40) {
      const old = mine.shift();
      try { fs.unlinkSync(path.join(dir, old.f)); } catch {}
    }
  } catch { /* 清理失败不影响截图本身 */ }
}

// ------------------------------------------------------------
// 外部视觉模型通道（OpenAI 兼容格式）
// env: VISION_API_KEY（没配就退回「只截图，自己看」）
//      VISION_API_BASE（默认 dashscope 兼容模式）
//      VISION_MODEL（默认 qwen-vl-plus）
// ------------------------------------------------------------
const VISION_DEFAULT_PROMPT = [
  '你是短视频内容审核员。看这张抖音视频截图，用中文回答下面四点：',
  '1) 画面里有什么（主体、场景、有没有文字/字幕）；',
  '2) 内容类型（风景/美食/教程/搞笑/剧情/广告/低质搬运…）；',
  '3) 质量打分（1=很差，10=很优质），附一句理由；',
  '   评分必须单独占一行，固定写成：评分：X/10（X 为 1-10，可带一位小数）',
  '4) 一句话建议：值不值得点赞/收藏/评论，还是直接划走。',
  '只输出这四段，不用客套。',
].join('\n');

function visionConfigured() {
  const k = (CFG.vision && CFG.vision.apiKey) || '';
  return !!String(k).trim();
}

/**
 * 把截图发给外部视觉模型。
 * @returns {{ok:true,text:string,model:string,usage?:object} | {ok:false,code:string,error?:string}}
 */
async function askVisionModel(imagePath, prompt) {
  if (!visionConfigured()) return { ok: false, code: 'NO_KEY' };
  const v = CFG.vision || DEFAULT_CONFIG.vision;
  const base = String(v.apiBase || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
  const primary = v.model || 'qwen-vl-plus';
  // 有些账号没开通 qwen-vl 系列（会返回 404 model_not_found），
  // 这里给一个降级链：主模型挂了就试下一个（实测 qwen3.8-omni-flash 能看图）
  const fallbacks = (Array.isArray(v.fallbacks) ? v.fallbacks : ['qwen3.8-omni-flash'])
    .map((s) => String(s).trim()).filter(Boolean);
  const models = [primary, ...fallbacks].filter((m, i, a) => a.indexOf(m) === i);

  // 读图并转 base64（上次改降级链时这段被替换块吞掉了，导致 b64 is not defined）
  let b64;
  try {
    b64 = fs.readFileSync(imagePath).toString('base64');
  } catch (e) {
    return { ok: false, code: 'READ_FAIL', error: String((e && e.message) || e) };
  }

  for (const model of models) {
    const body = {
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } },
        ],
      }],
      max_tokens: 900,
    };
    try {
      const res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + ((CFG.vision && CFG.vision.apiKey) || ''),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(10, Number(CFG.vision && CFG.vision.timeoutSec) || 90) * 1000),
      });
      if (res.status === 404) {
        // 模型不存在 → 换下一个候选；都换完了才报错
        const txt = await res.text().catch(() => '');
        if (model === models[models.length - 1]) {
          return { ok: false, code: 'MODEL_NOT_FOUND', error: '试过 ' + models.join(', ') + ' 都不存在：' + txt.slice(0, 200) };
        }
        continue;
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        return { ok: false, code: 'HTTP_' + res.status, error: txt.slice(0, 400) };
      }
      const data = await res.json();
      const msg = data && data.choices && data.choices[0] && data.choices[0].message;
      const content = msg && msg.content;
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((c) => (c && c.text) || '').join('\n')
          : '';
      return {
        ok: true,
        text: text.trim(),
        model: (data && data.model) || model,
        usedFallback: model !== primary,
        usage: data && data.usage,
      };
    } catch (e) {
      return { ok: false, code: 'NETWORK', error: String((e && e.message) || e) };
    }
  }
  return { ok: false, code: 'NO_MODEL', error: '没有可用的视觉模型' };
}

// ------------------------------------------------------------
// 质量闸门
// ------------------------------------------------------------
/**
 * 当前视频的点赞数。
 * 优先用接口里带过来的 aweme 数据（搜索过来的那条），否则读 DOM 文本。
 * @returns {{count:number|null, source:string, raw:string}}
 */
async function currentQuality() {
  // 1) 接口数据：URL 里如果有 video/<id>，在最近一次搜索缓存里找
  const st = await pageState().catch(() => null);
  const url = (st && st.url) || '';
  const idMatch = url.match(/\/video\/(\d+)/);
  if (idMatch) {
    const hit = lastAwemes.find((a) => a.aweme_id === idMatch[1]);
    if (hit && typeof hit.digg === 'number') {
      return { count: hit.digg, source: 'api(search)', raw: String(hit.digg) };
    }
  }
  // 2) DOM 文本
  const raw = await evalOnPage(DIGG_TEXT_EXPR, 8000).catch(() => '');
  return { count: parseCount(raw), source: 'dom', raw: String(raw || '') };
}

/**
 * 互动前做一次「数值体检」。
 * ⚠️ 2026-10-22 改：**不再硬拦**。
 * 点赞数只是个信号，真正的判断权交给模型（看图 + 标题 + 作者 + 数值一起看）。
 * 这里只负责把数值摆出来、低的时候给一句提醒。
 * @returns {{warn: string|null, note: string, count: number|null}}
 */
async function qualityGate(actionLabel, st) {
  const q = await currentQuality();
  if (q.count == null) {
    return { count: null, warn: null, note: `⚠️ 没能解析点赞数（原文「${q.raw}」），这次没有数值参考` };
  }
  if (q.count < lim().minDigg) {
    // 只记一笔「提醒过几次」，方便事后回看；不阻止任何操作
    st.lowQualityWarnings = (st.lowQualityWarnings || 0) + 1;
    saveState(st);
    return {
      count: q.count,
      warn: `⚠️ 点赞数偏低（${q.count} < ${lim().minDigg}）。先 douyin_evaluate 或 douyin_look 看一眼画面再决定，` +
        `不拦你：真要${actionLabel}就执行，觉得不值就 douyin_next 走人。`,
      note: `点赞数 ${q.count}（${q.source}），低于参考线 ${lim().minDigg}`,
    };
  }
  return { count: q.count, warn: null, note: `点赞数 ${q.count}（${q.source}）≥ ${lim().minDigg}` };
}

// ------------------------------------------------------------
// 网络日志 → 视频列表
// ------------------------------------------------------------
function awemesFromEntry(entry) {
  const j = entry && entry.json;
  if (!j || !Array.isArray(j.data)) return [];
  const out = [];
  for (const item of j.data) {
    const a = item && item.aweme_info;
    if (!a) continue;
    out.push({
      aweme_id: a.aweme_id,
      desc: (a.desc || '').slice(0, 120),
      author: (a.author && (a.author.nickname || a.author.unique_id)) || '',
      create_time: a.create_time,
      duration_ms: a.video && a.video.duration,
      digg: a.statistics && a.statistics.digg_count,
      comment: a.statistics && a.statistics.comment_count,
      share: a.statistics && a.statistics.share_count,
      url: a.aweme_id ? 'https://www.douyin.com/video/' + a.aweme_id : '',
    });
  }
  return out;
}

async function searchAwemes(keyword, { limit = 20, reopen = true } = {}) {
  if (reopen) {
    await rpc('goto', { url: 'https://www.douyin.com/search/' + encodeURIComponent(keyword) });
    await sleep(6500);
  }
  const log = await rpc('get_network_log', {
    limit: 20,
    urlFilter: 'general/search',
    maxBytes: 6_000_000,
  });
  if (!log.ok) throw new Error(log.error || 'get_network_log failed');
  const entries = (log.entries || []).filter((e) => e.json);
  for (let i = entries.length - 1; i >= 0; i--) {
    const list = awemesFromEntry(entries[i]);
    if (list.length) return { source: entries[i].url, total: list.length, items: list.slice(0, limit) };
  }
  return { source: null, total: 0, items: [], hint: '没截到可解析的 search 接口（页面可能还没加载完，或接口结构变了）' };
}

// ------------------------------------------------------------
// 点赞 / 收藏
// ------------------------------------------------------------
async function setReaction(e2e, want) {
  const before = await evalOnPage(reactionState(e2e), 8000);
  const isOn = String(before).includes('is-');
  if (isOn === want) return { changed: false, before, after: before, note: '已经是目标状态，没动' };
  const click = await evalOnPage(fireClick(e2e), 8000);
  if (!click || !click.ok) throw new Error((click && click.error) || '没找到按钮');
  await sleep(1200);
  const after = await evalOnPage(reactionState(e2e), 8000);
  return { changed: after !== before, before, after };
}

// ------------------------------------------------------------
// 键盘快捷键（比点坐标稳）
// W 清屏 / X 评论 / Z 赞 / F 作者主页 / P 推荐给朋友 / V 分享
// ------------------------------------------------------------
async function pressKey(k) {
  try {
    const r = await rpc('press', { key: k });
    return !!(r && r.ok !== false);
  } catch { return false; }
}

/** 优先用快捷键切换，读状态确认；没生效再退回点击 */
async function pressReaction(e2e, key, want) {
  const before = await evalOnPage(reactionState(e2e), 8000);
  const isOn = String(before).includes('is-');
  if (isOn === want) return { changed: false, before, after: before, note: '已经是目标状态，没动' };
  await pressKey(key);
  await sleep(1200);
  let after = await evalOnPage(reactionState(e2e), 8000);
  if ((String(after).includes('is-')) !== want) {
    const click = await evalOnPage(fireClick(e2e), 8000);
    if (click && click.ok) { await sleep(1000); after = await evalOnPage(reactionState(e2e), 8000); }
  }
  return { changed: after !== before, before, after };
}

// ------------------------------------------------------------
// 评论区
// ------------------------------------------------------------
const COMMENT = {
  // 只认「看得见」的编辑器：图文页收起状态的评论区也会把编辑器挂在 DOM 上，
  // 只看存在性会误判成已打开，后面点它必然 element is not visible 超时。
  check: `(() => {
    const ed = document.querySelector('.comment-input-inner-container [contenteditable="true"]');
    if (!ed) return false;
    const r = ed.getBoundingClientRect();
    return r.width > 30 && r.height > 8;
  })()`,
  activate: `(() => {
    const box = document.querySelector('.comment-input-inner-container');
    if (!box) return { ok: false, error: '评论输入区还没出现' };
    const ph = box.querySelector('._x9Gwl7G') || box.querySelector('span.RXtfhfhu') || box;
    const r = ph.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window,
      clientX: r.x + Math.min(60, Math.max(1, r.width / 2)), clientY: r.y + Math.max(1, r.height / 2), button: 0 };
    ph.dispatchEvent(new PointerEvent('pointerdown', o));
    ph.dispatchEvent(new MouseEvent('mousedown', o));
    ph.dispatchEvent(new PointerEvent('pointerup', o));
    ph.dispatchEvent(new MouseEvent('mouseup', o));
    ph.dispatchEvent(new MouseEvent('click', o));
    ph.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    return { ok: true };
  })()`,
  editorSel: '.comment-input-inner-container [contenteditable="true"]',
  text: `(() => {
    const ed = document.querySelector('.comment-input-inner-container [contenteditable="true"]');
    return ed ? (ed.innerText || '').trim() : null;
  })()`,
  focus: `(() => {
    const ed = document.querySelector('.comment-input-inner-container [contenteditable="true"]');
    if (!ed) return false;
    ed.focus();
    return true;
  })()`,
};

async function ensureCommentBox() {
  if (await evalOnPage(COMMENT.check, 8000)) return true;
  await evalOnPage(fireClick('feed-comment-icon'), 8000).catch(() => {});
  await sleep(2200);
  if (await evalOnPage(COMMENT.check, 8000)) return true;
  await evalOnPage(COMMENT.activate, 8000);
  await sleep(1200);
  return !!(await evalOnPage(COMMENT.check, 8000));
}

// ------------------------------------------------------------
// 私信 / 群聊（实测结论见文件头）
// ⚠️ 关键：消息面板**必须用真实鼠标点击**打开 —— 派发合成 click 只会让
//    React 把面板组件挂上去（DOM 里有 conversation-item），但面板不显示、
//    尺寸为 0。所以这里统一走 rpc click（Playwright 真点击）。
// ------------------------------------------------------------
const IM_PANEL_VISIBLE_EXPR = `(() => {
  const d = document.querySelector('[data-e2e="im-dialog"]');
  if (!d) return false;
  const r = d.getBoundingClientRect();
  return r.width > 100 && r.height > 100;
})()`;

const IM_EDITOR_SEL = '[data-e2e="msg-input"] [contenteditable="true"]';

const IM_LIST_EXPR = `(() => {
  const convs = [...document.querySelectorAll('[data-e2e="conversation-item"]')];
  const panel = document.querySelector('[data-e2e="im-dialog"]');
  const pr = panel ? panel.getBoundingClientRect() : null;
  return JSON.stringify(convs.map((c) => {
    const r = c.getBoundingClientRect();
    // ⚠️ 实测（2026-10-22）：innerText 里的换行不一定是单个换行符，正则空白符替换在部分行
    //    上不生效，所以先按换行切段再拼：第一段才是名字（后面跟的是火花天数、时间、预览）。
    const lines = (c.innerText || '').split(/[\\r\\n]+/).map((s) => s.trim()).filter(Boolean);
    const raw = lines.join(' ');
    const badge = c.querySelector('.semi-badge, [class*="badge"]');
    const badgeText = badge ? (badge.innerText || '').trim() : '';
    // 实测（2026-10-22）：会话行的信息散在几个 span 里，拆得更准：
    //   .conversationConversationItemtitle      → 昵称/群名
    //   [class*="ConversationItemHinttextBox"]  → 最后一条消息预览
    //   [class*="timeStr"]                      → 「刚刚 / 45分钟前 / 昨天 22:51」
    // 用 innerText 拆名字会把「某某群 65 45分钟前 …」里的 65（火花天数）当名字的一部分。
    const titleEl = c.querySelector('[class*="ConversationItemtitle"]');
    const previewEl = c.querySelector('[class*="ConversationItemHinttextBox"]');
    const timeEl = c.querySelector('[class*="timeStr"]');
    // title 节点里串着「名字 + 火花天数 + 时间」，名字只取第一段
    const name = lines[0] || raw;
    // 群判定（实测）：群的会话行头像是 .commonConversationIconnoDrag，
    // 私聊是 .commonIMAvataravatarContainer 的 semi-avatar 包装。
    let isGroup = false;
    try {
      isGroup = Boolean(c.querySelector('[class*="GroupAvatar"],[data-e2e="group-avatar"],.commonConversationIconnoDrag'))
        || !c.querySelector('.commonIMAvataravatarContainer');
    } catch (e) { isGroup = false; }
    return {
      name,
      raw: raw.slice(0, 80),
      preview: previewEl ? (previewEl.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 120) : '',
      timeText: timeEl ? (timeEl.innerText || '').trim() : '',
      unread: /^\\d+$/.test(badgeText) ? Number(badgeText) : 0,
      isGroup,
      visible: r.width > 50,
      rect: [Math.round(r.x), Math.round(r.y)],
      isLeftColumn: pr ? r.x < pr.x + pr.width / 2 : null,
    };
  }));
})()`;

const IM_MESSAGES_EXPR = `(() => {
  const panel = document.querySelector('[data-e2e="im-dialog"]');
  const pr = panel ? panel.getBoundingClientRect() : null;
  const items = [...document.querySelectorAll('[data-e2e="msg-item-content"]')];
  // ⚠️ 实测（2026-10-22，Edge 155）：滚动容器 .messageMessageListlist 带
  //    transform: matrix(-1,0,0,-1,0,0) —— 整列翻转 180° 来实现「新消息贴底」。
  //    两个后果必读：
  //    ① DOM 顺序是「新→旧」，items[0] 才是最新那条。原来直接 slice(-10) 取到的是
  //       最旧的 10 条，读出来自然"内容对不上"（真新消息被切掉了）。
  //    ② 子元素 rect 在翻转坐标系里，按气泡左边缘判左右会随气泡宽度漂
  //       （自己发的「1」判得出、长消息就判不出）。自己/对方要看行容器的
  //       flex-direction：自己发的 row-reverse，对方的 row。
  let reflected = false;
  try {
    let sc = items[0] ? items[0].parentElement : null;
    for (let d = 0; sc && d < 15; d++, sc = sc.parentElement) {
      const st = getComputedStyle(sc);
      if (st.overflowY === 'auto' || st.overflowY === 'scroll') {
        const m = st.transform || '';
        if (m.indexOf('matrix(') === 0) reflected = Number(m.slice(7, -1).split(',')[0]) < 0;
        break;
      }
    }
  } catch (e) {}
  const rows = items.map((it) => {
    const box = it.closest('[class*="MessageBox"]') || it.parentElement;
    const br = box ? box.getBoundingClientRect() : null;
    const row = it.closest('[class*="rowBox"]') || box;
    const text = (it.innerText || '').trim().replace(/\\s+/g, ' ');
    const imgs = it.querySelectorAll('img').length;
    const nameEl = box ? box.querySelector('[class*="avatarName"]') : null;
    // 分享过来的视频/图文是个卡片，链接只存在于 <a href> 里，文本里压根没有，
    // 所以必须单独抓一遍，否则「分享视频给我」这种消息读出来就是一片空白。
    const shares = it.querySelectorAll('.MessageItemShareAwemecontainer');
    const shareAuthor = shares.length
      ? ((it.querySelector('.MessageItemShareAwemeauthorName') || {}).innerText || '').trim()
      : '';
    const links = [...it.querySelectorAll('a[href]')]
      .map((a) => a.getAttribute('href') || '')
      .filter((h) => /\\/video\\/\\d+|\\/note\\/\\d+|v\\.douyin\\.com/.test(h))
      .map((h) => (h.startsWith('http') ? h : 'https://www.douyin.com' + h));
    return {
      text,
      imgs,
      links: [...new Set(links)],
      sender: nameEl ? (nameEl.innerText || '').trim() : null,
      // 自己发的在右侧；私聊不显示昵称，只能靠行的 flex-direction 判断（见上方注释）
      mine: (() => {
        try {
          const fd = row ? getComputedStyle(row).flexDirection : '';
          if (fd === 'row-reverse') return true;
          if (fd === 'row') return false;
        } catch (e) {}
        return pr && br ? br.x + br.width / 2 > pr.x + pr.width / 2 : null;
      })(),
      shareAuthor,
      hasShareCard: shares.length > 0,
      kind: links.length ? 'share' : (shares.length ? 'share-card' : (text ? 'text' : (imgs ? 'image' : 'other'))),
    };
  });
  // DOM 是「新→旧」，先翻转成时间顺序（旧→新），再取最近 10 条
  if (reflected) rows.reverse();
  return JSON.stringify({ count: rows.length, reflected, items: rows.slice(-10) });
})()`;

const IM_EDITOR_TEXT_EXPR = `(() => {
  const ed = document.querySelector('[data-e2e="msg-input"] [contenteditable="true"]');
  return ed ? (ed.innerText || '').replace(/\\u200b/g, '').trim() : null;
})()`;

/** 打开消息面板（真实点击；合成事件不显示） */
/**
 * 确保当前页面在抖音上。
 * 实测踩坑：页面可能是 about:blank（上一步导航走空了、或新标签页），
 * 这时消息入口、评论框全都不存在，工具会白等 8 秒然后报「点不开消息入口」。
 */
async function ensureDouyinHome() {
  const url = String((await evalOnPage('location.href', 8000).catch(() => '')) || '');
  if (url.includes('douyin.com')) return false;
  await rpc('goto', { url: 'https://www.douyin.com/' });
  await sleep(3500);
  return true;
}

async function ensureImPanel() {
  await ensureDouyinHome();
  if (await evalOnPage(IM_PANEL_VISIBLE_EXPR, 8000)) return true;
  const r = await rpc('click', { selector: '[data-e2e="im-entry"]' });
  if (!r.ok) throw new Error('点不开消息入口: ' + (r.error || ''));
  await sleep(2200);
  return !!(await evalOnPage(IM_PANEL_VISIBLE_EXPR, 8000));
}

/** 按名字模糊匹配会话并真实点开它（先打标记，再用 Playwright 点击） */
async function openChatByName(name) {
  if (!(await ensureImPanel())) throw new Error('消息面板没打开（可能被弹窗挡住，或用合成事件点不开）');

  // 聊天窗是盖在会话列表上的一层（data-stack-layer="chat"）。它开着的时候，
  // 会话行虽然还在 DOM 里、也「可见」，但会被上面那层挡住指针，
  // Playwright 点它会一直报 "subtree intercepts pointer events" 直到超时。
  // 所以切换会话前必须先点返回按钮退回列表。
  const needBack = await evalOnPage(`(() => {
    const btn = document.querySelector('[data-stack-layer="chat"] .StackLayoutStackTitleBarbackBtn');
    if (!btn) return false;
    const r = btn.getBoundingClientRect();
    return r.width > 4 && r.height > 4;
  })()`, 8000).catch(() => false);
  if (needBack) {
    await rpc('click', { selector: '[data-stack-layer="chat"] .StackLayoutStackTitleBarbackBtn' }).catch(() => {});
    await sleep(1200);
  }
  const mark = await evalOnPage(`(() => {
    const want = ${JSON.stringify(String(name))};
    document.querySelectorAll('[data-dy-target]').forEach((e) => e.removeAttribute('data-dy-target'));
    const convs = [...document.querySelectorAll('[data-e2e="conversation-item"]')];
    const hit = convs.find((c) => (c.innerText || '').includes(want));
    if (!hit) {
      return { ok: false, error: '没找到会话: ' + want, available: convs.map((c) => ((c.innerText || '').trim().split('\\n')[0] || '').slice(0, 20)) };
    }
    hit.setAttribute('data-dy-target', '1');
    return { ok: true };
  })()`, 8000);
  if (!mark || !mark.ok) {
    const err = new Error((mark && mark.error) || '标记会话失败');
    err.available = mark && mark.available;
    throw err;
  }
  const click = await rpc('click', { selector: '[data-dy-target="1"]' });
  if (!click.ok) throw new Error('点开会话失败: ' + (click.error || ''));
  await sleep(1800);
  return true;
}
/**
 * 从一段聊天文本里挖视频链接。
 * 支持：v.douyin.com 短链 / douyin.com/video|note/<id> / 裸的 19 位 aweme_id。
 */
function extractVideoLink(text) {
  const s = String(text || '');
  const short = s.match(/https?:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+/);
  if (short) return short[0];
  const full = s.match(/https?:\/\/(?:www\.)?douyin\.com\/(?:video|note)\/\d+/);
  if (full) return full[0];
  const bare = s.match(/\b(\d{19})\b/);
  if (bare) return 'https://www.douyin.com/video/' + bare[1];
  return null;
}
// ------------------------------------------------------------
// 分享 / 转发
// ------------------------------------------------------------
/** 打开分享面板并列出可选的转发目标（只读，不点） */
const listShareTargets = `(() => {
  const items = [...document.querySelectorAll('div,span,button')]
    .filter((e) => {
      const t = (e.innerText || '').trim();
      if (!t || t.length > 24) return false;
      if (e.children.length > 2) return false;
      if (/(分享|回复)/.test(t) && t.split('\\n').length > 1) return false;   // 跳过评论区的「N 分享 回复」
      return /(分享|群|好友|复制链接|微信|QQ|朋友圈|微博)/.test(t);
    })
    .map((e) => {
      const raw = (e.innerText || '').trim().replace(/\\s+/g, ' ');
      // 抖音的条目文字会带后缀：「某某群 65 分享」「某某24分钟前在线分享」「复制链接抖音 app 扫码观看」
      // 给一个可当 target 用的干净名字，raw 保留原样
      const name = raw
        .replace(/\\s*抖音\\s*app\\s*扫码观看$/i, '')
        .replace(/\\s*\\d+\\s*分钟前在线\\s*/g, ' ')
        .replace(/\\s*分享$/g, '')
        .replace(/\\s+/g, ' ')
        .trim();
      return { raw, name };
    })
    .filter((v, i, a) => a.findIndex((x) => x.raw === v.raw) === i);
  return JSON.stringify({ count: items.length, items: items.slice(0, 20) });
})()`;

/**
 * 点某个分享目标。
 * 用**包含匹配**而不是全等：面板里的文字是「某某群 65 分享」这种，
 * target 传「某某群」也命中。命中多个时取文本最短、层级最浅的那个
 * （避免点到把整块包住的外层容器）。
 */
const clickShareTarget = (label) => `(() => {
  const want = ${JSON.stringify(label)};
  const cands = [...document.querySelectorAll('div,span,button')]
    .filter((e) => {
      const t = (e.innerText || '').trim().replace(/\\s+/g, ' ');
      if (e.children.length > 2) return false;
      // startsWith 优先：面板条目是「某某群 65 分享」这种，
      // 而评论区的「@某某群 你说得对」也能 includes 命中 → 会点错地方
      return t.startsWith(want) || t.includes(want);
    })
    .sort((a, b) => {
      const ta = (a.innerText || '').trim().replace(/\\s+/g, ' ');
      const tb = (b.innerText || '').trim().replace(/\\s+/g, ' ');
      const sa = ta.startsWith(want) ? 0 : 1;
      const sb = tb.startsWith(want) ? 0 : 1;
      return sa - sb || ta.length - tb.length || a.children.length - b.children.length;
    });
  if (!cands.length) return { ok: false, error: '没找到目标: ' + want };
  const el = cands[0];
  const matched = (el.innerText || '').trim().replace(/\\s+/g, ' ');
  const r = el.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, view: window,
    clientX: r.x + Math.max(1, r.width / 2), clientY: r.y + Math.max(1, r.height / 2), button: 0 };
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  el.dispatchEvent(new MouseEvent('mousedown', o));
  el.dispatchEvent(new PointerEvent('pointerup', o));
  el.dispatchEvent(new MouseEvent('mouseup', o));
  el.dispatchEvent(new MouseEvent('click', o));
  return { ok: true, matched, startsWith: matched.startsWith(want) };
})()`;

// ------------------------------------------------------------
// 工具注册
// ------------------------------------------------------------
/** 功能开关的中文名（拦截文案用） */
const FEATURE_LABEL = {
  browse: '浏览/下滑',
  like: '点赞',
  favorite: '收藏',
  comment: '评论',
  share: '视频转发',
  chat: '私信/群聊',
};

/** 开关关了就不执行，连 DOM 都不碰 */
function featureGate(key) {
  if (!key) return null;
  const f = (CFG && CFG.features) || (DEFAULT_CONFIG && DEFAULT_CONFIG.features) || {};
  if (f[key] !== false) return null;
  const zh = FEATURE_LABEL[key] || key;
  return '⛔ 「' + zh + '」功能已在设置面板里关闭（features.' + key + ' = false）。\n' +
    '如果确实要用，去「设置 → 抖音助手 → 功能开关」打开它，保存后立即生效。\n' +
    '这一步没有碰页面：不会点任何东西、不会发任何消息。';
}

async function withHost(fn, label, featureKey) {
  reloadCfg(); // 每次工具调用都读一次 config.json —— 面板保存后立刻生效
  if (CFG.modules && CFG.modules.content === false) {
    return { text: '⛔ 内容模块已关闭（设置 → 总设置 → 模块开关）。' };
  }
  const blocked = featureGate(featureKey);
  if (blocked) return { text: blocked };
  if (!(await hostAlive())) return { text: HOST_DOWN };
  try {
    return await fn();
  } catch (e) {
    return { text: '❌ douyin_' + label + ' 失败: ' + ((e && e.message) || e) };
  }
}

async function apply(ctx) {
  const logger = ctx.logger;
  const tools = [];

  // 私信/群的会话池已交给社交模块（social/bridge.mjs + session-bridge.mjs），
  // 旧的浏览器私信链路（chat-agents）已下线：chatAgentsRef 恒为 null，
  // wakeOnNewMessage 会直接 return，不会误投递。
  reloadCfg();
  chatAgentsRef = null;

  const WORKFLOW_HINT =
    '刷推荐流的标准循环：douyin_state 看进度/点赞数 → 想判断内容好坏就 douyin_evaluate（或 douyin_look+read_image）→ 再 douyin_next ' +
    '（一次一条，别连点）→ 想互动再 douyin_like / douyin_favorite / douyin_comment。' +
    `注意：点赞数 < ${lim().minDigg} 的会被质量闸门拦掉；每天浏览上限 ${Math.round(lim().browseSec / 60)} 分钟，` +
    '到点 douyin_next 会直接拒绝。';

  // ---- 搜索 ----
  tools.push({
    name: 'douyin_search',
    description: '在抖音搜关键词，返回视频列表(标题/作者/点赞)。数据来自接口 JSON，不解析 DOM。',
    parameters: {
      type: 'object', additionalProperties: false,
      keyword: { type: 'string', description: '搜索关键词' },
      limit: { type: 'number', description: '最多几条(默认 20)' },
    },
    timeoutMs: 90000,
    output: OUTPUT_TEXT,
    execute: (args, exec) => withHost(async () => {
        rememberAgent(exec);
      if (!args.keyword) throw new Error('需要 keyword');
      const r = await searchAwemes(args.keyword, { limit: args.limit || 20 });
      lastAwemes = r.items;
      if (!r.items.length) return { text: '没拿到视频列表。' + (r.hint || '') };
      const lines = [`✅ 从接口拿到 ${r.total} 条（源: ${r.source}）`, ''];
      r.items.forEach((it, i) => {
        const ok = typeof it.digg === 'number' && it.digg >= lim().minDigg;
        lines.push(`${i + 1}. ${ok ? '' : '⚠️'}${it.desc || '(无标题)'}`);
        lines.push(`   @${it.author} | 赞 ${it.digg ?? '?'}${ok ? '' : `（低于 ${lim().minDigg}，建议先看画面）`} | 评论 ${it.comment ?? '?'} | ${it.url}`);
      });
      lines.push('', '下一步：douyin_open 序号 打开某条；或 douyin_next 在页面上滑');
      return { text: lines.join('\n') };
    }, 'search', 'browse'),
  });

  // ---- 读当前视频 id（带 DOM 反查校验）----
  tools.push({
    name: 'douyin_current_id',
    description: '读当前正在播放视频的 aweme_id（用于转发/分享到 douyin-im）。' +
      '\n      来源：接口日志里带 group_id 的请求；再用页面 DOM 反查这个 id 是否真的在当前页面上 ——' +
      '\n      反查不到就明确说「可能错位」，不装作拿到了。',
    parameters: { type: 'object', additionalProperties: false },
    timeoutMs: 60000,
    output: OUTPUT_TEXT,
    execute: (args, exec) => withHost(async () => {
      rememberAgent(exec);
      let id = '';
      let src = '';
      try {
        const log = await rpc('get_network_log', { limit: 60, maxBytes: 2_000_000 });
        if (log && log.ok && log.entries) {
          for (let k = log.entries.length - 1; k >= 0; k--) {
            const u = String((log.entries[k] && log.entries[k].url) || '');
            const marks = ['group_id=', 'aweme_id=', 'item_id='];
            for (const mk of marks) {
              const p = u.indexOf(mk);
              if (p < 0) continue;
              let tail = u.slice(p + mk.length);
              const stop = tail.search(/[^0-9]/);
              if (stop >= 0) tail = tail.slice(0, stop);
              if (tail && tail.length >= 15) { id = tail; src = mk; break; }
            }
            if (id) break;
          }
        }
      } catch (e) {}

      const st = await pageState().catch(() => null);
      if (!id) {
        return { text: '❌ 没拿到 aweme_id（接口日志里没有带 group_id 的请求）\n' +
          (st ? '当前: ' + (st.title || '(无标题)') + ' | 播放 ' + (st.playing ? '是' : '否') : '') +
          '\n先用 douyin_next 滑一条再试。' };
      }

      // 校验：这个 id 在页面 DOM 里出现过吗？出现 = 大概率就是当前这条
      let hits = -1;
      try {
        const expr = '(() => { const s = document.documentElement.innerHTML; const id = '
          + JSON.stringify(id) + '; let n = 0, i = 0;'
          + ' while ((i = s.indexOf(id, i)) >= 0) { n++; i += id.length; }'
          + ' return n; })()';
        const r = await evalOnPage(expr, 8000);
        if (typeof r === 'number') hits = r;
      } catch (e) {}

      const ok = hits > 0;
      return {
        text: (ok ? '✅ 当前视频 aweme_id: ' : '⚠️ 疑似 aweme_id（未能校验）: ') + id +
          '（来源 ' + src + '，DOM 命中 ' + (hits < 0 ? '读取失败' : hits + ' 次') + '）\n' +
          (st ? '当前: ' + (st.title || '(无标题)') + ' | 播放 ' + (st.playing ? '是' : '否') + ' | 点赞 ' + (st.diggText || '?') : '') +
          (ok ? '' : '\n⚠️ 这个 id 没在页面里找到，可能拿到的是上一条。滑一下再试，或先别转发。'),
      };
    }, 'currentid', 'browse'),
  });

  // ---- 主动收工（关浏览器）----
  tools.push({
    name: 'douyin_stop',
    description: '刷够了，主动收工：通知守卫脚本关掉管家浏览器（reason=done）。' +
      '\n      不占额度、不产生互动；只是让浏览器退场。',
    parameters: { type: 'object', additionalProperties: false },
    timeoutMs: 30000,
    output: OUTPUT_TEXT,
    execute: (args, exec) => withHost(async () => {
      rememberAgent(exec);
      const flagDir = process.env.DOUYIN_SOCIAL_DIR || path.join(HERE, 'social');
      const p = flagDir + '\\stop.flag';
      try { fs.writeFileSync(p, new Date().toISOString()); }
      catch (e) { throw new Error('写 stop.flag 失败: ' + ((e && e.message) || e)); }
      return { text: '✅ 已通知收工（stop.flag）\n守卫脚本会在 5 秒内关掉管家浏览器，日志记 reason=done。' };
    }, 'stop', 'browse'),
  });
  // ---- 通用快捷键 ----
  tools.push({
    name: 'douyin_press',
    description: '按抖音网页版快捷键操作当前视频，比点坐标可靠。' +
      '\n      w=清屏 / x=评论 / z=赞 / f=进入作者主页 / p=推荐给朋友 / v=分享。' +
      '\n      只负责按键，不判断结果；要确认状态再调 douyin_state。',
    parameters: {
      type: 'object', additionalProperties: false,
      key: { type: 'string', description: 'w / x / z / f / p / v' },
    },
    timeoutMs: 30000,
    output: OUTPUT_TEXT,
    execute: (args, exec) => withHost(async () => {
      rememberAgent(exec);
      const k = String(args.key || '').toLowerCase();
      const allowed = { w: '清屏', x: '评论', z: '赞', f: '进入作者主页', p: '推荐给朋友', v: '分享' };
      if (!allowed[k]) throw new Error('只支持 w/x/z/f/p/v');
      const ok = await pressKey(k);
      await sleep(900);
      const st = await pageState().catch(() => null);
      return {
        text: (ok ? '✅ 已按 ' : '⚠️ 按键可能没送达 ') + k.toUpperCase() + `（${allowed[k]}）` +
          (st ? `\n当前: ${st.title || '(无标题)'} | 播放 ${st.playing ? '是' : '否'} | 点赞 ${st.diggText || '?'}` : ''),
      };
    }, 'press', 'browse'),
  });
  // ---- 切到推荐流 ----
  tools.push({
    name: 'douyin_recommend',
    description: '切到抖音推荐流首页 (?recommend=1)，用于自主刷视频。切完可以直接用 douyin_next 往下刷。' +
      '\n      只负责导航，不计时；计时仍由 douyin_next 累加。',
    parameters: { type: 'object', additionalProperties: false },
    timeoutMs: 90000,
    output: OUTPUT_TEXT,
    execute: (args, exec) => withHost(async () => {
      rememberAgent(exec);
      if (!inScheduleWindow(new Date())) throw new Error(scheduleRefusal());
      const r = await rpc('goto', { url: 'https://www.douyin.com/?recommend=1' });
      if (!r.ok) throw new Error(r.error || 'goto failed');
      await sleep(2500);
      const st = await pageState().catch(() => null);
      return {
        text: '✅ 已切到推荐流\n' +
          (st
            ? `当前: ${st.title || '(加载中)'} | 播放: ${st.playing ? '是' : '否'} | ${st.currentTime}s/${st.duration}s | 点赞 ${st.diggText || '?'}`
            : '(页面状态未知)'),
      };
    }, 'recommend', 'browse'),
  });
  // ---- 打开 ----
  tools.push({
    name: 'douyin_open',
    description: '按 douyin_search 的序号或 aweme_id 打开视频详情页。' +
      '\n      ⚠️ 防呆：如果是通过群聊 @ 或外部链接被动打开的单条视频，看完必须停，不要接着调 douyin_next —— 那会把被动观看变成主动刷流、开始消耗主人每日 1 小时的浏览额度。被动打开本身不计时（只有 douyin_next 会累加）。',
    parameters: {
      type: 'object', additionalProperties: false,
      index: { type: 'number', description: 'douyin_search 结果里的序号(从 1 开始)' },
      aweme_id: { type: 'string', description: '直接给 aweme_id(与 index 二选一)' },
    },
    timeoutMs: 90000,
    output: OUTPUT_TEXT,
    execute: (args, exec) => withHost(async () => {
        rememberAgent(exec);
      let id = args.aweme_id;
      if (!id && args.index) {
        const hit = lastAwemes[args.index - 1];
        id = hit && hit.aweme_id;
      }
      if (!id) throw new Error('需要 index 或 aweme_id（用 index 的话要先跑 douyin_search）');
      const r = await rpc('goto', { url: 'https://www.douyin.com/video/' + id });
      if (!r.ok) throw new Error(r.error || 'goto failed');
      await sleep(1500);
      const st = await pageState().catch(() => null);
      return {
        text: `✅ 已打开 ${id}\n标题: ${(st && st.title) || r.title || ''}\n` +
          (st ? `播放: ${st.playing ? '是' : '否'} | ${st.currentTime}s/${st.duration}s | 点赞 ${st.diggText || '?'}` : ''),
      };
    }, 'open', 'browse'),
  });

  // ---- 下滑（含防沉迷计时）----
  tools.push({
    name: 'douyin_next',
    description: '往下滑切下一条视频（eval 注入 ArrowDown）。' +
      '\n      ⚠️ 只有主人主动要求刷流时才用。被动打开的单个视频（群聊 @、外部链接）看完整停，严禁调这个 —— 每次都会消耗每日额度。' +
      WORKFLOW_HINT,
    parameters: {
      type: 'object', additionalProperties: false,
      times: { type: 'number', description: '滑几次(默认 1，最多 10)' },
    },
    timeoutMs: 120000,
    output: OUTPUT_TEXT,
    execute: (args, exec) => withHost(async () => {
        rememberAgent(exec);
      const st = loadState();
      if (browseBlocked(st)) return { text: browseBlockedText(st) };

      const times = Math.min(Math.max(Number(args.times) || 1, 1), 10);
      const moved = [];
      const now = Date.now();

      // 防呆计时：只有「1 秒 ~ 2 分钟」的间隔才算连着刷
      if (!inScheduleWindow(new Date())) throw new Error(scheduleRefusal());
      const gap = st.lastNextTime ? now - st.lastNextTime : 0;
      let counted = 0;
      if (st.lastNextTime && gap >= MIN_GAP_MS && gap <= MAX_GAP_MS) {
        counted = Math.round(gap / 1000);
        st.browseSeconds += counted;
      }
      st.lastNextTime = now;
      saveState(st);

      if (browseBlocked(st)) return { text: browseBlockedText(st) };

      for (let i = 0; i < times; i++) {
        const before = await pageState().catch(() => null);
        const r = await rpc('eval', { expression: SLIDE_EXPR, timeout: 8000 });
        if (!r.ok) await rpc('press', { key: 'ArrowDown' });
        await sleep(1000 + Math.floor(Math.random() * 900));
        const after = await pageState().catch(() => null);
        moved.push({ from: before && before.currentTime, to: after && after.currentTime });
      }

      const after = await pageState().catch(() => null);
      const q = after ? parseCount(after.diggText) : null;
      const lines = [`✅ 滑了 ${times} 次`];
      try {
        if (after) logBrowse({ t: new Date().toISOString(), desc: after.desc || '', title: after.title || '', digg: after.diggText || '', currentTime: after.currentTime || 0 });
      } catch (eBL) { }
      moved.forEach((m, i) => lines.push(`  ${i + 1}. 播放进度 ${m.from ?? '?'}s → ${m.to ?? '?'}s`));
      if (after) {
        lines.push(`当前: ${after.title || '(无标题)'} | 点赞 ${after.diggText || '?'}${q != null && q < lim().minDigg ? '（低于参考线，先看画面）' : ''}`);
      }
      lines.push(`今日浏览: ${Math.round(st.browseSeconds / 60)} 分钟 / 上限 ${Math.round(lim().browseSec / 60)} 分钟` +
        (counted ? `（本次 +${counted}s）` : '（间隔太久，这次不计时）'));
      return { text: lines.join('\n') };
    }, 'next', 'browse'),
  });

  // ---- 状态 ----
  tools.push({
    name: 'douyin_state',
    description:
      '读当前视频状态：是否在播 / 进度 / 标题 / 点赞数 / 点赞收藏是否已激活 / 评论框 / 今日用量。' +
      '⚠️ 只看标题和点赞数不够。评估质量的两条路：' +
      '① 配了外部视觉模型就调 douyin_evaluate（自动截图 + 让视觉模型描述打分，最省事）；' +
      '② 没配就 douyin_look 截图 → read_image 自己看。' +
      '然后结合「画面内容 + 标题 + 作者 + 点赞数」综合判断，再决定 douyin_like / douyin_favorite / ' +
      'douyin_comment，还是直接 douyin_next 走人。注意点赞数低**只是提醒、不拦你**。',
    parameters: { type: 'object', additionalProperties: false },
    timeoutMs: 45000,
    output: OUTPUT_TEXT,
    execute: (_a, exec) => withHost(async () => {
        rememberAgent(exec);
      const st = await pageState();
      const s = loadState();
      const on = (x) => (String(x).includes('is-') ? '已' : '未');
      const digg = parseCount(st.diggText);
      return {
        text: [
          `网址: ${st.url}`,
          `标题: ${st.title || '(无)'}`,
          `播放: ${st.playing ? '是' : '否'} | ${st.currentTime}s / ${st.duration}s | 视频元素 ${st.videoCount} 个`,
          `点赞: ${on(st.diggState)}（${st.diggText || '?'}${digg != null ? ' ≈ ' + digg : ''}）| 收藏: ${on(st.collectState)} | 评论框: ${st.commentOpen ? '已打开' : '未打开'}`,
          `质量闸门: ${digg == null ? '解析不出点赞数，本次不判' : digg >= lim().minDigg ? '达标（可互动）' : `偏低（< ${lim().minDigg}，只提醒）`}`,
          `今日: 浏览 ${Math.round(s.browseSeconds / 60)}/${Math.round(lim().browseSec / 60)} 分钟 | 赞 ${s.likes} 藏 ${s.favorites} 评 ${s.comments} | 转发 群 ${s.groupForwards}/${lim().group} 私 ${s.privateForwards}/${lim().private}`,
          '',
          '👉 想看画面质量：douyin_look 截图 → read_image 看 → 再决定互动还是滑走。',
        ].join('\n'),
      };
    }, 'state'),
  });

  // ---- 视觉感知：截图 ----
  tools.push({
    name: 'douyin_look',
    description:
      '给当前视频截一张画面（只截 video 元素那块，不是整页；拿不到视频尺寸时退回整视口），' +
      '返回本地图片绝对路径，用 read_image 打开就能看见。' +
      '评估内容质量、判断该不该点赞/收藏/评论之前都应该先看一眼。',
    parameters: {
      type: 'object', additionalProperties: false,
      mode: { type: 'string', description: 'video(默认，只截视频画面) / viewport(整个可见区域)' },
    },
    timeoutMs: 60000,
    output: OUTPUT_TEXT,
    execute: (args, exec) => withHost(async () => {
        rememberAgent(exec);
      const mode = args.mode === 'viewport' ? 'viewport' : 'video';
      const st = await pageState().catch(() => null);
      const shot = await lookAtVideo({ mode });
      const q = st ? parseCount(st.diggText) : null;
      const size = shot.rect ? `${shot.rect.width}x${shot.rect.height}` : '(整视口)';
      const play = shot.rect
        ? `${shot.rect.playing ? '播放中' : '暂停'} ${shot.rect.currentTime}s/${shot.rect.duration}s`
        : (st && st.playing ? '播放中' : '暂停');
      return {
        text: [
          `📸 已截图（${shot.mode === 'video' ? '视频画面区域' : '整个视口'}）`,
          `路径: ${shot.path}`,
          '下一步：用 read_image 打开这个路径看画面。',
          '',
          `画面尺寸: ${size} | ${play}`,
          `标题: ${(st && st.title) || '(未知)'} | 作者/点赞: ${(st && st.diggText) || '?'}${q != null ? ' ≈ ' + q : ''}`,
          '',
          '看完画面再综合判断：内容值得就 douyin_like / douyin_favorite / douyin_comment（仍要过点赞数闸门），' +
          '不值得就 douyin_next 直接走。',
        ].join('\n'),
      };
    }, 'look'),
  });

  // ---- 外部视觉评估 ----
  tools.push({
    name: 'douyin_evaluate',
    description:
      '对当前视频做「看图评估」：自动截视频画面 → 发给外部视觉模型 → 返回描述、打分(1-10)和建议。' +
      '判断该不该点赞/收藏/评论之前最该先调它。' +
      '没配 VISION_API_KEY 时会退回成「只截图，让你自己 read_image 看」，不会报错。',
    parameters: {
      type: 'object', additionalProperties: false,
      prompt: { type: 'string', description: '自定义评估提示词(可选，不给用默认的审核员提示词)' },
      mode: { type: 'string', description: 'video(默认，只截视频画面) / viewport(整个可见区域)' },
    },
    timeoutMs: 150000,
    output: OUTPUT_TEXT,
    execute: (args, exec) => withHost(async () => {
        rememberAgent(exec);
      const mode = args.mode === 'viewport' ? 'viewport' : 'video';
      const shot = await lookAtVideo({ mode });
      const st = await pageState().catch(() => null);
      const q = st ? parseCount(st.diggText) : null;
      const meta = [
        `标题: ${(st && st.title) || '(未知)'}`,
        `点赞: ${(st && st.diggText) || '?'}${q != null ? ' ≈ ' + q + (q < lim().minDigg ? `（低于参考线 ${lim().minDigg}，仅供参考）` : '') : ''}`,
      ];
      if (!visionConfigured()) {
        return {
          text: [
            '💤 未配置外部视觉模型（VISION_API_KEY 为空），这次只截了图：',
            `路径: ${shot.path}`,
            ...meta,
            '',
            '直接用 read_image 打开这个路径看画面，自己判断质量再决定互动。',
          ].join('\n'),
        };
      }
      const custom = (CFG.vision && CFG.vision.prompt) || '';
      const kwList = (CFG.preferences && CFG.preferences.keywords) || [];
      const kwLine = kwList.length
        ? ('\n\n【我特别想看这类内容】：' + kwList.join('、') + '。遇到这类请给更高分，并说明理由。')
        : '';
      const fmtLine = '\n\n【输出格式】最后必须单独一行写：评分：X/10（X 为 1-10 的数字）';
      const prompt = args.prompt ? String(args.prompt) : ((custom.trim() || VISION_DEFAULT_PROMPT) + kwLine + fmtLine);
      const r = await askVisionModel(shot.path, prompt);
      if (!r.ok) {
        return {
          text: [
            `⚠️ 外部视觉模型调用失败（${r.code}${r.error ? ': ' + r.error : ''}）`,
            `截图还在: ${shot.path}`,
            '可以 read_image 自己看，或稍后重试。',
            ...meta,
          ].join('\n'),
        };
      }
      // 自动互动：评分达阈值就点赞/收藏（阈值 0 = 关）
      let autoLine = '';
      try {
        const ai = (CFG.autoInteract) || {};
        const minScore = Number(ai.minScore) || 7;
        if (ai.enabled === true) {
          const txt = String(r.text || '');
          const mm = /([0-9]+(?:\.[0-9]+)?)\s*(?:\/\s*10|分)/.exec(txt);
          const score = mm ? Number(mm[1]) : null;
          if (score !== null && score >= minScore) {
            if (ai.like) {
              const lr = await pressReaction('video-player-digg', 'z', true);
              if (lr && lr.changed) { const s2 = loadState(); s2.likes += 1; saveState(s2); autoLine += '\n❤️ 自动点赞（评分 ' + score + '）'; }
            }
            if (ai.favorite) {
              const fr = await setReaction('video-player-collect', true);
              if (fr && fr.changed) { const s3 = loadState(); s3.favorites += 1; saveState(s3); autoLine += '\n⭐ 自动收藏（评分 ' + score + '）'; }
            }
          } else if (score !== null) {
            autoLine += '\n（评分 ' + score + ' 低于阈值 ' + minScore + '，没自动互动）';
          }
        }
      } catch (eAI) { autoLine = ''; }

      return {
        text: [
          `🧠 外部视觉模型评价（${r.model}）：`,
          '',
          r.text || '(模型返回了空内容)',
          autoLine || '',
          '',
          `截图: ${shot.path}（想自己核对可以 read_image）`,
          ...meta,
          r.usage ? `用量: ${JSON.stringify(r.usage)}` : '',
        ].filter(Boolean).join('\n'),
      };
    }, 'evaluate'),
  });
  // ---- 点赞 ----
  tools.push({
    name: 'douyin_like',
    description: `给当前视频点赞（对外可见）。已点过不会重复点。传 action=unlike 取消。` +
      `点赞数低只会提醒、不拦（判断权在模型）。`,
    parameters: {
      type: 'object', additionalProperties: false,
      action: { type: 'string', description: 'like(默认) / unlike' },
    },
    timeoutMs: 60000,
    output: OUTPUT_TEXT,
    execute: (args, exec) => withHost(async () => {
        rememberAgent(exec);
      const st = loadState();
      const want = (args.action || 'like') === 'like';
      const maxLikes = Number((CFG && CFG.limits && CFG.limits.likesPerDay) ?? 3);
      if (want && Number.isFinite(maxLikes) && maxLikes >= 0 && st.likes >= maxLikes) {
        return { text: `⛔ 今天已经点了 ${st.likes} 个赞，到上限 ${maxLikes} 了，别点了。` };
      }
      const gate = await qualityGate('点赞', st);
      const r = await pressReaction('video-player-digg', 'z', want);
      if (r.changed) { st.likes += want ? 1 : -1; if (st.likes < 0) st.likes = 0; saveState(st); }
      if (!r.changed && r.note) return { text: `没动：点赞${want ? '已经是开着的' : '本来就是关着的'}（${r.after}）` };
      return {
        text: (want ? '✅ 已点赞' : '✅ 已取消点赞') + `\n状态: ${r.before || '(空)'} → ${r.after || '(空)'}` +
          (gate.warn ? '\n' + gate.warn : gate.note ? '\n' + gate.note : '') +
          (r.changed ? '' : '\n⚠️ 状态没变化，可能被风控或页面结构变了'),
      };
    }, 'like', 'like'),
  });

  // ---- 收藏 ----
  tools.push({
    name: 'douyin_favorite',
    description: `收藏当前视频（对外可见）。已收藏不会重复。传 action=off 取消。` +
      `点赞数低只会提醒、不拦（判断权在模型）。`,
    parameters: {
      type: 'object', additionalProperties: false,
      action: { type: 'string', description: 'on(默认) / off' },
    },
    timeoutMs: 60000,
    output: OUTPUT_TEXT,
    execute: (args, exec) => withHost(async () => {
        rememberAgent(exec);
      const st = loadState();
      const want = (args.action || 'on') !== 'off';
      const gate = await qualityGate('收藏', st);
      const r = await setReaction('video-player-collect', want);
      if (r.changed) { st.favorites += want ? 1 : -1; if (st.favorites < 0) st.favorites = 0; saveState(st); }
      if (!r.changed && r.note) return { text: `没动：收藏${want ? '已经收藏过了' : '本来就没收藏'}（${r.after}）` };
      return {
        text: (want ? '✅ 已收藏' : '✅ 已取消收藏') + `\n状态: ${r.before || '(空)'} → ${r.after || '(空)'}` +
          (gate.warn ? '\n' + gate.warn : gate.note ? '\n' + gate.note : '') +
          (r.changed ? '' : '\n⚠️ 状态没变化，可能被风控或页面结构变了'),
      };
    }, 'favorite', 'favorite'),
  });

  // ---- 评论 ----
  tools.push({
    name: 'douyin_comment',
    description: `在当前视频下写评论。默认只填草稿不发送；要真发必须传 send=true。` +
      `点赞数低只会提醒、不拦（判断权在模型）。` + WORKFLOW_HINT,
    parameters: {
      type: 'object', additionalProperties: false,
      text: { type: 'string', description: '评论内容' },
      send: { type: 'boolean', description: 'true=真的发出去(对外可见)；默认 false 只填草稿' },
      clear: { type: 'boolean', description: 'true=先清空输入框' },
    },
    timeoutMs: 90000,
    output: OUTPUT_TEXT,
    execute: (args, exec) => withHost(async () => {
        rememberAgent(exec);
      const st = loadState();
      const gate = await qualityGate('评论', st);

      const opened = await ensureCommentBox();
      if (!opened) return { text: '❌ 没打开评论输入框（评论区可能没加载出来，先 douyin_state 看看是不是在视频页）' };
      if (args.clear) {
        await evalOnPage(COMMENT.focus, 8000);
        await rpc('press', { key: 'Control+a' });
        await rpc('press', { key: 'Delete' });
        await sleep(400);
      }
      if (!args.text && !args.clear) throw new Error('需要 text，或 clear=true 先清空');
      if (args.text) {
        const t = await rpc('type', { selector: COMMENT.editorSel, text: String(args.text), replace: !!args.clear });
        if (!t.ok) throw new Error(t.error || '输入失败');
        await sleep(500);
      }
      const draft = await evalOnPage(COMMENT.text, 8000);
      const _warn = gate.warn ? gate.warn + '\n\n' : '';
      const lines = [`草稿内容: ${draft === null ? '(输入框不见了)' : JSON.stringify(draft)}`];
      if (args.send) {
        if (!draft) return { text: lines.concat('⚠️ 草稿是空的，没有发送').join('\n') };
        const capC = Number((CFG.limits && CFG.limits.commentsPerDay) || 0);
        if (capC > 0 && (st.comments || 0) >= capC) {
          return { text: lines.concat('⛔ 今日评论已达上限（' + st.comments + '/' + capC + '），明天再发。').join('\n') };
        }
        await rpc('press', { key: 'Enter' });
        await sleep(1500);
        const after = await evalOnPage(COMMENT.text, 8000);
        // 抖音可能弹「接收短信验证码」拦下这条评论 —— 必须明确告诉模型，别当成普通失败
        const verifyOpen = await evalOnPage(`(() => {
          const hits = [...document.querySelectorAll('div')].filter((e) => {
            const t = e.innerText || '';
            return (t.includes('接收短信验证码') || t.includes('为确保是本人操作')) && e.getBoundingClientRect().width > 200;
          });
          return hits.length > 0;
        })()`, 8000).catch(() => false);
        if (verifyOpen) {
          lines.push('⛔ 触发了抖音风控：页面弹出「接收短信验证码」，这条评论没有发出去。');
          lines.push('需要在浏览器里手动输入手机验证码才能继续；不验证就先别用评论功能。');
          st.comments = st.comments; // 不发出去就不计数
        } else if (after) {
          lines.push('⚠️ 按了回车但输入框还有内容，可能没发出去（风控/需要点发送按钮）');
        } else {
          st.comments += 1;
          saveState(st);
          lines.push('✅ 已发送（输入框已清空）');
        }
      } else if (args.clear && !args.text) {
        lines.push('（已清空输入框，没有发送）');
      } else {
        lines.push('（只填了草稿，没发送。要发出去再加 send=true）');
      }
      return { text: _warn + lines.join('\n') };
    }, 'comment', 'comment'),
  });

  // ---- 分享 / 转发（走社交模块 douyin-im，浏览器分享面板已证实送不到）----
  tools.push({
    name: 'douyin_share',
    description: '把视频转发到某个群或好友。走 douyin-im 通道（有服务端回执），不走浏览器分享面板。' +
      '\n      target 可以是群名/好友昵称，也可以直接给 id；不传 aweme_id 就取当前播放的那条。' +
      '\n      受「群转发上限 / 私聊转发上限」约束。',
    parameters: {
      type: 'object', additionalProperties: false,
      target: { type: 'string', description: '群名 / 好友昵称 / 群id / uid' },
      kind: { type: 'string', description: 'group / private' },
      aweme_id: { type: 'string', description: '要转发的视频 id；不填则用当前播放的' },
    },
    timeoutMs: 60000,
    output: OUTPUT_TEXT,
    execute: (args, exec) => withHost(async () => {
      rememberAgent(exec);
      const st = loadState();
      const kind = args.kind === 'private' ? 'private' : 'group';
      const limit = kind === 'group' ? lim().group : lim().private;
      const usedNow = kind === 'group' ? (st.groupForwards || 0) : (st.privateForwards || 0);
      if (usedNow >= limit) throw new Error('今日' + (kind === 'group' ? '群' : '私聊') + '转发已达上限（' + usedNow + '/' + limit + '）');
      if (!args.target) throw new Error('需要 target（群名 / 好友昵称 / id）');

      const socialDir = process.env.DOUYIN_SOCIAL_DIR || path.join(HERE, 'social');
      let channels = null;
      try { channels = JSON.parse(fs.readFileSync(path.join(socialDir, 'channels.json'), 'utf8')); } catch (e) { channels = null; }
      const list = channels ? ((kind === 'group' ? channels.groups : channels.friends) || []) : [];
      const t0 = String(args.target).trim();
      const hit = list.find(function (x) { return x.id === t0; })
        || list.find(function (x) { return String(x.name || '').trim() === t0; })
        || list.find(function (x) { return String(x.name || '').indexOf(t0) >= 0; });
      const id = hit ? hit.id : (/^\d+$/.test(t0) ? t0 : '');
      if (!id) throw new Error('找不到目标「' + t0 + '」（社交模块还没登录过？让它先跑一次生成 channels.json）');

      let awemeId = args.aweme_id ? String(args.aweme_id) : '';
      if (!awemeId) {
        try {
          const log = await rpc('get_network_log', { limit: 60, maxBytes: 2000000 });
          if (log && log.ok && log.entries) {
            for (let k = log.entries.length - 1; k >= 0; k--) {
              const u = String((log.entries[k] && log.entries[k].url) || '');
              const q = u.indexOf('group_id=');
              if (q < 0) continue;
              let tail = u.slice(q + 9);
              const stop = tail.search(/[^0-9]/);
              if (stop >= 0) tail = tail.slice(0, stop);
              if (tail && tail.length >= 15) { awemeId = tail; break; }
            }
          }
        } catch (e2) { }
      }
      if (!awemeId) throw new Error('拿不到视频 id：先 douyin_next 滑一条，或直接传 aweme_id');

      const spec = { target: kind + ':' + id, card: { itemId: awemeId } };
      try { fs.mkdirSync(socialDir, { recursive: true }); fs.writeFileSync(path.join(socialDir, 'outbox.json'), JSON.stringify(spec), 'utf8'); }
      catch (e3) { throw new Error('写投递箱失败：' + (e3 && e3.message || e3)); }

      st[kind === 'group' ? 'groupForwards' : 'privateForwards'] = usedNow + 1;
      saveState(st);
      return {
        text: '📮 已交给社交模块投递（douyin-im）\n' +
          '目标: ' + (hit ? (hit.name + ' (' + id + ')') : id) + '（' + kind + '）\n' +
          '视频: ' + awemeId + '\n' +
          '今日配额: ' + (usedNow + 1) + '/' + limit + '\n' +
          '送达以桥日志里的 serverMessageId 为准。',
      };
    }, 'share', 'share'),
  });

  // ---- 接口日志 ----
  tools.push({
    name: 'douyin_api_log',
    description: '查看本插件页面最近抓到的接口原始返回。调试接口变化时用。',
    parameters: {
      type: 'object', additionalProperties: false,
      filter: { type: 'string', description: '只显示 URL 含该子串的条目' },
      limit: { type: 'number', description: '最多几条(默认 10)' },
    },
    timeoutMs: 60000,
    output: OUTPUT_TEXT,
    execute: (args, exec) => withHost(async () => {
        rememberAgent(exec);
      const log = await rpc('get_network_log', {
        limit: args.limit || 10,
        urlFilter: args.filter,
        maxBytes: 3_000_000,
      });
      if (!log.ok) throw new Error(log.error || 'get_network_log failed');
      if (!log.entries || !log.entries.length) return { text: '(还没抓到接口。先 douyin_search 或打开一个页面)' };
      const lines = [`共 ${log.total} 条（显示 ${log.returned}，${log.bytes} 字节）`, ''];
      for (const e of log.entries) {
        lines.push(`[${e.i}] ${e.method} ${e.status} ${e.ct}`);
        lines.push('    ' + e.url.slice(0, 160));
        if (e.json) {
          lines.push('    JSON 顶层: ' + Object.keys(e.json).slice(0, 12).join(', '));
          if (Array.isArray(e.json.data)) lines.push(`    data[]: ${e.json.data.length} 项`);
        } else if (e.text) {
          lines.push('    文本: ' + String(e.text).slice(0, 120).replace(/\n/g, ' '));
        }
        if (e.error) lines.push('    错误: ' + e.error);
      }
      return { text: lines.join('\n') };
    }, 'api_log'),
  });

  // ---- 私信/群聊：列表 ----
  tools.push({
    name: 'douyin_list_chats',
    description:
      '打开抖音消息面板，列出会话（私聊/群聊），带未读数。' +
      '注意：会话**没有稳定 ID**，只能用名字（第一段文字）当键；未读数来自页面的 semi-badge。',
    parameters: { type: 'object', additionalProperties: false },
    timeoutMs: 60000,
    output: OUTPUT_TEXT,
    execute: (_a, exec) => withHost(async () => {
        rememberAgent(exec);
      if (!(await ensureImPanel())) return { text: '❌ 消息面板没打开（抖音可能改了入口，或者需要真实点击）' };
      const raw = await evalOnPage(IM_LIST_EXPR, 10000);
      let list = [];
      try { list = JSON.parse(raw); } catch {}
      if (!list.length) return { text: '面板开了但没读到会话（可能还在加载）' };
      const lines = [`共 ${list.length} 个会话（未读合计 ${list.reduce((a, c) => a + (c.unread || 0), 0)}）`, ''];
      for (const c of list) {
        lines.push(`${c.unread ? '🔴' + c.unread : '  '} ${c.raw}`);
      }
      lines.push('', '下一步：douyin_read_chat target=<上面的名字> 读消息；douyin_send_chat 发消息');
      return { text: lines.join('\n') };
    }, 'list_chats', 'chat'),
  });

  // ---- 私信/群聊：读消息 ----
  tools.push({
    name: 'douyin_read_chat',
    description:
      '点开指定会话（按名字模糊匹配），读最近 10 条消息。' +
      '文本消息给正文；图片/表情包只标 [图片]。' +
      '⚠️ 抖音的消息列表是窗口化渲染（滚出可视区的会被卸载），所以只能拿到"当前渲染出来的"那几条，' +
      '看不到历史更早的记录；切走期间的新消息如果已经滚出窗口也补不回来。',
    parameters: {
      type: 'object', additionalProperties: false,
      target: { type: 'string', description: '会话名字（/群名，模糊匹配就行）' },
    },
    timeoutMs: 90000,
    output: OUTPUT_TEXT,
    execute: (args, exec) => withHost(async () => {
        rememberAgent(exec);
      if (!args.target) throw new Error('需要 target（会话名）');
      try {
        await openChatByName(args.target);
      } catch (e) {
        const avail = e && e.available ? '\n现有会话: ' + e.available.join(' / ') : '';
        throw new Error(((e && e.message) || String(e)) + avail);
      }
      const raw = await evalOnPage(IM_MESSAGES_EXPR, 12000);
      let data = { count: 0, items: [] };
      try { data = JSON.parse(raw); } catch {}
      // 抖音会在会话里插系统提示（打招呼引导、互相关注提示等），它们在 DOM 上和普通
      // 消息长得一样，只能靠文案特征认——认得出就标成[系统]，省得模型当成对方说的话。
      const SYS_HINTS = ['打个招呼吧', '可以开始聊天了', '你们已互相关注', '撤回了一条消息', '以上是打招呼的内容', '对方正在输入'];
      const isSystem = (txt) => SYS_HINTS.some((h) => String(txt || '').includes(h));
      const lines = [`会话「${args.target}」当前渲染出 ${data.count} 条消息：`, ''];
      for (const m of data.items) {
        const sys = isSystem(m.text);
        const who = sys ? '系统' : m.mine === true ? '我' : m.mine === false ? '对方' : '?';
        const link = (m.links && m.links[0]) || '';
        const body = m.kind === 'image'
          ? '[图片/表情]'
          : m.kind === 'text'
            ? m.text
            : link
              ? '[视频分享链接] ' + link
              : m.kind === 'share-card'
                ? '[视频分享卡片] 作者：' + (m.shareAuthor || '未知') + '（卡片里没有 href，要点开才知道是哪条）'
                : '[非文本]';
        const name = !sys && m.sender ? `（${m.sender}）` : '';
        lines.push(`${who}${name}: ${body}`);
      }
      if (!data.count) lines.push('(没读到消息：可能是新会话，或页面还没加载完)');
      lines.push('', '发消息：douyin_send_chat target="' + args.target + '" text="..."（默认只填草稿）');
      return { text: lines.join('\n') };
    }, 'read_chat', 'chat'),
  });

  // ---- 私信/群聊：发消息 ----
  tools.push({
    name: 'douyin_send_chat',
    description:
      `给指定会话发文本消息。**默认只填草稿不发送**，要真发传 send=true。` +
      `发出去就是真的发给真人了（对外可见，撤不回来），确认过再发。` +
      `每日自动回复上限 ${lim().replies} 条（防封号），用完就拒。`,
    parameters: {
      type: 'object', additionalProperties: false,
      target: { type: 'string', description: '会话名（模糊匹配）' },
      text: { type: 'string', description: '要发的内容（纯文本）' },
      send: { type: 'boolean', description: 'true=真的发出去；默认 false 只填草稿' },
      clear: { type: 'boolean', description: 'true=发送前先清空输入框（默认覆盖）' },
    },
    timeoutMs: 120000,
    output: OUTPUT_TEXT,
    execute: (args, exec) => withHost(async () => {
        rememberAgent(exec);
      if (!args.target) throw new Error('需要 target（会话名）');
      if (!args.text) throw new Error('需要 text');
      const st = loadState();
      const doSend = !!args.send;
      if (doSend && st.replies >= lim().replies) {
        return { text: `⛔ 今日自动回复已达上限（${st.replies}/${lim().replies} 条），今天的私信不再自动发。明天 0 点重置。` };
      }
      await openChatByName(args.target);
      if (args.clear) {
        await evalOnPage(`(() => { const ed = document.querySelector('${IM_EDITOR_SEL}'); if (ed) { ed.focus(); return true; } return false; })()`, 8000);
        await rpc('press', { key: 'Control+a' });
        await rpc('press', { key: 'Delete' });
        await sleep(300);
      }
      const typed = await rpc('type', { selector: IM_EDITOR_SEL, text: String(args.text), replace: !args.clear });
      if (!typed.ok) throw new Error(typed.error || '输入失败');
      await sleep(600);
      const draft = await evalOnPage(IM_EDITOR_TEXT_EXPR, 8000);
      const lines = [`草稿: ${draft === null ? '(没找到输入框)' : JSON.stringify(draft)}`];
      if (!doSend) {
        lines.push('（只填了草稿，没发送。确认要发再加 send=true）');
        return { text: lines.join('\n') };
      }
      if (!draft) {
        lines.push('⚠️ 草稿是空的，没有发送');
        return { text: lines.join('\n') };
      }
      await rpc('press', { key: 'Enter' });
      await sleep(1500);
      const after = await evalOnPage(IM_EDITOR_TEXT_EXPR, 8000);
      const sent = !after;
      if (sent) {
        st.replies += 1;
        saveState(st);
        lines.push(`✅ 已发送（回车提交，输入框已清空）`);
        lines.push(`今日自动回复: ${st.replies}/${lim().replies}`);
      } else {
        lines.push('⚠️ 按了回车但输入框还有内容，可能没发出去（抖音可能要求点发送按钮，或有风控）');
      }
      return { text: lines.join('\n') };
    }, 'send_chat', 'chat'),
  });
  // ---- 群聊/私信 @ 巡检（被动响应，绝不消耗主动浏览额度）----
  tools.push({
    name: 'douyin_check_mentions',
    description:
      '检查群聊/私信里有没有「@ 我」的未读消息，命中且带视频链接就打开那条视频。' +
      '⚠️ 这是**被动响应**：打开后必须停。严禁紧接着调用 douyin_next —— 那是主人的主动浏览额度，' +
      '每滑一次都在消耗每日 1 小时上限。被动看别人 @ 我的视频不算主动浏览，但一旦开始下滑就变成主动刷了。' +
      '（本工具只读消息，不受 chat 开关限制。）',
    parameters: {
      type: 'object', additionalProperties: false,
      maxChats: { type: 'number', description: '最多翻几个未读会话(默认 3，上限 5)' },
      open: { type: 'boolean', description: 'true=命中就打开第一条；默认 false 只报告' },
    },
    timeoutMs: 120000,
    output: OUTPUT_TEXT,
    execute: (args, exec) => withHost(async () => {
        rememberAgent(exec);
      const nick = (CFG.identity && CFG.identity.selfNickname) || '';
      if (!(await ensureImPanel())) throw new Error('消息面板没打开');
      const raw = await evalOnPage(IM_LIST_EXPR, 12000);
      let list = [];
      try { list = JSON.parse(raw); } catch {}
      const unread = list.filter((c) => (c.unread || 0) > 0);
      if (!unread.length) return { text: `消息面板里有 ${list.length} 个会话，但都没有未读，没有需要处理的 @。` };

      const limit = Math.min(Math.max(Number(args.maxChats) || 3, 1), 5);
      const hits = [];
      const scanned = [];
      for (const c of unread.slice(0, limit)) {
        try {
          await openChatByName(c.name);
        } catch (e) {
          scanned.push(`${c.name}（打不开：${(e && e.message) || e}）`);
          continue;
        }
        const msgRaw = await evalOnPage(IM_MESSAGES_EXPR, 15000);
        let data = { items: [] };
        try { data = JSON.parse(msgRaw); } catch {}
        scanned.push(`${c.name}（${data.items.length} 条）`);
        for (const m of data.items) {
          const txt = String(m.text || '');
          // 链接优先取卡片上的 <a href>；纯文本里的链接再兜一层。
          // 私聊直接分享视频时是没有 @ 的，所以「有链接就收」，@ 只当标注。
          const raw = (m.links && m.links[0]) || extractVideoLink(txt);
          // 分享卡片：没有 href，只能靠「点开再看地址栏」。先记下来，open 的时候再点。
          if (!raw && m.hasShareCard) {
            const mentioned2 = txt.includes('@' + nick) || txt.includes('@ ' + nick) || txt.includes('提到了我') || txt.includes('提到了你');
            hits.push({
              chat: c.name,
              from: m.sender || (m.mine ? '我' : '对方'),
              text: '[视频分享卡片] 作者：' + (m.shareAuthor || '未知'),
              link: null,
              card: true,
              mentioned: mentioned2,
            });
            continue;
          }
          if (!raw) continue;
          const link = String(raw).startsWith('http') ? String(raw) : 'https://www.douyin.com' + String(raw);
          const mentioned = txt.includes('@' + nick) || txt.includes('@ ' + nick) || txt.includes('提到了我') || txt.includes('提到了你');
          hits.push({
            chat: c.name,
            from: m.sender || (m.mine ? '我' : '对方'),
            text: (txt || '[视频分享]').slice(0, 100),
            link,
            mentioned,
          });
        }
      }

      const lines = [`扫描了 ${scanned.length} 个未读会话：${scanned.join('、')}`];
      if (!hits.length) {
        lines.push(`没有找到「@${nick} 且带视频链接」的消息。`);
        lines.push('（如果昵称不对，改 config.json 的 identity.selfNickname）');
        return { text: lines.join('\n') };
      }
      lines.push('', `找到 ${hits.length} 条：`);
      hits.forEach((h, i) => {
        lines.push(`${i + 1}. [${h.chat}]${h.mentioned ? ' [@我]' : ' [分享]'} ${h.from}: ${h.text}`);
        lines.push(`   链接: ${h.link || '（卡片，需点开才知道）'}`);
      });

      if (!args.open) {
        lines.push('', '（open=false，只报告没打开。要打开第一条就传 open=true）');
        return { text: lines.join('\n') };
      }

      const first = hits[0];
      let targetUrl = first.link;
      let openedVia = 'goto';

      // 分享卡片没有 href，只能真实点开再看地址栏。点完可能当前页跳转，也可能开新标签。
      if (!targetUrl && first.card) {
        const marked = await evalOnPage(`(() => {
          const cards = [...document.querySelectorAll('.MessageItemShareAwemecontainer')];
          if (!cards.length) return false;
          // 消息列表是 180° 翻转渲染的，DOM 里**第一个**才是最新那条分享
          cards[0].setAttribute('data-dy-share', '1');
          return true;
        })()`, 8000).catch(() => false);
        if (marked) {
          await rpc('click', { selector: '[data-dy-share="1"]' }).catch(() => {});
          await sleep(4000);
          targetUrl = String((await evalOnPage('location.href', 8000).catch(() => '')) || '');
          openedVia = 'click-card';
          // 新标签打开时当前页不会变 —— 把页面列表也报出来，让人知道视频在哪个标签里
          if (!/\/video\/\d+|\/note\/\d+/.test(targetUrl)) {
            const pages = await rpc('pages', {}).catch(() => null);
            lines.push('', '（点开卡片后当前页没跳转，可能开在新标签。当前标签：' +
              (pages && pages.ok ? JSON.stringify(pages.pages || pages).slice(0, 300) : '取不到') + '）');
          }
        }
      }

      if (!targetUrl) {
        lines.push('', '⚠️ 找到了分享卡片，但点开后没拿到链接。可以在浏览器里手动点一下它，或者让对方改发链接。');
        return { text: lines.join('\n') };
      }

      if (openedVia === 'goto') {
        await rpc('goto', { url: targetUrl }).catch(() => {});
        await sleep(2500);
      }
      const st = await pageState().catch(() => null);
      lines.push(
        '',
        `▶ 已打开（${openedVia === 'click-card' ? '点卡片' : '直接导航'}）: ${targetUrl}`,
        `标题: ${(st && st.title) || '(读取中)'}`,
        '',
        '⛔ 看完就停，不要调用 douyin_next。',
        '被动打开的视频不算主动浏览，但一旦下滑就变成主动刷、开始消耗每日 1 小时额度。',
      );
      return { text: lines.join('\n') };
    }, 'check_mentions'),
  });
  // ---- 今日用量 ----
  tools.push({
    name: 'douyin_usage',
    description: '看今天的用量：浏览时长、点赞/收藏/评论次数、转发配额还剩多少、因质量跳过了几次。',
    parameters: { type: 'object', additionalProperties: false },
    timeoutMs: 30000,
    output: OUTPUT_TEXT,
    execute: (_a, exec) => withHost(async () => {
        rememberAgent(exec);
      const s = loadState();
      return {
        text: [
          `日期: ${s.date}`,
          `浏览: ${Math.round(s.browseSeconds / 60)} 分钟 / ${Math.round(lim().browseSec / 60)} 分钟` +
            (s.browseSeconds >= lim().browseSec ? '（已达上限，douyin_next 会被拒）' : ''),
          `互动: 赞 ${s.likes} / 藏 ${s.favorites} / 评 ${s.comments}`,
          `转发: 群 ${s.groupForwards}/${lim().group}、私聊 ${s.privateForwards}/${lim().private}`,
          `点赞数偏低提醒过: ${s.lowQualityWarnings || 0} 次（参考线 ${lim().minDigg} 赞，不拦操作）`,
          `状态文件: ${STATE_FILE}`,
        ].join('\n'),
      };
    }, 'usage'),
  });

  ctx.effect(() => {
    const disposers = tools.map((t) => ctx.tools.register(t));
    logger.info(`douyin-on-base: ${tools.length} 个工具 → ${HOST} (session ${SESSION_ID})`);
    return () => { for (const d of disposers) { try { d(); } catch {} } };
  }, 'douyin-on-base: tools');

  // ---- 实时通道：订阅管家的 /events，页面一有新消息就叫醒当前会话 ----
  ctx.effect(() => {
    let stopped = false;
    let lastWakeAt = 0;
    (async () => {
      while (!stopped) {
        try {
          const res = await fetch(HOST + '/events', { headers: { accept: 'text/event-stream' } });
          if (!res.ok || !res.body) throw new Error('SSE ' + res.status);
          wakeLog('SSE 已连上 ' + HOST + '/events');
          logger.info('[douyin-on-base] SSE 已连上：' + HOST + '/events');
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          while (!stopped) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let cut;
            while ((cut = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, cut);
              buf = buf.slice(cut + 2);
              for (const line of block.split('\n')) {
                if (!line.startsWith('data:')) continue;
                let ev = null;
                try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
                if (!ev || ev.type !== 'new_msg') continue;
                reloadCfg();
                // 默认不自动叫醒：只有显式 features.chatAutoWake = true 才轮询投递
                if (!(CFG && CFG.features && CFG.features.chatAutoWake === true)) continue;
                const now = Date.now();
                if (now - lastWakeAt < 1500) continue;   // 同一波动静只分发一次（1.5 秒防抖，不是冷却）
                lastWakeAt = now;
                wakeOnNewMessage(ev, logger).catch(() => {});
              }
            }
          }
          logger.warn('[douyin-on-base] SSE 断开了，3 秒后重连');
        } catch (e) {
          if (stopped) break;
          logger.warn('[douyin-on-base] SSE 连接失败: ' + String((e && e.message) || e) + '（3 秒后重试）');
        }
        if (!stopped) await sleep(3000);
      }
    })().catch(() => {});
    return () => { stopped = true; };
  }, 'douyin-on-base: sse-wake');
}

export { name, apply, inject };
