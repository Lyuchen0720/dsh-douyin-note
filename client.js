/**
 * dsh-douyin-note —— 浏览器半端（设置里的一页「抖音图文」）
 * ============================================================================
 * 只管「按频率自己发」这套设置：开关 / 频率 / 每天上限 / 真发还是只出草稿 / 配乐池。
 * 数据走宿主路由 /api/douyin-note/*（index.js 里注册），改完立刻写进 state.json。
 * 注意：这个文件是**非 ESM**，由 ModuleLoader 直接执行；注册 id 必须等于加载器条目名。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-douyin-note',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const API = '/api/douyin-note'

    const asJson = async (res) => {
      if (res.ok) return res.json()
      throw new Error('HTTP ' + res.status)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const fmt = (iso) => {
      if (!iso) return '—'
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return '—'
      return d.toLocaleString('zh-CN', { hour12: false })
    }

    const S = {
      card: { border: '1px solid var(--dsh-border, #e5e5e5)', borderRadius: 12, padding: '14px 16px', marginBottom: 12 },
      row: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 150px', gap: 12, alignItems: 'center', padding: '6px 0' },
      label: { fontSize: 13, color: 'var(--dsh-text-2, #555)' },
      hint: { fontSize: 12, color: 'var(--dsh-text-3, #888)', marginTop: 2 },
      input: { width: '100%', padding: '6px 8px', borderRadius: 8, border: '1px solid var(--dsh-border, #d9d9d9)', background: 'transparent', color: 'inherit', fontSize: 13 },
      btn: { padding: '6px 14px', borderRadius: 8, border: '1px solid var(--dsh-border, #d9d9d9)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 13 },
      btnPrimary: { padding: '6px 14px', borderRadius: 8, border: '1px solid transparent', background: 'var(--dsh-accent, #2b6cff)', color: '#fff', cursor: 'pointer', fontSize: 13 },
      kv: { display: 'grid', gridTemplateColumns: '92px minmax(0,1fr)', gap: 8, fontSize: 13, padding: '3px 0' },
      tag: { display: 'inline-block', padding: '1px 8px', borderRadius: 999, fontSize: 12, border: '1px solid var(--dsh-border, #ddd)' },
    }

    function Field({ title, hint, children }) {
      return h('div', { style: S.row },
        h('div', null, h('div', { style: { fontSize: 13 } }, title), hint ? h('div', { style: S.hint }, hint) : null),
        children)
    }

    function Toggle({ on, onChange }) {
      return h('button', {
        type: 'button',
        onClick: () => onChange(!on),
        style: { ...S.btn, background: on ? 'var(--dsh-accent, #2b6cff)' : 'transparent', color: on ? '#fff' : 'inherit', borderColor: on ? 'transparent' : undefined },
      }, on ? '已开启' : '已关闭')
    }

    function Panel() {
      const [state, setState] = React.useState(null)
      const [form, setForm] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [note, setNote] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const formFrom = (auto) => ({
        enabled: Boolean(auto?.enabled),
        publish: Boolean(auto?.publish),
        everyHours: Number(auto?.everyHours || 24),
        perDay: Number(auto?.perDay || 1),
        musicPool: (auto?.musicPool || []).join('，'),
      })

      const adopt = (s) => {
        setState(s)
        setForm((f) => f || formFrom(s?.auto))
      }

      const load = async () => {
        try { setErr(''); adopt(await jget('/status')) } catch (e) { setErr(String(e?.message || e)) }
      }
      React.useEffect(() => { void load() }, [])

      const save = async () => {
        if (!form) return
        setBusy(true); setErr(''); setNote('')
        try {
          const s = await jpost('/config', {
            enabled: Boolean(form.enabled),
            publish: Boolean(form.publish),
            everyHours: Number(form.everyHours) || 24,
            perDay: Number(form.perDay) || 1,
            musicPool: String(form.musicPool || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean),
          })
          adopt(s); setForm(formFrom(s?.auto)); setNote('已保存')
          setTimeout(() => setNote(''), 2000)
        } catch (e) { setErr(String(e?.message || e)) } finally { setBusy(false) }
      }

      const runDraft = async () => {
        setBusy(true); setErr(''); setNote('')
        try {
          const r = await jpost('/run', { publish: false })
          adopt(r)
          setNote(r?.record?.image ? `草稿已生成：${r.record.image}` : '草稿已生成')
        } catch (e) { setErr(String(e?.message || e)) } finally { setBusy(false) }
      }

      const auto = state?.auto
      return h('div', { style: { padding: '4px 2px 18px' } },
        h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 4 } }, '抖音图文 · 按频率自己发'),
        h('div', { style: { ...S.hint, marginBottom: 12 } },
          '到点后：模型按插件自带的人设自己写 → 渲染成 1080×1440 的文字卡 → 随机挑一首配乐 → 发出去。'),

        h('div', { style: S.card },
          h('div', { style: S.kv }, h('span', { style: S.label }, '状态'),
            h('span', null, auto
              ? (auto.enabled ? h('span', { style: { ...S.tag, borderColor: '#2b6cff', color: '#2b6cff' } }, '自动发布中') : h('span', { style: S.tag }, '已关闭'))
              : '—')),
          h('div', { style: S.kv }, h('span', { style: S.label }, '下一次'), h('span', null, fmt(auto?.nextRunAt))),
          h('div', { style: S.kv }, h('span', { style: S.label }, '上一轮'), h('span', null, fmt(auto?.lastRunAt))),
          h('div', { style: S.kv }, h('span', { style: S.label }, '今天已发'), h('span', null,
            auto ? `${auto.dayCount || 0} / ${auto.perDay || 0}` : '—')),
          h('div', { style: S.kv }, h('span', { style: S.label }, '本轮说明'), h('span', { style: { wordBreak: 'break-all' } }, state?.due?.why || '—')),
          auto?.lastError ? h('div', { style: { ...S.kv, color: '#c0392b' } }, h('span', { style: S.label }, '最近错误'), h('span', { style: { wordBreak: 'break-all' } }, auto.lastError)) : null,
        ),

        form ? h('div', { style: S.card },
          h(Field, { title: '自动发布', hint: '关掉后心跳不再触发' },
            h(Toggle, { on: form.enabled, onChange: (v) => setForm({ ...form, enabled: v }) })),
          h(Field, { title: '每 N 小时一条', hint: '最小 0.25；实际时间带 ±12 分钟抖动' },
            h('input', { type: 'number', min: 0.25, step: 0.25, value: form.everyHours, style: S.input, onChange: (e) => setForm({ ...form, everyHours: e.target.value }) })),
          h(Field, { title: '每天最多几条', hint: '只有真发才占名额，草稿不算' },
            h('input', { type: 'number', min: 1, step: 1, value: form.perDay, style: S.input, onChange: (e) => setForm({ ...form, perDay: e.target.value }) })),
          h(Field, { title: '发布方式', hint: '草稿存 drafts/，可以先看两天' },
            h('div', { style: { display: 'flex', gap: 8 } },
              h('button', { type: 'button', style: { ...S.btn, ...(form.publish ? {} : { background: 'var(--dsh-accent,#2b6cff)', color: '#fff', borderColor: 'transparent' }) }, onClick: () => setForm({ ...form, publish: false }) }, '只出草稿'),
              h('button', { type: 'button', style: { ...S.btn, ...(form.publish ? { background: 'var(--dsh-accent,#2b6cff)', color: '#fff', borderColor: 'transparent' } : {}) }, onClick: () => setForm({ ...form, publish: true }) }, '直接真发'))),
          h(Field, { title: '配乐池', hint: '逗号分隔；每次随机挑一个' },
            h('input', { type: 'text', value: form.musicPool, style: S.input, onChange: (e) => setForm({ ...form, musicPool: e.target.value }) })),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
            h('button', { type: 'button', style: S.btnPrimary, disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
            h('button', { type: 'button', style: S.btn, disabled: busy, onClick: runDraft }, '现在生成一条草稿'),
            h('button', { type: 'button', style: S.btn, disabled: busy, onClick: load }, '刷新')),
        ) : null,

        note ? h('div', { style: { fontSize: 12, color: '#2b8a3e', marginTop: 6, wordBreak: 'break-all' } }, note) : null,
        err ? h('div', { style: { fontSize: 12, color: '#c0392b', marginTop: 6, wordBreak: 'break-all' } }, err) : null,
        h('div', { style: { ...S.hint, marginTop: 10 } },
          '手动发单条（带自己的图）用工具 douyin_note_publish；这里只管「按频率自己发」。'),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'douyin-note', order: 32, label: '抖音图文' },
          () => h(Panel),
        ))
      },
    }
  },
})
