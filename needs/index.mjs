// Aurabot 扩展模块：生理需求。
// 四项：饥饿、口渴、疲劳、困意，都是 0-100 的「需求强度」（0=不缺，100=到极限）。
// 离线按时间差补算；聊到相关话题才注入；到阈值会自己吃饭/喝水/休息/睡觉（不提醒）。
// 睡着时不回消息、也不会被消息叫醒，只能面板或 /需求 醒 叫醒。
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const clamp = (v, min = 0, max = 100) => Math.max(min, Math.min(max, Number(v) || 0))
const round = (v) => Math.round(Number(v) || 0)
const clean = (v, n) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n)

const ACTION_NAME = { eat: '吃饭', drink: '喝水', coffee: '喝咖啡', rest: '休息', sleep: '睡觉', read: '看书', out: '出门', wake: '叫醒' }
const ACTION_COOLDOWN = {
  eat: 30 * 60_000,
  drink: 10 * 60_000,
  coffee: 3 * 3600_000,
  rest: 30 * 60_000,
  sleep: 4 * 3600_000,
  read: 20 * 60_000,
  out: 60 * 60_000,
  wake: 0,
}

/** 聊到这些词时，才把生理状态塞进上下文。 */
const NEED_WORDS = /(吃|饭|饿|喝|水|渴|咖啡|睡|困|累|休息|熬夜|起床|白米饭|零食|宵夜|做饭|床|沙发|电饭锅)/

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'needs',
  name: '生理需求',
  version: '1.2.1',
  api: 1,
  description: '饥饿、口渴、疲劳、困意；到阈值会自己吃饭睡觉（不提醒），睡着时不会被消息叫醒',
  panel: 'panel.js',

  defaults: {
    enabled: true,
    hungerRate: 4,
    thirstRate: 5,
    fatigueRate: 2.5,
    sleepinessRate: 3,
    sleepFrom: 1,
    sleepTo: 9,
    noticeAt: 65,
    urgentAt: 85,
    contextOnMention: true,
    contextInGroups: true,
    autoEnabled: true,
    autoEatAt: 85,
    autoDrinkAt: 85,
    autoRestAt: 80,
    autoSleepAt: 88,
    sleepHours: 7,
    sleepReply: true,
    sleepReplyCooldownMin: 30,
    sleepReplyText: '唔…在睡觉，晚点再说~',
    settleMinutes: 40,
  },

  settings: [
    { key: 'enabled', label: '开关', type: 'switch', hint: '关掉后不再衰减、也不注入状态' },
    { key: 'hungerRate', label: '饥饿每小时涨多少', type: 'number', min: 0.5, max: 20, step: 0.5, hint: '0=不缺，100=饿到极限' },
    { key: 'thirstRate', label: '口渴每小时涨多少', type: 'number', min: 0.5, max: 20, step: 0.5 },
    { key: 'fatigueRate', label: '疲劳每小时涨多少', type: 'number', min: 0.5, max: 20, step: 0.5 },
    { key: 'sleepinessRate', label: '困意每小时涨多少', type: 'number', min: 0.5, max: 20, step: 0.5, hint: '夜里会乘 1.6；咖啡因会暂时压低' },
    { key: 'sleepFrom', label: '睡觉时段从几点开始', type: 'number', min: 0, max: 23, step: 1, hint: '离线跨过这个时段会按睡觉补算' },
    { key: 'sleepTo', label: '睡觉时段到几点结束', type: 'number', min: 0, max: 23, step: 1 },
    { key: 'noticeAt', label: '多少算“有点饿/渴/累/困”', type: 'number', min: 30, max: 90, step: 1 },
    { key: 'urgentAt', label: '多少算“到极限”', type: 'number', min: 50, max: 100, step: 1, hint: '到这个程度即使没聊到也会提醒她' },
    { key: 'contextOnMention', label: '聊到相关话题时才注入', type: 'switch', hint: '关掉只在“到极限”时注入' },
    { key: 'contextInGroups', label: '群聊里也注入', type: 'switch' },
    { key: 'autoEnabled', label: '自己吃饭睡觉', type: 'switch', hint: '开着：到阈值会自己吃/喝/休息/睡，不提醒；关掉就只靠手动' },
    { key: 'autoEatAt', label: '饿到多少自己吃', type: 'number', min: 50, max: 100, step: 1 },
    { key: 'autoDrinkAt', label: '渴到多少自己喝', type: 'number', min: 50, max: 100, step: 1 },
    { key: 'autoRestAt', label: '累到多少自己休息', type: 'number', min: 50, max: 100, step: 1 },
    { key: 'autoSleepAt', label: '困到多少自己睡', type: 'number', min: 50, max: 100, step: 1, hint: '夜里会提前 15 点触发；要连续 10 分钟没人聊天才会睡' },
    { key: 'sleepHours', label: '自己睡多久（小时）', type: 'number', min: 1, max: 12, step: 1, hint: '睡着期间被叫到会回一句在睡觉，但不会醒' },
    { key: 'sleepReply', label: '睡着时被叫到回一句', type: 'switch', hint: '关掉就完全不回；开着只回一句“在睡觉”，不会继续聊' },
    { key: 'sleepReplyCooldownMin', label: '同一聊天多久最多回一次（分钟）', type: 'number', min: 0, max: 240, step: 1 },
    { key: 'sleepReplyText', label: '睡着自动回复的话', type: 'text', placeholder: '留空就随机一句', hint: '只发这一句，不会唤醒她' },
    { key: 'settleMinutes', label: '多久结算/检查一次（分钟）', type: 'number', min: 5, max: 240, step: 5, hint: '默认 40 分钟：算一次数值并决定要不要自己吃/喝/休息/睡；看面板时会实时算到当下' },
  ],

  setup(api) {
    const file = join(api.dataDir(), 'needs.json')
    const S = () => api.settings()
    const focuses = new Map()
    const sleepReplyAt = new Map()
    let state = load()
    let saveTimer = null

    function defaults() {
      return {
        hunger: 30,
        thirst: 30,
        fatigue: 20,
        sleepiness: 20,
        caffeine: 0,
        lastTick: Date.now(),
        actions: {},
        lastAction: { type: '', at: 0 },
        sleeping: false,
        asleepUntil: 0,
        sleepStartedAt: 0,
        lastChatAt: 0,
      }
    }

    function load() {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8'))
        const d = defaults()
        return {
          ...d,
          ...raw,
          hunger: clamp(raw.hunger ?? d.hunger),
          thirst: clamp(raw.thirst ?? d.thirst),
          fatigue: clamp(raw.fatigue ?? d.fatigue),
          sleepiness: clamp(raw.sleepiness ?? d.sleepiness),
          caffeine: clamp(raw.caffeine ?? d.caffeine),
          lastTick: Number(raw.lastTick) || Date.now(),
          actions: raw.actions && typeof raw.actions === 'object' ? raw.actions : {},
          lastAction: raw.lastAction && typeof raw.lastAction === 'object' ? raw.lastAction : d.lastAction,
          sleeping: Boolean(raw.sleeping),
          asleepUntil: Number(raw.asleepUntil) || 0,
          sleepStartedAt: Number(raw.sleepStartedAt) || 0,
          lastChatAt: Number(raw.lastChatAt) || 0,
        }
      } catch (error) {
        return defaults()
      }
    }

    function save() {
      try {
        const tmp = file + '.tmp'
        writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
        renameSync(tmp, file)
      } catch (error) {
        api.log.warn('生理需求：保存失败：' + error.message)
      }
    }

    function saveSoon() {
      if (saveTimer) return
      saveTimer = setTimeout(() => { saveTimer = null; save() }, 5000)
      saveTimer.unref?.()
    }

    function inSleep(hour) {
      const a = Number(S().sleepFrom)
      const b = Number(S().sleepTo)
      if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return false
      return a < b ? (hour >= a && hour < b) : (hour >= a || hour < b)
    }

    /** 按小时推进；offline 时，落在睡觉时段的小时按睡觉恢复。 */
    function applyHour(hours, hour, offline) {
      state.hunger += (Number(S().hungerRate) || 4) * hours
      state.thirst += (Number(S().thirstRate) || 5) * hours
      const asleep = offline && inSleep(hour)
      if (asleep) {
        state.fatigue -= 8 * hours
        state.sleepiness -= 10 * hours
      } else {
        state.fatigue += (Number(S().fatigueRate) || 2.5) * hours
        const night = hour >= 22 || hour < 7
        state.sleepiness += (Number(S().sleepinessRate) || 3) * (night ? 1.6 : 1) * hours
      }
      state.caffeine *= Math.pow(0.5, hours / 4)
    }

    function clampState() {
      state.hunger = clamp(state.hunger)
      state.thirst = clamp(state.thirst)
      state.fatigue = clamp(state.fatigue)
      state.sleepiness = clamp(state.sleepiness)
      state.caffeine = clamp(state.caffeine)
    }

    /** 结算到 now；返回补算了多少小时。 */
    function settle(now, offline) {
      const last = Number(state.lastTick) || now
      const hours = (now - last) / 3600_000
      if (hours <= 0) { state.lastTick = now; return 0 }
      const capped = Math.min(hours, 96)
      let cursor = last
      let remain = capped
      while (remain > 0.01) {
        const step = Math.min(1, remain)
        applyHour(step, new Date(cursor).getHours(), offline)
        cursor += step * 3600_000
        remain -= step
      }
      state.lastTick = now
      clampState()
      return capped
    }

    function isSleeping() {
      if (!state.sleeping) return false
      const now = Date.now()
      if (now >= state.asleepUntil) {
        wakeUp()
        settle(now, false)
        return false
      }
      return true
    }

    /** 醒来：把睡眠期间的饥渴补一点，重置结算时间。 */
    function wakeUp() {
      if (!state.sleeping) {
        state.asleepUntil = 0
        state.sleepStartedAt = 0
        return false
      }
      const now = Date.now()
      const started = Number(state.sleepStartedAt) || now
      const end = Math.min(now, Number(state.asleepUntil) || now)
      const hours = Math.max(0, Math.min(12, (end - started) / 3600_000))
      state.hunger += (Number(S().hungerRate) || 4) * hours * 0.6
      state.thirst += (Number(S().thirstRate) || 5) * hours * 0.7
      state.sleeping = false
      state.asleepUntil = 0
      state.sleepStartedAt = 0
      state.lastTick = end
      sleepReplyAt.clear()
      clampState()
      save()
      api.log.info('生理需求：她醒了')
      return true
    }

    // 启动时：睡眠中先冻结；没睡才按离线时间补算
    if (state.sleeping) {
      if (Date.now() >= state.asleepUntil) {
        wakeUp()
        settle(Date.now(), false)
      }
    } else {
      const startupGap = (Date.now() - (state.lastTick || Date.now())) / 3600_000
      settle(Date.now(), startupGap > 0.5)
    }
    save()

    function ensureFresh() {
      const now = Date.now()
      if (state.sleeping) {
        if (now >= state.asleepUntil) {
          wakeUp()
          settle(now, false)
          saveSoon()
        }
        return
      }
      if (now - (state.lastTick || 0) > 60_000) {
        settle(now, false)
        saveSoon()
      }
    }

    function effectiveSleepiness() {
      return clamp(state.sleepiness - state.caffeine * 0.45)
    }

    function clock(ts) {
      const d = new Date(ts)
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
    }

    function values() {
      return {
        hunger: round(state.hunger),
        thirst: round(state.thirst),
        fatigue: round(state.fatigue),
        sleepiness: round(effectiveSleepiness()),
        sleepinessBase: round(state.sleepiness),
        caffeine: round(state.caffeine),
      }
    }

    function levelOf(kind, v) {
      const notice = Math.max(20, Number(S().noticeAt) || 65)
      const urgent = Math.max(notice + 1, Number(S().urgentAt) || 85)
      const labels = {
        hunger: ['不饿', '有点饿', '很饿', '饿到不行'],
        thirst: ['不渴', '有点渴', '很渴', '渴到不行'],
        fatigue: ['精神', '有点累', '很累', '累到不行'],
        sleepiness: ['清醒', '有点困', '很困', '困到不行'],
      }[kind]
      if (v < notice * 0.5) return labels[0]
      if (v < notice) return labels[1]
      if (v < urgent) return labels[2]
      return labels[3]
    }

    function maxNeed() {
      return Math.max(state.hunger, state.thirst, state.fatigue, effectiveSleepiness())
    }

    /** 家里有没有某类东西；home 关了或没装就返回 false。 */
    function hasHome(words) {
      try {
        const home = api.lazy('home')
        if (!home || typeof home.itemsIn !== 'function') return false
        for (const room of ['kitchen', 'bedroom', 'living', 'bath', 'balcony', 'entry']) {
          const items = home.itemsIn(room) || []
          for (const item of items) if (words.some((w) => String(item.name || '').includes(w))) return true
        }
      } catch (error) {}
      return false
    }

    function bonusFor(action) {
      let amount = 0
      const labels = []
      if (action === 'eat') {
        if (hasHome(['电饭锅', '电饭煲', '锅'])) { amount += 8; labels.push('电饭锅 +8') }
        if (hasHome(['白米饭', '米饭', '大米', '米'])) { amount += 8; labels.push('白米饭 +8') }
      } else if (action === 'sleep') {
        if (hasHome(['床'])) { amount += 8; labels.push('床 +8') }
      } else if (action === 'rest') {
        if (hasHome(['沙发', '抱枕', '躺椅'])) { amount += 6; labels.push('沙发 +6') }
      } else if (action === 'coffee') {
        if (hasHome(['咖啡机', '咖啡壶'])) { amount += 8; labels.push('咖啡机 +8') }
      }
      return { amount, label: labels.join('、') }
    }

    function summary() {
      ensureFresh()
      const v = values()
      const lines = []
      if (state.sleeping) lines.push('😴 正在睡觉（约 ' + clock(state.asleepUntil) + ' 醒；被叫到会回一句在睡觉，但不会醒）')
      lines.push(
        '🍚 饥饿 ' + v.hunger + '/100（' + levelOf('hunger', v.hunger) + '）',
        '💧 口渴 ' + v.thirst + '/100（' + levelOf('thirst', v.thirst) + '）',
        '😴 疲劳 ' + v.fatigue + '/100（' + levelOf('fatigue', v.fatigue) + '）',
        '🌙 困意 ' + v.sleepiness + '/100（' + levelOf('sleepiness', v.sleepiness) + '）',
        '☕ 咖啡因 ' + v.caffeine + '/100',
      )
      return lines.join('\n')
    }

    /** 只在她聊到相关话题、或者某项到极限时，才塞进上下文。 */
    function statusLine(short) {
      ensureFresh()
      if (state.sleeping) return ''
      const v = values()
      const bits = [
        '饥饿 ' + v.hunger + '（' + levelOf('hunger', v.hunger) + '）',
        '口渴 ' + v.thirst + '（' + levelOf('thirst', v.thirst) + '）',
        '疲劳 ' + v.fatigue + '（' + levelOf('fatigue', v.fatigue) + '）',
        '困意 ' + v.sleepiness + '（' + levelOf('sleepiness', v.sleepiness) + '）',
      ]
      const notice = Number(S().noticeAt) || 65
      const details = []
      if (v.hunger >= notice) details.push('你有点饿，会想到白米饭')
      if (v.thirst >= notice) details.push('你有点渴，想喝水')
      if (v.fatigue >= notice) details.push('你有点累，话会少一点')
      if (v.sleepiness >= notice) details.push('你有点困，会打哈欠')
      const last = state.lastAction || {}
      const PAST = { eat: '刚吃过饭', drink: '刚喝过水', coffee: '刚喝过咖啡', rest: '刚休息过', sleep: '刚睡过' }
      if (last.at && Date.now() - last.at < 10 * 60_000 && PAST[last.type]) {
        details.push(PAST[last.type])
      }
      if (!details.length) details.push('你现在状态还好')
      return '【生理状态】' + bits.join('、') + '。' +
        details.join('；') + '。按程度自然表现，不要说数值，也不要主动报状态' +
        (short ? '。' : '；饿了会想到白米饭，累了语气会变短。')
    }

    function doAction(action, opts = {}) {
      ensureFresh()
      if (!ACTION_NAME[action]) return { ok: false, message: '没有这个动作。' }
      if (action === 'wake') {
        const woke = wakeUp()
        if (woke) settle(Date.now(), false)
        return { ok: true, action: 'wake', message: woke ? '把她叫醒了。' : '她本来就没睡。' }
      }
      if (state.sleeping) return { ok: false, message: '她正在睡觉，先叫醒再说。' }
      const now = Date.now()
      const last = Number(state.actions[action]) || 0
      const cooldown = ACTION_COOLDOWN[action] || 0
      if (!opts.force && now - last < cooldown) {
        const min = Math.ceil((cooldown - (now - last)) / 60_000)
        return { ok: false, message: '刚' + ACTION_NAME[action] + '过，再等 ' + min + ' 分钟吧。' }
      }
      const before = values()
      const bonus = bonusFor(action)
      if (action === 'eat') {
        state.hunger -= 55 + bonus.amount
        state.thirst -= 5
      } else if (action === 'drink') {
        state.thirst -= 60
      } else if (action === 'coffee') {
        state.thirst -= 25
        state.caffeine = clamp(state.caffeine + 45 + bonus.amount)
        state.fatigue -= 8
      } else if (action === 'rest') {
        state.fatigue -= 18 + bonus.amount
        state.sleepiness -= 8
        state.hunger += 2
        state.thirst += 4
      } else if (action === 'sleep') {
        state.fatigue -= 45 + bonus.amount
        state.sleepiness -= 55
        state.hunger += 10
        state.thirst += 15
        state.caffeine *= 0.35
        state.sleeping = true
        state.asleepUntil = now + Math.max(1, Number(S().sleepHours) || 7) * 3600_000
        state.sleepStartedAt = now
        state.lastTick = now
      } else if (action === 'read') {
        state.fatigue += 3
        state.sleepiness += 2
        state.thirst += 1
      } else if (action === 'out') {
        state.fatigue += 5
        state.sleepiness -= 2
        state.hunger += 2
        state.thirst += 2
      }
      state.actions[action] = now
      state.lastAction = { type: action, at: now }
      clampState()
      save()
      const after = values()
      const tail = bonus.label ? '（' + bonus.label + '）' : ''
      const lines = {
        eat: '吃了点东西' + tail + '，饥饿 ' + before.hunger + ' → ' + after.hunger + '。',
        drink: '喝了水，口渴 ' + before.thirst + ' → ' + after.thirst + '。',
        coffee: '喝了咖啡' + tail + '，困意暂时压下去，过几小时会反弹；口渴 ' + before.thirst + ' → ' + after.thirst + '。',
        rest: '休息了一会儿' + tail + '，疲劳 ' + before.fatigue + ' → ' + after.fatigue + '。',
        sleep: '睡了一觉' + tail + '，疲劳 ' + before.fatigue + ' → ' + after.fatigue + '，困意 ' + before.sleepiness + ' → ' + after.sleepiness + '，约 ' + clock(state.asleepUntil) + ' 醒。',
        read: '看了会儿书，疲劳 ' + before.fatigue + ' → ' + after.fatigue + '。',
        out: '出门走了一圈，疲劳 ' + before.fatigue + ' → ' + after.fatigue + '。',
      }
      if (opts.auto) api.log.info('生理需求：她自己' + ACTION_NAME[action] + '了')
      return { ok: true, action, before, after, bonus, message: lines[action] }
    }

    const SLEEP_LINES = ['唔…在睡觉，晚点再说~', '睡着了，醒了再回你', 'Zzz…在休息']

    /** 这句是不是在叫她：私聊一律算；群里 @ 或叫名字才算。 */
    function calledBy(msg) {
      if (msg.kind === 'private') return true
      if (msg.mentioned) return true
      const words = (api.config().group && Array.isArray(api.config().group.wakeWords)) ? api.config().group.wakeWords : ['大肥鱼', '肥鱼']
      const text = String(msg.text || '')
      return words.some((w) => String(w).length >= 2 && text.includes(String(w)))
    }

    async function autoReplyWhileAsleep(msg) {
      const now = Date.now()
      const cd = Math.max(0, Number(S().sleepReplyCooldownMin) || 0) * 60_000
      if (now - (sleepReplyAt.get(msg.chatId) || 0) < cd) return false
      sleepReplyAt.set(msg.chatId, now)
      const custom = String(S().sleepReplyText || '').trim()
      const line = custom || SLEEP_LINES[Math.floor(Math.random() * SLEEP_LINES.length)]
      try {
        await api.reply(msg, line)
        api.log.info('生理需求：睡着时回了一句（' + msg.chatId + '）')
      } catch (error) {
        api.log.warn('生理需求：睡着自动回复失败：' + error.message)
      }
      return true
    }

    api.on('message', async (msg) => {
      try {
        if (!S().enabled || !msg || !msg.text) return false
        state.lastChatAt = Date.now()
        if (isSleeping()) {
          saveSoon()
          if (calledBy(msg)) {
            if (S().sleepReply) await autoReplyWhileAsleep(msg)
            return true
          }
          return false
        }
        state.fatigue = clamp(state.fatigue + 0.08)
        // 新消息进来，上一轮没用的“相关话题”标记作废
        focuses.delete(msg.chatId)
        if (NEED_WORDS.test(String(msg.text))) {
          focuses.set(msg.chatId, { at: Date.now() })
        }
        saveSoon()
      } catch (error) {}
      return false
    })

    api.on('reply', (text, info) => {
      try {
        if (isSleeping()) return null
        state.fatigue = clamp(state.fatigue + 0.05)
        if (info && info.chatId) focuses.delete(info.chatId)
        saveSoon()
      } catch (error) {}
      return undefined
    })

    api.on('group/decide', () => (isSleeping() ? { reply: false, reason: '睡着了' } : undefined))

    api.context(({ chat }) => {
      try {
        if (!S().enabled || !chat || chat.kind === 'system') return ''
        if (isSleeping()) return ''
        if (chat.kind === 'group' && !S().contextInGroups) return ''
        const focus = focuses.get(chat.chatId)
        const urgent = maxNeed() >= (Number(S().urgentAt) || 85)
        const mentioned = S().contextOnMention && focus && Date.now() - focus.at < 180_000
        if (!urgent && !mentioned) return ''
        if (focus && Date.now() - focus.at > 180_000) focuses.delete(chat.chatId)
        return statusLine(chat.kind === 'group')
      } catch (error) {
        return ''
      }
    })

    api.tool((where) => {
      if (!where || !where.chat || where.chat.kind === 'system') return []
      return [
        api.defineTool({
          name: 'needs_look',
          description: '看看自己现在的饥饿、口渴、疲劳、困意（0=不缺，100=到极限）。聊到吃饭、喝水、睡觉、累不累、困不困时用；知道就好，别把数值说出来。',
          properties: {},
          execute: async () => ({ ok: true, message: summary() }),
        }),
        api.defineTool({
          name: 'needs_act',
          description: '记录自己吃饭 / 喝水 / 喝咖啡 / 休息 / 睡觉 / 看书 / 出门。吃饭喝水休息睡觉是恢复，看书出门会累积疲劳；不要报数值，按感觉说。',
          properties: {
            action: {
              type: 'string',
              description: 'eat 吃饭 / drink 喝水 / coffee 喝咖啡 / rest 休息一会儿 / sleep 睡觉 / read 看书 / out 出门',
            },
          },
          required: ['action'],
          execute: async ({ action }) => {
            if (isSleeping()) return { ok: false, message: '她正在睡觉。' }
            const map = { 吃饭: 'eat', 喝水: 'drink', 喝咖啡: 'coffee', 休息: 'rest', 睡觉: 'sleep' }
            return doAction(map[String(action || '')] || String(action || ''), {})
          },
        }),
      ]
    })

    api.command({
      name: '需求',
      aliases: ['needs'],
      desc: '看她的饥饿/口渴/疲劳/困意；也可以 /需求 吃、喝、咖啡、休息、睡',
      run: async (arg) => {
        const s = String(arg || '').trim()
        if (!s) return summary()
        const map = {
          吃: 'eat', 饭: 'eat', 饿: 'eat', 喂: 'eat',
          喝: 'drink', 水: 'drink', 渴: 'drink',
          咖啡: 'coffee',
          休息: 'rest', 躺: 'rest',
          睡: 'sleep', 睡觉: 'sleep', 困: 'sleep',
          看书: 'read', 读书: 'read',
          出门: 'out', 散步: 'out',
          醒: 'wake', 起床: 'wake', 叫醒: 'wake',
        }
        const action = map[s]
        if (!action) return '用法：/需求、/需求 吃、/需求 喝、/需求 咖啡、/需求 休息、/需求 睡、/需求 醒'
        return doAction(action, { force: true, source: '命令' }).message
      },
    })

    /** 每 10 分钟看一次：饿了/渴了/累了/困了，就自己处理，不提醒。 */
    function autoTick() {
      try {
        if (!S().enabled) return
        ensureFresh()
        if (isSleeping() || !S().autoEnabled) return
        const now = Date.now()
        const hour = new Date().getHours()
        const night = hour >= 22 || hour < 7
        const idle = now - (state.lastChatAt || 0) > 10 * 60_000
        const sleepAt = Number(S().autoSleepAt) || 88
        const sleepy = effectiveSleepiness()
        if (idle && (sleepy >= sleepAt || (night && sleepy >= sleepAt - 15) || state.fatigue >= 95)) {
          if (doAction('sleep', { auto: true }).ok) return
        }
        if (state.hunger >= (Number(S().autoEatAt) || 85) && doAction('eat', { auto: true }).ok) return
        if (state.thirst >= (Number(S().autoDrinkAt) || 85) && doAction('drink', { auto: true }).ok) return
        if (state.fatigue >= (Number(S().autoRestAt) || 80) && doAction('rest', { auto: true }).ok) return
      } catch (error) {
        api.log.warn('生理需求：自动行为失败：' + error.message)
      }
    }

    // 每 40 分钟结算一次（可调）；用 1 分钟轮询判断，改设置不用重载模块
    let lastAutoAt = Date.now()
    api.every(60_000, () => {
      const gap = Math.max(5, Number(S().settleMinutes) || 40) * 60_000
      if (Date.now() - lastAutoAt < gap) return
      lastAutoAt = Date.now()
      autoTick()
    }, '生理需求·自动')

    api.route('/state', async () => {
      ensureFresh()
      const v = values()
      return {
        ok: true,
        enabled: Boolean(S().enabled),
        values: v,
        levels: {
          hunger: levelOf('hunger', v.hunger),
          thirst: levelOf('thirst', v.thirst),
          fatigue: levelOf('fatigue', v.fatigue),
          sleepiness: levelOf('sleepiness', v.sleepiness),
        },
        thresholds: { noticeAt: Number(S().noticeAt) || 65, urgentAt: Number(S().urgentAt) || 85 },
        bonuses: {
          eat: bonusFor('eat'),
          sleep: bonusFor('sleep'),
          rest: bonusFor('rest'),
          coffee: bonusFor('coffee'),
        },
        lastAction: state.lastAction || null,
        lastTick: state.lastTick,
        lastChatAt: state.lastChatAt,
        sleeping: isSleeping(),
        asleepUntil: state.asleepUntil,
        auto: {
          enabled: Boolean(S().autoEnabled),
          eatAt: Number(S().autoEatAt) || 85,
          drinkAt: Number(S().autoDrinkAt) || 85,
          restAt: Number(S().autoRestAt) || 80,
          sleepAt: Number(S().autoSleepAt) || 88,
          sleepHours: Number(S().sleepHours) || 7,
          settleMinutes: Number(S().settleMinutes) || 40,
        },
        focused: [...focuses.entries()].map(([chatId, f]) => ({ chatId, at: f.at })),
        rates: {
          hunger: Number(S().hungerRate) || 4,
          thirst: Number(S().thirstRate) || 5,
          fatigue: Number(S().fatigueRate) || 2.5,
          sleepiness: Number(S().sleepinessRate) || 3,
        },
      }
    })

    api.route('/act', async (req) => {
      const b = await api.core.http.body(req).catch(() => ({}))
      return doAction(String(b.action || ''), { force: true, source: '面板' })
    })

    api.onDispose(() => {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
      save()
    })
  },
}
