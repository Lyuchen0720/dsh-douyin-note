// lib/autopilot.mjs —— 「按频率自己发」：定时 + 自己写 + 随机配乐
// ============================================================================
// 设计（2026-11-23 使用者要的）：
//   ① 频率：每 N 小时一次，每天最多 M 条（N/M 都可改）。
//   ② 内容：调一次模型，按本插件包里的人设写标题/描述/话题/图片大字。
//   ③ 配乐：从音乐池里随机挑一个关键词，交给发布流程去搜。
//   ④ 闸门：`publish:false` 时只生成草稿（存 drafts/，能预览），
//            改成 `true` 才真的发。默认关。
// 频率与状态都落在 state.json 的 `auto` 字段里，重启后接着算。
// ============================================================================
import { writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ensureHome, homeDir } from './paths.mjs'
import { readState, writeState } from './state.mjs'
import { askDraft, loadPersona, DEFAULT_MUSIC_POOL } from './draft.mjs'
import { buildHtml, renderCard } from './render.mjs'
import { publishNote } from './note-publish.mjs'
import { openPage } from './chrome.mjs'

export const AUTO_DEFAULTS = {
  enabled: false,      // 总开关
  everyHours: 12,      // 每多少小时一条
  perDay: 2,           // 每天最多几条
  publish: false,      // true = 真发；false = 只出草稿
  musicPool: [...DEFAULT_MUSIC_POOL],
  nextRunAt: null,
  dayKey: null,
  dayCount: 0,
  lastRunAt: null,
  lastError: null,
}

const HOUR = 3600_000
const dayKeyOf = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function readAuto() {
  const state = readState()
  const auto = { ...AUTO_DEFAULTS, ...(state.auto && typeof state.auto === 'object' ? state.auto : {}) }
  if (!Array.isArray(auto.musicPool) || !auto.musicPool.length) auto.musicPool = [...DEFAULT_MUSIC_POOL]
  return auto
}

export function patchAuto(patch = {}) {
  const state = readState()
  const auto = { ...AUTO_DEFAULTS, ...(state.auto || {}) }
  const next = { ...auto, ...patch }
  if ('everyHours' in patch || 'enabled' in patch) {
    next.nextRunAt = next.enabled ? nextRunAtFrom(next, new Date()) : next.nextRunAt
  }
  next.updated_at = new Date().toISOString()
  writeState({ ...state, auto: next })
  return next
}

/** 下一次该跑的时间（带 ±12 分钟抖动，避免每天卡在同一秒） */
export function nextRunAtFrom(auto, from = new Date()) {
  const hours = Math.max(0.25, Number(auto.everyHours) || 12)
  const jitter = Math.round((Math.random() * 24 - 12) * 60_000)
  return new Date(from.getTime() + hours * HOUR + jitter).toISOString()
}

export function pickMusic(auto) {
  const pool = (Array.isArray(auto?.musicPool) ? auto.musicPool : []).filter(Boolean)
  if (!pool.length) return null
  return pool[Math.floor(Math.random() * pool.length)]
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function recentLines(limit = 4) {
  const state = readState()
  const list = Array.isArray(state.publishes) ? state.publishes : []
  return list
    .slice(0, limit)
    .map((r) => `- ${r.text || r.desc || r.title || '(没记下文案)'}`)
}

function briefOf(auto, now = new Date()) {
  const wd = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()]
  const hh = now.getHours()
  const period = hh < 5 ? '半夜' : hh < 11 ? '早上' : hh < 13 ? '中午' : hh < 18 ? '下午' : hh < 23 ? '晚上' : '深夜'
  const recent = recentLines()
  return [
    `现在是 ${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日（星期${wd}）${period} ${hh} 点多。`,
    recent.length ? `最近已经发过这些，别重复同一件事：\n${recent.join('\n')}` : '最近还没发过。',
    auto.publish ? '这次会直接发出去，写之前自己再确认一遍没有不该说的。' : '这次先出一张草稿给主人看，不用发。',
    '写一条吧。',
  ].join('\n\n')
}

/**
 * 生成（并可选发布）一条。
 * @param {object} opts { llm, route, persona, pluginDir, publish, reason, signal }
 */
