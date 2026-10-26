# CHANGELOG

## 未发布

- 修：`social/register-workspace` 重写——登记工作区的逻辑抽成独立 `register-workspace.mjs`，参数化（`--path/--title/--sessions/--unarchive/--dsh-home/--dry-run`），并修掉路径被写成双反斜杠导致工作区指向不存在目录的 bug；`.ps1` 退化成「停 DSH → 跑脚本 → 起 DSH」的薄壳
- 改：`session-bridge.mjs` 空回复的报错带上 `reason.kind`（blocked / error / completed），不再一律说"可能只有工具调用"
- 文档：维护手册补「消息进来了只回兜底话术」的排查路径（归档闸门 / 上下文超限 / 只有工具调用）

## 0.5.0

- 内容模块：推荐流、搜索、评估、点赞/收藏/评论、转发、快捷键、收工
- 社交模块：douyin-im 收发私信/群、白名单、通道开关、触发方式、表情/卡片
- 会话持久：`agents.resume` 优先，重启不换会话
- 三页设置面板，保存即时生效
- 守卫：限额 / 时段 / 命中即关浏览器，`reason=done|cap|window|interrupt`
- 日报：上限触发 + 23:59 兜底，日记体
- 开源：路径全相对化，无个人信息，`github:` 一行安装