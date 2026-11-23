/**
 * lib/paths.mjs —— 这个插件的「家」在哪、浏览器 profile 用哪个
 * ============================================================================
 * 两件事：
 *   ① 自己的运行数据放 `$DSH_HOME/douyin-note/`（state.json / runtime.json /
 *      出错截图），**不写进插件包目录**。
 *   ② 无头浏览器默认**共用「刷抖音」插件的 profile**
 *      （`$DSH_HOME/douyin-duty/chrome-profile`）—— 创作者中心跟 www.douyin.com
 *      共用一份 `.douyin.com` Cookie，共用 profile 就等于「已经登录」。
 *      想隔离就设 `DOUYIN_NOTE_PROFILE` 指向另一个目录（但那样要重新登录）。
 *
 * ⚠️ 同一个 user-data-dir 不能起两个 Chrome。共用 profile 时如果「刷抖音」那边
 *    正在跑浏览器，这边会**复用同一个 CDP 端口**（见 chrome.mjs 的 pickPort）。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** DSH 的家（跟宿主同一套规则） */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 本插件自己的家 */
export function homeDir() {
  return process.env.DOUYIN_NOTE_HOME || join(dshHome(), 'douyin-note')
}

export function ensureHome() {
  mkdirSync(homeDir(), { recursive: true })
  return homeDir()
}

/** 「刷抖音」插件家目录（共用登录态的约定位置） */
export function douyinDutyHome() {
  return join(dshHome(), 'douyin-duty')
}

/** 「刷抖音」插件的浏览器 profile —— 登录态就住在这里 */
export function sharedProfileDir() {
  return join(douyinDutyHome(), 'chrome-profile')
}

/**
 * 无头浏览器用哪个 profile：
 *   ① 环境变量 DOUYIN_NOTE_PROFILE（显式指定，最高优先）
 *   ② 「刷抖音」的 profile 存在就共用（默认 = 免登录）
 *   ③ 都没有 ⇒ 自己的 chrome-profile（第一次要扫码登录）
 */
export function profileDir() {
  const env = String(process.env.DOUYIN_NOTE_PROFILE || '').trim()
  if (env) return env
  const shared = sharedProfileDir()
  return existsSync(shared) ? shared : join(homeDir(), 'chrome-profile')
}

export function usesSharedProfile() {
  return profileDir() === sharedProfileDir()
}

/**
 * 「刷抖音」插件在不在、登录态有没有。
 * 本插件**必须**跟它绑在一起用（见 README 的「前置依赖」）：
 * 发布走的就是它那套已经登录过的 headless Chrome profile。
 */
export function scrollStatus() {
  const home = douyinDutyHome()
  const profile = sharedProfileDir()
  const markers = ['config.json', 'account.json', 'duty.log', 'health.json', 'chrome-profile'].filter((m) =>
    existsSync(join(home, m)),
  )
  const hasProfile = existsSync(profile)
  return {
    ok: markers.length > 0 && hasProfile,
    plugin: 'dsh-douyin-scroll',
    home,
    profile,
    markers,
    has_profile: hasProfile,
    cookie: existsSync(join(home, 'douyin_cookie.txt')),
    hint: hasProfile
      ? ''
      : `没有找到 ${profile}。先装「刷抖音」插件（dsh-douyin-scroll）并登录一次，本插件会复用它那份登录态。`,
  }
}

export function runtimeFile() {
  return join(homeDir(), 'runtime.json')
}

export function stateFile() {
  return join(homeDir(), 'state.json')
}

export function readRuntime() {
  try {
    const j = JSON.parse(readFileSync(runtimeFile(), 'utf8'))
    return j && typeof j === 'object' ? j : {}
  } catch {
    return {}
  }
}

/** 原子写：先写 .tmp 再 rename，半截文件不会把下次启动搞崩 */
export function writeRuntime(patch) {
  try {
    ensureHome()
    const next = { ...readRuntime(), ...patch, updated_at: new Date().toISOString() }
    const tmp = runtimeFile() + '.tmp'
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, runtimeFile())
    return next
  } catch {
    return {}
  }
}
