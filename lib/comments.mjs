/**
 * lib/comments.mjs —— 读作品评论 / 回一条评论
 * ============================================================================
 * 为什么复用 vendor 里的脚本，而不是自己重写：
 *   ① 读评论：抖音 web 的 `comment/list` 要 a_bogus 签名。`dy-signer.mjs` 是
 *      「纯 Node + jsdom」把签名 SDK 灌进页面算出来的，跑了几个月；失败还有
 *      `cdp-fetch.mjs` 在已登录的无头页面里用 XHR（页面自己的 SDK 活着）兜底。
 *   ② 回评论：`comment-api.mjs` 在页面上下文里发请求，ticket-guard 由抖音前端
 *      自己补 —— 自己拼签名会 403。它还处理了 `reply_id` / `reply_to_reply_id`
 *      这个坑（回楼中楼不能把两个塞同一个值，否则会变成一条冒出来的顶层评论）。
 *
 * 红线：
 *   · 只读不写时绝不发请求写接口；`postCommentReply` 必须由调用方拿 confirm。
 *   · 失败就把真实原因往上抛（签名失败 / HTTP / status_code / 页面结构变了），
 *     不编「大概成功了」。
 * ============================================================================
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { douyinDutyHome, pluginRoot } from './paths.mjs'

const NODE = process.execPath
const VENDOR = join(pluginRoot(), 'vendor', 'dsh-douyin-scroll')
const SIGNER = join(VENDOR, 'tools', 'dy-signer.mjs')
const CDP_FETCH = join(VENDOR, 'tools', 'cdp-fetch.mjs')
const COMMENT_API = join(VENDOR, 'tools', 'comment-api.mjs')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

/** 和网页端一致的公共参数（抄自 api-comments.py，少一个都可能被风控） */
const COMMON = {
  device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web', pc_client_type: '1',
  version_code: '190500', version_name: '19.5.0', cookie_enabled: 'true',
  screen_width: '1920', screen_height: '1080', browser_language: 'zh-CN', browser_platform: 'Win32',
  browser_name: 'Chrome', browser_version: '141.0.0.0', engine_name: 'Blink', engine_version: '141.0.0.0',
  os_name: 'Windows', os_version: '10', platform: 'PC',
}

const qs = (d) => Object.entries(d).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')

export class CommentError extends Error {
  constructor(message, stage, detail) {
    super(message)
    this.name = 'CommentError'
    this.stage = stage || 'comments'
    this.detail = detail || {}
  }
}

/** 读 Cookie（剥 BOM：记事本存的文件带 BOM，会直接把请求头编码搞崩） */
export function readCookie() {
  const file = join(douyinDutyHome(), 'douyin_cookie.txt')
  if (!existsSync(file)) return ''
  try {
    return readFileSync(file, 'utf8').replace(/^\ufeff/, '').trim()
  } catch { return '' }
}

function cookieJar(text) {
  const jar = {}
  for (const part of String(text || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) jar[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return jar
}

function runNode(script, args, { timeout = 240_000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    execFile(NODE, [script, ...args], {
      cwd: VENDOR,
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, DOUYIN_HOME: douyinDutyHome(), ...env },
    }, (err, stdout, stderr) => {
      const out = String(stdout || '')
      if (err && !out.trim()) {
        reject(new CommentError(`子进程失败：${String(err.message || err).slice(0, 200)}`, 'spawn', { stderr: String(stderr || '').slice(-500) }))
        return
      }
      resolve({ out, err: String(stderr || '') })
    })
  })
}

