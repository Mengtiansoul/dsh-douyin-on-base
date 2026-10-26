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

## 消息进来了，只回「这一轮没有产出文本」

桥把消息送进 DSH 了，但那边一个回合都没跑。看会话文件里的 `turn/end`：

| `reason` | 含义 | 怎么办 |
|---|---|---|
| `blocked` | 会话处在**归档**状态。`dsh-api-session-controller` 的 ArchivedSessionGate 在 `agent/pre-step` 直接拒掉，不发请求、不产出文本，桥只能回兜底话术 | 停 DSH → 用 `social/register-workspace.ps1 -Unarchive <sessionId>` 把它从 `archivedSessionIds` 摘出来 → 起 DSH |
| `error` + `CONTEXT_WINDOW_EXCEEDED` | 会话上下文塞满了（消息 token + 输出预留超过模型上限） | `/new` 开新会话 |
| `completed` 但没有文本 | 模型只调了工具 | 看那段工具调用干了什么，多半是它的权限或用例不对 |

加一堆「别调工具、只回文字」的提示词治不了归档——那是闸门在 pre-step 就拒了，模型根本没机会看到消息。

### 误归档现在会自己恢复

从 2026-10-26 起插件自带一条「防误归档」的路：

1. 桥在处理每条消息前读一次 `{dshHome}/storages/workspace.json`（30 秒缓存），发现绑定的会话在归档列表里，就不走兜底话术，直接回一句「我这边会话被归档了，正在恢复」，同时写 `social/archived.flag`。
2. 看门狗（每 5 分钟）看到这个 flag，排一次性任务 `social/recover-archived.ps1`：等 60 秒 → 停宿主 → `register-workspace.mjs --unarchive <id>` → 起宿主 → 清 flag。
3. 前提是 `config.json` 的 `dshHome` 填对（本机 `D:/Deepseek-Harness/DSH`）。留空只跳过这项检查，收发不受影响。
4. 不想要自动恢复就把 `social.autoUnarchive` 设成 `false`。

代价说清楚：恢复本身要停宿主几十秒，所以故意延迟 60 秒才开始，正在聊的天先说完。

### 新接一条通道时：工作区要登记，不是建目录就行

DSH 的工作区是**注册表**，不是磁盘目录：`{DSH_HOME}/storages/workspace.json` 的 `global.workspaceIds` + `tables.workspaces` 里没有记录，光 `mkdir` 侧栏也不会出现。而且会话首帧的 cwd 必须等于工作区 `path`，否则 attach 失败。

```
powershell -File social\register-workspace.ps1 -Path "D:\Deepseek-Harness\Social\douyin" -Title douyin `
     -Sessions "<私信会话id>,<群会话id>" -Unarchive "<只解归档、不改归属的id>"
```

脚本自己「停 DSH → 改文件 → 回读校验 → 起 DSH」，加 `-DryRun` 只看改动不写。必须在 DSH 停止时改：宿主退出时会把内存里的工作区/归档状态写回文件，边跑边改会被覆盖。

**别在 pwsh 双引号里拼 `node -e` 写 Windows 路径**——PowerShell 不把反斜杠当转义，再经过 JS 一层就会落成字面双反斜杠，工作区指向一个不存在的目录，症状是侧栏整组不显示、也不报任何错。

## 别做的事

- 别手改 `profiles/web/cordis.patch.yml`（面板保存会整份重写，改动会被冲掉）
- 别删 `data/`（登录态，删了要重新扫码/短信）
- 别删 `social/sessions.json`（会话映射，删了对话会断）

## 升级顺序

1. 备份 `data/` + `config.json` + `social/sessions.json`
2. 升 DSH 宿主 → 看 `agents.resume` / `agentPresets.mount` 有没有变
3. 升 `douyin-im` → 先跑一次登录 + 发一条消息
4. 升 `star-browser` → 先跑一次 `douyin_state`