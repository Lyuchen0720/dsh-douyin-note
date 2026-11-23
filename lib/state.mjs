/**
 * lib/state.mjs —— 发布记录（给 douyin_note_status 看）
 * ============================================================================
 * 只记「发过什么」，最多留 30 条。所有字段都可能是 null —— 拿不到就写 null，
 * 不编。写在 `$DSH_HOME/douyin-note/state.json`。
 * ============================================================================
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { ensureHome, stateFile } from './paths.mjs'

export function readState() {
  try {
    const j = JSON.parse(readFileSync(stateFile(), 'utf8'))
    if (j && typeof j === 'object') return { publishes: [], ...j }
  } catch { /* 没有 / 坏了都当空 */ }
  return { publishes: [] }
}

export function writeState(next) {
  try {
    ensureHome()
    const tmp = stateFile() + '.tmp'
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, stateFile())
  } catch { /* 记录失败不影响发布本身 */ }
}

/** 记一条；返回更新后的 state */
export function appendPublish(record) {
  const state = readState()
  const list = Array.isArray(state.publishes) ? state.publishes : []
  state.publishes = [record, ...list].slice(0, 30)
  state.updated_at = new Date().toISOString()
  writeState(state)
  return state
}