/** 从混杂输出里抠出最后一个 JSON 对象 */
function lastJson(text) {
  const s = String(text || '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) throw new CommentError('子进程没有输出 JSON', 'parse', { sample: s.slice(-400) })
  try { return JSON.parse(s.slice(start, end + 1)) } catch (e) {
    throw new CommentError(`子进程 JSON 解析失败：${e.message}`, 'parse', { sample: s.slice(-400) })
  }
}

/**
 * 签名一个相对 URL。
 * 注意：签名器第一次启动要初始化 jsdom + 7 个 SDK，约 1–3 秒。
 */
async function signRel(rel) {
  const cookie = readCookie()
  const jar = cookieJar(cookie)
  if (!Object.keys(jar).length) throw new CommentError('没有 Cookie：先在「刷抖音」里扫码登录一次', 'login')
  const { out } = await runNode(SIGNER, [rel], { env: { DY_COOKIES: JSON.stringify(jar) } })
  return lastJson(out)
}

async function cdpFetchRel(rel) {
  const { out } = await runNode(CDP_FETCH, ['--path', rel], { timeout: 200_000 })
  return lastJson(out)
}

function buildPath(awemeId, cursor, count) {
  return '/aweme/v1/web/comment/list/?' + qs({
    ...COMMON, aweme_id: String(awemeId), count: String(count), cursor: String(cursor), item_type: '0',
  })
}

function normalize(c) {
  const u = c?.user || {}
  return {
    cid: String(c?.cid || ''),
    text: String(c?.text || ''),
    nickname: String(u.nickname || ''),
    uid: String(u.uid || ''),
    unique_id: String(u.unique_id || ''),
    digg: Number(c?.digg_count || 0),
    create_time: Number(c?.create_time || 0),
    reply_comment_total: Number(c?.reply_comment_total || 0),
    is_author: Boolean(c?.is_author || u.is_author),
  }
}

/**
 * 拉一条作品下的评论（只读）。
 * 先走签名接口（快），失败自动退回无头页面里发 XHR（慢但不挑网络）。
 * @returns {Promise<{comments: object[], via: string, total: number, has_more: boolean}>}
 */
export async function listComments(awemeId, { count = 20, cursor = 0 } = {}) {
  const rel = buildPath(awemeId, cursor, count)
  let json = null
  let via = 'sign'
  let signErr = null
  try {
    const s = await signRel(rel)
    if (!s?.signedUrl) throw new CommentError(`签名没返回地址：${s?.err || '未知'}`, 'sign')
    const headers = {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://www.douyin.com/',
      Origin: 'https://www.douyin.com',
      ...(s.headers || {}),
    }
    const cookie = readCookie()
    if (cookie) headers.Cookie = cookie
    const res = await fetch(s.signedUrl, { headers })
    if (!res.ok) throw new CommentError(`签名接口 HTTP ${res.status}`, 'sign')
    json = await res.json()
    if (json?.status_code !== 0) throw new CommentError(`签名接口 status_code=${json?.status_code}`, 'sign')
  } catch (e) {
    signErr = e
    via = 'cdp'
    try {
      json = await cdpFetchRel(rel)
      if (json?.status_code !== 0) throw new CommentError(`页面接口 status_code=${json?.status_code}`, 'cdp')
    } catch (e2) {
      throw new CommentError(
        `评论读取失败：签名=${String(signErr?.message || signErr).slice(0, 120)}；兜底=${String(e2?.message || e2).slice(0, 120)}`,
        'read',
      )
    }
  }
  const comments = (Array.isArray(json?.comments) ? json.comments : []).map(normalize).filter((c) => c.cid)
  return { comments, via, total: Number(json?.total || comments.length), has_more: Boolean(json?.has_more) }
}

/**
 * 回一条评论（会发出去）。传 dry:true 只解析目标、不发送。
 * @returns {Promise<{ok:boolean, cid:string|null, root:string|null, error?:string}>}
 */
export async function postCommentReply({ awemeId, cid, text, dry = false }) {
  const t = String(text || '').trim()
  if (!t) throw new CommentError('回复内容是空的', 'validate')
  if (t.length > 500) throw new CommentError('回复超过 500 字', 'validate')
  const args = ['--aweme', String(awemeId), '--text', t]
  if (cid) args.push('--reply', String(cid))
  if (dry) args.push('--dry')
  const { out } = await runNode(COMMENT_API, args, { timeout: 300_000 })
  const j = lastJson(out)
  if (!j?.ok) throw new CommentError(String(j?.error || '评论接口没有返回 ok'), 'reply', { raw: j })
  return j
}

// ── 挑哪条回 ────────────────────────────────────────────────────────────────

const SPAM = /(https?:\/\/|www\.|加\s*[vV微]|微信|vx|VX|qq群|QQ群|私信我|互关|互粉|优惠|贷款|刷单|兼职|代发|引流)/
const EMOJI_ONLY = /^(\[[^\]]{1,8}\])+$/

/** 这条评论值不值得回（纯 emoji、广告、自己发的、已经回过的都不回） */
export function isReplyable(c, { repliedCids = new Set() } = {}) {
  if (!c?.cid || !c?.text) return false
  if (repliedCids.has(c.cid)) return false
  if (c.is_author) return false
  const t = c.text.trim()
  if (!t) return false
  if (EMOJI_ONLY.test(t)) return false
  if (SPAM.test(t)) return false
  if (t.length > 200) return false
  return true
}

/**
 * 从一批评论里挑出最多 `limit` 条：新的优先，其次点赞多的。
 * 同一个人的多条只取最新一条（别连着回同一个人）。
 */
export function pickCandidates(comments, { repliedCids = new Set(), limit = 2 } = {}) {
  const seenUser = new Set()
  return [...comments]
    .filter((c) => isReplyable(c, { repliedCids }))
    .sort((a, b) => (b.create_time - a.create_time) || (b.digg - a.digg))
    .filter((c) => {
      const key = c.uid || c.nickname || c.cid
      if (seenUser.has(key)) return false
      seenUser.add(key)
      return true
    })
    .slice(0, limit)
}

// ── 回什么 ──────────────────────────────────────────────────────────────────

/**
 * 让模型按人设回一句（纯文本，不是 JSON）。
 * 约束：一句话、≤40 字、不提问、不复述、不承诺、不带链接。
 */
export async function askReply({ llm, route, persona, noteTitle, comment, nickname, signal }) {
  if (!llm || typeof llm.stream !== 'function') throw new CommentError('llm 服务不可用（宿主没给模型）', 'llm')
  if (!route?.provider || !route?.model) throw new CommentError('拿不到默认模型路由', 'llm')
  const system = [
    persona,
    '',
    '【现在要干的活】有人在你发的抖音图文下面留了评论，用你自己的口吻回一句。',
    '规则：一句话，不超过 40 个字；口语、自然，像随手回的；',
    '不要复述对方的评论、不要提问、不要承诺任何事、不要提自己是 AI、不要带链接或联系方式；',
    '只输出这一句话本身，不要引号、不要解释。',
  ].join('\n')
  const ctx = [
    noteTitle ? `你发的图文：《${noteTitle}》` : '',
    `对方昵称：${nickname || '路人'}`,
    `对方评论：${comment}`,
  ].filter(Boolean).join('\n')
  let out = ''
  const it = llm.stream({
    provider: route.provider, model: route.model, system,
    messages: [{ role: 'user', content: [{ type: 'text', text: ctx }] }],
    maxTokens: 120, temperature: 0.9, signal,
  })
  for await (const chunk of it) {
    if (chunk && chunk.type === 'text-delta') out += chunk.text || ''
    else if (chunk && chunk.type === 'finish') break
  }
  const text = String(out)
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  if (!text) throw new CommentError('模型没有给出回复内容', 'llm')
  return text
}
