// lib/config.js —— 统一配置管理（默认值 + 落盘 + 校验）
//
// 设计原则：
//   ① 所有可调参数集中在这里，不散落各处
//   ② 默认值写死在此，运行时从 settings.json 覆盖
//   ③ 每组参数带范围校验，防止用户填出灾难值
//   ④ 面板读写都走这里，保证"面板改的 = 实际生效的"

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const MIN = 60 * 1000
const HOUR = 60 * MIN

/* ═══════════════════════════════════════════════════════════════════
   参数定义（含类型、范围、说明）
   ═══════════════════════════════════════════════════════════════════ */

export const SCHEMA = {
  /* ── 记忆注入 ── */
  inject: {
    label: '提示词注入',
    desc: '每轮对话把相关记忆注入提示词。关闭可省 token，但 AI 不再"记得"追问。',
    fields: {
      enabled: { type: 'bool', def: false, label: '启用注入' },
      budgetChars: {
        type: 'num', def: 1200, min: 200, max: 8000, step: 100,
        label: '注入预算字符', unit: '字', desc: '超长会被截断',
      },
      recallK: {
        type: 'num', def: 5, min: 1, max: 20, step: 1,
        label: '检索条数', unit: '条', desc: '每次注入最多几条记忆',
      },
      minScore: {
        type: 'num', def: 0.25, min: 0, max: 1, step: 0.05,
        label: '最低相关分', desc: '低于这个分不注入',
      },
    },
  },

  /* ── 记忆库 ── */
  memory: {
    label: '记忆库',
    desc: '写入与检索的行为参数。',
    fields: {
      maxTextLen: {
        type: 'num', def: 400, min: 50, max: 4000, step: 50,
        label: '正文长度上限', unit: '字',
      },
      mergeSimilar: {
        type: 'num', def: 0.75, min: 0.5, max: 1, step: 0.01,
        label: '相似合并阈值', desc: 'fact/lesson 超过此相似度会合并',
      },
      dedupeKinds: {
        type: 'list', def: ['fact', 'lesson'],
        label: '参与去重的类型',
        desc: '哪些类型的记忆会被相似合并（episode 通常不参与）',
        options: ['episode', 'fact', 'reflection', 'skill', 'lesson', 'procedural',
          'emotion_event', 'plan', 'preference', 'relationship', 'profile', 'insight'],
      },
    },
  },

  /* ── 睡眠 ── */
  sleep: {
    label: '睡眠系统',
    desc: '四态状态机的阈值与时长。改完立即生效。',
    fields: {
      enabled: { type: 'bool', def: true, label: '启用自动睡眠' },
      fatigueSleep: {
        type: 'num', def: 70, min: 30, max: 100, step: 5,
        label: '入睡疲惫阈值', unit: '分', desc: '疲惫值达到这个分数就想睡',
      },
      fatigueSleepMin: {
        type: 'num', def: 45, min: 10, max: 90, step: 5,
        label: '窗口内入睡阈值', unit: '分', desc: '在作息窗口内时，疲惫到这条线也会睡（比主阈值宽容）',
      },
      fatigueWake: {
        type: 'num', def: 25, min: 0, max: 60, step: 5,
        label: '醒来疲惫阈值', unit: '分', desc: '疲惫降到这条线以下自然醒',
      },
      sleepDebtWake: {
        type: 'num', def: 40, min: 0, max: 80, step: 5,
        label: '睡眠债高时醒来阈值', unit: '分', desc: '睡眠债高的人放宽醒来阈值，避免永远醒不了',
      },

      idleMinutes: {
        type: 'num', def: 240, min: 30, max: 1440, step: 15,
        label: '空闲入睡', unit: '分钟', desc: '多久没互动开始准备入睡',
      },
      preparingMinMin: {
        type: 'num', def: 15, min: 1, max: 120, step: 1,
        label: '准备入睡最短', unit: '分钟',
      },
      preparingMaxMin: {
        type: 'num', def: 45, min: 5, max: 180, step: 5,
        label: '准备入睡最长', unit: '分钟', desc: '超过强制进入沉睡',
      },

      minSleepMin: {
        type: 'num', def: 45, min: 10, max: 240, step: 5,
        label: '最短睡眠', unit: '分钟', desc: '睡满这个时长才可能醒',
      },
      normalSleepMin: {
        type: 'num', def: 90, min: 30, max: 480, step: 15,
        label: '常规睡眠', unit: '分钟', desc: '达到这个时长通常会醒',
      },
      maxSleepH: {
        type: 'num', def: 12, min: 1, max: 24, step: 1,
        label: '最长睡眠（安全网）', unit: '小时', desc: '超过强制唤醒，防死锁',
      },

      recoveringMinMin: {
        type: 'num', def: 3, min: 1, max: 30, step: 1,
        label: '将醒最短', unit: '分钟', desc: '让"刚睡醒"的迷糊有实体感',
      },
      recoveringMaxMin: {
        type: 'num', def: 40, min: 5, max: 120, step: 5,
        label: '将醒最长', unit: '分钟', desc: '超时强制回清醒 —— 这是防死锁的关键',
      },

      manualOverrideMin: {
        type: 'num', def: 120, min: 0, max: 480, step: 15,
        label: '手动覆盖保护期', unit: '分钟', desc: '手动去睡/叫醒后，自动判断暂停这么久',
      },

      /* 疲惫值速率 */
      awakeRate: {
        type: 'num', def: 6, min: 1, max: 30, step: 1,
        label: '清醒累积速率', unit: '分/小时', desc: '清醒时疲惫值每小时涨多少',
      },
      awakeFreshMul: {
        type: 'num', def: 0.55, min: 0.1, max: 1, step: 0.05,
        label: '刚醒折扣', desc: '刚醒 2 小时内的速率倍率',
      },
      awakeRushAfterH: {
        type: 'num', def: 12, min: 4, max: 24, step: 1,
        label: '连续清醒加速起点', unit: '小时', desc: '超过这个时长后速率开始上升',
      },
      nightMul: {
        type: 'num', def: 1.35, min: 1, max: 3, step: 0.05,
        label: '夜间倍率', desc: '夜间（22:00-06:00）的速率倍率',
      },
      sleepRateFast: {
        type: 'num', def: 18, min: 1, max: 40, step: 1,
        label: '深睡恢复速率', unit: '分/小时', desc: '前 1.5 小时恢复最快',
      },
      sleepRateMid: {
        type: 'num', def: 12, min: 1, max: 30, step: 1,
        label: '中段恢复速率', unit: '分/小时',
      },
      sleepRateSlow: {
        type: 'num', def: 6, min: 1, max: 20, step: 1,
        label: '长睡恢复速率', unit: '分/小时', desc: '超过 5 小时后恢复变慢',
      },

      tickSeconds: {
        type: 'num', def: 30, min: 5, max: 300, step: 5,
        label: '检查间隔', unit: '秒', desc: '多久检查一次状态（不是时钟本身）',
      },
      preferFixedTime: { type: 'bool', def: false, label: '固定时间优先', desc: '开启后进作息窗口就准备睡，不再只看疲惫值' },
    },
  },

  /* ── 星图 ── */
  graph: {
    label: '星图',
    desc: '3D 记忆宇宙的视觉与性能参数。',
    fields: {
      extent: { type: 'num', def: 470, min: 200, max: 900, step: 10, label: '布局尺度', desc: '星团分布的空间半径' },
      rotateSpeed: {
        type: 'num', def: 0.00008, min: 0.00001, max: 0.001, step: 0.00001,
        label: '自动旋转速度', desc: '越小越慢',
      },
      quality: {
        type: 'enum', def: 'auto', options: ['auto', 'high', 'medium', 'low'],
        label: '画质', desc: 'auto 会按设备与帧率自动调',
      },
      bloom: { type: 'bool', def: true, label: '光晕（Bloom）', desc: '关闭可提升低端设备帧率' },
      maxLabelCount: {
        type: 'num', def: 26, min: 0, max: 60, step: 2,
        label: '记忆标签上限', unit: '个', desc: '拉近时最多显示几个记忆名',
      },
      neighborLinks: {
        type: 'num', def: 90, min: 0, max: 300, step: 10,
        label: '弱连线上限', unit: '条', desc: '星团之间最多画几条关联线',
      },
      dustCount: {
        type: 'num', def: 2000, min: 0, max: 6000, step: 100,
        label: '远景星尘', unit: '个', desc: '背景零散粒子数量',
      },
    },
  },

  /* ── 面板 ── */
  panel: {
    label: '面板',
    desc: '界面行为。',
    fields: {
      roleName: { type: 'text', def: '', label: '角色名', desc: '留空则自动探测（桥接 > 角色卡 > 兜底）' },
      memPageSize: {
        type: 'num', def: 200, min: 20, max: 1000, step: 20,
        label: '记忆列表每页', unit: '条',
      },
      refreshSeconds: {
        type: 'num', def: 20, min: 5, max: 300, step: 5,
        label: '睡眠页刷新间隔', unit: '秒',
      },
      showNoise: { type: 'bool', def: false, label: '显示噪声记忆', desc: '系统提示词残留等低质量条目' },
    },
  },

  /* ── 外部集成 ── */
  external: {
    label: '外部服务',
    desc: '均为开源项目，可选接入。留空则对应页面显示"未连接"。',
    fields: {
      moodEnabled: { type: 'bool', def: true, label: '启用 dsh-mood 情绪引擎', desc: '心情/日记/经验卡/品味四页' },
      bridgeEnabled: { type: 'bool', def: true, label: '启用桥接集成', desc: '角色卡/消费两页' },
      bridgeConfigPath: { type: 'text', def: '', label: '桥接 config.json 路径' },
      bridgePort: { type: 'num', def: 3100, min: 1, max: 65535, step: 1, label: '桥接控制台端口' },
      bridgeToken: { type: 'text', def: '', label: '桥接控制台令牌' },
      bridgeDir: { type: 'text', def: '', label: '桥接目录', desc: '用于角色卡文件名探测' },
    },
  },
}

