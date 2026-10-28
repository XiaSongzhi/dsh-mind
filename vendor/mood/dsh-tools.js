// vendor/mood/dsh-tools.js —— @deepseek-ai/dsh-tools 的本地解析层
//
// 为什么存在：vendored mood/index.js 静态 import '@deepseek-ai/dsh-tools'。
// 在 DSH 宿主内，宿主的模块钩子会把这个 specifier 解析到内部实现——不需要本文件。
// 在离线测试/裸 Node 环境（没有宿主钩子）里，静态 import 会直接炸。
// 所以这里改成：优先动态加载真包；加载不到（离线）就退化为形状透传的 shim——
// 仅保证「工具定义能注册、execute 能跑」，不代表宿主的 schema 校验行为。
let mod = null
try {
  mod = await import('@deepseek-ai/dsh-tools')
} catch {
  mod = {
    defineTool(def) {
      // 最小透传：真实宿主会在这一步包参数 schema 与校验；离线下原样返回。
      return def
    },
  }
}

export const defineTool = mod.defineTool
