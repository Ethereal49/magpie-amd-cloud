// 从 TokenLab 响应里提取 points 消耗并按账号持久化累计（本地预估）。
//
// TokenLab 的 OpenAI 响应在 usage 里带一个非标字段 cost（本次请求消耗的 pts，
// 2026-11-13 实测与目录价逐位吻合）。magpie 网关不认识这个字段（usage 行的
// cost 只按 models.dev 目录价算，amd-cloud-lab 无目录价 → unpriced），所以
// 插件自己记账：loader 的 fetch 从响应体里抓 cost，写入 magpie 配置目录下的
// JSON 账本（跨宿主进程共享——桌面 app、CLI、TUI 各自的插件宿主都读写同一份），
// auth.usage 汇总成「本地预估已用」窗口。
//
// 已知局限（README 同步写明）：
// - 计数从账本建立（插件首次记录）起算，之前的消耗不包含；
// - 记账请求后异步写盘，极小概率在写盘瞬间掉电丢失最后一笔；
// - 这是本地预估：实际余额与明细以 TokenLab 个人页（Points history）为准。

import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs"
import { join } from "node:path"

// 宿主启动时由插件函数把配置目录注入进来（见 index.mjs）。
let ledgerPath = null

function defaultMagpieDir() {
  // magpie 的配置目录：Windows %USERPROFILE%\.config\magpie，类 Unix 同路径（XDG 兼容）。
  // 插件函数拿到 directory 时会覆盖这个兜底。
  return process.env.MAGPIE_CONFIG_DIR || join(process.env.USERPROFILE || process.env.HOME || "", ".config", "magpie")
}

export function setLedgerDir(dir) {
  if (dir) ledgerPath = join(dir, "magpie-amd-cloud-points.json")
  // 传 null/空时不清空已有路径（避免并发钩子误清）
}

function ensureLedgerPath() {
  if (!ledgerPath) ledgerPath = join(defaultMagpieDir(), "magpie-amd-cloud-points.json")
  return ledgerPath
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function readLedger() {
  const p = ensureLedgerPath()
  try {
    if (!existsSync(p)) return { accounts: {} }
    const j = JSON.parse(readFileSync(p, "utf8"))
    if (j && typeof j === "object" && j.accounts) return j
    return { accounts: {} }
  } catch {
    // 损坏/半写的账本：从空开始（预估口径，宁少勿多）
    return { accounts: {} }
  }
}

function writeLedger(data) {
  const p = ensureLedgerPath()
  try {
    const tmp = `${p}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(data))
    renameSync(tmp, p) // 原子替换，避免半写
  } catch {
    // 写失败不阻塞请求；下次请求再试
  }
}

// 记一笔。accountKey 用 key 本身（多账号各记各的）；并发安全靠「读-改-写 + 原子替换」，
// 同进程内 Bun/Node 的模块单例使 fetch 回调串行到达，跨进程由 rename 原子性兜底。
export function recordCost(accountKey, model, cost) {
  const c = num(cost)
  if (!accountKey || c == null || c <= 0) return false
  const data = readLedger()
  const a = (data.accounts[accountKey] ??= {
    total: 0,
    calls: 0,
    startedAt: new Date().toISOString(),
    byModel: {},
  })
  a.total = Math.round((a.total + c) * 1e12) / 1e12
  a.calls += 1
  if (model) a.byModel[model] = Math.round(((a.byModel[model] ?? 0) + c) * 1e12) / 1e12
  a.lastAt = new Date().toISOString()
  writeLedger(data)
  return true
}

export function spentFor(accountKey) {
  return readLedger().accounts[accountKey] ?? null
}

// 从 chat completions 响应体（JSON 已解析）里抓 usage.cost。
export function costOfResponse(body) {
  const c = num(body?.usage?.cost)
  return c != null && c > 0 ? c : null
}

// 从 SSE 流的原始 chunk 文本里抓 "cost":<num>（usage 在最后一个 chunk，
// 对整段缓冲取最后一个匹配）。
export function costOfStreamText(text) {
  if (!text) return null
  let last = null
  let m
  const re = /"cost"\s*:\s*([0-9.]+(?:[eE][+-]?[0-9]+)?)/g
  while ((m = re.exec(text))) last = m
  if (!last) return null
  const c = num(last[1])
  return c != null && c > 0 ? c : null
}

// usage 钩子的返回值组装：本地预估窗口，标注清楚数据来源与局限。
export function estimateWindow(accountKey, { limitPts = 10 } = {}) {
  const s = spentFor(accountKey)
  const note = "本地预估：插件自 TokenLab 响应 usage.cost 累计，不含装插件前的消耗；实际余额与明细以个人页为准"
  if (!s || s.total <= 0) {
    return { plan: "AMD Cloud Lab", note, windows: [] }
  }
  const top = Object.entries(s.byModel)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, pts]) => `${id} ${pts.toFixed(6)}`)
    .join(" · ")
  return {
    plan: "AMD Cloud Lab",
    note: `${note}（自 ${s.startedAt} 起 ${s.calls} 次请求${top ? "；Top: " + top : ""}）`,
    windows: [
      {
        name: "本地预估已用（30 天 10 pts）",
        used: Math.min(99.9, Math.round((s.total / limitPts) * 10000) / 100),
        display: `${s.total.toFixed(6)} / ${limitPts} pts`,
        amount: s.total,
        limit: limitPts,
        unit: "pts",
      },
    ],
  }
}
