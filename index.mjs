// magpie-amd-cloud：把 AMD 的两个免费共享模型 API 站点变成 magpie 供应商。
//
// 入口导出两个插件函数——magpie 会把入口文件的每个导出函数都当成插件调用，
// 辅助函数全部放在 lib/ 里（见插件开发文档「模块导出什么」）：
//   AmdCloudPlugin()    → 供应商 `amd-cloud`     国内站 Radeon Cloud（developer.amd.com.cn）
//   AmdCloudLabPlugin() → 供应商 `amd-cloud-lab` 国际站 TokenLab（api.tokenlab.amd.com）
//
// 接入方式：agent 请求由 magpie 网关统一转成 chat completions（@ai-sdk/openai-compatible），
// 插件的 loader 提供 baseURL，鉴权头由 magpie 按 API key 登录自动补上
// （Authorization: Bearer …），我们只额外改写 User-Agent。
//
// 两站差异：
//   国内站：额度走 Model API 主机的 /v1/usage（滚动 24h 花费窗口，pts 点数口径）。
//   国际站：key 在 notebooks.amd.com/tokenlab 手动签发、30 天有效；无用量查询端点
//          （/v1/usage 等 2026-11-13 实测 404），额度只在控制台显示。

import {
  MODEL_API_BASE,
  LAB_MODEL_API_BASE,
  LAB_CONSOLE_URL,
  LAB_PROFILE_URL,
  PLUGIN_VERSION,
  USER_AGENT,
  fetchJSON,
} from "./lib/platform.mjs"
import { FALLBACK_MODELS, LAB_FALLBACK_MODELS, catalogToModels } from "./lib/catalog.mjs"
import { usageToMagpie } from "./lib/usage.mjs"

// 官方限流：每密钥 30 RPM / 8 并发（国内站文档）；账号 20 RPM。两站共用口径。
const MAX_CONCURRENCY = 8

// 两个供应商共享同一套钩子形状，只差 id / 展示名 / baseURL / 兜底表 / usage 实现 / key 形状。
function makePlugin({ provider, name, base, fallbacks, usage, keyPlaceholder = "rc-…" }) {
  return async function plugin() {
    return {
      // 供应商与静态兜底模型。用 ??= 以免覆盖用户在 plugins.json 里的同名配置。
      config: async (cfg) => {
        cfg.provider ??= {}
        cfg.provider[provider] ??= {
          name,
          npm: "@ai-sdk/openai-compatible", // chat completions
          api: base,
          models: fallbacks,
        }
      },

      auth: {
        provider,
        maxConcurrency: MAX_CONCURRENCY,
        methods: [{ type: "api", label: `${name} API key`, placeholder: keyPlaceholder }],
        // key 原样保存（不做 authorize）：无效 key 由首个请求的 401 触发 magpie 的账号标记。
        async loader(getAuth) {
          const auth = await getAuth()
          if (auth?.type !== "api") return {}
          return {
            baseURL: base,
            async fetch(input, init) {
              const headers = new Headers(init?.headers)
              headers.set("user-agent", USER_AGENT)
              return fetch(input, { ...init, headers })
            },
          }
        },
        usage,
      },

      // 每个账号的模型：运行时拉共享目录（官方要求不写死模型名），失败保留静态列表。
      provider: {
        id: provider,
        async models(providerModels, { auth } = {}) {
          if (auth?.type !== "api") return providerModels
          try {
            const res = await fetchJSON(`${base}/models`, auth.key)
            if (!res.ok) return providerModels
            return catalogToModels(res.data, providerModels)
          } catch {
            return providerModels
          }
        },
      },
    }
  }
}

export const AmdCloudPlugin = makePlugin({
  provider: "amd-cloud",
  name: "AMD Cloud",
  base: MODEL_API_BASE,
  fallbacks: FALLBACK_MODELS,
  // 国内站额度：滚动 24h 花费窗口（pts 口径），来自 Model API 主机的 /v1/usage。
  async usage(getAuth) {
    const auth = await getAuth()
    if (auth?.type !== "api") return { error: "尚未登录 AMD Cloud", windows: [] }
    const u = await fetchJSON(`${MODEL_API_BASE}/usage`, auth.key)
    if (!u.ok) {
      if (u.status === 401) {
        return { error: "AMD Cloud 密钥无效，请重新登录", windows: [] }
      }
      return {
        error:
          u.status === 0
            ? `AMD Cloud 不可达：${u.error}`
            : `AMD Cloud 用量查询失败（HTTP ${u.status}）`,
        windows: [],
      }
    }
    return usageToMagpie(u.data)
  },
})

export const AmdCloudLabPlugin = makePlugin({
  provider: "amd-cloud-lab",
  name: "AMD Cloud Lab",
  base: LAB_MODEL_API_BASE,
  fallbacks: LAB_FALLBACK_MODELS,
  keyPlaceholder: "tl-…",
  // 国际站没有用量端点（/v1/usage 404）；points 是 30 天周期总量（非每日重置），
  // 用量与续期（Extend by 15 days / Request more points）都在个人页操作。
  async usage() {
    return {
      plan: "AMD Cloud Lab",
      error: `Points（30 天周期总量）与续期请到个人页查看：${LAB_PROFILE_URL}`,
      windows: [],
    }
  },
})
