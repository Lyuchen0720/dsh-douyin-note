/**
 * lib/replyauto.mjs —— 「发的图文下面，挑一两条评论回一句」
 * ============================================================================
 * 规则（2026-11-24 使用者要的）：
 *   ① **不是有评就回**：每轮最多回 `perRun` 条（默认 2），隔 `everyMinutes`
 *      （默认 60）才看一次；同一个人这轮只回一条。
 *   ② 只回**本插件自己发出去**的图文（state.json 里 `published + aweme_id` 的记录），
 *      且只回最近 `maxAgeDays` 天内的。
 *   ③ 纯 emoji、广告、引流、已经回过的 cid 一律跳过（见 comments.mjs 的 isReplyable）。
 *   ④ 回什么由模型按插件自带人设现场写；写不出来就跳过，不拿模板糊。
 *   ⑤ 默认**关闭**：`enabled:false` 时心跳只检查不发。打开后也是先写进
 *      `state.replies` 记账，再发 —— 发失败会记 lastError，不静默。
 * ============================================================================
 */
import { readState, writeState } from './state.mjs'
import { listComments, pickCandidates, postCommentReply, askReply, CommentError } from './comments.mjs'

export const REPLY_DEFAULTS = {
  enabled: false,      // 总开关
  everyMinutes: 60,    // 隔多久看一次评论
  perRun: 2,           // 每轮最多回几条
  maxAgeDays: 7,       // 只看最近几天的作品
  lastCheckAt: null,
  lastResult: null,
  lastError: null,
}

const MINUTE = 60_000

export function readReplyAuto() {
  const state = readState()
  const cfg = state.reply_auto && typeof state.reply_auto === 'object' ? state.reply_auto : {}
  return { ...REPLY_DEFAULTS, ...cfg }
}

export function patchReplyAuto(patch = {}) {
  const state = readState()
  const next = { ...readReplyAuto(), ...patch, updated_at: new Date().toISOString() }
  writeState({ ...state, reply_auto: next })
  return next
}

/** 已经回过哪些 cid（去重 / 防连发） */
export function readReplies() {
  const state = readState()
  return Array.isArray(state.replies) ? state.replies : []
}

export function repliedCidSet() {
  return new Set(readReplies().map((r) => String(r.cid || '')).filter(Boolean))
}

export function appendReply(record) {
  const state = readState()
  const list = Array.isArray(state.replies) ? state.replies : []
  const next = [record, ...list.filter((r) => String(r.cid) !== String(record.cid))].slice(0, 300)
  writeState({ ...state, replies: next })
  return next
}

/** 到点没：没开 / 没到间隔 / 刚看过 */
export function replyDue(cfg, now = new Date()) {
  if (!cfg.enabled) return { due: false, why: '评论自动回复未开启' }
  const last = cfg.lastCheckAt ? new Date(cfg.lastCheckAt) : null
  const gap = Math.max(5, Number(cfg.everyMinutes) || 60) * MINUTE
  if (!last || Number.isNaN(last.getTime())) return { due: true, why: '还没检查过' }
  const at = new Date(last.getTime() + gap)
  if (now >= at) return { due: true, why: '到点了' }
  return { due: false, why: `下一次 ${at.toLocaleString('zh-CN')}` }
}

/** 本插件自己发出去、还在时间窗口内的作品（新的在前） */
export function recentNotes({ maxAgeDays = 7, limit = 3 } = {}) {
  const state = readState()
  const list = Array.isArray(state.publishes) ? state.publishes : []
  const cutoff = Date.now() - Math.max(1, Number(maxAgeDays) || 7) * 24 * 3600_000
  return list
    // 老记录只写了 aweme_id（没有 published 字段），所以以「有 aweme_id 且不是干跑」为准
    .filter((r) => r && r.aweme_id && r.published !== false && r.dry_run !== true)
    .filter((r) => {
      const t = r.at ? new Date(r.at).getTime() : 0
      return !t || t >= cutoff
    })
    .slice(0, limit)
    .map((r) => ({ aweme_id: String(r.aweme_id), title: r.title || null, text: r.text || null, at: r.at || null }))
}

