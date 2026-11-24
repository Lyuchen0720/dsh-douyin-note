/**
 * dsh-douyin-note —— 抖音图文发布插件（host 半端）
 * ============================================================================
 * 两个工具：
 *   douyin_note_publish —— 传图 + 标题 + 描述 + 话题 → 发一条图文。
 *                          默认**干跑**（填完表单、点发布，但把 create 请求拦下）。
 *                          使用者当场同意后才可 confirm:true 真发。
 *   douyin_note_status  —— 家目录 / profile / 浏览器 / 最近发布记录 / 登录态。
 *
 * 浏览器复用「刷抖音」插件的无头 Chrome 与 profile（同一个 `$DSH_HOME/douyin-duty/
 * chrome-profile`），所以创作者中心一般已经是登录状态。
 * ============================================================================
 */
import { loadHostDeps } from './lib/hostdeps.mjs'

// ⭐ 这两个是 optional peer：从宿主那棵树里取，拿不到有本地等价实现（见 lib/hostdeps.mjs）
const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool

import { publishNote, probeCreator } from './lib/note-publish.mjs'
import { cdpAlive, findBrowser } from './lib/chrome.mjs'
import { ensureHome, homeDir, profileDir, sharedProfileDir, scrollStatus, usesSharedProfile, readRuntime } from './lib/paths.mjs'
import { readState } from './lib/state.mjs'
import { readAuto, patchAuto, dueCheck, runOne, pickMusic, listDrafts } from './lib/autopilot.mjs'
import { readReplyAuto, patchReplyAuto, replyDue, runReplyPass, scanComments, recentNotes, readReplies } from './lib/replyauto.mjs'
import { loadPersona } from './lib/draft.mjs'
import { readAdmins, writeAdmins, knownPeers, PERMS } from './lib/admins.mjs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const pluginDir = dirname(fileURLToPath(import.meta.url))

export const name = 'douyin-note'
export const inject = ['tools']
/** 模型是可选服务：拿不到就只发「手动」那条路，自动写稿会明确报错，不静默降级 */
export const optional = ['llm', 'webServer']

export const Config = !z ? undefined : z.object({
  /** 总开关（设置层可见；关掉后插件不注册工具） */
  enabled: z.boolean().default(true).extra('volatile', true),
  /**
   * 无头浏览器 profile 目录。留空 = 共用「刷抖音」插件的 profile（登录态直接可用）。
   * 填了别的目录就要自己重新登录创作者中心。
   */
  profile: z.string().default('').extra('volatile', true),
})

const STAGE_LABEL = {
  dependency: '前置依赖（刷抖音插件）',
  validate: '参数检查',
  browser: '启动/连接无头浏览器',
  navigate: '打开创作者中心',
  login: '登录态',
  tab: '切换到「发布图文」',
  'file-input': '找图片上传控件',
  upload: '上传图片',
  title: '填标题',
  desc: '填描述',
  tags: '挂话题',
  music: '配乐',
  visibility: '设置可见性',
  publish: '点发布 / 拿发布请求',
  verify: '核对发布请求',
  wait: '等页面状态',
  timeout: '等待超时',
  comments: '读评论',
  sign: '评论接口签名',
  cdp: '页面里读评论',
  read: '读评论',
  reply: '发回复',
  llm: '写回复',
  parse: '解析子进程输出',
  spawn: '启动子进程',
}

