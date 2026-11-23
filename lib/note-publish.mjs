/**
 * lib/note-publish.mjs —— 抖音图文发布（创作者中心「发布图文」全流程）
 * ============================================================================
 * 链路（每一步都在真实页面里点，不自己拼签名、不直接打写接口）：
 *   打开发布页 → 点「发布图文」→ DOM.setFileInputFiles 传图 → 等编辑器
 *   → 填标题 / 描述 → 逐个输入 「#话题 + 回车」变成话题实体
 *   →（可选）选可见性 → 点「发布」
 *
 * 🔴 最关键的一道闸：发布请求 `POST /web/api/media/aweme/create_v2/`
 *    会被 CDP Fetch 域**暂停**。我们先核对请求体（文字、图片数），
 *    - 没有 confirm ⇒ 直接 failRequest：请求根本不会到服务器（干跑预览）；
 *    - 有 confirm   ⇒ 校验通过才 continueRequest，并读回包拿 aweme_id。
 *
 * 实测要点（2026-11-23，账号「姜姜的大肥鱼」）：
 *   - 标题与描述在请求里被拼成 `<title>。<desc>`；只有描述时就是 desc。
 *   - 话题不是普通文本：输入 `#夏日傍晚` 后按回车会变成话题实体，
 *     请求体 text_extra 里出现 `{type:1,hashtag_name:'夏日傍晚'}`；
 *     `challenges` 始终是 "[]"，别拿它判断话题有没有挂上。
 *   - 可见性单选的 value 就是 visibility_type：公开 0 / 仅自己 1 / 好友 2。
 *   - 发布按钮在页面最底部，必须先滚到底再按坐标点。
 *   - 点「发布」时还会顺带打一个 fast_detect/poll（作品检测），失败只提示
 *     「当前检测人数过多」，不影响发布 —— 不要因为它超时就把整次发布判失败。
 * ============================================================================
 */
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'

import { ensureHome, scrollStatus } from './paths.mjs'
import { openPage, sleep } from './chrome.mjs'
import { appendPublish } from './state.mjs'

const UPLOAD_URL = 'https://creator.douyin.com/creator-micro/content/upload'
const CREATE_URL_MARK = '/web/api/media/aweme/create_v2/'
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff'])
const MAX_IMAGES = 35
const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_TITLE = 20
const MAX_DESC = 1000
const MAX_TAG = 30

export const VIS_LABEL = { public: '公开', friends: '好友可见', private: '仅自己可见' }
export const VIS_VALUE = { public: '0', friends: '2', private: '1' }

/** 页面上那个「描述」输入框（可见的那个 contenteditable） */
const ED = "[...document.querySelectorAll('[contenteditable=true]')].find(e=>e.getBoundingClientRect().width>0)"

export class NoteError extends Error {
  constructor(message, stage = '', detail = {}) {
    super(message)
    this.name = 'NoteError'
    this.stage = stage
    this.detail = detail
  }
}

/* ───────────────────────── 前置依赖 ───────────────────────── */

/**
 * 硬性前置：必须装「刷抖音」（dsh-douyin-scroll）并登录过一次。
 * 本插件不自己管登录 —— 发布用的就是它那份已经登录好的 headless Chrome profile。
 */
export function requireScrollPlugin() {
  const dep = scrollStatus()
  if (!dep.ok) {
    throw new NoteError(
      '这个插件必须绑定「刷抖音」（dsh-douyin-scroll）才能用：没检测到它的家目录 / 浏览器 profile。'
      + '先装 dsh-douyin-scroll 并扫码登录一次，再来发图文。',
      'dependency',
      { dependency: dep },
    )
  }
  return dep
}

/* ───────────────────────── 小工具 ───────────────────────── */

function deferred() {
  let resolveFn, rejectFn
  const p = new Promise((res, rej) => { resolveFn = res; rejectFn = rej })
  p.settled = false
  p.resolve = (v) => { if (!p.settled) { p.settled = true; resolveFn(v) } }
  p.reject = (e) => { if (!p.settled) { p.settled = true; rejectFn(e) } }
  return p
}

function withTimeout(promise, ms, message) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new NoteError(message, 'timeout')), ms) }),
  ])
}

