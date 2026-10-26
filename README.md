# 抖音助手（dsh-douyin-on-base）

给 DSH 用的抖音插件：把「刷视频」和「回消息」拆成两个互不干扰的模块。

- **内容模块**（主动式）：调 star-browser 管家驱动浏览器，刷推荐流、评估画面、点赞收藏转发。用完关浏览器。
- **社交模块**（被动式）：纯 Node 直连 WSS（douyin-im），收发私信与群消息。**完全不碰浏览器**。

## 能力

### 内容模块

| 工具 | 说明 |
|---|---|
| `douyin_recommend` | 切到推荐流 |
| `douyin_search` | 搜视频（读接口，不点页面） |
| `douyin_open` | 按 aweme_id / 搜索结果序号打开 |
| `douyin_next` | 下滑切下一条（累计浏览时长） |
| `douyin_state` | 读播放/点赞/收藏/今日用量 |
| `douyin_look` | 截图当前画面 |
| `douyin_evaluate` | 截图 + 视觉模型打分（可自动互动） |
| `douyin_current_id` | 取当前视频 aweme_id（带 DOM 反查校验） |
| `douyin_like` / `douyin_favorite` | 点赞 / 收藏（点赞键走快捷键 Z） |
| `douyin_comment` | 发评论（默认草稿，`send=true` 才发） |
| `douyin_share` | 转发视频到群/好友（走社交通道，有服务端回执） |
| `douyin_press` | 快捷键：w 清屏 / x 评论 / z 赞 / f 作者主页 / p 推荐给朋友 / v 分享 |
| `douyin_stop` | 收工，通知守卫关浏览器 |
| `douyin_usage` / `douyin_api_log` | 今日用量 / 接口原始返回 |

### 社交模块

`social/bridge.mjs` 用 douyin-im 登录后监听消息，通过 `session-bridge.mjs`（HTTP 3099）投进真正的 DSH 会话，
拿到整段回复后再发回抖音。特性：

- 一人一会话 / 一群一会话，**重启不换会话**（`agents.resume` 优先）
- 白名单（群 / 好友）、通道开关（私信 / 群）、触发方式（仅 @ / 自行判断）
- 每日回复上限、分段间隔与段数
- 支持自带表情（`[呲牙]` 这种文本式）、收藏表情（图片式）、视频卡片
- 出站投递箱（`social/outbox.json`）：可主动往任意群/好友发文字或卡片

## 安装

```bash
# 一行装（推荐）
npx -p @deepseek-ai/dsh dsh plugin --profile web add github:Mengtiansoul/dsh-douyin-on-base
```

装完重启宿主（或在插件面板启用），依赖会由 pnpm 自动安装。

本地开发用：

```bash
dsh plugin --profile web add link:/path/to/douyin-on-base
```

`cordis.patch.yml` 里有三个 entry：工具本体、设置面板宿主半身、会话桥。
**想给社交会话指定某个 Agent 预设**（比如带你自定义人格的那个），在该文件的会话桥条目下加 `agentPreset: '你的预设id'`；不写就用宿主默认预设。

## 配置

打开 **设置 → 抖音助手**，三页：总设置 / 内容模块 / 社交模块。所有配置写在插件目录的 `config.json`，
**保存即时生效，不用重启宿主**。

首次使用需要：

1. 总设置里填视觉模型（OpenAI 兼容接口，用于 `douyin_evaluate`）
2. 社交模块首次运行要扫码或短信登录（登录态存在 `data/`，之后自动恢复）
3. 内容模块需要 star-browser 管家在跑

另外建议把 `dshHome` 填上（就是这个 DSH 实例的家目录）。填了之后，万一社交会话被误归档，插件能认出来并自己捞回来；不填只影响这一项检查，收发消息不受影响。
## 文件说明

| 文件 | 作用 |
|---|---|
| `index.mjs` | 内容模块，注册 `douyin_*` 工具 |
| `session-bridge.mjs` | 会话桥，HTTP 3099，把消息投进 DSH 会话并取回整段回复 |
| `lib/config-store.mjs` | 配置默认值、读写、字段校验 |
| `ui/client.js` | 设置面板前端（三页 Tab） |
| `ui/host.mjs` | 设置面板的宿主接口 `/douyin/api/*` |
| `social/bridge.mjs` | 社交模块主进程，douyin-im 收发消息 |
| `social/watchdog.ps1` | 看门狗，桥挂了拉起来；社交模块关闭时停掉它 |
| `social/content-guard-loop.ps1` | 内容守卫，按限额/时段/中断关浏览器 |
| `social/daily-report.mjs` | 生成刷视频日报 |
| `social/register-workspace.mjs` | 把通道会话登记进独立工作区、解归档（停宿主时用） |
| `social/recover-archived.ps1` | 被误归档时的自动恢复（看门狗排的一次性任务调用） |
| `social/daily-report-guide.md` | 日报的写作要求 |
| `social/selfcheck.ps1` | 自检，查任务/端口/配置/进程 |
| `social/backup.ps1` | 每日备份登录态与配置 |
| `workspace/AGENTS.md` | 抖音会话的守则，会话 cwd 里读它 |
| `cordis.patch.yml` | 插件挂载条目（工具 / 面板 / 会话桥） |
| `docs/` | 架构与维护说明 |

运行时生成、不进仓库：`config.json`、`state.json`、`browse-log.jsonl`、`data/`、`reports/`、`backups/`、`social/channels.json`、`social/sessions.json`。

## 行为约定

- **社交优先于内容**：有消息进来时写 `interrupt.flag`，守卫 5 秒内关掉管家浏览器让路。
- **浏览器用完就关**：到每日上限、出时段、我主动收工、或有消息打断，都会关掉管家 Edge。
- **日报**：刷满当日上限时生成，或每天 23:59 兜底生成。口语化日记体，不是流水账。

## 已知限制

- 真 @ 某人在评论里做不到（需要下拉选人），只支持纯文本 `@昵称`
- 评论的楼中楼回复没有实现
- 视觉模型打分靠解析文本里的「评分：X/10」，自定义提示词请保留这个格式
- 依赖第三方库 [douyin-im](https://www.npmjs.com/package/douyin-im)，其登录与部分接口尚未经过大规模真实账号验收


详细的分层、数据流、隔离机制见 [docs/architecture.md](docs/architecture.md)。

## 自检与备份

```bash
powershell -ExecutionPolicy Bypass -File social\selfcheck.ps1
```

检查计划任务指向、端口、配置、登录态、依赖、进程。
每天 04:00 自动备份 `data/` + `config.json` + `social/sessions.json` 到 `backups/`，保留 7 份。

## 依赖与平台

- **社交模块**：只需要 `douyin-im`（已写在 dependencies，`npm i` 自动装）。**不需要浏览器**。
- **内容模块**：需要另外安装 [star-browser](https://github.com/) 插件（提供 9443 管家 + CDP），它负责真正驱动浏览器。
- **守卫 / 看门狗 / 日报定时**：`social/*.ps1` 是 Windows PowerShell 脚本；非 Windows 平台请自行用 cron/systemd 替代，
  或只跑社交模块（它不依赖这些脚本）。
- Node ≥ 20（`douyin-im` 要求 22.5+，社交模块请用 Node 22.5 以上）。

## 首次启动会做什么

1. `config.json` 不存在 → 自动写入一份全默认配置（空密钥、空白名单、上限 60 分钟、自动互动关闭）
2. `data/` 不存在 → 自动创建，首次需要扫码或短信登录抖音
3. `social/channels.json` 在桥登录成功后自动导出（群/好友清单，给白名单勾选用）

## License

MIT