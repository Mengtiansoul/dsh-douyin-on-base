#!/usr/bin/env node
/**
 * register-workspace.mjs — 把一条通道的会话登记进 DSH 独立工作区，并确保它们没被归档。
 *
 * 为什么需要它：
 *   1. DSH 的工作区是「注册表」不是目录——{DSH_HOME}/storages/workspace.json 的
 *      global.workspaceIds + tables.workspaces 里没有记录，光建目录侧栏也不会出现。
 *   2. 归档的会话会被 ArchivedSessionGate 在 agent/pre-step 直接拒掉，
 *      表现为 turn/end reason=blocked、一条 assistant 消息都没有，
 *      上层桥只能回兜底话术（"这一轮没有产出文本"）。
 *
 * 用法（**必须在 DSH 停止时运行**，否则运行中的宿主会把内存状态写回来覆盖）：
 *   node social/register-workspace.mjs --path "D:\Deepseek-Harness\Social\douyin" --title douyin \
 *        --sessions douyin-ed84d0ea187f-188v,douyin-54e0b7b050d5-d947 \
 *        --unarchive douyin-9707c5b1e2f1-yfsu
 *
 * 参数：
 *   --path      工作区目录（必填，会话首帧 cwd 必须等于它）
 *   --title     侧栏显示名（缺省取目录名）
 *   --sessions  逗号分隔，要挂进这个工作区的 sessionId
 *   --unarchive 逗号分隔，只解除归档、不改归属的 sessionId（cwd 不在该工作区下时用这个）
 *   --dsh-home  缺省 $DSH_HOME，再缺省 %USERPROFILE%\.dsh
 *   --port      宿主端口（默认 3080），用来检查宿主是否还活着
 *   --force     宿主在跑也照改（不推荐）
 *   --dry-run   只打印将要做的改动
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

function args(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[k] = true;
    else { out[k] = next; i++; }
  }
  return out;
}

const A = args(process.argv);
const dshHome = A["dsh-home"] || process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const wsFile = path.join(dshHome, "storages", "workspace.json");
const port = Number(A.port || process.env.DSH_PORT || 3080);
const list = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
// 折叠任意多个连续反斜杠（历史版本有写坏成双反斜杠的），比较时再忽略大小写
const canonical = (p) => String(p || "").replace(/\\{2,}/g, "\\");
const keyOf = (p) => canonical(p).toLowerCase();

const targetPath = A.path ? canonical(A.path) : "";
const sessions = list(A.sessions);
const unarchive = [...new Set([...sessions, ...list(A.unarchive)])];
const title = A.title || (targetPath ? path.basename(targetPath) : "");

if (!targetPath && !unarchive.length) {
  console.error("缺少参数：至少给 --path 或 --unarchive");
  process.exit(2);
}
if (!fs.existsSync(wsFile)) {
  console.error("找不到 " + wsFile + "（用 --dsh-home 指定 DSH_HOME）");
  process.exit(2);
}

// 宿主在跑就别改：它会用内存状态覆盖文件
if (!A.force && !A["dry-run"]) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    if (res) {
      console.error(`宿主在 ${port} 端口还有响应，先停掉 DSH 再跑（或加 --force 自担风险）`);
      process.exit(3);
    }
  } catch {
    /* 连不上 = 没在跑，正常 */
  }
}

const raw = fs.readFileSync(wsFile, "utf8");
const j = JSON.parse(raw);
const dry = !!A["dry-run"];
const changes = [];

// ① 工作区（按规范化 path 找，兼容历史上写坏的双反斜杠）
if (targetPath) {
  let wsId = Object.keys(j.tables.workspaces).find((id) => keyOf(j.tables.workspaces[id].path) === keyOf(targetPath));
  if (wsId) {
    const ws = j.tables.workspaces[wsId];
    if (ws.path !== targetPath) { changes.push(`workspace path: ${JSON.stringify(ws.path)} -> ${JSON.stringify(targetPath)}`); ws.path = targetPath; }
    if (ws.title !== title) { changes.push(`workspace title: ${JSON.stringify(ws.title)} -> ${JSON.stringify(title)}`); ws.title = title; }
    for (const s of sessions) if (!ws.sessionIds.includes(s)) { ws.sessionIds.push(s); changes.push(`attach ${s}`); }
    ws.updatedAt = new Date().toISOString();
    console.log("workspace:", wsId);
  } else {
    wsId = crypto.randomUUID();
    j.tables.workspaces[wsId] = { path: targetPath, title, sessionIds: [...sessions], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    j.global.workspaceIds.push(wsId);
    changes.push(`workspace created ${wsId} (${targetPath})`);
    console.log("workspace created:", wsId);
  }
}

// ② 解归档
const before = j.global.archivedSessionIds.length;
const removed = j.global.archivedSessionIds.filter((id) => unarchive.includes(id));
j.global.archivedSessionIds = j.global.archivedSessionIds.filter((id) => !unarchive.includes(id));
if (removed.length) changes.push(`unarchive: ${removed.join(", ")} (${before} -> ${j.global.archivedSessionIds.length})`);

if (!changes.length) {
  console.log("没有需要改的（已是目标状态）");
  process.exit(0);
}
console.log(changes.map((c) => "  · " + c).join("\n"));

if (dry) {
  console.log("[dry-run] 未写入");
  process.exit(0);
}

const bak = `${wsFile}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
fs.copyFileSync(wsFile, bak);
fs.writeFileSync(wsFile, JSON.stringify(j, null, 2), { encoding: "utf8" });

// 回读校验
const back = JSON.parse(fs.readFileSync(wsFile, "utf8"));
const okWs = !targetPath || Object.values(back.tables.workspaces).some((w) => keyOf(w.path) === keyOf(targetPath) && sessions.every((s) => w.sessionIds.includes(s)));
const okArch = unarchive.every((s) => !back.global.archivedSessionIds.includes(s));
const bom = fs.readFileSync(wsFile).subarray(0, 3).toString("hex") === "efbbbf";
console.log(`backup: ${bak}`);
console.log(`verify: workspace=${okWs} unarchive=${okArch} bom=${bom}`);
process.exit(okWs && okArch && !bom ? 0 : 2);
