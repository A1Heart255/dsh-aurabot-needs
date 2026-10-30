// 「生理需求」面板：四项数值、衰减速度在设置里，面板负责看和手动操作。
const { useState, useEffect } = React

const NAME = { eat: '吃饭', drink: '喝水', coffee: '喝咖啡', rest: '休息', sleep: '睡觉', read: '看书', out: '出门', wake: '叫醒' }
const fmt = (ts) => {
  if (!ts) return ''
  const d = new Date(ts)
  return (d.getMonth() + 1) + '-' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

return function NeedsPanel({ toast }) {
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  const load = async () => {
    try {
      setSt(await call('/state'))
      setErr('')
    } catch (e) {
      setErr(String((e && e.message) || e))
    }
  }

  useEffect(() => { load() }, [])

  const act = async (action) => {
    setBusy(action)
    try {
      const r = await call('/act', { action })
      if (r && r.ok === false) toast(r.message || '没做成', 'err')
      else toast(r.message || '好了', 'ok')
      await load()
    } catch (e) {
      toast(String((e && e.message) || e), 'err')
    } finally {
      setBusy('')
    }
  }

  if (err) return h(ui.Card, { title: '生理需求', desc: '模块可能没在跑' }, h('div', { className: 'ab-note err' }, err))
  if (!st) return h(ui.Empty, { icon: '🍚', text: '加载中…' })

  const v = st.values || {}
  const sleeping = Boolean(st.sleeping)
  const clock = (ts) => {
    const d = new Date(ts)
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  }
  const bar = (label, value, level, color) => h('div', { style: { marginBottom: 12 } },
    h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
      h('b', { style: { fontSize: 14 } }, label),
      h('span', { style: { color, fontWeight: 600 } }, String(value)),
      h('span', { className: 'ab-muted ab-small' }, '/100 · ' + level)),
    h('div', { style: { height: 9, background: 'var(--ab-line)', borderRadius: 999, marginTop: 5, overflow: 'hidden' } },
      h('div', { style: { height: '100%', width: Math.max(0, Math.min(100, Number(value) || 0)) + '%', background: color, borderRadius: 999, transition: 'width .3s' } })),
  )

  const bonus = (key) => {
    const b = st.bonuses && st.bonuses[key]
    return b && b.label ? '（' + b.label + '）' : ''
  }

  const actionBtn = (action, label, hint) => h(ui.Btn, {
    small: true, disabled: Boolean(busy) || sleeping, onClick: () => act(action), title: hint,
  }, busy === action ? '处理中…' : label)

  return h('div', { className: 'ab-grid' },

    h(ui.Card, {
      title: '🍚 生理需求',
      desc: '四项都是 0=不缺、100=到极限。到阈值她会自己吃/喝/休息/睡，不提醒；睡着时被叫到会回一句“在睡觉”，但不会醒。',
      right: h(ui.Btn, { small: true, kind: 'ghost', disabled: Boolean(busy), onClick: load }, '刷新'),
    },
      sleeping ? h('div', { className: 'ab-note warn', style: { marginBottom: 12 } },
        '正在睡觉，约 ' + clock(st.asleepUntil) + ' 醒。被叫到会回一句“在睡觉”，但不会继续聊、也不会醒；只能在这里或 /需求 醒 叫醒。',
        h('div', { style: { marginTop: 8 } },
          h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: () => act('wake') }, busy === 'wake' ? '叫醒中…' : '叫醒她'))) : null,
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '4px 22px' } },
        bar('饥饿', v.hunger, st.levels.hunger, '#e8893a'),
        bar('口渴', v.thirst, st.levels.thirst, '#4a9fd8'),
        bar('疲劳', v.fatigue, st.levels.fatigue, '#9a6fd0'),
        bar('困意', v.sleepiness, st.levels.sleepiness, '#6a7fd8'),
      ),
      h('div', { className: 'ab-small ab-muted', style: { marginTop: 2 } },
        '咖啡因 ' + v.caffeine + '/100 · 上次动作：' +
        (st.lastAction && st.lastAction.type ? NAME[st.lastAction.type] + ' ' + fmt(st.lastAction.at) : '还没有') +
        ' · 上次结算：' + fmt(st.lastTick)),
      h('div', { className: 'ab-small ab-muted', style: { marginTop: 4 } },
        st.auto && st.auto.enabled
          ? '自动行为：开（每 ' + (st.auto.settleMinutes || 40) + ' 分钟结算一次；饿≥' + st.auto.eatAt + ' 自己吃、渴≥' + st.auto.drinkAt + ' 自己喝、累≥' + st.auto.restAt + ' 自己休息、困≥' + st.auto.sleepAt + ' 自己睡 ' + st.auto.sleepHours + ' 小时，不提醒）'
          : '自动行为：关（只靠面板/命令手动）'),
    ),

    h(ui.Card, { title: '现在做点什么', desc: sleeping ? '她正在睡觉，先叫醒再操作' : '手动操作会立刻结算；家里有对应物品会加成' },
      h('div', { className: 'ab-flex', style: { flexWrap: 'wrap', gap: 8 } },
        actionBtn('eat', '吃饭' + bonus('eat'), '饥饿降得多一些；家里有锅/白米饭会加成'),
        actionBtn('drink', '喝水', '口渴降 60'),
        actionBtn('coffee', '喝咖啡' + bonus('coffee'), '暂时压困意，过几小时反弹'),
        actionBtn('rest', '休息' + bonus('rest'), '疲劳降一点；家里有沙发会加成'),
        actionBtn('sleep', '睡觉' + bonus('sleep'), '疲劳和困意大幅恢复；家里有床会加成'),
      ),
      h('div', { className: 'ab-small ab-muted', style: { marginTop: 10 } },
        '吃饭/喝水/咖啡/休息/睡觉都有冷却，面板里手动点会直接执行；她自己在聊天里用 needs_act 时会受限。'),
    ),
  )
}
