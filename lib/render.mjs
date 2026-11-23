// lib/render.mjs —— 把一条草稿渲染成 1080×1440 的文字卡（用已在跑的无头浏览器截图，不引第三方库）
// ============================================================================
import { writeFileSync } from 'node:fs'

export const IMAGE_W = 1080
export const IMAGE_H = 1440

const THEMES = [
  { a: '#101a33', b: '#4a1440', g1: 'rgba(255,92,122,.55)', g2: 'rgba(60,190,255,.42)', accent: '#ffd678' },
  { a: '#0a2028', b: '#12143a', g1: 'rgba(255,190,80,.5)', g2: 'rgba(80,255,205,.35)', accent: '#ffc86b' },
  { a: '#1b1030', b: '#0d2b33', g1: 'rgba(150,120,255,.5)', g2: 'rgba(90,255,220,.32)', accent: '#ffb3d9' },
  { a: '#2a1208', b: '#121a28', g1: 'rgba(255,140,70,.5)', g2: 'rgba(120,170,255,.35)', accent: '#ffe1a8' },
  { a: '#08161b', b: '#241032', g1: 'rgba(90,220,255,.45)', g2: 'rgba(255,110,180,.4)', accent: '#b9f2ff' },
]

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

function pickTheme(seed) {
  let h = 0
  const s = String(seed || '')
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return THEMES[h % THEMES.length]
}

function sizeFor(lines) {
  const longest = Math.max(...lines.map((l) => [...l].length), 1)
  if (lines.length <= 1) return longest <= 6 ? 170 : longest <= 9 ? 140 : 112
  if (lines.length === 2) return longest <= 6 ? 150 : longest <= 9 ? 124 : 100
  return longest <= 6 ? 128 : longest <= 9 ? 106 : 88
}

export function buildHtml({ headline, subhead, tags = [], top = '抖音 · 图文', footer = '大肥鱼 · 随手记' }) {
  const lines = String(headline || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const fs = sizeFor(lines.length ? lines : [''])
  const th = pickTheme(headline + subhead)
  const chips = tags
    .slice(0, 4)
    .map((t) => `<span class="chip">#${esc(t)}</span>`)
    .join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:${IMAGE_W}px; height:${IMAGE_H}px; overflow:hidden; }
  body {
    font-family:"Microsoft YaHei","PingFang SC",sans-serif;
    background:linear-gradient(160deg, ${th.a} 0%, ${th.b} 100%);
    color:#fff; position:relative;
  }
  .glow { position:absolute; border-radius:50%; filter:blur(160px); }
  .g1 { width:820px; height:820px; left:-260px; top:-180px; background:${th.g1}; }
  .g2 { width:900px; height:900px; right:-320px; bottom:-220px; background:${th.g2}; }
  .wrap { position:relative; padding:96px 88px 84px; height:100%; display:flex; flex-direction:column; }
  .top { display:flex; }
  .pill { border:2px solid rgba(255,255,255,.35); background:rgba(255,255,255,.10);
          color:#fff; font-size:40px; padding:18px 36px; border-radius:999px; letter-spacing:1px; }
  .mid { flex:1; display:flex; flex-direction:column; justify-content:center; }
  h1 { font-size:${fs}px; line-height:1.24; font-weight:900; letter-spacing:2px;
       text-shadow:0 6px 40px rgba(0,0,0,.35); }
  h1 span { display:block; }
  .sub { margin-top:30px; font-size:44px; line-height:1.5; color:rgba(255,255,255,.82); font-weight:400; }
  .chips { margin-top:44px; display:flex; gap:18px; flex-wrap:wrap; }
  .chip { font-size:40px; font-weight:700; color:${th.accent}; background:rgba(255,255,255,.10);
          border:2px solid rgba(255,255,255,.22); padding:14px 30px; border-radius:999px; }
  .foot { font-size:34px; color:rgba(255,255,255,.6); letter-spacing:2px; }
  </style></head><body>
  <div class="glow g1"></div><div class="glow g2"></div>
  <div class="wrap">
    <div class="top"><div class="pill">${esc(top)}</div></div>
    <div class="mid">
      <h1>${lines.map((l) => `<span>${esc(l)}</span>`).join('')}</h1>
      ${subhead ? `<div class="sub">${esc(subhead)}</div>` : ''}
      ${chips ? `<div class="chips">${chips}</div>` : ''}
    </div>
    <div class="foot">${esc(footer)}</div>
  </div></body></html>`
}

/** 用无头页面把 HTML 渲染成 PNG。page 来自 openPage({isolated:true})。 */
export async function renderCard(page, { html, outPath }) {
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: IMAGE_W,
    height: IMAGE_H,
    deviceScaleFactor: 1,
    mobile: false,
  })
  const url = 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
  await page.send('Page.navigate', { url })
  // 等字体与布局稳定
  for (let i = 0; i < 40; i++) {
    const ready = await page.ev('document.readyState === "complete" && document.body && document.body.innerText.length >= 0')
    if (ready) break
    await new Promise((r) => setTimeout(r, 150))
  }
  await page.ev('document.fonts && document.fonts.ready ? document.fonts.ready.then(() => 1) : 1')
  await new Promise((r) => setTimeout(r, 450))
  const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const buf = Buffer.from(shot.data, 'base64')
  writeFileSync(outPath, buf)
  return { path: outPath, bytes: buf.length, width: IMAGE_W, height: IMAGE_H }
}