/* ═══════════════════════════════════════════════════════════════════
   读取 / 写入
   ═══════════════════════════════════════════════════════════════════ */

/** 从 SCHEMA 生成默认值对象（扁平化，方便落盘与传输） */
export function buildDefaults() {
  const out = {}
  for (const groupK of Object.keys(SCHEMA)) {
    const g = SCHEMA[groupK]
    for (const fieldK of Object.keys(g.fields)) {
      out[groupK + '.' + fieldK] = g.fields[fieldK].def
    }
  }
  return out
}

/** 按字段定义校验并裁剪一个值；不合法就返回默认 */
function clampField(def, v) {
  const f = def
  if (!f) return v

  if (f.type === 'bool') return (v === true || v === 'true' || v === 1) ? true : false

  if (f.type === 'num') {
    let n = Number(v)
    if (!isFinite(n)) return f.def
    if (f.min != null && n < f.min) n = f.min
    if (f.max != null && n > f.max) n = f.max
    return n
  }

  if (f.type === 'enum') {
    return f.options.includes(v) ? v : f.def
  }

  if (f.type === 'list') {
    if (!Array.isArray(v)) return f.def
    return v.filter((x) => f.options.includes(x))
  }

  if (f.type === 'text') {
    return String(v == null ? '' : v).slice(0, 400)
  }

  return v
}

