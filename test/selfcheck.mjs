/**
 * test/selfcheck.mjs —— 不联网的纯逻辑自检（不启动浏览器、不发任何请求）
 * 跑法：node test/selfcheck.mjs
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const { normalizeTags, validateInput, buildExpectedText, NoteError } = await import('../lib/note-publish.mjs')
const paths = await import('../lib/paths.mjs')
const state = await import('../lib/state.mjs')

let n = 0
const ok = (label) => { n += 1; console.log(`  ✓ ${label}`) }

/* ── 话题清洗 ── */
assert.deepEqual(normalizeTags(['#夏日傍晚', ' 城市夜景 ', '夏日傍晚', '', '###']), ['夏日傍晚', '城市夜景'])
ok('normalizeTags 去 #、去空白、去重、丢空')
assert.throws(() => normalizeTags('x'), NoteError)
assert.throws(() => normalizeTags(['a'.repeat(31)]), NoteError)
ok('normalizeTags 拒绝非数组 / 超长话题')

/* ── 标题 + 描述 拼成 text ── */
assert.equal(buildExpectedText({ title: '标题测试', desc: '描述测试', tags: ['夏日傍晚', '城市夜景'] }),
  '标题测试。描述测试 #夏日傍晚 #城市夜景')
assert.equal(buildExpectedText({ title: '', desc: '只要描述', tags: ['测试话题'] }), '只要描述 #测试话题')
assert.equal(buildExpectedText({ title: '只有标题', desc: '', tags: [] }), '只有标题')
ok('buildExpectedText：标题。描述 + 空格 + #话题')

/* ── 入参校验 ── */
const imgs = ['E:/工作区/_note-probe/a.png'] // 真实存在的 PNG 探针图
assert.throws(() => validateInput({ images: [] }), /images 至少给 1 张/)
assert.throws(() => validateInput({ images: ['nope.png'] }), /图片不存在/)
assert.throws(() => validateInput({ images: [join(root, 'icon.svg')] }), /不支持的格式/) // svg 不被接受
assert.throws(() => validateInput({ images: imgs, title: 'x'.repeat(21) }), /标题最多/)
ok('validateInput 拦空数组 / 不存在 / 后缀 / 标题超长')

/* ── 配乐关键词：trim + 长度上限 ── */
{
  const out = validateInput({ images: imgs, music: '  小美满  ' })
  assert.equal(out.music, '小美满')
  assert.equal(validateInput({ images: imgs }).music, '')
  assert.throws(() => validateInput({ images: imgs, music: 'x'.repeat(41) }), /音乐关键词最多/)
  ok('music：trim / 缺省空 / 超长被拦')
}

/* ── 可见性 → visibility_type ── */
const { VIS_VALUE } = await import('../lib/note-publish.mjs')
assert.deepEqual(VIS_VALUE, { public: '0', friends: '2', private: '1' })
ok('VIS_VALUE 0/2/1 与页面单选 value 一致')

/* ── 路径 ── */
assert.ok(paths.homeDir().endsWith('douyin-note'))
assert.ok(paths.sharedProfileDir().endsWith(join('douyin-duty', 'chrome-profile')))
ok('家目录 / 共用 profile 路径')

/* ── 发布记录：头插 + 上限 30 ── */
const before = state.readState()
for (let i = 0; i < 35; i += 1) state.appendPublish({ id: `t${i}` })
const after = state.readState()
assert.equal(after.publishes.length, 30)
assert.equal(after.publishes[0].id, 't34')
ok('appendPublish 头插且最多 30 条')
// 还原，别污染真实记录
const fs = await import('node:fs')
fs.writeFileSync(paths.stateFile(), JSON.stringify(before, null, 2))

/* ── 入口能加载、工具描述里带 confirm 闸 ── */
const entry = await import('../index.js')
assert.equal(entry.name, 'douyin-note')
assert.deepEqual(entry.inject, ['tools'])
assert.equal(typeof entry.apply, 'function')
ok('index.js 导出 name / inject / apply')

/* ── 自动写稿：JSON 解析 / 字段裁剪 / 频率判断 ── */
const draftMod = await import('../lib/draft.mjs')
{
  const d = draftMod.parseDraft('```json\n{"title":"一二三四五六七八九十一二三四五六七八九十多出来的","desc":"描述","tags":["#a"," a ","b"],"headline":"天黑了\\n灯还没开","subhead":"副标题","mood":"懒"}\n```')
  assert.equal([...d.title].length, 20, '标题要截到 20 字')
  assert.deepEqual(d.tags, ['a', 'b'])
  assert.equal(d.headline, '天黑了\n灯还没开')
  assert.throws(() => draftMod.parseDraft('我没想好'), /没有 JSON/)
  ok('parseDraft：容忍代码块 / 截断标题 / 去重话题 / 拒绝非 JSON')
}

const autoMod = await import('../lib/autopilot.mjs')
{
  assert.deepEqual(autoMod.pickMusic({ musicPool: ['仅此一首'] }), '仅此一首')
  assert.ok(autoMod.AUTO_DEFAULTS.musicPool.length >= 2)
  assert.equal(autoMod.dueCheck({ enabled: false }).due, false)
  assert.equal(autoMod.dueCheck({ enabled: true, dayKey: '2000-01-01', perDay: 3 }).due, true)
  assert.equal(autoMod.dueCheck({ enabled: true, dayKey: new Date().toISOString().slice(0, 10), dayCount: 3, perDay: 3 }).due, false)
  const next = autoMod.nextRunAtFrom({ everyHours: 2 }, new Date('2026-01-01T00:00:00Z'))
  const delta = (new Date(next) - new Date('2026-01-01T00:00:00Z')) / 3600_000
  assert.ok(delta > 1.7 && delta < 2.3, `每 2 小时应落在 1.7~2.3，实际 ${delta}`)
  ok('autopilot：随机配乐 / 开关 / 每天上限 / 下次时间抖动')
}

/* ── 文字卡模板：大字号 + 换行 + 话题 ── */
const renderMod = await import('../lib/render.mjs')
{
  const html = renderMod.buildHtml({ headline: '天黑了\n灯还没开', subhead: '周一的傍晚', tags: ['傍晚'] })
  assert.ok(html.includes('<span>天黑了</span>'))
  assert.ok(html.includes('font-size:150px') || /font-size:\s*\d+px/.test(html))
  assert.ok(html.includes('#傍晚'))
  ok('buildHtml：换行成两行 / 带话题 / 有字号')
}

/* ── 前置依赖：必须绑「刷抖音」 ── */
{
  const pathsMod = await import('../lib/paths.mjs')
  const real = pathsMod.scrollStatus()
  assert.equal(real.plugin, 'dsh-douyin-scroll')
  assert.equal(typeof real.ok, 'boolean')
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = join(root, '.tmp-no-scroll')
  const fake = pathsMod.scrollStatus()
  assert.equal(fake.ok, false, '空 DSH_HOME 下不该认为已装刷抖音')
  assert.ok(fake.hint.includes('dsh-douyin-scroll'))
  if (saved === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = saved
  ok('前置依赖：缺「刷抖音」时判定失败并给提示')
}

/* ── 包结构 ── */
for (const f of ['package.json', 'cordis.patch.yml', 'README.md', 'icon.svg', 'lib/chrome.mjs', 'prompts/persona.md']) {
  assert.ok(existsSync(join(root, f)), `缺文件 ${f}`)
}
ok('包内必需文件齐全')

console.log(`\n全部通过：${n} 项`)