function hintFor(err) {
  const stage = err?.stage
  if (stage === 'dependency') return '这个插件必须绑定「刷抖音」（dsh-douyin-scroll）：先装它、并让它在同一台机器上扫码登录过一次（它会建好 $DSH_HOME/douyin-duty/chrome-profile），再回来发图文。'
  if (stage === 'login') return '先打开「刷抖音」插件的扫码登录，扫码一次即可（两个插件共用同一个浏览器 profile）。'
  if (stage === 'upload') return '看页面提示：格式只收 jpg/jpeg/png/webp/bmp/tif，单张 ≤50MB，最多 35 张；不支持 gif。'
  if (stage === 'publish' || stage === 'timeout') return '先看截图和 page_sample：常见原因是弹窗（作品检测/新手引导）挡住了发布按钮，或页面结构变了。'
  if (stage === 'visibility') return '为安全起见，可见性没切成功时不会发布。可先不传 visibility（默认公开）试一次干跑。'
  if (stage === 'music') return '配乐是「搜关键词 → 取第一条 → 点使用」。搜不到就换个更常见的歌名/关键词，或先不传 music。'
  if (stage === 'verify') return '浏览器里实际要提交的内容和入参对不上，已被拦下。看 preview 里真实的 text / 图片数。'
  if (stage === 'validate') return '按提示修参数；图片路径要用绝对路径。'
  if (stage === 'reply') return '发表评论失败：看 error/raw。常见是页面结构变了、账号被限流，或目标评论已被删。'
  if (stage === 'comments' || stage === 'read' || stage === 'sign' || stage === 'cdp') return '读评论失败：确认「刷抖音」已扫码登录（Cookie 在 $DSH_HOME/douyin-duty/douyin_cookie.txt），并且 signer 依赖装好了。'
  if (stage === 'llm') return '宿主没给模型（或没配默认模型）：评论自动回复需要模型来写那句话。'
  return '把 error / page_sample / screenshot 一起发出来排查。'
}

function describeFailure(err) {
  const detail = err?.detail || {}
  return {
    ok: false,
    dry_run: true,
    published: false,
    stage: err?.stage || 'unknown',
    stage_label: STAGE_LABEL[err?.stage] || err?.stage || '未知阶段',
    error: String(err?.message || err),
    hint: hintFor(err),
    page_sample: detail.page ?? null,
    screenshot: detail.screenshot ?? null,
    preview: detail.preview ?? null,
    response: detail.response ?? null,
  }
}

function stripRuns(auto) {
  const { runs, ...rest } = auto || {}
  return { ...rest, recent_runs: Array.isArray(runs) ? runs.slice(0, 3) : [] }
}