export async function runOne(opts = {}) {
  const auto = readAuto()
  const publish = Boolean(opts.publish)
  const now = new Date()
  const dir = ensureHome()
  const draftsDir = join(dir, 'drafts')
  mkdirSync(draftsDir, { recursive: true })
  const name = `note-${stamp(now)}`
  const persona = opts.persona || loadPersona(opts.pluginDir || '')
  const music = pickMusic(auto)

  let draft
  try {
    draft = await askDraft({ llm: opts.llm, route: opts.route, persona, brief: briefOf({ ...auto, publish }, now), signal: opts.signal })
  } catch (e) {
    const err = `写稿失败：${e?.message || e}`
    patchAuto({ lastError: err })
    throw new Error(err)
  }

  // 渲染文字卡
  let image = null
  let page = null
  try {
    page = await openPage({ isolated: true })
    const html = buildHtml({ headline: draft.headline, subhead: draft.subhead, tags: draft.tags })
    image = await renderCard(page, { html, outPath: join(draftsDir, `${name}.png`) })
    writeFileSync(join(draftsDir, `${name}.json`), JSON.stringify({ at: now.toISOString(), draft, music }, null, 2), 'utf8')
  } catch (e) {
    throw new Error(`渲染图片失败：${e?.message || e}`)
  } finally {
    try { page?.close?.() } catch { /* 关不掉就算了 */ }
  }

  const record = {
    at: now.toISOString(),
    reason: opts.reason || (publish ? 'auto' : 'draft'),
    draft,
    image: image?.path || null,
    music,
    published: false,
    dry_run: !publish,
  }

  if (publish) {
    try {
      const res = await publishNote({
        images: [image.path],
        title: draft.title,
        desc: draft.desc,
        tags: draft.tags,
        music: music || undefined,
        visibility: 'public',
        confirm: true,
      })
      record.published = Boolean(res?.published)
      record.aweme_id = res?.aweme_id || null
      record.url = res?.url || null
      record.text = res?.text || null
      record.music_id = res?.music_id || null
      record.ok = res?.ok !== false
      record.stage = res?.stage || null
      record.error = res?.error || null
    } catch (e) {
      record.ok = false
      record.error = `${e?.stage ? `[${e.stage}] ` : ''}${e?.message || e}`
      patchAuto({ lastError: record.error })
      writeRun(record)
      throw e
    }
  } else {
    record.ok = true
    record.text = [draft.title, draft.desc].filter(Boolean).join('。')
  }

  writeRun(record)
  patchAuto({
    lastRunAt: now.toISOString(),
    lastError: record.ok ? null : record.error || null,
    dayKey: dayKeyOf(now),
    // 只有真发出去才占当天名额；草稿不占（但 nextRunAt 照样往后排，不会连发）
    dayCount: (auto.dayKey === dayKeyOf(now) ? auto.dayCount : 0) + (record.published ? 1 : 0),
    nextRunAt: nextRunAtFrom(auto, now),
  })
  return record
}

function writeRun(record) {
  const state = readState()
  const auto = { ...AUTO_DEFAULTS, ...(state.auto || {}) }
  const runs = Array.isArray(auto.runs) ? auto.runs : []
  writeState({ ...state, auto: { ...auto, runs: [record, ...runs].slice(0, 20) } })
}

/** 到点了没：返回 {due, why} */
export function dueCheck(auto, now = new Date()) {
  if (!auto.enabled) return { due: false, why: '未开启' }
  const dk = dayKeyOf(now)
  const count = auto.dayKey === dk ? Number(auto.dayCount || 0) : 0
  const perDay = Number(auto.perDay || 0)
  if (count >= perDay) return { due: false, why: `今天已发 ${count} 条（上限 ${perDay}）` }
  // 跨天不会「零点补发」：仍然要等 nextRunAt 到点
  const at = auto.nextRunAt ? new Date(auto.nextRunAt) : null
  if (!at || Number.isNaN(at.getTime())) return { due: true, why: '还没排过下一轮' }
  if (now >= at) return { due: true, why: '到点了' }
  return { due: false, why: `下一次 ${at.toLocaleString('zh-CN')}` }
}

export function listDrafts(limit = 10) {
  try {
    return readdirSync(join(homeDir(), 'drafts'))
      .filter((f) => f.endsWith('.png'))
      .sort()
      .reverse()
      .slice(0, limit)
  } catch {
    return []
  }
}

export function saveDraftJson(draft, path) {
  try {
    writeFileSync(path, JSON.stringify(draft, null, 2), 'utf8')
  } catch { /* 草稿落地失败不致命 */ }
}