export function createConfigStore({ dataDir, log = () => {} } = {}) {
  const file = join(dataDir, 'settings.json')
  let values = buildDefaults()
  let loadedFrom = 'defaults'

  function load() {
    try {
      if (!existsSync(file)) return
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      values = Object.assign({}, buildDefaults(), raw.values || raw)
      // 逐项校验（防止手改文件写坏）
      for (const key of Object.keys(values)) {
        const [g, f] = key.split('.')
        const def = SCHEMA[g] && SCHEMA[g].fields[f]
        if (def) values[key] = clampField(def, values[key])
      }
      loadedFrom = 'file'
    } catch (e) {
      log('settings.json 读取失败，用默认值：' + (e?.message ?? e))
    }
  }

  function save() {
    try {
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(file, JSON.stringify({ savedAt: Date.now(), values }, null, 2))
    } catch (e) {
      log('settings.json 写入失败：' + (e?.message ?? e))
    }
  }

  load()

  return {
    /** 取一个值，"group.field" 形式 */
    get(key) {
      return values[key]
    },

    /** 取一整组 */
    group(name) {
      const out = {}
      const g = SCHEMA[name]
      if (!g) return out
      for (const f of Object.keys(g.fields)) out[f] = values[name + '.' + f]
      return out
    },

    /** 全部值（面板展示用） */
    all() {
      return Object.assign({}, values)
    },

    /** 带 schema 的完整定义（面板渲染表单用） */
    schema() {
      return SCHEMA
    },

    /** 批量更新（校验后落盘） */
    update(patch) {
      const applied = []
      const rejected = []
      for (const key of Object.keys(patch || {})) {
        const parts = key.split('.')
        if (parts.length !== 2) { rejected.push(key); continue }
        const [g, f] = parts
        const def = SCHEMA[g] && SCHEMA[g].fields[f]
        if (!def) { rejected.push(key); continue }
        values[key] = clampField(def, patch[key])
        applied.push(key)
      }
      if (applied.length) save()
      return { applied, rejected, values: Object.assign({}, values) }
    },

    /** 恢复默认 */
    reset(groupName) {
      if (groupName && SCHEMA[groupName]) {
        for (const f of Object.keys(SCHEMA[groupName].fields)) {
          values[groupName + '.' + f] = SCHEMA[groupName].fields[f].def
        }
      } else {
        values = buildDefaults()
      }
      save()
      return Object.assign({}, values)
    },

    /** 从环境变量初始化（首次运行时把 env 的值写进 settings） */
    seedFromEnv() {
      const map = {
        'sleep.enabled': process.env.DSH_MIND_SLEEP_ENABLED,
        'inject.enabled': process.env.DSH_MIND_INJECT,
        'inject.budgetChars': process.env.DSH_MIND_INJECT_BUDGET,
        'external.bridgeConfigPath': process.env.QQ_BRIDGE_CONFIG,
        'external.bridgePort': process.env.QQ_BRIDGE_PORT,
        'external.bridgeToken': process.env.QQ_BRIDGE_TOKEN,
        'external.bridgeDir': process.env.QQ_BRIDGE_DIR,
        'panel.roleName': process.env.DSH_MIND_ROLE_NAME,
      }
      let changed = false
      for (const k of Object.keys(map)) {
        const v = map[k]
        if (v == null || v === '') continue
        const [g, f] = k.split('.')
        const def = SCHEMA[g] && SCHEMA[g].fields[f]
        if (!def) continue
        const test = def.type === 'bool' ? (v === '1' || v === 'true') : v
        const clamped = clampField(def, test)
        if (values[k] !== clamped) { values[k] = clamped; changed = true }
      }
      if (changed) save()
    },

    file,
    loadedFrom() { return loadedFrom },
  }
}
