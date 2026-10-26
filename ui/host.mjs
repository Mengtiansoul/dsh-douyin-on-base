// ============================================================
// ui/host.mjs — 设置面板的「宿主半身」
//
// 只做两件事：给浏览器半身读配置、接一次保存。
// 挂载方式（profile 的 cordis.patch.yml）：
//   - insert:
//       - id: douyin-on-base-ui
//         name: './ui/host.mjs'
//
// 访问守卫：只允许本机回环，或 tailnet 的 *.ts.net（主人偶尔从笔记本开 GUI）。
// 跨站请求一律拒（看 origin + sec-fetch-site）。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig, saveConfig, maskedForPanel, stateSummary, sanitizePatch,
  CONFIG_FILE, STATE_FILE, DEFAULT_CONFIG,
} from '../lib/config-store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 请求日志：面板保存卡住时靠它判断请求到底有没有到宿主 */
const REQ_LOG = path.join(HERE, '..', 'ui-requests.log');
function logReq(line) {
  try { fs.appendFileSync(REQ_LOG, new Date().toISOString() + ' ' + line + '\n'); } catch {}
}

export const name = 'douyin-on-base-ui';
/** 只依赖宿主 webServer：开 HTTP 路由给浏览器半身用 */
export const inject = ['webServer'];

const API_PATH = '/douyin/api';

function hostnameOf(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('[')) return raw.slice(1, raw.indexOf(']'));
  return raw.split(':')[0];
}

function isAllowedHost(h) {
  if (!h) return false;
  if (h === '127.0.0.1' || h === 'localhost' || h === '::1') return true;
  return /\.ts\.net$/i.test(h); // tailnet 入口
}