/**
 * 扫一遍：只看不写。
 * @returns {Promise<{notes: number, comments: number, candidates: object[], errors: string[]}>}
 */
export async function scanComments({ maxAgeDays = 7, limit = 2, perNote = 3 } = {}) {
  const notes = recentNotes({ maxAgeDays, limit: perNote })
  const replied = repliedCidSet()
  const errors = []
  const all = []
  for (const note of notes) {
    try {
      const { comments, via } = await listComments(note.aweme_id)
      for (const c of comments) all.push({ ...c, aweme_id: note.aweme_id, note_title: note.title, via })
    } catch (e) {
      errors.push(`${note.aweme_id}: ${String(e?.message || e)}`)
    }
  }
  return {
    notes: notes.length,
    comments: all.length,
    candidates: pickCandidates(all, { repliedCids: replied, limit }),
    errors,
  }
}

/**
 * 跑一轮：挑评论 → 写回复 → 发。
 * @param {object} opts { llm, route, persona, dry, limit, awemeId, signal }
 */
export async function runReplyPass(opts = {}) {
  const cfg = readReplyAuto()
  const limit = Math.max(1, Number(opts.limit ?? cfg.perRun) || 2)
  const notes = recentNotes({ maxAgeDays: cfg.maxAgeDays, limit: opts.awemeId ? 1 : 3 })
    .filter((n) => !opts.awemeId || n.aweme_id === String(opts.awemeId))
  const replied = repliedCidSet()
  const startedAt = new Date()
  const errors = []
  const sent = []
  const candidates = []

  for (const note of notes) {
    let comments = []
    try {
      const r = await listComments(note.aweme_id, { count: 20 })
      comments = r.comments
    } catch (e) {
      errors.push(`${note.aweme_id}: ${String(e?.message || e)}`)
      continue
    }
    for (const c of pickCandidates(comments, { repliedCids: replied, limit })) {
      candidates.push({ ...c, aweme_id: note.aweme_id, note_title: note.title })
      if (sent.length >= limit) break
      let text
      try {
        text = await askReply({
          llm: opts.llm, route: opts.route, persona: opts.persona,
          noteTitle: note.title || note.text || '', comment: c.text, nickname: c.nickname,
          signal: opts.signal,
        })
      } catch (e) {
        errors.push(`写回复失败（${c.cid}）：${String(e?.message || e)}`)
        continue
      }
      if (opts.dry) {
        sent.push({ cid: c.cid, aweme_id: note.aweme_id, nickname: c.nickname, comment: c.text, reply: text, dry: true })
        replied.add(c.cid)
        continue
      }
      try {
        const j = await postCommentReply({ awemeId: note.aweme_id, cid: c.cid, text })
        const record = {
          cid: c.cid,
          reply_cid: j.cid || null,
          aweme_id: note.aweme_id,
          nickname: c.nickname,
          comment: c.text,
          reply: text,
          at: new Date().toISOString(),
        }
        appendReply(record)
        replied.add(c.cid)
        sent.push(record)
      } catch (e) {
        errors.push(`发送失败（${c.cid}）：${String(e?.message || e)}`)
      }
    }
  }

  const result = {
    at: startedAt.toISOString(),
    dry: Boolean(opts.dry),
    notes: notes.length,
    candidates: candidates.length,
    sent: sent.length,
    errors,
  }
  patchReplyAuto({
    lastCheckAt: startedAt.toISOString(),
    lastResult: result,
    lastError: errors[0] || null,
  })
  return { ok: errors.length === 0, result, sent, candidates: candidates.map((c) => ({
    cid: c.cid, aweme_id: c.aweme_id, nickname: c.nickname, text: c.text, create_time: c.create_time,
  })) }
}

export { CommentError }