export function apply(ctx, config = {}) {
  // ⚠️ 用 === false 判断：没有 Config schema 时 config 可能是 {}，不能当成「关掉」
  if (config?.enabled === false) return
  if (config.profile) process.env.DOUYIN_NOTE_PROFILE = String(config.profile)
  try { ensureHome() } catch { /* 家目录建不出来时，发布流程自己会报错 */ }

  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  }

  /** 工具返回值一律过这里：宿主只吃无损 JSON */
  const safe = (v) => {
    if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }

  /** 同一时刻只允许一条发布在跑（共用 profile / 页面状态不能交叉） */
  let running = Promise.resolve()
  const serialize = (fn) => {
    const next = running.then(fn, fn)
    running = next.then(() => {}, () => {})
    return next
  }

  const getLlm = () => { try { return ctx.get('llm') } catch { return null } }
  const getRoute = () => {
    try {
      const sel = ctx.get('agentDefaultModel')?.currentSelection?.()
      return sel && sel.provider && sel.model ? { provider: sel.provider, model: sel.model } : null
    } catch { return null }
  }

  /** 生成（并可选真发）一条自写图文 */
  const runAuto = async ({ publish, reason }) => {
    const llm = getLlm()
    const route = getRoute()
    if (!llm) throw new Error('宿主没有给 llm 服务，自动写稿不可用（手动发布不受影响）')
    if (!route) throw new Error('拿不到默认模型路由（agentDefaultModel 为空）')
    return runOne({ llm, route, pluginDir, publish: publish === true, reason })
  }

  /**
   * 自动发布的心跳：每分钟看一眼「到点没有」。
   * 定时器回调里的异常必须自己兜住 —— 未捕获异常会杀掉整个宿主进程。
   */
  let ticking = false
  const tick = async () => {
    if (ticking) return
    const auto = readAuto()
    if (!auto.enabled) return
    const due = dueCheck(auto)
    if (!due.due) return
    ticking = true
    try {
      // 跨天：把计数清零再排下一次
      const today = new Date().toISOString().slice(0, 10)
      if (auto.dayKey !== today) patchAuto({ dayKey: today, dayCount: 0 })
      await serialize(() => runAuto({ publish: auto.publish === true, reason: 'auto' }))
      ctx.logger?.info?.(`[douyin-note] 自动发布完成（publish=${auto.publish === true}）`)
    } catch (e) {
      patchAuto({ lastError: String(e?.message || e) })
      ctx.logger?.warn?.(`[douyin-note] 自动发布失败：${e?.message || e}`)
    } finally {
      ticking = false
    }
  }

  /**
   * 评论自动回复的心跳：跟发布分开（自动发布关了它也能跑）。
   * 回调里的异常必须自己兜住 —— 未捕获异常会杀掉整个宿主进程。
   */
  let replying = false
  const tickReplies = async () => {
    if (replying) return
    const cfg = readReplyAuto()
    if (!replyDue(cfg).due) return
    const llm = getLlm()
    const route = getRoute()
    if (!llm || !route) {
      patchReplyAuto({ lastError: '宿主没有给 llm 服务（或没有默认模型），评论自动回复跑不了' })
      return
    }
    replying = true
    try {
      const r = await serialize(() => runReplyPass({ llm, route, persona: loadPersona(pluginDir) }))
      ctx.logger?.info?.(`[douyin-note] 评论自动回复：回了 ${r.result.sent} 条`)
    } catch (e) {
      patchReplyAuto({ lastCheckAt: new Date().toISOString(), lastError: String(e?.message || e) })
      ctx.logger?.warn?.(`[douyin-note] 评论自动回复失败：${e?.message || e}`)
    } finally { replying = false }
  }

  const timer = setInterval(() => {
    tick().catch(() => {})
    tickReplies().catch(() => {})
  }, 60_000)
  const stopTimer = () => clearInterval(timer)
  try { ctx.effect?.(() => stopTimer) } catch { /* 没有 effect 就等进程结束 */ }
  try { ctx.on?.('dispose', stopTimer) } catch { /* 同上 */ }

  ctx.tools.register(defineTool({
    name: 'douyin_note_publish',
    description:
      '把本地图片发成一条抖音图文（创作者中心「发布图文」，走真实页面：传图 → 填标题/描述 → 挂话题 → 配乐 → 点发布）。'
      + '⚠️ 必须已安装并登录「刷抖音」（dsh-douyin-scroll）：本插件只复用它那份浏览器登录态，没装就不发。'
      + '⭐ 默认只做干跑：会真的把图上传、把表单填好、点「发布」，但最后的 create 请求会在浏览器里被拦下，不会真发出去，'
      + '返回即将提交的 text / 图片数 / music_id 供核对。**必须由使用者当场明确同意后，才可传 confirm:true 真发**。'
      + '限制：1-35 张，jpg/jpeg/png/webp/bmp/tif（不支持 gif），单张 ≤50MB；标题 ≤20 字，描述 ≤1000 字；比例推荐 3:4。',
    parameters: {
      images: {
        type: 'array',
        items: { type: 'string' },
        description: '图片的本地绝对路径，1-35 张；第一张默认当封面（必填）。',
      },
      title: { type: 'string', description: '作品标题，≤20 字（不传就只发描述）。' },
      desc: { type: 'string', description: '作品描述，≤1000 字，可换行。' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: '要挂的话题，不带 #（如 ["夏日傍晚","城市夜景"]）；会按「输入 #话题 再回车」变成真话题实体。',
      },
      music: {
        type: 'string',
        description: '配乐：歌名或关键词（如「小美满」），会搜出来取第一条并点「使用」；不传 = 不加音乐。',
      },
      visibility: {
        type: 'string',
        description: '可见性：public 公开（默认）/ friends 好友可见 / private 仅自己可见。',
      },
      confirm: {
        type: 'boolean',
        description: '🔴 必须由使用者当场同意后才传 true；不传或 false = 干跑预览，不会发布。',
      },
    },
    output: textOutput,
    execute: async (args) => serialize(async () => {
      try {
        return safe(await publishNote({
          images: args?.images,
          title: args?.title,
          desc: args?.desc,
          tags: args?.tags,
          music: args?.music,
          visibility: args?.visibility,
          confirm: args?.confirm === true,
        }))
      } catch (err) {
        return safe(describeFailure(err))
      }
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'douyin_note_auto',
    description:
      '「按频率自己发」的控制台：可查看/修改频率与开关，也可立刻生成一条（可选直接发）。'
      + '⚠️ 依赖「刷抖音」（dsh-douyin-scroll）的登录态。'
      + '自动模式下，插件会调一次模型，按插件自带的人设自己想标题/描述/话题/图片大字，渲染成 1080×1440 文字卡，'
      + '再从音乐池里随机挑一首挂上。⚠️ `publish:false` 时只生成草稿（存 drafts/，可预览），不会发出去；'
      + '改成 true 才会真发，默认是 false。action=status 看状态，action=config 改设置，action=run 立刻跑一条。',
    parameters: {
      action: { type: 'string', description: 'status（默认，看状态）/ config（改设置）/ run（立刻跑一条）' },
      enabled: { type: 'boolean', description: 'config 用：自动发布总开关' },
      everyHours: { type: 'number', description: 'config 用：每多少小时一条（最小 0.25）' },
      perDay: { type: 'number', description: 'config 用：每天最多几条' },
      publish: { type: 'boolean', description: 'config/run 用：true = 真发；false = 只出草稿（默认 false）' },
      musicPool: { type: 'array', items: { type: 'string' }, description: 'config 用：配乐关键词池，每次随机挑一个' },
      reason: { type: 'string', description: 'run 用：记在记录里的原因（可选）' },
    },
    output: textOutput,
    execute: async (args) => {
      const action = String(args?.action || 'status')
      try {
        if (action === 'config') {
          const patch = {}
          for (const k of ['enabled', 'publish']) if (typeof args?.[k] === 'boolean') patch[k] = args[k]
          for (const k of ['everyHours', 'perDay']) if (args?.[k] != null && Number.isFinite(Number(args[k]))) patch[k] = Number(args[k])
          if (Array.isArray(args?.musicPool)) patch.musicPool = args.musicPool.map(String).filter(Boolean).slice(0, 20)
          const auto = patchAuto(patch)
          return safe({ ok: true, changed: Object.keys(patch), auto: stripRuns(auto), due: dueCheck(auto) })
        }
        if (action === 'run') {
          const auto = readAuto()
          const wantPublish = typeof args?.publish === 'boolean' ? args.publish : auto.publish === true
          const record = await serialize(() => runAuto({ publish: wantPublish, reason: args?.reason || 'manual' }))
          return safe({ ok: true, record, auto: stripRuns(readAuto()) })
        }
        const auto = readAuto()
        return safe({
          ok: true,
          auto: stripRuns(auto),
          due: dueCheck(auto),
          drafts: listDrafts(8),
          nextMusic: pickMusic(auto),
          note: '默认只出草稿；publish:true 才会真发。到点由宿主内每分钟一次的心跳触发。',
        })
      } catch (e) {
        return safe({ ok: false, action, error: String(e?.message || e), stage: e?.stage || null, hint: hintFor(e) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'douyin_note_replies',
    description:
      '「图文下面挑一两条评论回一句」的控制台。'
      + '只看本插件自己发出去的作品（state.json 里有 aweme_id 的那几条，默认最近 7 天）。'
      + '默认每轮最多回 2 条、隔 60 分钟看一次；纯 emoji / 广告 / 已经回过的会跳过。'
      + 'action=status 看开关与最近回过什么；action=scan 只读扫一遍（不发任何东西）；'
      + 'action=reply 立刻跑一轮 —— **不带 confirm 只生成候选和回复草稿（dry），带 confirm:true 才真发**；'
      + 'action=config 改开关/间隔/每轮条数。回复文案由模型按插件自带人设现场写。',
    parameters: {
      action: { type: 'string', description: 'status（默认）/ scan（只读）/ reply（跑一轮）/ config（改设置）' },
      confirm: { type: 'boolean', description: '🔴 reply 用：必须由使用者当场同意后才传 true；不传 = dry，只出草稿不发。' },
      enabled: { type: 'boolean', description: 'config 用：评论自动回复总开关（默认关）' },
      everyMinutes: { type: 'number', description: 'config 用：隔多少分钟看一次（最小 5，默认 60）' },
      perRun: { type: 'number', description: 'config 用：每轮最多回几条（默认 2）' },
      maxAgeDays: { type: 'number', description: 'config 用：只看最近几天的作品（默认 7）' },
      limit: { type: 'number', description: 'scan/reply 用：本轮最多挑几条候选（默认取配置里的 perRun）' },
    },
    output: textOutput,
    execute: async (args) => {
      const action = String(args?.action || 'status')
      const cfg = readReplyAuto()
      try {
        if (action === 'config') {
          const patch = {}
          if (typeof args?.enabled === 'boolean') patch.enabled = args.enabled
          for (const k of ['everyMinutes', 'perRun', 'maxAgeDays']) {
            if (args?.[k] != null && Number.isFinite(Number(args[k]))) patch[k] = Number(args[k])
          }
          const next = patchReplyAuto(patch)
          return safe({ ok: true, changed: Object.keys(patch), reply: next, due: replyDue(next) })
        }
        if (action === 'scan') {
          const r = await scanComments({ maxAgeDays: cfg.maxAgeDays, limit: Number(args?.limit || cfg.perRun) })
          return safe({ ok: r.errors.length === 0, ...r, replied_total: readReplies().length })
        }
        if (action === 'reply') {
          const llm = getLlm()
          const route = getRoute()
          if (!llm || !route) throw new Error('宿主没有给 llm 服务或没有默认模型，写不了回复')
          const dry = args?.confirm !== true
          const r = await serialize(() => runReplyPass({
            llm, route, persona: loadPersona(pluginDir),
            dry, limit: Number(args?.limit || cfg.perRun),
          }))
          return safe({
            ok: r.ok,
            dry_run: dry,
            message: dry
              ? '干跑：只生成了回复草稿，没有发出去。确认没问题后带 confirm:true 再跑一次。'
              : `已回复 ${r.result.sent} 条。`,
            ...r,
          })
        }
        return safe({
          ok: true,
          reply: cfg,
          due: replyDue(cfg),
          recent: readReplies().slice(0, 10),
          notes: recentNotes({ maxAgeDays: cfg.maxAgeDays }),
          note: '默认关闭；打开后由宿主内每分钟一次的心跳按间隔触发。真发需要 confirm:true（手动）或开关已开（自动）。',
        })
      } catch (e) {
        return safe({ ok: false, action, stage: e?.stage || null, error: String(e?.message || e), hint: hintFor(e), raw: e?.detail || null })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'douyin_note_status',
    description:
      '抖音图文插件的状态：家目录、浏览器 profile（是否共用「刷抖音」的登录态）、无头 Chrome 是否在跑、'
      + '最近的发布/干跑记录。传 check_login:true 会真的打开一次创作者中心确认登录态（会起/复用无头浏览器，慢几秒）。',
    parameters: {
      check_login: { type: 'boolean', description: 'true = 打开创作者中心查一次登录态（默认 false，只看本地记录）。' },
    },
    output: textOutput,
    execute: async (args) => {
      const runtime = readRuntime()
      const port = Number(runtime.cdpPort || 0)
      let alive = false
      if (port) { try { alive = await cdpAlive(port) } catch { alive = false } }

      let creator = null
      if (args?.check_login === true) {
        try { creator = await probeCreator() } catch (e) {
          creator = { error: String(e?.message || e), stage: e?.stage || null }
        }
      }

      const state = readState()
      const auto = readAuto()
      return safe({
        ok: true,
        home: homeDir(),
        profile: profileDir(),
        profile_shared_with_scroll: usesSharedProfile(),
        dependency: scrollStatus(),
        shared_profile_dir: sharedProfileDir(),
        chrome_alive: alive,
        cdp_port: port || null,
        browser: runtime.browser || (() => { try { return findBrowser() } catch { return null } })(),
        last_publishes: (state.publishes || []).slice(0, 5),
        auto: stripRuns(auto),
        auto_due: dueCheck(auto),
        drafts: listDrafts(5),
        creator,
        limits: {
          images: '1-35',
          formats: 'jpg/jpeg/png/webp/bmp/tif（不支持 gif）',
          max_file_mb: 50,
          title_chars: 20,
          desc_chars: 1000,
          recommended_ratio: '3:4（不建议超过 1:2）',
          music: '可选：传歌名/关键词，取搜索结果第一条并点「使用」',
        },
        note: '默认干跑；confirm:true 才会真的发布。发布走浏览器的真实页面操作，不自己拼签名。',
        requires: 'dsh-douyin-scroll（刷抖音）：本插件只复用它已经登录好的浏览器 profile，没有它就不发。',
      })
    },
  }))

  // ── 设置页接口（Web GUI 里那页「抖音图文」用它读写）─────────────────────────
  const readJsonBody = async (req) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    if (!raw) return {}
    try { return JSON.parse(raw) } catch { return {} }
  }
  const sendJson = (res, code, obj) => {
    try {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(obj))
    } catch { /* 连接断了就算了 */ }
  }
  const apiStatus = () => {
    const auto = readAuto()
    const state = readState()
    return {
      ok: true,
      auto: stripRuns(auto),
      due: dueCheck(auto),
      drafts: listDrafts(8),
      last_publishes: (state.publishes || []).slice(0, 3),
      reply: { config: readReplyAuto(), due: replyDue(readReplyAuto()), recent: readReplies().slice(0, 5) },
      dependency: scrollStatus(),
    }
  }

  // webServer 可能晚于插件就绪；headless 里没有它，那就只靠工具
  ctx.inject(['webServer'], (webCtx) => {
    try {
      webCtx.effect(() => webCtx.get('webServer').register({
        kind: 'prefix',
        path: '/api/douyin-note',
        handler: async (req, res) => {
          try {
            const url = new URL(req.url, 'http://127.0.0.1')
            const p = url.pathname
            if (req.method === 'GET' && p === '/api/douyin-note/status') return sendJson(res, 200, apiStatus())
            if (req.method === 'POST' && p === '/api/douyin-note/config') {
              const body = await readJsonBody(req)
              const patch = {}
              for (const k of ['enabled', 'publish']) if (typeof body[k] === 'boolean') patch[k] = body[k]
              for (const k of ['everyHours', 'perDay']) {
                if (body[k] != null && Number.isFinite(Number(body[k]))) patch[k] = Number(body[k])
              }
              if (Array.isArray(body.musicPool)) patch.musicPool = body.musicPool.map(String).filter(Boolean).slice(0, 20)
              patchAuto(patch)
              if (body.reply && typeof body.reply === 'object') {
                const rp = {}
                if (typeof body.reply.enabled === 'boolean') rp.enabled = body.reply.enabled
                for (const k of ['everyMinutes', 'perRun', 'maxAgeDays']) {
                  if (body.reply[k] != null && Number.isFinite(Number(body.reply[k]))) rp[k] = Number(body.reply[k])
                }
                if (Object.keys(rp).length) patchReplyAuto(rp)
              }
              return sendJson(res, 200, apiStatus())
            }
            if (req.method === 'POST' && p === '/api/douyin-note/reply/scan') {
              const cfg = readReplyAuto()
              const r = await scanComments({ maxAgeDays: cfg.maxAgeDays, limit: cfg.perRun })
              return sendJson(res, 200, { ...apiStatus(), scan: r })
            }
            if (req.method === 'POST' && p === '/api/douyin-note/reply/run') {
              const body = await readJsonBody(req)
              const cfg = readReplyAuto()
              const llm = getLlm()
              const route = getRoute()
              if (!llm || !route) throw new Error('宿主没有给 llm 服务或没有默认模型')
              const dry = body.confirm !== true
              const r = await serialize(() => runReplyPass({
                llm, route, persona: loadPersona(pluginDir), dry, limit: cfg.perRun,
              }))
              return sendJson(res, 200, { ...apiStatus(), reply_run: r })
            }
            if (req.method === 'GET' && p === '/api/douyin-note/admins') {
              return sendJson(res, 200, { ok: true, ...readAdmins(), peers: knownPeers(), perms: PERMS })
            }
            if (req.method === 'POST' && p === '/api/douyin-note/admins') {
              const body = await readJsonBody(req)
              const saved = writeAdmins(body?.admins)
              return sendJson(res, 200, { ok: true, ...saved, peers: knownPeers(), perms: PERMS })
            }
            if (req.method === 'POST' && p === '/api/douyin-note/run') {
              const body = await readJsonBody(req)
              const auto = readAuto()
              const want = typeof body.publish === 'boolean' ? body.publish : auto.publish === true
              const record = await serialize(() => runAuto({ publish: want, reason: 'ui' }))
              return sendJson(res, 200, { ...apiStatus(), record })
            }
            return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${p}` })
          } catch (e) {
            return sendJson(res, 500, { ok: false, error: String(e?.message || e) })
          }
        },
      }), 'douyin-note: /api/douyin-note 路由')
    } catch { /* 服务不在就算了 */ }
  })
}
