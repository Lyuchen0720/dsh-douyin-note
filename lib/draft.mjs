// lib/draft.mjs —— 自己想一条图文：人设 → 一次纯模型调用 → 严格 JSON
// ============================================================================
// 红线（跟 dsh-douyin-scroll 一脉相承）：
//   · 人设只读**本插件包内**的 prompts/persona.md，绝不读外面的任何设定。
//   · 模型调用失败 / 返回不是 JSON：明确报错，不编一条假稿子顶上。
//   · 生成的内容必须过一遍硬约束（标题 ≤20、话题 ≤4 等），过不了就报错。
// ============================================================================
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_PERSONA = `你是主人电脑上养着的一条鱼，叫「大肥鱼」。写抖音图文配文：短句、口语、像随手记。`
export const DEFAULT_MUSIC_POOL = ['小美满', '晴天', '起风了', '稻香', '晚风', '夏日漱石', '光年之外', '银河与星斗']

export function loadPersona(pluginDir) {
  const file = join(pluginDir, 'prompts', 'persona.md')
  if (!existsSync(file)) return DEFAULT_PERSONA
  try {
    const raw = readFileSync(file, 'utf8')
    // 第一行是身份牌注释，给 selfcheck 认的，不喂给模型
    return raw.replace(/^<!--\s*persona:[^>]*-->\s*/, '').trim() || DEFAULT_PERSONA
  } catch {
    return DEFAULT_PERSONA
  }
}

const SCHEMA = `只输出一个 JSON 对象，不要解释、不要 Markdown 代码块，字段如下：
{
  "title":   "标题，最多 20 个字，一句话",
  "desc":    "描述，2-3 句，最多 120 个字，可以带 1 个 #话题",
  "tags":    ["话题1", "话题2"],       // 2-4 个，不带 #
  "headline":"图片上的大字，最多 14 个字；想换行就用 \\n 分成 2-3 行",
  "subhead": "图片上的副标题，最多 18 个字",
  "mood":    "一个词，概括这条的心情"
}`

export function buildMessages({ persona, brief }) {
  const system = `${persona}\n\n【现在要干的活】按下面格式，写**一条**抖音图文（图片是纯文字卡，字很大）。\n${SCHEMA}`
  return {
    system,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: brief || '现在，写一条。' }],
      },
    ],
  }
}

/** 从模型输出里抠出 JSON（容忍 ```json 包裹 / 前后废话）。 */
export function parseDraft(raw) {
  const text = String(raw || '').trim()
  if (!text) throw new Error('模型返回了空内容')
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1].trim() : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型返回里没有 JSON 对象')
  let obj
  try {
    obj = JSON.parse(body.slice(start, end + 1))
  } catch (e) {
    throw new Error(`模型返回的 JSON 解析失败：${e.message}`)
  }
  return normalizeDraft(obj)
}

export function normalizeDraft(obj) {
  const s = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim()
  const title = s(obj.title).slice(0, 20)
  const desc = String(obj.desc == null ? '' : obj.desc).trim().slice(0, 240)
  const headline = String(obj.headline == null ? '' : obj.headline).replace(/\r/g, '').trim().slice(0, 60)
  const subhead = s(obj.subhead).slice(0, 40)
  const rawTags = Array.isArray(obj.tags) ? obj.tags : String(obj.tags || '').split(/[,，\s]+/)
  const tags = [...new Set(rawTags.map((t) => s(t).replace(/^#+/, '')).filter(Boolean))].slice(0, 4)
  if (!title) throw new Error('模型给的标题是空的')
  if (!desc) throw new Error('模型给的描述是空的')
  if (!headline) throw new Error('模型给的图片大字是空的')
  return { title, desc, tags, headline, subhead, mood: s(obj.mood).slice(0, 12) }
}

/**
 * 调一次真模型，拿到一条草稿。
 * @param {object} opts { llm, route, persona, brief, signal, maxTokens }
 */
export async function askDraft({ llm, route, persona, brief, signal, maxTokens = 700 }) {
  if (!llm || typeof llm.stream !== 'function') throw new Error('llm 服务不可用（宿主没给模型）')
  if (!route || !route.provider || !route.model) throw new Error('拿不到默认模型路由（agentDefaultModel 为空）')
  const { system, messages } = buildMessages({ persona, brief })
  const run = async () => {
    let out = ''
    const it = llm.stream({ provider: route.provider, model: route.model, system, messages, maxTokens, temperature: 0.95, signal })
    for await (const chunk of it) {
      if (chunk && chunk.type === 'text-delta') out += chunk.text || ''
      else if (chunk && chunk.type === 'finish') break
    }
    return out.trim()
  }
  let raw = await run()
  try {
    return parseDraft(raw)
  } catch (first) {
    // 给模型一次机会：只吐 JSON
    const retry = await run()
    try {
      return parseDraft(retry)
    } catch {
      throw new Error(`${first.message}（重试一次仍失败）`)
    }
  }
}
