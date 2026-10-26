# 维护手册

## 抖音改版了，改哪

| 症状 | 位置 |
|---|---|
| `douyin_state` 文案/点赞数取不到 | `index.mjs` 的 `STATE_EXPR`（三个 desc 选择器、`[data-e2e="video-player-digg"]`） |
| `douyin_current_id` 拿不到 id | `douyin_current_id` 里抠 `group_id=` 的逻辑 |
| 点赞/收藏点不动 | `pressReaction` 的快捷键 + `reactionState` 选择器 |
| 分享没送达 | 已废弃浏览器分享，统一走 `douyin_share` → outbox |
| 登录失败/收不到消息 | `douyin-im` 库（第三方协议实现），升级库版本 |

## 出问题先查这三处

1. `profiles/web/cordis.patch.yml` 末尾有没有多出 `- id: xxx` + `disabled: true`（加载失败会被自动禁用）
2. 5 个计划任务指向的文件还在不在（跑 `social/selfcheck.ps1`）
3. `social/content-guard.log` 的 `reason=` 与 `social/bridge.log` 的 `OUTBOX_*` / `SKIP_*`

## 别做的事

- 别手改 `profiles/web/cordis.patch.yml`（面板保存会整份重写，改动会被冲掉）
- 别删 `data/`（登录态，删了要重新扫码/短信）
- 别删 `social/sessions.json`（会话映射，删了对话会断）

## 升级顺序

1. 备份 `data/` + `config.json` + `social/sessions.json`
2. 升 DSH 宿主 → 看 `agents.resume` / `agentPresets.mount` 有没有变
3. 升 `douyin-im` → 先跑一次登录 + 发一条消息
4. 升 `star-browser` → 先跑一次 `douyin_state`