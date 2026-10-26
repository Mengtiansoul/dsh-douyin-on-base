/**
 * douyin-bridge — 把抖音私信消息接进真正的 DSH 会话。
 *
 * 为什么要有它：dsh-douyin-browser-local 默认自己调一次模型生成回复
 * （chat-agent.mjs），那条链路不经过 DSH 会话，也就没有记忆、没有工具、
 * 跟 QQ 那边不是同一个上下文。这里改成：插件把消息丢过来，由本模块建
 * 一条真正的 DSH 会话（跟 QQ 一样，记忆人设共享、对话各自独立），把消息
 * followup 进去，等这一轮跑完再把 assistant 的文本还回去。
 *
 * 接口（只监听 127.0.0.1）：
 *   POST /chat  { key, text, name? }  -> { ok, reply, sessionId }
 *   POST /new   { key }               -> { ok, sessionId }
 *   GET  /health                      -> { ok, chats, sessions }
 *
 * key 由调用方决定（建议 "private:<id>" / "group:<id>"），用来稳定映射会话。
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url))

export const name = 'dsh-douyin-bridge'
export const inject = ['agents', 'agentPresets', 'agentDefaultModel']

const TURN_TIMEOUT_MS = 180_000
const MAX_TEXT = 8000

function textOf(message) {
  if (!message || !Array.isArray(message.content)) return ''
  const parts = []
  for (const block of message.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

function sourceKindOf(key) {
  if (String(key).startsWith('group:')) return 'douyin:group'
  if (String(key).startsWith('private:')) return 'douyin:private'
  return 'plugin:dsh-douyin-bridge'
}

function userMessage(text, key) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: sourceKindOf(key), plugin: 'dsh-douyin-bridge', key: String(key || '') },
  })
}

export function apply(ctx, config = {}) {
  const port = Number(config.port) || 3099
  const cwd = typeof config.cwd === 'string' && config.cwd
    ? config.cwd
    : (process.env.DOUYIN_CWD || path.join(SELF_DIR, 'workspace'))
  const presetId = typeof config.agentPreset === 'string' ? config.agentPreset : ''
  const mapFile = typeof config.mapFile === 'string' && config.mapFile
    ? config.mapFile
    : path.join(SELF_DIR, 'social', 'sessions.json')

  const log = (level, message) => {
    try {
      if (ctx.logger && typeof ctx.logger[level] === 'function') ctx.logger[level]('[douyin-bridge] ' + message)
      else console.log('[douyin-bridge] ' + message)
    } catch { /* logging never breaks the bridge */ }
  }

  /** key -> { sessionId, handle, buffer, waiter, chain } */
  const bySession = new Map()
  const byKey = new Map()

  // ---- 会话映射持久化（重启后接着用同一条会话）--------------------------
  let mapping = {}
  try { mapping = JSON.parse(fs.readFileSync(mapFile, 'utf8')) } catch { mapping = {} }
  const saveMapping = () => {
    try {
      fs.mkdirSync(path.dirname(mapFile), { recursive: true })
      const tmp = mapFile + '.' + process.pid + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(mapping, null, 2), { mode: 0o600 })
      fs.renameSync(tmp, mapFile)
    } catch (error) { log('warn', 'mapping save failed: ' + error.message) }
  }

  const sessionIdFor = (key) => 'douyin-' + createHash('sha1').update(key).digest('hex').slice(0, 12)

  // ---- 会话事件 ---------------------------------------------------------
  ctx.on('session/event', (session, event) => {
    const chat = bySession.get(session.id)
    if (!chat) return
    if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message)
      if (text) chat.buffer.push(text)
      return
    }
    if (event.type === 'turn/end') settle(chat, event.data?.reason)
  })

  function settle(chat, reason) {
    const waiter = chat.waiter
    if (!waiter) return
    chat.waiter = null
    clearTimeout(waiter.timer)
    const reply = chat.buffer.join('\n').trim()
    chat.buffer = []
    if (reason && reason.kind === 'error') {
      waiter.reject(new Error('回合出错：' + String(reason.error?.message || reason.kind)))
      return
    }
    if (!reply) {
      waiter.reject(new Error('这一轮没有产出文本（结束原因 ' + ((reason && reason.kind) || '?') + '，可能是工具调用被权限挡掉）'))
      return
    }
    waiter.resolve(reply)
  }

  // ---- 建/取会话 --------------------------------------------------------
  async function open(key) {
    const known = byKey.get(key)
    if (known && known.handle) return known

    const sessionId = mapping[key] || sessionIdFor(key)
    const selection = (() => {
      try { return ctx.agentDefaultModel?.currentSelection?.() } catch { return undefined }
    })()
    const agentOptions = {}
    if (selection && selection.provider && selection.model) {
      agentOptions.provider = selection.provider
      agentOptions.model = selection.model
    }
    const setup = async (agentCtx) => {
      const presets = ctx.agentPresets
      if (!presets || typeof presets.mount !== 'function' || !presetId) return
      try { await presets.mount(agentCtx, presetId) } catch (error) {
        log('warn', 'preset mount failed (' + presetId + '): ' + error.message)
      }
    }

    let handle

    // 会话接续顺序（不能跳步，跳一步就会新建会话、上下文丢失）：
    //   ① resume(映射里记的 id)  ← 正常路径
    //   ② resume(key 推出的稳定 id) ← 映射丢了但会话还在
    //   ③ create(key 推出的稳定 id) ← 真没有这条会话
    //   ④ create(随机后缀)          ← 磁盘有同名会话但 ①② 都接不上（最后兜底）
    const stableId = sessionIdFor(key)
    // 工作区目录不存在就建出来（每个通道一个独立工作区，不塞进用户项目目录）
    try { fs.mkdirSync(cwd, { recursive: true }) } catch (e0) { log('warn', '创建工作区失败 ' + cwd + ' :: ' + ((e0 && e0.message) || e0)) }
    const tryResume = async (id, why) => {
      try {
        const h = await ctx.agents.resume({ resumeSessionId: id, agentOptions, setup })
        log('info', 'resumed(' + why + ') ' + key + ' -> ' + id)
        return h
      } catch (e) {
        log('warn', 'resume(' + why + ') 失败 ' + id + ' :: ' + ((e && e.message) || e))
        return null
      }
    }

    handle = await tryResume(sessionId, 'mapping')
    if (!handle && stableId !== sessionId) handle = await tryResume(stableId, 'stable-id')
    if (!handle) {
      try {
        handle = await ctx.agents.create({ sessionId: stableId, meta: { cwd }, agentOptions, setup })
        log('info', 'created ' + key + ' -> ' + stableId)
      } catch (createError) {
        const fallback = stableId + '-' + Math.random().toString(36).slice(2, 6)
        log('warn', 'create 冲突（' + ((createError && createError.message) || createError) + '），改用 ' + fallback + '（上下文会丢）')
        handle = await ctx.agents.create({ sessionId: fallback, meta: { cwd }, agentOptions, setup })
      }
    }

    const actual = handle.agent.session.id
    const chat = { key, sessionId: actual, handle, buffer: [], waiter: null, chain: Promise.resolve() }
    bySession.set(actual, chat)
    byKey.set(key, chat)
    mapping[key] = actual
    saveMapping()
    log('info', 'opened ' + key + ' -> ' + actual)
    return chat
  }

  // ---- 投一条消息并等回复 ------------------------------------------------
  function ask(key, text) {
    return open(key).then((chat) => {
      // 同一个会话串行处理，避免两条消息抢同一轮。
      const run = chat.chain.then(() => new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (chat.waiter && chat.waiter.timer === timer) {
            chat.waiter = null
            reject(new Error('等待模型回复超时（' + Math.round(TURN_TIMEOUT_MS / 1000) + ' 秒）'))
          }
        }, TURN_TIMEOUT_MS)
        timer.unref?.()
        chat.waiter = { resolve, reject, timer }
        chat.buffer = []
        try {
          chat.handle.agent.followup(userMessage(text, key))
        } catch (error) {
          clearTimeout(timer)
          chat.waiter = null
          reject(error)
        }
      }))
      chat.chain = run.catch(() => {}).then(() => {
        // settle 之后留一点间隔，避免极端情况下下一轮事件串到上一轮。
        return new Promise((r) => setTimeout(r, 50))
      })
      return run
    })
  }

  async function reset(key) {
    const old = byKey.get(key)
    if (old) {
      byKey.delete(key)
      bySession.delete(old.sessionId)
      try { old.handle.dispose?.() } catch (error) { log('warn', 'dispose failed: ' + error.message) }
      delete mapping[key]
      saveMapping()
      log('info', 'retired ' + key + ' (' + old.sessionId + ')')
    }
    const chat = await open(key)
    return chat.sessionId
  }

  // ---- HTTP -------------------------------------------------------------
  const server = http.createServer((req, res) => {
    const send = (code, body) => {
      const data = Buffer.from(JSON.stringify(body), 'utf8')
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length })
      res.end(data)
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/health') {
      send(200, { ok: true, chats: byKey.size, sessions: bySession.size, port })
      return
    }
    if (req.method !== 'POST') { send(405, { ok: false, error: 'only POST' }); return }

    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 200_000) req.destroy()
    })
    req.on('end', () => {
      let body = {}
      try { body = raw ? JSON.parse(raw) : {} } catch { send(400, { ok: false, error: '请求不是合法 JSON' }); return }
      const key = typeof body.key === 'string' ? body.key.trim() : ''
      if (!key) { send(400, { ok: false, error: '缺少 key' }); return }

      if (url.pathname === '/new') {
        reset(key).then((sessionId) => send(200, { ok: true, sessionId }))
          .catch((error) => send(500, { ok: false, error: error.message }))
        return
      }
      if (url.pathname === '/chat') {
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (!text) { send(400, { ok: false, error: '缺少 text' }); return }
        if (text.length > MAX_TEXT) { send(400, { ok: false, error: '消息太长' }); return }
        if (text === '/new' || text === '／new') {
          reset(key).then((sessionId) => send(200, { ok: true, reply: '好，换新会话了', sessionId }))
            .catch((error) => send(500, { ok: false, error: error.message }))
          return
        }
        const head = typeof body.name === 'string' && body.name ? '[' + body.name + '] ' : ''
        ask(key, head + text).then((reply) => {
          const chat = byKey.get(key)
          send(200, { ok: true, reply, sessionId: chat ? chat.sessionId : '' })
        }).catch((error) => send(500, { ok: false, error: error.message }))
        return
      }
      send(404, { ok: false, error: '没有这个入口' })
    })
  })

  server.on('error', (error) => log('error', 'http: ' + error.message))
  server.listen(port, '127.0.0.1', () => log('info', 'listening on 127.0.0.1:' + port))

  ctx.effect?.(() => () => {
    try { server.close() } catch { /* ignore */ }
    for (const chat of byKey.values()) {
      try { chat.handle.dispose?.() } catch { /* ignore */ }
    }
    byKey.clear()
    bySession.clear()
  })
}