function guard(req) {
  const host = hostnameOf(req.headers && req.headers.host);
  if (!isAllowedHost(host)) return { code: 403, error: 'host not allowed' };
  const origin = req.headers && req.headers.origin;
  if (origin && String(origin) !== 'null') {
    let oh = '';
    try { oh = hostnameOf(new URL(String(origin)).host); } catch { return { code: 403, error: 'origin not allowed' }; }
    if (!isAllowedHost(oh)) return { code: 403, error: 'origin not allowed' };
  }
  // 浏览器跨站请求会带这个头
  const site = String((req.headers && req.headers['sec-fetch-site']) || '').toLowerCase();
  if (site === 'cross-site') return { code: 403, error: 'cross-site request blocked' };
  return null;
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PATH,
    handler: async (req, res) => {
      const send = (code, payload) => {
        try {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify(payload));
        } catch { /* 客户端已断开 */ }
      };
      try {
        logReq(req.method + ' ' + req.url + ' host=' + (req.headers.host || '-') +
          ' ct=' + (req.headers['content-type'] || '-') +
          ' site=' + (req.headers['sec-fetch-site'] || '-'));
        const blocked = guard(req);
        if (blocked) { logReq('  -> blocked ' + blocked.code + ' ' + blocked.error); }
        if (blocked) return send(blocked.code, { ok: false, error: blocked.error });

        const url = new URL(req.url, 'http://127.0.0.1');

        // GET 保存兜底：有些环境里浏览器对同源 POST 会莫名挂住（实测：GET 通、POST 不到宿主），
        // 这里允许 GET /config?patch=<base64(JSON)>，同样走 sanitizePatch 校验。
        if (url.pathname === API_PATH + '/config' && req.method === 'GET') {
          const patchParam = url.searchParams.get('patch');
          if (patchParam) {
            try {
              const json = Buffer.from(patchParam, 'base64').toString('utf8');
              const check = sanitizePatch(JSON.parse(json));
              if (!check.ok) { logReq('  -> patch invalid: ' + check.error); return send(400, { ok: false, error: check.error }); }
              saveConfig(check.patch);
              logReq('  -> saved via GET fallback');
              return send(200, {
                ok: true,
                config: maskedForPanel(loadConfig({ seedEnv: false })),
                state: stateSummary(),
                savedAt: Date.now(),
                via: 'get-fallback',
                note: '已写入 config.json（GET 兜底通道），工具下一次调用就生效',
              });
            } catch (e) {
              return send(400, { ok: false, error: 'patch 解析失败: ' + String((e && e.message) || e) });
            }
          }
          let cfg;
          try {
            cfg = loadConfig({ seedEnv: false }); // 面板只看文件值，不掺环境变量
          } catch (e) {
            return send(409, { ok: false, error: String((e && e.message) || e), configPath: CONFIG_FILE });
          }
          return send(200, {
            ok: true,
            config: maskedForPanel(cfg),
            defaults: DEFAULT_CONFIG,
            state: stateSummary(),
            files: { config: CONFIG_FILE, state: STATE_FILE },
          });
        }

        // 保存（唯一写入口）
        if (url.pathname === API_PATH + '/config' && req.method === 'POST') {
          const ct = String((req.headers && req.headers['content-type']) || '').toLowerCase();
          if (!ct.includes('application/json')) return send(415, { ok: false, error: 'content-type must be application/json' });
          let body;
          try { body = JSON.parse(await readBody(req)); } catch (e) {
            return send(400, { ok: false, error: 'body is not valid JSON: ' + String((e && e.message) || e) });
          }
          const check = sanitizePatch(body && body.config);
          if (!check.ok) return send(400, { ok: false, error: check.error });
          try {
            const next = saveConfig(check.patch);
            return send(200, {
              ok: true,
              config: maskedForPanel(loadConfig({ seedEnv: false })),
              savedAt: Date.now(),
              // 告诉面板哪些是即时生效的
              note: '已写入 config.json，工具下一次调用就生效（不用重启宿主）',
            });
          } catch (e) {
            return send(409, { ok: false, error: String((e && e.message) || e) });
          }
        }

        // 只读状态
        if (url.pathname === API_PATH + '/state' && req.method === 'GET') {
          return send(200, { ok: true, state: stateSummary() });
        }

        // 人设文件：上传内容 → 落到 social/persona-*.md，返回路径给面板记住
        if (url.pathname === API_PATH + '/persona' && req.method === 'POST') {
          const ct = String((req.headers && req.headers['content-type']) || '').toLowerCase();
          if (!ct.includes('application/json')) return send(415, { ok: false, error: 'content-type must be application/json' });
          let body = '';
          const readBody = new Promise(function (resolve) {
            req.on('data', function (c) { body += c; if (body.length > 512 * 1024) req.destroy(); });
            req.on('end', function () { resolve(); });
          });
          await readBody;
          let p = {};
          try { p = JSON.parse(body || '{}'); } catch (e) { return send(400, { ok: false, error: '请求不是合法 JSON' }); }
          const text = typeof p.text === 'string' ? p.text : '';
          if (!text.trim()) return send(400, { ok: false, error: '文件内容为空' });
          const safeName = String(p.name || 'persona.md').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(-60);
          const dir = path.join(HERE, '..', 'social');
          try {
            fs.mkdirSync(dir, { recursive: true });
            const target = path.join(dir, 'persona-' + safeName);
            fs.writeFileSync(target, text, 'utf8');
            return send(200, { ok: true, file: target.replace(/\\/g, '/'), name: safeName, bytes: Buffer.byteLength(text) });
          } catch (e) {
            return send(500, { ok: false, error: String((e && e.message) || e) });
          }
        }

        // 重置今日用量（只清 state.json 的今日计数，不动 config）
        if (url.pathname === API_PATH + '/reset' && req.method === 'POST') {
          try {
            const before = stateSummary();
            const today = new Date().toISOString().slice(0, 10);
            const fresh = {
              date: today, browseSeconds: 0, groupForwards: 0, privateForwards: 0,
              lastNextTime: 0, likes: 0, favorites: 0, comments: 0,
              lowQualityWarnings: 0, replies: 0,
            };
            fs.writeFileSync(STATE_FILE, JSON.stringify(fresh, null, 2), 'utf8');
            return send(200, { ok: true, before: before, after: stateSummary() });
          } catch (e) {
            return send(500, { ok: false, error: String((e && e.message) || e) });
          }
        }

        // 最近一篇刷视频日报（txt）
        if (url.pathname === API_PATH + '/report' && req.method === 'GET') {
          try {
            const dir = process.env.DOUYIN_REPORT_DIR
              || path.join(HERE, '..', 'reports');
            if (!fs.existsSync(dir)) return send(200, { ok: true, report: null });
            const files = fs.readdirSync(dir)
              .filter(function (f) { return f.indexOf('douyin-diary-') === 0 && f.endsWith('.txt'); })
              .map(function (f) { return { f: f, t: fs.statSync(dir + '\\' + f).mtimeMs }; })
              .sort(function (a, b) { return b.t - a.t; });
            if (!files.length) return send(200, { ok: true, report: null });
            const latest = files[0].f;
            const text = fs.readFileSync(dir + '\\' + latest, 'utf8').slice(0, 4000);
            return send(200, { ok: true, report: { file: latest, dir: dir, text: text, count: files.length } });
          } catch (e) {
            return send(200, { ok: true, report: null, error: String((e && e.message) || e) });
          }
        }

        // 群/好友清单（由社交模块 bridge.mjs 登录后导出），给白名单勾选用
        if (url.pathname === API_PATH + '/channels' && req.method === 'GET') {
          const cf = process.env.DOUYIN_CHANNELS_FILE
            || path.join(HERE, '..', 'social', 'channels.json');
          try {
            const raw = fs.readFileSync(cf, 'utf8');
            return send(200, { ok: true, channels: JSON.parse(raw) });
          } catch (e) {
            return send(200, { ok: true, channels: null, error: '还没拉到清单（社交模块没跑过？）' });
          }
        }

        return send(404, { ok: false, error: 'not found' });
      } catch (e) {
        return send(500, { ok: false, error: String((e && e.message) || e) });
      }
    },
  }), 'douyin-on-base: settings api');
}
