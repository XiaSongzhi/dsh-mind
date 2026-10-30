/**
 * 角色名自动探测
 *
 * 设计：名字不该写死。按可信度依次尝试：
 *   ① 面板手动配置（window.__DSH_MIND_NAME__ / localStorage）
 *   ② 桥接 /api/status 的 role 字段（当前正在用的角色）
 *   ③ 角色卡目录里最近修改的 .md 文件名
 *   ④ 环境变量 DSH_MIND_ROLE_NAME
 *   ⑤ 兜底：Memoryverse
 *
 * 探测在服务端起（能读文件、能转发请求），结果缓存到内存，
 * 面板通过 /state 拿到。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/* ═══════════════════════════════════════════════════════════════════
   探测逻辑
   ═══════════════════════════════════════════════════════════════════ */

const FALLBACK_NAME = 'Memoryverse'

export function createNameResolver({ log = () => {}, bridgeDir } = {}) {
  let cached = null
  let cachedAt = 0
  const TTL = 10 * 60 * 1000      // 10 分钟重新探测一次

  return {
    /** 同步版本：只查环境变量与本地文件，不发网络请求 */
    resolveLocal() {
      // ① 环境变量（最常见的手动配置方式）
      const env = process.env.DSH_MIND_ROLE_NAME
      if (env && env.trim()) return { name: env.trim(), source: 'env' }

      // ② 角色卡目录：取最近修改、且不是 .bak 的 .md
      const dir = bridgeDir || process.env.QQ_BRIDGE_DIR || ''
      if (dir) {
        const cards = join(dir, 'roles')
        if (existsSync(cards)) {
          try {
            const files = readdirSync(cards)
              .filter((f) => f.endsWith('.md') && !f.endsWith('.bak'))
              .map((f) => ({
                name: f.slice(0, -3),
                mtime: statSync(join(cards, f)).mtimeMs,
              }))
              .sort((a, b) => b.mtime - a.mtime)
            // 排除说明文件
            const picked = files.find((f) =>
              !/^readme$/i.test(f.name) && !/说明/.test(f.name))
            if (picked) return { name: picked.name, source: 'role-card' }
          } catch {}
        }
      }

      return null
    },

    /**
     * 异步版本：再加一步桥接 /api/status 查询（最准，因为那是"当前生效"的角色）
     * 失败时退回本地探测结果。
     */
    async resolve({ bridgeConfig } = {}) {
      const now = Date.now()
      if (cached && (now - cachedAt) < TTL) return cached

      // 环境变量优先级最高（用户显式指定）
      const env = process.env.DSH_MIND_ROLE_NAME
      if (env && env.trim()) {
        cached = { name: env.trim(), source: 'env' }
        cachedAt = now
        return cached
      }

      // 桥接状态：这是"当前正在生效"的角色名，最可信
      if (bridgeConfig && bridgeConfig.port && bridgeConfig.token) {
        try {
          const ac = new AbortController()
          const timer = setTimeout(() => { try { ac.abort() } catch {} }, 3000)
          timer.unref?.()
          const resp = await fetch('http://127.0.0.1:' + bridgeConfig.port + '/api/status', {
            headers: { 'x-console-token': bridgeConfig.token },
            signal: ac.signal,
          })
          clearTimeout(timer)
          if (resp.ok) {
            const j = await resp.json()
            const role = String(j.role || '').trim()
            if (role) {
              cached = { name: role, source: 'bridge' }
              cachedAt = now
              return cached
            }
          }
        } catch { /* 桥接不可用时走本地 */ }
      }

      // 角色卡目录
      const local = this.resolveLocal()
      if (local) {
        cached = local
        cachedAt = now
        return cached
      }

      cached = { name: FALLBACK_NAME, source: 'fallback' }
      cachedAt = now
      return cached
    },

    /** 清缓存（用户改名后强制重探） */
    invalidate() { cached = null; cachedAt = 0 },
  }
}
