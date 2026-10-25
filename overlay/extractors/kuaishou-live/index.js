/** 快手直播：手动房间（只看自己填的直播间，需登录 Cookie）或按官网分区自动收录，FLV 由本机流式转发。 */
import {
  CATEGORIES,
  KUAISHOU_GROUP,
  QUALITY_OPTIONS,
  DEFAULT_QUALITY,
  DEFAULT_CATEGORIES,
  clearResolveCache,
  claimsRef,
  categoryLabel,
  fetchCategoryRooms,
  fetchRoomDetail,
  credentialRejected,
  markCredentialState,
  normalizeQuality,
  parseCategoryIds,
  parseCookie,
  parseRoomLinks,
  resolveRoom,
  toChannel,
} from './api.js'

const CONCURRENCY = 3
const DEFAULT_PER_CATEGORY = 6
const DEFAULT_MAX_CHANNELS = 40

async function mapLimit(items, limit, worker) {
  const output = new Array(items.length)
  let cursor = 0
  async function run() {
    while (cursor < items.length) {
      const index = cursor++
      output[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return output
}

/**
 * 分类轮流抽取：先每个分类的第 1 名，再第 2 名……这样开了十几个分类也不会被
 * 王者荣耀、和平精英这种大分区整屏占满。
 */
export function interleaveByRank(lists, perCategory) {
  const output = []
  const limit = Math.max(0, Math.min(30, Number(perCategory) || 0))
  for (let rank = 0; rank < limit; rank++) {
    for (const rooms of lists) {
      if (rooms[rank]) output.push(rooms[rank])
    }
  }
  return output
}

const CATEGORY_OPTIONS = Object.entries(CATEGORIES).map(([id, meta]) => ({
  value: id,
  label: `${meta.section} · ${meta.name}`,
}))

export default {
  id: 'kuaishou-live',
  name: '快手直播',
  description: '只看自己添加的快手直播间（需登录 Cookie），也可退回按官网分类自动收录；地址带短效签名，播放时即时刷新；FLV 由本机转发。',
  category: 'live',
  capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
  streamType: 'flv',
  defaultRefreshMinutes: 30,
  minRefreshMinutes: 15,
  maxRefreshMinutes: 120,
  // 手动房间模式的 Cookie 有失效可能，让后台提醒中心能跟踪（详见 api.js 的标记逻辑）
  credentialCheck: { refresh: true, playback: true, degrade: '手动房间模式下 Cookie 失效或主播都未开播时本次不出频道，下轮刷新自动重试；分类自动收录不需要 Cookie，不受影响' },

  configSchema: [
    {
      key: 'rooms',
      section: '手动房间 —— 只加入下面填的直播间，填了就不再抓取分类',
      label: '直播间链接（每行一个）',
      type: 'text',
      multiline: true,
      placeholder: 'https://live.kuaishou.com/u/chaoshi66',
      default: '',
      hint: '粘贴直播间网页链接（live.kuaishou.com/u/xxx），也可以直接填链接末尾的主播 ID，# 开头的行是注释。'
        + '这里填了内容，下面的「分类」设置全部忽略，播放列表里只出这些主播；未开播的主播会跳过并在日志里说明。',
    },
    {
      key: 'cookie',
      section: '手动房间 —— 只加入下面填的直播间，填了就不再抓取分类',
      label: '快手登录 Cookie',
      type: 'text',
      secret: true,
      env: 'mKsCookie',
      default: '',
      hint: '手动房间必须。电脑浏览器登录 live.kuaishou.com 后按 F12 → 网络（Network）→ 随便点一个 live.kuaishou.com 的请求 → 请求头里复制完整的 Cookie 值粘贴进来（支持带 Cookie: 前缀）。'
        + '快手把单房间取流接口锁在登录态后面，匿名请求一律回「未开播」，所以这步省不掉。Cookie 过期后频道会消失，重新复制一次即可。',
    },
    {
      key: 'categories',
      section: '自动收录 —— 不填手动房间时才生效：按快手官网分类加入正在播的房间',
      label: '选择分类（可多选）',
      type: 'multiselect',
      options: CATEGORY_OPTIONS,
      default: DEFAULT_CATEGORIES.join('\n'),
      hint: '默认四个热门分区。快手网页版目前公开 50 个分类：游戏分区走 gameboard 接口，'
        + '娱乐、综合、文化走 non-gameboard，两边的房间都能看。分类越少，首次抓取越快。',
    },
    {
      key: 'perCategory',
      section: '自动收录 —— 不填手动房间时才生效：按快手官网分类加入正在播的房间',
      label: '每个分类取前几名',
      type: 'int',
      min: 1,
      max: 30,
      default: DEFAULT_PER_CATEGORY,
      hint: '按当前观看人数从高到低取，各分类轮流排（先每个分类的第 1 名，再第 2 名），'
        + '避免大分区把小分区挤掉。游戏分区一页 20 个、非游戏分区一页 50 个，取超过一页只拿得到一页的量。',
    },
    {
      key: 'minViewers',
      section: '自动收录 —— 不填手动房间时才生效：按快手官网分类加入正在播的房间',
      label: '最低观看人数',
      type: 'int',
      min: 0,
      max: 10000000,
      default: 0,
      hint: '默认 0 不设门槛。快手网页显示的是实时观看人数，填 100 可滤掉刚开播的冷门房间。',
    },
    {
      key: 'maxChannels',
      section: '自动收录 —— 不填手动房间时才生效：按快手官网分类加入正在播的房间',
      label: '总共最多加入几个频道',
      type: 'int',
      min: 1,
      max: 200,
      default: DEFAULT_MAX_CHANNELS,
      hint: '分类开得多时防止播放列表被刷屏。超出后按「分类轮流」的顺序截断，前面的分类优先。',
    },
    {
      key: 'quality',
      section: '播放偏好',
      label: '优先画质',
      type: 'select',
      options: QUALITY_OPTIONS,
      default: DEFAULT_QUALITY,
      hint: '游戏分区通常有高清 / 超清 / 蓝光 / 蓝光 Plus 四档，非游戏分区多数只有超清一档。'
        + '房间没有所选档位时自动往下一档找，不会掉到没有。'
        + '单个频道可在播放地址末尾加 ?quality= 覆盖：0 最高、8000 蓝光 Plus、4000 蓝光、2000 超清、1000 高清。',
    },
  ],

  async fetch(config, ctx = {}) {
    const warnings = []
    let hardErrors = 0
    const quality = normalizeQuality(config.quality)

    // 手动房间模式：只解析用户填的链接，分类设置全部忽略
    const { ids: roomIds, skipped } = parseRoomLinks(config.rooms)
    if (roomIds.length) {
      for (const line of skipped) warnings.push(`快手：认不出这行链接，已跳过 —— ${line}`)
      let cookie
      try {
        cookie = parseCookie(config.cookie)
      } catch (error) {
        return { groups: [], meta: { skipped: warnings, warnings: [...warnings, error.message] } }
      }
      if (!cookie) {
        warnings.push('手动房间需要登录 Cookie：请在「快手登录 Cookie」里粘贴浏览器里的完整 Cookie（获取方法见该项说明）')
        return { groups: [], meta: { skipped: warnings, warnings } }
      }
      const resolved = await mapLimit(roomIds, 2, async id => {
        try {
          return await fetchRoomDetail(id, { cookie, timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
        } catch (error) {
          warnings.push(`快手「${id}」：${error.message}`)
          return null
        }
      })
      const channels = []
      const seen = new Set()
      for (const room of resolved) {
        if (!room || seen.has(room.principalId)) continue
        seen.add(room.principalId)
        try {
          channels.push(toChannel(room, quality))
        } catch (error) {
          warnings.push(`快手「${room.principalId}」：${error.message}`)
        }
      }
      if (!channels.length && roomIds.length) {
        warnings.push('填写的直播间当前都不在播（或 Cookie 已失效），本次没有产出频道')
      }
      // 凭证状态只看「全部落空」：单个主播下播是常态，不能据此说 Cookie 坏了
      markCredentialState(cookie, channels.length === 0)
      return {
        groups: channels.length ? [{ name: KUAISHOU_GROUP, dataList: channels }] : [],
        meta: { skipped: warnings, warnings },
      }
    }

    const perCategory = Math.max(1, Math.min(30, Number(config.perCategory) || DEFAULT_PER_CATEGORY))
    const minViewers = Math.max(0, Number(config.minViewers) || 0)
    const maxChannels = Math.max(1, Math.min(200, Number(config.maxChannels) || DEFAULT_MAX_CHANNELS))
    const ids = parseCategoryIds(config.categories)

    if (!ids.length) {
      return { groups: [], meta: { skipped: ['没有选择任何快手分类'], warnings: ['没有选择任何快手分类'] } }
    }

    const batches = await mapLimit(ids, CONCURRENCY, async id => {
      try {
        const { rooms } = await fetchCategoryRooms(id, 1, {
          timeoutMs: ctx.timeoutMs,
          fetchImpl: ctx.fetchImpl,
        })
        return rooms
          .filter(room => room.viewers >= minViewers)
          .sort((a, b) => b.viewers - a.viewers)
          .slice(0, perCategory)
      } catch (error) {
        if (error?.name !== 'KuaishouOfflineError') hardErrors++
        warnings.push(`快手分类「${categoryLabel(id)}」抓取失败：${error.message}`)
        return []
      }
    })

    const channels = []
    const seen = new Set()
    for (const room of interleaveByRank(batches, perCategory)) {
      if (channels.length >= maxChannels) break
      if (seen.has(room.streamId)) continue
      seen.add(room.streamId)
      try {
        channels.push(toChannel(room, quality))
      } catch (error) {
        warnings.push(`快手房间 ${room.streamId}：${error.message}`)
      }
    }

    if (!channels.length && hardErrors > 0) throw new Error(warnings[0] || '快手直播抓取失败')
    if (!channels.length) warnings.push('所选分类当前没有正在播、且能取到地址的房间')
    return {
      groups: channels.length ? [{ name: KUAISHOU_GROUP, dataList: channels }] : [],
      meta: { skipped: warnings, warnings },
    }
  },

  claimsRef,
  resolve: resolveRoom,
  clearResolveCache,
  credentialRejected,
}
