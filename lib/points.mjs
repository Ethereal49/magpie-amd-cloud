// 从 TokenLab 响应里提取 points 消耗并按账号累计（本地预估）。
//
// TokenLab 的 OpenAI 响应在 usage 里带一个非标字段 cost（本次请求消耗的 pts，
// 2026-11-13 实测与目录价逐位吻合）。magpie 网关不认识这个字段（usage 行的
// cost 只按 models.dev 目录价算，amd-cloud-lab 无目录价 → unpriced），所以
// 插件自己记账：loader 的 fetch 从响应体里抓 cost，按账号写入宿主状态，
// auth.usage 汇总成「本地预估已用」窗口。
//
// 已知局限（README 也有写）：
// - 流式响应里 usage 出现在最后一个 chunk，从流里同样能抓到；
// - 计数从本插件首次记录起算，装插件之前发生的消耗不包含；
// - magpie 换宿主/重装不会丢（状态随账号存 plugin-auth 同款存储），
//   但以控制台 Points history 为准——这里只是本地预估。

// 按账号的累计状态：{ total, byModel: { id: pts }, startedAt }
// 状态存进 auth 对象自己的字段（magpie 会把 loader/usage 看到的同一 auth 对象
// 的变更经 client.auth.set 持久化——不行，auth 变更只在 login/refresh 时落盘。
// 改用模块级 Map：宿主进程内累计，重启清零；usage 文案里注明是进程内累计。）

const spent = new Map() // providerAccount key string → { total, byModel, startedAt }

export function recordCost(accountKey, model, cost, tokens) {
  if (!Number.isFinite(cost) || cost <= 0) return false
  let s = spent.get(accountKey)
  if (!s) {
    s = { total: 0, byModel: {}, calls: 0, startedAt: new Date().toISOString() }
    spent.set(accountKey, s)
  }
  s.total += cost
  s.calls += 1
  if (model) s.byModel[model] = (s.byModel[model] ?? 0) + cost
  return true
}

export function spentFor(accountKey) {
  return spent.get(accountKey) ?? null
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// 从 chat completions 响应体（JSON 已解析）里抓 usage.cost。
export function costOfResponse(body) {
  const c = num(body?.usage?.cost)
  return c != null && c > 0 ? c : null
}

// 从 SSE 流的原始 chunk 文本里抓 "cost":<num>（usage 在最后一个 chunk，
// 逐块扫描已收到的缓冲即可，正则容忍空格与数字格式 1.2e-7）。
const COST_RE = /"cost"\s*:\s*([0-9.]+(?:[eE][+-]?[0-9]+)?)/

export function costOfStreamText(text) {
  // 只匹配 usage 对象里的 cost：取最后一个匹配（SSE 逐 chunk 累计缓冲，
  // usage 的 cost 是全流唯一/最后一个）
  let last = null
  let m
  const re = new RegExp(COST_RE.source, "g")
  while ((m = re.exec(text))) last = m
  if (!last) return null
  const c = num(last[1])
  return c != null && c > 0 ? c : null
}

// usage 钩子的返回值组装：本地预估窗口（span 与接入期一致按 30 天），标注清楚。
export function estimateWindow(accountKey, { limitPts = 10 } = {}) {
  const s = spentFor(accountKey)
  const note =
    "本地预估：插件记录的累计 points，不含装插件前的消耗；实际以 TokenLab 个人页为准"
  if (!s || s.total <= 0) {
    return { plan: "AMD Cloud Lab", note, windows: [] }
  }
  const models = Object.entries(s.byModel)
    .sort((a, b) => b[1] - a[1])
    .map(([id, pts]) => `${id} ${pts.toFixed(6)}`)
    .slice(0, 5)
    .join(" · ")
  return {
    plan: "AMD Cloud Lab",
    note: `${note}（自 ${s.startedAt} 起 ${s.calls} 次请求${models ? "；Top: " + models : ""}）`,
    windows: [
      {
        name: "本地预估已用（30 天 10 pts）",
        used: Math.min(99.9, Math.round((s.total / limitPts) * 10000) / 100),
        resetsAt: undefined,
        display: `${s.total.toFixed(6)} / ${limitPts} pts`,
        amount: s.total,
        limit: limitPts,
        unit: "pts",
      },
    ],
  }
}