async function waitFor(fn, { timeout = 30000, interval = 400, label = '条件' } = {}) {
  const t0 = Date.now()
  let lastErr
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) { lastErr = e }
    await sleep(interval)
  }
  throw new NoteError(
    `等待「${label}」超时（${Math.round(timeout / 1000)} 秒）${lastErr ? '：' + String(lastErr.message || lastErr).slice(0, 200) : ''}`,
    'wait',
  )
}

const norm = (s) => String(s ?? '')
  .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
  .replace(/\s+/g, ' ')
  .trim()

async function bodyText(page) {
  return page.ev("(document.body.innerText||'').replace(/\\s+/g,' ').trim()")
}

async function editorText(page) {
  return page.ev(`(() => { const e = ${ED}; return e ? e.innerText : '' })()`)
}

async function editorMentions(page) {
  return page.ev('document.querySelectorAll(\'[data-mention="#"]\').length')
}

async function clickPoint(page, p) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0 })
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 })
}

async function pressEnter(page) {
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
}

/**
 * 挑一首配乐：打开右侧「选择音乐」面板 → 搜关键词 → 点第一条 → 点「使用」。
 * 返回页面上最终显示的曲目文案，用来回读确认。
 */
async function selectMusic(page, query) {
  const openAt = await page.ev(`(() => {
    const els = [...document.querySelectorAll('*')]
      .filter((e) => (e.textContent || '').trim() === '选择音乐' && e.children.length === 0 && e.getBoundingClientRect().width > 0)
    const el = els[els.length - 1]
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  if (!openAt) throw new NoteError('页面上没找到「选择音乐」入口', 'music')
  await clickPoint(page, openAt)
  await sleep(1400) // 面板是滑入动画：等它停稳再点，否则坐标会打在动画中间

  const box = await waitFor(() => page.ev(`(() => {
    const e = [...document.querySelectorAll('input')].find((x) => x.placeholder && x.placeholder.includes('搜索音乐'))
    if (!e) return null
    const r = e.getBoundingClientRect()
    if (r.width < 50) return null
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`), { timeout: 20000, label: '音乐面板' }).catch(() => {
    throw new NoteError('音乐面板没打开（点了「选择音乐」但没出现搜索框）', 'music')
  })

  await clickPoint(page, box)
  await sleep(300)

  // 焦点不一定落进搜索框（点击时机不对就会输进描述框），改用「原生 setter + input 事件」写入
  const typed = await page.ev(`(() => {
    const e = [...document.querySelectorAll('input')].find((x) => x.placeholder && x.placeholder.includes('搜索音乐'))
    if (!e) return null
    e.focus()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(e, ${JSON.stringify(String(query).trim())})
    e.dispatchEvent(new Event('input', { bubbles: true }))
    return e.value
  })()`)
  if (typed !== String(query).trim()) {
    await page.send('Input.insertText', { text: query })
  }
  await sleep(3200)

  const row = await waitFor(() => page.ev(`(() => {
    const q = ${JSON.stringify(String(query).trim())}
    const panel = [...document.querySelectorAll('div')]
      .find((d) => (d.innerText || '').includes('音乐封面以发布后播放页面展示为准') && d.getBoundingClientRect().width > 300)
    if (!panel) return null
    const rows = [...panel.querySelectorAll('div')].filter((d) => {
      if (!d.querySelector('img')) return false
      const t = (d.innerText || '').trim()
      if (!t.includes(q) || t.length > 120) return false
      const r = d.getBoundingClientRect()
      return r.width > 280 && r.width < 520 && r.height > 40 && r.height < 120 && r.y > 100 && r.y < window.innerHeight - 60
    })
    if (!rows.length) return null
    rows.sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y)
    const el = rows[0]
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80) }
  })()`), { timeout: 20000, label: `「${query}」的搜索结果` }).catch(() => {
    throw new NoteError(`搜「${query}」没搜到可用的音乐（换个关键词试试）`, 'music')
  })

  // 先移到行上（有的列表要 hover 才显示「使用」），再点
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y, button: 'none', buttons: 0 })
  await sleep(300)
  await clickPoint(page, row)
  await sleep(1200)

  const useAt = await waitFor(() => page.ev(`(() => {
    const b = [...document.querySelectorAll('*')]
      .filter((e) => (e.textContent || '').trim() === '使用' && e.children.length === 0 && e.getBoundingClientRect().width > 0)
    const el = b[b.length - 1]
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`), { timeout: 12000, label: '「使用」按钮' }).catch(() => {
    throw new NoteError('选中了音乐但没出现「使用」按钮', 'music')
  })
  await clickPoint(page, useAt)
  await sleep(1800)

  const applied = await waitFor(async () => {
    const t = await bodyText(page)
    return !t.includes('点击添加合适作品风格音乐') && !t.includes('音乐封面以发布后播放页面展示为准')
  }, { timeout: 15000, label: '音乐挂上' }).catch(() => false)
  if (!applied) throw new NoteError('点了「使用」但配乐没挂上（表单里还是「点击添加合适作品风格音乐」）', 'music')

  return page.ev(`(() => {
    const label = [...document.querySelectorAll('*')]
      .find((e) => (e.textContent || '').trim() === '选择音乐' && e.children.length === 0 && e.getBoundingClientRect().width > 0)
    if (!label) return ''
    let p = label.parentElement
    for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
      const t = (p.innerText || '').replace(/\\s+/g, ' ').trim()
      if (t.length > 8 && t !== '选择音乐') return t.replace(/^选择音乐\\s*/, '').slice(0, 120)
    }
    return ''
  })()`)
}

function saveShot(page, name) {
  return page.send('Page.captureScreenshot', { format: 'png' })
    .then((s) => {
      const file = join(ensureHome(), name)
      writeFileSync(file, Buffer.from(s.data, 'base64'))
      return file
    })
    .catch(() => null)
}

/* ───────────────────────── 入参校验 ───────────────────────── */

export function normalizeTags(tags) {
  if (tags === undefined || tags === null) return []
  if (!Array.isArray(tags)) throw new NoteError('tags 必须是字符串数组', 'validate')
  const out = []
  for (const raw of tags) {
    const s = String(raw ?? '').trim().replace(/^#+/, '').replace(/\s+/g, '')
    if (!s) continue
    if ([...s].length > MAX_TAG) throw new NoteError(`话题「${s}」太长了（最多 ${MAX_TAG} 字）`, 'validate')
    if (!out.includes(s)) out.push(s)
  }
  return out
}

export function validateInput({ images, title, desc, tags, visibility, music }) {
  if (!Array.isArray(images) || images.length === 0) {
    throw new NoteError('images 至少给 1 张图片（绝对路径）', 'validate')
  }
  if (images.length > MAX_IMAGES) {
    throw new NoteError(`最多 ${MAX_IMAGES} 张图片，这次给了 ${images.length} 张`, 'validate')
  }
  const files = images.map((p) => {
    const abs = resolve(String(p ?? ''))
    if (!existsSync(abs)) throw new NoteError(`图片不存在：${abs}`, 'validate')
    const st = statSync(abs)
    if (!st.isFile()) throw new NoteError(`不是文件：${abs}`, 'validate')
    const ext = extname(abs).toLowerCase()
    if (!ALLOWED_EXT.has(ext)) {
      throw new NoteError(`不支持的格式 ${ext || '(无扩展名)'}：${basename(abs)}（只收 jpg/jpeg/png/webp/bmp/tif，不支持 gif）`, 'validate')
    }
    if (st.size <= 0) throw new NoteError(`空文件：${abs}`, 'validate')
    if (st.size > MAX_FILE_BYTES) {
      throw new NoteError(`超过 50MB：${basename(abs)}（${(st.size / 1024 / 1024).toFixed(1)}MB）`, 'validate')
    }
    return { path: abs, name: basename(abs), size: st.size }
  })

  const t = String(title ?? '').trim()
  const d = String(desc ?? '').trim()
  if ([...t].length > MAX_TITLE) throw new NoteError(`标题最多 ${MAX_TITLE} 字，这次 ${[...t].length} 字（抖音会截断，不如先改短）`, 'validate')
  if ([...d].length > MAX_DESC) throw new NoteError(`描述最多 ${MAX_DESC} 字，这次 ${[...d].length} 字`, 'validate')

  const tagList = normalizeTags(tags)
  const vis = String(visibility || 'public')
  if (!VIS_LABEL[vis]) throw new NoteError(`visibility 只能是 public / friends / private，收到「${vis}」`, 'validate')
  const tune = String(music ?? '').trim()
  if ([...tune].length > 40) throw new NoteError(`音乐关键词最多 40 字，这次 ${[...tune].length} 字`, 'validate')

  const warnings = []
  if ([...t].length + [...d].length + tagList.reduce((n, x) => n + x.length + 2, 0) > MAX_DESC) {
    warnings.push('标题 + 描述 + 话题合计超过 1000 字，抖音可能截断')
  }

  return { files, title: t, desc: d, tags: tagList, visibility: vis, music: tune, warnings }
}

/** 只是给人看的预期文案（真正的判断用「包含」而不是全等） */
export function buildExpectedText({ title, desc, tags = [] } = {}) {
  const base = title ? (desc ? `${title}。${desc}` : title) : desc
  return [base, ...tags.map((t) => `#${t}`)].filter(Boolean).join(' ').trim()
}

/* ───────────────────────── 主流程 ───────────────────────── */

/**
 * 发一条图文。允许失败抛 NoteError（带 stage）。
 * @param {object} opts
 * @param {string[]} opts.images 本地绝对路径
 * @param {string} [opts.title]
 * @param {string} [opts.desc]
 * @param {string[]} [opts.tags] 不带 #
 * @param {'public'|'friends'|'private'} [opts.visibility]
 * @param {boolean} [opts.confirm] 必须由使用者当场同意才传 true；否则干跑
 * @returns {Promise<object>}
 */
export async function publishNote(opts = {}) {
  const input = validateInput(opts)
  requireScrollPlugin()
  const confirm = Boolean(opts.confirm)
  const started = Date.now()
  const warnings = [...input.warnings]
  let stage = 'init'
  let page = null
  let shot = null

  try {
    stage = 'browser'
    page = await openPage({ isolated: true, url: UPLOAD_URL })

    stage = 'navigate'
    await page.send('Page.navigate', { url: UPLOAD_URL })
    await waitFor(async () => {
      const href = String(await page.ev('location.href'))
      return href.includes('creator.douyin.com') && (await page.ev('document.readyState')) === 'complete'
    }, { timeout: 45000, label: '创作者中心打开' })
    await sleep(1800)

    stage = 'login'
    const login = await page.ev(`(() => {
      const t = document.body.innerText || ''
      return {
        href: location.href,
        blocked: /扫码登录|手机号登录|登录后可发布|请先登录/.test(t),
        sample: t.replace(/\\s+/g, ' ').slice(0, 160),
      }
    })()`)
    if (login.blocked) {
      throw new NoteError(
        '创作者中心没登录（共用 profile 里没有有效 Cookie，或登录已过期）。'
        + '先在「刷抖音」插件里扫码登录一次（会复用同一个浏览器 profile），再回来重试。',
        'login',
        { href: login.href },
      )
    }

    stage = 'tab'
    const tabHits = await page.ev(`(() => {
      const hits = [...document.querySelectorAll('div,span,a,button,li')]
        .filter((e) => (e.innerText || '').trim() === '发布图文' && e.getBoundingClientRect().width > 0)
      const el = hits[hits.length - 1]
      if (!el) return 0
      el.click()
      return hits.length
    })()`)
    if (!tabHits) {
      throw new NoteError('没找到「发布图文」入口（账号没有图文权限，或页面结构变了）', 'tab', { page: (await bodyText(page)).slice(0, 240) })
    }
    await sleep(2200)

    stage = 'file-input'
    const objectId = await waitFor(async () => {
      const r = await page.send('Runtime.evaluate', {
        expression: "[...document.querySelectorAll('input[type=file]')].find(e => String(e.accept||'').includes('image/'))",
        objectGroup: 'douyin-note',
      })
      return r.result?.objectId || null
    }, { timeout: 30000, label: '图片上传控件' })

    stage = 'upload'
    await page.send('DOM.setFileInputFiles', { files: input.files.map((f) => f.path), objectId })
    await waitFor(
      () => page.ev(`!!document.querySelector('input[placeholder="添加作品标题"]')`),
      { timeout: 120000, label: '图片上传完成、编辑器出现' },
    )
    await waitFor(
      async () => (await bodyText(page)).includes(`已添加${input.files.length}张图片`),
      { timeout: 120000, label: `${input.files.length} 张图都上传完` },
    ).catch(async (e) => {
      const text = await bodyText(page)
      const bad = /上传失败|格式不支持|大小超过|数量超过|网络异常/.test(text)
      throw new NoteError(
        bad ? `图片上传被拒：${text.slice(0, 220)}` : `图片上传超时（编辑器出来了，但没看到「已添加${input.files.length}张图片」）`,
        'upload',
        { page: text.slice(0, 240) },
      )
    })
    await sleep(900)

    if (input.title) {
      stage = 'title'
      const applied = await page.ev(`(() => {
        const inp = document.querySelector('input[placeholder="添加作品标题"]')
        if (!inp) return null
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(inp, ${JSON.stringify(input.title)})
        inp.dispatchEvent(new Event('input', { bubbles: true }))
        return inp.value
      })()`)
      if (applied !== input.title) {
        throw new NoteError(`标题没填进去（输入框返回「${applied}」）`, 'title')
      }
    }

    if (input.desc || input.tags.length) {
      stage = 'desc'
      await page.ev(`(() => { const e = ${ED}; if (!e) return false; e.scrollIntoView({ block: 'center' }); e.focus(); return true })()`)
      if (input.desc) {
        await page.send('Input.insertText', { text: input.desc })
        await sleep(400)
      }
      stage = 'tags'
      for (const tag of input.tags) {
        const cur = await editorText(page)
        const needSpace = cur.length > 0 && !/ $/.test(cur)
        await page.send('Input.insertText', { text: (needSpace ? ' ' : '') + '#' + tag })
        await sleep(350)
        await pressEnter(page)
        await sleep(450)
      }
      if (input.tags.length) {
        const n = await editorMentions(page)
        if (n < input.tags.length) {
          warnings.push(`话题实体只生成了 ${n}/${input.tags.length} 个 —— 没变成实体的会留成普通文字`)
        }
        await sleep(300)
      }
      const filled = await editorText(page)
      if (input.desc && !norm(filled).includes(norm(input.desc))) {
        throw new NoteError('描述没填进去（编辑器里读不到这段文字）', 'desc', { got: norm(filled).slice(0, 160) })
      }
    }

    if (input.music) {
      stage = 'music'
      const picked = await selectMusic(page, input.music)
      warnings.push(`配乐已挂上：${picked || input.music}（页面显示）`)
      await sleep(400)
    }

    if (input.visibility !== 'public') {
      stage = 'visibility'
      const label = VIS_LABEL[input.visibility]
      await page.ev('window.scrollTo(0, document.body.scrollHeight)')
      await sleep(700)
      const found = await page.ev(`(() => {
        const els = [...document.querySelectorAll('div,span,label')]
          .filter((e) => (e.innerText || '').trim() === ${JSON.stringify(label)} && e.getBoundingClientRect().width > 0)
        const el = els[els.length - 1]
        if (!el) return 0
        el.scrollIntoView({ block: 'center' })
        return els.length
      })()`)
      if (!found) throw new NoteError(`页面上没找到可见性选项「${label}」`, 'visibility')
      await sleep(500)
      const pt = await page.ev(`(() => {
        const els = [...document.querySelectorAll('div,span,label')]
          .filter((e) => (e.innerText || '').trim() === ${JSON.stringify(label)} && e.getBoundingClientRect().width > 0)
        const el = els[els.length - 1]
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      })()`)
      if (!pt) throw new NoteError(`可见性选项「${label}」定位失败`, 'visibility')
      await clickPoint(page, pt)
      await sleep(900)
      const checked = await page.ev(`(() => {
        return [...document.querySelectorAll('input.radio-native-p6VBGt, input[type=radio]')]
          .filter((e) => e.checked && e.getBoundingClientRect().width > 0)
          .map((e) => e.value + '|' + ((e.parentElement?.innerText || '').trim()))
      })()`)
      if (!checked.some((x) => x.startsWith(VIS_VALUE[input.visibility] + '|') && x.includes(label))) {
        throw new NoteError(`可见性没切到「${label}」（当前：${checked.join(' / ')}）—— 为安全起见不发布`, 'visibility', { checked })
      }
    }

    stage = 'publish'
    await page.ev('window.scrollTo(0, document.body.scrollHeight)')
    await sleep(800)
    await page.send('Network.enable')

    const pausedD = deferred()
    const respD = deferred()
    let netId = null
    let netStatus = null

    page.on('Fetch.requestPaused', (ev) => pausedD.resolve(ev))
    page.on('Network.responseReceived', (p) => {
      const url = String(p.response?.url || '')
      if (url.includes(CREATE_URL_MARK)) { netId = p.requestId; netStatus = p.response?.status ?? null }
    })
    const collectBody = (p) => {
      if (!netId || p.requestId !== netId) return
      page.send('Network.getResponseBody', { requestId: p.requestId })
        .then((r) => respD.resolve({ status: netStatus, body: r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body }))
        .catch((e) => respD.reject(e))
    }
    page.on('Network.loadingFinished', collectBody)
    page.on('Network.loadingFailed', (p) => {
      if (netId && p.requestId === netId) respD.reject(new NoteError('发布请求被浏览器判为失败（可能被拦截或断网）', 'publish'))
    })

    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*create_v2*', requestStage: 'Request' }] })

    const btn = await page.ev(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').trim() === '发布' && x.getBoundingClientRect().width > 0)
      if (!b) return null
      b.scrollIntoView({ block: 'center' })
      const r = b.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })()`)
    if (!btn) throw new NoteError('没找到「发布」按钮', 'publish', { page: (await bodyText(page)).slice(0, 240) })
    await clickPoint(page, btn)

    const paused = await withTimeout(pausedD, 45000, '点了「发布」45 秒内没看到 create_v2 请求（可能被弹窗挡住了，或者页面改了）')
      .catch(async (e) => {
        throw new NoteError(e.message, 'publish', { page: (await bodyText(page)).slice(0, 300) })
      })

    let payload
    try { payload = JSON.parse(String(paused.request?.postData || '')) } catch {
      await page.send('Fetch.failRequest', { requestId: paused.requestId, errorReason: 'BlockedByClient' }).catch(() => {})
      throw new NoteError('发布请求体不是 JSON —— 不认识的页面版本，已拦下', 'publish')
    }

    const item = payload?.item?.common || {}
    const actualText = norm(item.text)
    const actualImages = Array.isArray(item.images) ? item.images.length : 0
    const problems = []
    if (input.title && !actualText.includes(norm(input.title))) problems.push(`请求里没有标题「${input.title}」`)
    if (input.desc && !actualText.includes(norm(input.desc))) problems.push('请求里没有描述原文')
    for (const tag of input.tags) if (!actualText.includes('#' + tag)) problems.push(`请求里没有话题 #${tag}`)
    if (actualImages !== input.files.length) problems.push(`请求里是 ${actualImages} 张图，本地是 ${input.files.length} 张`)
    if (input.music && !item.music_id) problems.push('请求里没有 music_id（配乐没挂上）')

    const visibilityType = item.visibility_type
    const preview = {
      text: actualText,
      image_count: actualImages,
      media_type: item.media_type ?? null,
      visibility_type: visibilityType ?? null,
      visibility: Object.keys(VIS_VALUE).find((k) => VIS_VALUE[k] === String(visibilityType)) || null,
      download: item.download ?? null,
      music_id: item.music_id ? String(item.music_id) : null,
      music_end_time: item.music_end_time ?? null,
    }

    if (problems.length) {
      await page.send('Fetch.failRequest', { requestId: paused.requestId, errorReason: 'BlockedByClient' }).catch(() => {})
      shot = await saveShot(page, 'last-error.png')
      throw new NoteError(`发布请求和本地内容对不上，已拦下：${problems.join('；')}`, 'verify', { preview, screenshot: shot })
    }

    if (!confirm) {
      await page.send('Fetch.failRequest', { requestId: paused.requestId, errorReason: 'BlockedByClient' }).catch(() => {})
      shot = await saveShot(page, 'last-preview.png')
      const record = {
        at: new Date().toISOString(),
        ok: true,
        dry_run: true,
        aweme_id: null,
        title: input.title || null,
        desc: input.desc || null,
        tags: input.tags,
        visibility: input.visibility,
        images: input.files.length,
        music: input.music || null,
        text: actualText,
      }
      appendPublish(record)
      return {
        ok: true,
        published: false,
        dry_run: true,
        message: '干跑完成：表单已填好、也点了「发布」，但 create 请求在浏览器里被拦下，**没有真的发出去**。核对下面的 text / 图片数，确认无误后由使用者当场同意，再带 confirm:true 调一次。',
        text: actualText,
        image_count: actualImages,
        visibility: preview.visibility,
        visibility_type: preview.visibility_type,
        music_id: preview.music_id,
        music_end_time: preview.music_end_time,
        warnings,
        screenshot: shot,
        elapsed_ms: Date.now() - started,
      }
    }

    await page.send('Fetch.continueRequest', { requestId: paused.requestId })
    const resp = await withTimeout(respD, 45000, '发布请求已放行，但 45 秒内没拿到回包')
    let json = null
    try { json = JSON.parse(String(resp.body || '')) } catch { /* 非 JSON 回包也照样报出来 */ }

    const code = json?.status_code ?? json?.code ?? json?.data?.status_code ?? null
    const message = json?.status_msg ?? json?.message ?? json?.msg ?? json?.data?.status_msg ?? ''
    const awemeId = json?.aweme_id ?? json?.item_id ?? json?.data?.aweme_id ?? json?.data?.item_id ?? json?.data?.aweme?.aweme_id ?? null
    const ok = code === 0 || (code === null && Boolean(awemeId))
    shot = await saveShot(page, ok ? 'last-publish.png' : 'last-error.png')

    appendPublish({
      at: new Date().toISOString(),
      ok,
      dry_run: false,
      aweme_id: awemeId ? String(awemeId) : null,
      title: input.title || null,
      desc: input.desc || null,
      tags: input.tags,
      visibility: input.visibility,
      images: input.files.length,
      music: input.music || null,
      music_id: preview.music_id,
      text: actualText,
      http_status: resp.status,
      code,
      message: message || null,
    })

    if (!ok) {
      throw new NoteError(
        `抖音拒绝了发布：${message || `code=${code === null ? '(空)' : code}`}（HTTP ${resp.status}）`,
        'publish',
        { response: json, screenshot: shot },
      )
    }

    return {
      ok: true,
      published: true,
      dry_run: false,
      aweme_id: awemeId ? String(awemeId) : null,
      url: awemeId ? `https://www.douyin.com/note/${awemeId}` : null,
      text: actualText,
      image_count: actualImages,
      visibility: preview.visibility,
      visibility_type: preview.visibility_type,
      music_id: preview.music_id,
      warnings,
      screenshot: shot,
      elapsed_ms: Date.now() - started,
    }
  } catch (err) {
    if (!(err instanceof NoteError)) {
      err = new NoteError(String(err?.message || err), stage)
    } else if (!err.stage) {
      err.stage = stage
    }
    if (page) {
      try { err.detail = { ...(err.detail || {}), screenshot: err.detail?.screenshot || await saveShot(page, 'last-error.png') } } catch { /* 截图不是重点 */ }
      try {
        if (!err.detail?.page) err.detail = { ...(err.detail || {}), page: (await bodyText(page)).slice(0, 300) }
      } catch { /* 页面可能已经关了 */ }
    }
    throw err
  } finally {
    if (page) { try { await page.close() } catch { /* 关不掉就算了 */ } }
  }
}

/* ───────────────────────── 体检 ───────────────────────── */

/** 打开创作者中心看一眼登录态（会起/复用无头浏览器） */
export async function probeCreator() {
  requireScrollPlugin()
  const page = await openPage({ isolated: true, url: UPLOAD_URL })
  try {
    await page.send('Page.navigate', { url: UPLOAD_URL })
    await waitFor(async () => (await page.ev('document.readyState')) === 'complete', { timeout: 30000, label: '创作者中心打开' })
    await sleep(1500)
    return await page.ev(`(() => {
      const t = document.body.innerText || ''
      return {
        href: location.href,
        logged_in: !/扫码登录|手机号登录|登录后可发布|请先登录/.test(t),
        body: t.replace(/\\s+/g, ' ').slice(0, 120),
      }
    })()`)
  } finally {
    await page.close().catch(() => {})
  }
}
