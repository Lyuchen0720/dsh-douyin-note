/**
 * 管理员名单：主人可以在设置页里指定「哪些抖音号能对我下指令」，并且逐项勾权限。
 *
 * 文件落在「刷抖音」的家目录里（`$DSH_HOME/douyin-duty/admin.json`），
 * 因为读它的是刷抖音插件的私信转达逻辑；本插件只负责写入。
 *
 * 形状：
 * {
 *   "admins": [
 *     { "sec_uid": "MS4w...", "nick": "古代学者克莱恩",
 *       "perms": { "post": true, "reply": true, "delete": false, "config": false, "read": true } }
 *   ],
 *   "updated_at": "2026-11-24T...",
 *   "note": "由「抖音图文」插件设置页维护"
 * }
 * 兼容旧形状 { "uids": [...] }（等于全权限）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from './paths.mjs'

/** 权限项：键是存储用的英文名，值是给人看的标签（顺序即界面顺序）。 */
export const PERMS = {
  post: '发图文',
  reply: '回评论',
  delete: '删作品',
  config: '改设置 / 频率',
  read: '查状态',
}

export const allPerms = () => Object.fromEntries(Object.keys(PERMS).map((k) => [k, true]))

/** admin.json 的绝对路径。 */
export function adminFile() {
  return join(dshHome(), 'douyin-duty', 'admin.json')
}

function normalizePerms(raw) {
  const out = {}
  for (const k of Object.keys(PERMS)) out[k] = raw?.[k] !== false
  return out
}

function normalizeAdmin(a) {
  const sec_uid = String(a?.sec_uid || a?.uid || '').trim()
  if (!sec_uid) return null
  return { sec_uid, nick: String(a?.nick || '').trim(), perms: normalizePerms(a?.perms) }
}

/** 读名单。文件不存在 / 坏掉都返回 ok:false，但 admins 仍是空数组（= 没人被授权）。 */
export function readAdmins() {
  const file = adminFile()
  try {
    const j = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    const list = Array.isArray(j?.admins) ? j.admins : []
    let admins = list.map(normalizeAdmin).filter(Boolean)
    const legacy = !list.length && Array.isArray(j?.uids)
    if (legacy) admins = j.uids.map((u) => normalizeAdmin({ sec_uid: u })).filter(Boolean)
    return {
      ok: true,
      file,
      admins,
      legacy,
      updated_at: j?.updated_at || null,
      perms_vocab: PERMS,
    }
  } catch (e) {
    return {
      ok: false,
      file,
      admins: [],
      legacy: false,
      updated_at: null,
      perms_vocab: PERMS,
      error: existsSync(file) ? String(e?.message || e) : '还没配置过管理员',
    }
  }
}

/** 整份覆盖写入（界面是「编辑后整体保存」的模型）。返回读回的结果。 */
export function writeAdmins(list) {
  const admins = (Array.isArray(list) ? list : []).map(normalizeAdmin).filter(Boolean)
  const seen = new Set()
  const unique = admins.filter((a) => (seen.has(a.sec_uid) ? false : seen.add(a.sec_uid)))
  const file = adminFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(
    file,
    JSON.stringify(
      {
        admins: unique,
        updated_at: new Date().toISOString(),
        note: '由「抖音图文」插件设置页维护；刷抖音的私信转达会按这里的权限判断指令',
      },
      null,
      2,
    ) + '\n',
    'utf8',
  )
  return readAdmins()
}

/** 从刷抖音的 config.json 里取出聊过的人，界面上可以直接勾选，不用手抄 sec_uid。 */
export function knownPeers() {
  try {
    const j = JSON.parse(readFileSync(join(dshHome(), 'douyin-duty', 'config.json'), 'utf8').replace(/^\uFEFF/, ''))
    const list = Array.isArray(j?.dmPeers) ? j.dmPeers : []
    return list
      .map((p) => ({ sec_uid: String(p?.sec_uid || '').trim(), nick: String(p?.nick || '').trim() }))
      .filter((p) => p.sec_uid)
  } catch {
    return []
  }
}
