/**
 * 快手直播：两种取频道的方式。
 *
 * 1) 分类模式 —— 公开网页分类列表里正在播的房间与 FLV 播放地址。
 *    两个列表接口共用一个 gameId 参数，但按分区拆开：
 *      游戏分区（gameId < 1000000）      /live_api/gameboard/list
 *      非游戏分区（gameId ≥ 1000000）    /live_api/non-gameboard/list
 *    两边互换参数都只回空列表，别试图统一。
 *
 * 2) 手动房间模式 —— 只加入用户在后台填的直播间链接。
 *    播放地址来自 /live_api/liveroom/livedetail?principalId=，这是网页播放器的
 *    取流接口；实测它对未登录请求一律回「未开播」（result=2，哪怕主播正在播，
 *    观众几千也一样），必须带用户自己的登录 Cookie 才出流。房间页 SSR、搜索、
 *    profile 接口对匿名请求同样全部关闭，所以手动模式没有游客版。
 *
 * 播放地址带 wsTime/txTime 签名，有效期数小时；刷新间隔默认 30 分钟，
 * 播放时按需重新取一次，避免用过期签名。
 */
import fetch from 'node-fetch'
import { createHash } from 'node:crypto'
import { qualityFrom } from '../../utils/qualityOverride.js'

export const KUAISHOU_GROUP = '快手'
export const ORIGIN = 'https://live.kuaishou.com'
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const REFERER = `${ORIGIN}/live/HOT`

// 非游戏分区的 gameId 都是七位数，游戏分区最大三位（1009）。
export const NON_GAME_BASE = 1_000_000

export const DEFAULT_QUALITY = 2000
// 后台下拉框与播放地址 ?quality= 共用这一份档位表；0 表示「能拿到的最高档」。
export const QUALITY_OPTIONS = Object.freeze([
  { value: 0, label: '自动：取该房间能拿到的最高档' },
  { value: 8000, label: '蓝光 Plus 8M' },
  { value: 4000, label: '蓝光 4M' },
  { value: 2000, label: '超清 2M（推荐）' },
  { value: 1000, label: '高清 1M' },
])

/**
 * 快手直播网页版当前公开的 50 个分类，按官网分区归组。
 * roomCount 天天变，不写进表里；分类增删以 /live_api/category/data 为准。
 */
export const CATEGORIES = Object.freeze({
  // 手游休闲
  22008: { name: '和平精英', section: '手游休闲' },
  1001: { name: '王者荣耀', section: '手游休闲' },
  22484: { name: '暗区突围', section: '手游休闲' },
  22181: { name: '原神', section: '手游休闲' },
  1054: { name: 'QQ飞车手游', section: '手游休闲' },
  22337: { name: '蛋仔派对', section: '手游休闲' },
  22494: { name: '金铲铲之战', section: '手游休闲' },
  22130: { name: '使命召唤手游', section: '手游休闲' },
  22150: { name: 'DNF手游', section: '手游休闲' },
  22645: { name: '崩坏：星穹铁道', section: '手游休闲' },
  22723: { name: '三角洲行动', section: '手游休闲' },
  1011: { name: '火影忍者', section: '手游休闲' },
  1006: { name: '穿越火线手游', section: '手游休闲' },
  22018: { name: '第五人格', section: '手游休闲' },
  22786: { name: '超自然行动组', section: '手游休闲' },
  22814: { name: '王者万象棋', section: '手游休闲' },
  // 网游竞技
  1: { name: '英雄联盟', section: '网游竞技' },
  2: { name: '穿越火线', section: '网游竞技' },
  3: { name: '地下城与勇士', section: '网游竞技' },
  21: { name: '绝地求生', section: '网游竞技' },
  25: { name: 'CS:GO', section: '网游竞技' },
  32: { name: '大话西游2', section: '网游竞技' },
  1009: { name: '我的世界', section: '网游竞技' },
  22017: { name: '魔域', section: '网游竞技' },
  22146: { name: '无畏契约', section: '网游竞技' },
  22551: { name: '恐龙岛', section: '网游竞技' },
  22658: { name: '热血传奇', section: '网游竞技' },
  22737: { name: '热血传奇手游', section: '网游竞技' },
  22742: { name: '龙岛异兽起源', section: '网游竞技' },
  7: { name: '传奇', section: '网游竞技' },
  // 单机热游
  22762: { name: '黑神话悟空', section: '单机热游' },
  22088: { name: '经典单机', section: '单机热游' },
  15: { name: '街机游戏', section: '单机热游' },
  // 娱乐
  1000003: { name: '音乐', section: '娱乐' },
  1000004: { name: '才艺', section: '娱乐' },
  1000002: { name: '舞蹈', section: '娱乐' },
  1000006: { name: '颜值', section: '娱乐' },
  1000007: { name: '情感', section: '娱乐' },
  1000005: { name: '脱口秀', section: '娱乐' },
  // 综合
  1000020: { name: '购物', section: '综合' },
  1000024: { name: '其他', section: '综合' },
  1000008: { name: '汽车', section: '综合' },
  1000015: { name: '田园', section: '综合' },
  1000016: { name: '健康', section: '综合' },
  1000011: { name: '美妆', section: '综合' },
  1000019: { name: '文玩', section: '综合' },
  1000009: { name: '美食', section: '综合' },
  1000014: { name: '旅游', section: '综合' },
  1000021: { name: '媒体', section: '综合' },
  // 文化
  1000023: { name: '科普', section: '文化' },
})

export const DEFAULT_CATEGORIES = ['1001', '22008', '22723', '1']

// 手动房间的 deferredRef 用 0 占住分区号的位置：kuaishou-0-<principalId>。
export const MANUAL_GAME_ID = '0'
const REF_RE = /^kuaishou-(\d{1,8})-([A-Za-z0-9_-]{1,40})$/
const RESOLVE_TTL_MS = 45_000
const FAIL_TTL_MS = 10_000
// 播放时找不到房间就往后再翻几页；超过这个数基本是已经下播了。
const RESOLVE_MAX_PAGES = 3
const resolveCache = new Map()
const resolvePending = new Map()
// fetch 抓过的房间按 streamId 留一份最新地址，播放时先查这里，省掉一次翻页。
const streamPool = new Map()
const POOL_MAX = 800
// 手动房间按 principalId 留最新一份，播放时没过期就直接用。
const manualPool = new Map()

export class KuaishouError extends Error {
  constructor(message) {
    super(message)
    this.name = 'KuaishouError'
  }
}

export class KuaishouOfflineError extends KuaishouError {
  constructor(message) {
    super(message)
    this.name = 'KuaishouOfflineError'
  }
}

/* ------------------------- 登录凭证状态（后台提醒用） ------------------------- */

export const KS_COOKIE_REJECTED_NOTICE =
  '快手当前 Cookie 没取到任何流：可能是 Cookie 已过期（请在浏览器重新复制），也可能是填的主播确实都没播'

const credentialKey = cookie => createHash('sha256').update(cookie).digest('base64url').slice(0, 12)

// 最近一次「带着这把 Cookie 全部房间都未开播」的摘要。注意快手的「未开播」和
// 「Cookie 失效」接口返回一模一样（都是 result=2 且无流），单房间失败不能下结论，
// 只有手动模式下所有房间都拿不到流时才标记，避免一个主播下播就误报。
let rejectedCookieKey = ''

/** 刷新结束时更新凭证状态：rejected = 本轮一个频道都没拿到。 */
export function markCredentialState(cookie, rejected) {
  try {
    const normalized = parseCookie(cookie)
    if (!normalized) return
    rejectedCookieKey = rejected ? credentialKey(normalized) : ''
  } catch { /* 坏 Cookie 不进状态机，配置保存时就会报错 */ }
}

/** 后台状态接口用：当前生效的 Cookie 是否处于被拒状态（见 registry.js 的 credentialRejected）。 */
export function credentialRejected(config) {
  let cookie = ''
  try { cookie = parseCookie(config?.cookie) } catch { return '' }
  return cookie && credentialKey(cookie) === rejectedCookieKey ? KS_COOKIE_REJECTED_NOTICE : ''
}

/** 测试用：清掉内存里记下的被拒 Cookie。 */
export function resetCredentialState() {
  rejectedCookieKey = ''
}

export function isGameCategory(gameId) {
  return Number(gameId) < NON_GAME_BASE
}

/** 只认下拉框里列出的档位；配置里存了别的值（老备份、手改 JSON）一律按默认档。 */
export function normalizeQuality(value) {
  const wanted = Number(value)
  return QUALITY_OPTIONS.some(option => option.value === wanted) ? wanted : DEFAULT_QUALITY
}

export function categoryLabel(gameId) {
  const found = CATEGORIES[Number(gameId)]
  return found ? found.name : `分区 ${gameId}`
}

export function listEndpoint(gameId, page = 1) {
  const base = isGameCategory(gameId) ? 'gameboard' : 'non-gameboard'
  const query = new URLSearchParams({ gameId: String(gameId) })
  if (Number(page) > 1) query.set('page', String(Number(page)))
  return `${ORIGIN}/live_api/${base}/list?${query.toString()}`
}

export function normalizeCategoryId(value) {
  const text = String(value ?? '').trim()
  if (!/^\d{1,8}$/.test(text)) throw new KuaishouError(`快手分类号格式不正确：${text || value}`)
  const id = String(Number(text))
  if (!CATEGORIES[Number(id)]) throw new KuaishouError(`未知的快手分类：${id}`)
  return id
}

export function parseCategoryIds(text) {
  const seen = new Set()
  const ids = []
  for (const line of String(text || '').split('\n')) {
    const value = line.trim()
    if (!value || value.startsWith('#')) continue
    let id
    try { id = normalizeCategoryId(value) } catch { continue }
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

/* ============================== 手动房间模式 ============================== */

// 认这两种链接：live.kuaishou.com/u/<principalId> 与 www.kuaishou.com/profile/<id>
const ROOM_LINK_RE = /(?:live\.kuaishou\.com\/u\/|www\.kuaishou\.com\/profile\/)([A-Za-z0-9_-]{1,64})/
const PLAIN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** 把后台粘贴的多行文本解析成主播 ID 列表；认不出原样的行进 skipped，不打断。 */
export function parseRoomLinks(text) {
  const seen = new Set()
  const ids = []
  const skipped = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const value = line.trim()
    if (!value || value.startsWith('#')) continue
    const linked = ROOM_LINK_RE.exec(value)
    const id = linked ? linked[1] : (PLAIN_ID_RE.test(value) ? value : '')
    if (!id || !PLAIN_ID_RE.test(id)) {
      skipped.push(value.slice(0, 40))
      continue
    }
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return { ids, skipped }
}

/** 只挑 kuaishou.com 域下的条目，其他域（百度统计之类）的 cookie 不外发。 */
function cookieEntries(value) {
  const entries = Array.isArray(value) ? value : value?.cookies
  if (!Array.isArray(entries)) return null
  return entries
    .filter(item => {
      const domain = String(item?.domain || '').replace(/^\./, '').toLowerCase()
      return !domain || domain === 'kuaishou.com' || domain.endsWith('.kuaishou.com')
    })
    .map(item => `${String(item?.name || '').trim()}=${String(item?.value || '')}`)
    .filter(item => !item.startsWith('='))
    .join('; ')
}

/**
 * 登录 Cookie 规范化。接受三种写法：请求头里的原始 Cookie 值、带 "Cookie:" 前缀的
 * 请求头整行、浏览器导出的 cookies JSON（数组或 {cookies:[]}）。写法不对就抛错，
 * 宁可让用户重新复制，也不要拿着半截 Cookie 去打接口。
 */
export function parseCookie(input) {
  if (input === undefined || input === null) return ''
  let value = typeof input === 'string' ? input.trim() : input
  if (typeof value === 'string') {
    value = value.replace(/^cookie\s*:\s*/i, '').trim()
    if (value.startsWith('{') || value.startsWith('[')) {
      let parsed
      try { parsed = JSON.parse(value) } catch { throw new KuaishouError('快手 Cookie JSON 格式无效') }
      value = typeof parsed?.cookie === 'string' ? parsed.cookie : cookieEntries(parsed)
      if (value === null) throw new KuaishouError('快手 Cookie JSON 中没有 cookie 或 cookies 字段')
    }
  } else {
    value = typeof value?.cookie === 'string' ? value.cookie : cookieEntries(value)
    if (value === null) throw new KuaishouError('快手 Cookie JSON 中没有 cookie 或 cookies 字段')
  }
  value = String(value || '').trim()
  if (!value) return ''
  if (value.length > 16_000 || /[\r\n\0]/.test(value)) throw new KuaishouError('快手 Cookie 格式无效')
  const pairs = value.split(';').map(part => part.trim()).filter(Boolean)
  if (!pairs.length || pairs.some(pair => !/^[^=;,\s]+=[^;\r\n]*$/.test(pair))) {
    throw new KuaishouError('快手 Cookie 格式无效，请粘贴浏览器请求头里的完整 Cookie 值')
  }
  return pairs.join('; ')
}

export function detailEndpoint(principalId) {
  return `${ORIGIN}/live_api/liveroom/livedetail?principalId=${encodeURIComponent(principalId)}`
}

// livedetail 的 playUrls 是 {h264:{standard:url,...}, hevc:{...}}，档位名没有码率字段，
// 只能按官网固定档位映射；value 偶尔是对象（带 url / bitrate），一并兼容。
const DETAIL_QUALITY_BY_KEY = Object.freeze({
  standard: { bitrate: 1000, name: '高清' },
  high: { bitrate: 2000, name: '超清' },
  super: { bitrate: 4000, name: '蓝光' },
  bluevip: { bitrate: 8000, name: '蓝光Plus' },
})

export function representationsFromDetail(liveStream) {
  const playUrls = liveStream?.playUrls
  // 兼容列表同款数组结构（万一接口某天统一格式）
  if (Array.isArray(playUrls)) return representationsOf({ playUrls })
  if (!playUrls || typeof playUrls !== 'object') return []
  const reps = []
  for (const codec of ['h264', 'hevc']) {
    const bucket = playUrls[codec]
    if (!bucket || typeof bucket !== 'object') continue
    for (const [key, value] of Object.entries(bucket)) {
      const url = typeof value === 'string' ? value : (value?.url || value?.playUrl)
      if (!url) {
        // value 若是列表同款的 adaptationSet 结构，也照单全收
        if (value?.adaptationSet?.representation) reps.push(...representationsOf({ playUrls: [value] }))
        continue
      }
      const known = DETAIL_QUALITY_BY_KEY[String(key).toLowerCase()]
      let bitrate = typeof value === 'object' ? (Number(value.bitrate) || 0) : 0
      bitrate = bitrate || known?.bitrate || 0
      const name = (typeof value === 'object' && value.name) || known?.name || key
      try {
        reps.push({ id: bitrate, name: String(name), bitrate, url: officialMediaUrl(url) })
      } catch { /* 域名不对的条目直接跳过 */ }
    }
    if (reps.length) break // h264 优先，播放器兼容性最好
  }
  return reps.sort((a, b) => b.bitrate - a.bitrate)
}

/**
 * 取一个手动房间的最新状态。result 非 1 或没有地址都按「未开播」处理——
 * 注意 Cookie 失效时接口也是这个表现，提示里把两种可能都写上。
 */
export async function fetchRoomDetail(principalId, options = {}) {
  const cookie = parseCookie(options.cookie)
  if (!cookie) {
    throw new KuaishouError('手动房间需要登录 Cookie：在后台「快手登录 Cookie」里粘贴浏览器里的完整 Cookie')
  }
  const data = await fetchJson(detailEndpoint(principalId), {
    ...options,
    cookie,
    referer: `${ORIGIN}/u/${principalId}`,
  })
  const liveStream = data?.liveStream || {}
  const reps = representationsFromDetail(liveStream)
  if (Number(data?.result) !== 1 || !reps.length) {
    throw new KuaishouOfflineError('主播当前未开播（若确认在播，多半是 Cookie 失效，请重新复制）')
  }
  const author = data.author || {}
  const name = truncate(author.name || principalId, 40)
  const title = truncate(liveStream.caption || data.caption || '', 30)
  const room = {
    // 手动房间的 streamId 就用 principalId：deferredRef（kuaishou-0-<principalId>）
    // 要长期稳定，liveStream.id 是每次开播都变的场次号，不能进引用里。
    streamId: String(principalId),
    liveStreamId: String(liveStream.id || ''),
    principalId: String(principalId),
    name: title && title !== name ? `${name} · ${title}` : name,
    author: name,
    logo: String(author.avatar || author.headUrl || ''),
    viewers: Number(liveStream.watchingCount) || 0,
    reps,
    gameId: MANUAL_GAME_ID,
  }
  manualPool.set(room.principalId, { room, at: Date.now() })
  return room
}

function truncate(value, max) {
  const text = String(value || '').replace(/[\x00-\x1f"]/g, ' ').replace(/,/g, '，').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** 列表里的 playUrls 是一条 dynamic 记录，真实档位在 adaptationSet.representation 里。 */
export function representationsOf(room) {
  for (const entry of Array.isArray(room?.playUrls) ? room.playUrls : []) {
    const list = entry?.adaptationSet?.representation
    if (!Array.isArray(list)) continue
    const reps = []
    for (const rep of list) {
      if (!rep?.url || rep.hidden) continue
      try {
        reps.push({
          id: Number(rep.id) || 0,
          name: String(rep.name || rep.qualityType || '').trim(),
          bitrate: Number(rep.bitrate) || 0,
          url: officialMediaUrl(rep.url),
        })
      } catch { /* 域名不对的条目直接跳过 */ }
    }
    if (reps.length) return reps.sort((a, b) => b.bitrate - a.bitrate)
  }
  return []
}

/**
 * 快手的 FLV 地址都落在自建/腾讯云回源域名上（*-origin.pull.yximgs.com）。
 * 只放行这一类域名，避免把上游返回的任意地址当播放源转发。
 */
export function officialMediaUrl(value) {
  let url
  try { url = new URL(String(value || '')) } catch { throw new KuaishouError('快手播放地址无效') }
  const host = url.hostname.toLowerCase()
  if (!['http:', 'https:'].includes(url.protocol)) throw new KuaishouError('快手播放地址协议不正确')
  if (!host.endsWith('.pull.yximgs.com')) throw new KuaishouError(`快手播放地址域名不可信：${host}`)
  if (!url.pathname.toLowerCase().endsWith('.flv')) throw new KuaishouError('快手播放地址不是 FLV')
  url.protocol = 'https:'
  return url.href
}

/** quality 为 0 时取最高档；指定档位不存在就往下一档找，都不存在再用最高档。 */
export function pickRepresentation(reps, quality) {
  if (!reps.length) throw new KuaishouOfflineError('房间没有可用的播放地址')
  const wanted = Number(quality) || 0
  if (!wanted) return reps[0]
  const exact = reps.find(rep => rep.bitrate === wanted)
  if (exact) return exact
  const lower = reps.filter(rep => rep.bitrate < wanted).sort((a, b) => b.bitrate - a.bitrate)[0]
  return lower || reps[0]
}

export function normalizeRoom(row) {
  const streamId = String(row?.id || '').trim()
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(streamId)) throw new KuaishouOfflineError('房间号格式不正确')
  const author = row?.author || {}
  const name = truncate(author.name || author.id || `快手 ${streamId}`, 40)
  const title = truncate(row.caption || '', 30)
  const reps = representationsOf(row)
  if (!reps.length) throw new KuaishouOfflineError(`房间 ${streamId} 当前没有播放地址`)
  return {
    streamId,
    name: title && title !== name ? `${name} · ${title}` : name,
    author: name,
    logo: String(author.avatar || ''),
    viewers: Number(row.watchingCount) || 0,
    reps,
  }
}

async function fetchJson(url, options = {}) {
  const { timeoutMs = 12000, fetchImpl = fetch, cookie = '', referer = REFERER } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      headers: {
        'User-Agent': UA,
        Referer: referer,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      redirect: 'follow',
      signal: controller.signal,
    })
    if (!response.ok) throw new KuaishouError(`HTTP ${response.status}`)
    const payload = await response.json()
    if (!payload || typeof payload !== 'object' || !payload.data) {
      throw new KuaishouError('快手列表接口返回结构异常')
    }
    return payload.data
  } catch (error) {
    if (error instanceof KuaishouError) throw error
    const reason = error?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error?.message || String(error))
    throw new KuaishouError(reason)
  } finally {
    clearTimeout(timer)
  }
}

/** 拉一个分类的一页房间；能解析出播放地址的才算数，没地址的（多为回放位）直接丢。 */
export async function fetchCategoryRooms(gameId, page = 1, options = {}) {
  const data = await fetchJson(listEndpoint(gameId, page), options)
  const rows = Array.isArray(data.list) ? data.list : []
  const rooms = []
  for (const row of rows) {
    let room
    try { room = normalizeRoom(row) } catch { continue }
    room.gameId = String(gameId)
    rooms.push(room)
    streamPool.set(room.streamId, { room, gameId: String(gameId), at: Date.now() })
  }
  if (streamPool.size > POOL_MAX) {
    const cutoff = Date.now() - 30 * 60 * 1000
    for (const [key, value] of streamPool) if (value.at < cutoff) streamPool.delete(key)
    while (streamPool.size > POOL_MAX) streamPool.delete(streamPool.keys().next().value)
  }
  return { rooms, hasMore: Boolean(data.hasMore) }
}

export function toChannel(room, quality) {
  const rep = pickRepresentation(room.reps, quality)
  return {
    name: room.name,
    deferredRef: `kuaishou-${room.gameId}-${room.streamId}`,
    relayHls: false,
    logo: room.logo,
    groupTitle: KUAISHOU_GROUP,
    catchup: 'none',
    // 列表给的档位名留在频道上，后台一眼能看出这路是超清还是蓝光。
    qualityLabel: rep.name || '',
  }
}

async function findRoomInCategory(gameId, streamId, ctx) {
  const pool = streamPool.get(streamId)
  if (pool && Date.now() - pool.at < 5 * 60 * 1000) return pool.room
  for (let page = 1; page <= RESOLVE_MAX_PAGES; page++) {
    const { rooms, hasMore } = await fetchCategoryRooms(gameId, page, ctx)
    const hit = rooms.find(room => room.streamId === streamId)
    if (hit) return hit
    if (!hasMore) break
  }
  throw new KuaishouOfflineError(`快手房间 ${streamId} 已不在该分类的列表里（可能已下播或换了分区）`)
}

async function resolveFresh(gameId, streamId, ctx) {
  const quality = normalizeQuality(qualityFrom(ctx, QUALITY_OPTIONS, DEFAULT_QUALITY))
  // 手动房间：分区号位置是 0，streamId 实际是 principalId，直接走 livedetail 取新地址
  if (String(gameId) === MANUAL_GAME_ID) {
    const pool = manualPool.get(streamId)
    const room = (pool && Date.now() - pool.at < 5 * 60 * 1000)
      ? pool.room
      : await fetchRoomDetail(streamId, { cookie: ctx.config?.cookie, timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
    const rep = pickRepresentation(room.reps, quality)
    return {
      url: rep.url,
      desc: `快手「${room.author}」${rep.name}地址获取成功`,
      streamType: 'flv',
      validateMediaUrl: url => officialMediaUrl(url),
    }
  }
  const room = await findRoomInCategory(gameId, streamId, ctx)
  const rep = pickRepresentation(room.reps, quality)
  return {
    url: rep.url,
    desc: `快手「${room.author}」${rep.name}地址获取成功`,
    streamType: 'flv',
    validateMediaUrl: url => officialMediaUrl(url),
  }
}

export async function resolveRoom(ref, ctx = {}) {
  try {
    const match = REF_RE.exec(String(ref || ''))
    if (!match) return { url: '', desc: '快手直播间引用格式错误' }
    const gameId = match[1]
    const streamId = match[2]
    const now = Number(ctx.now ?? Date.now())
    const quality = normalizeQuality(qualityFrom(ctx, QUALITY_OPTIONS, DEFAULT_QUALITY))
    const key = `${gameId}:${streamId}:${quality}`
    const cached = resolveCache.get(key)
    if (cached && cached.expiresAt > now) return cached.value

    let pending = resolvePending.get(key)
    if (!pending) {
      pending = resolveFresh(gameId, streamId, ctx)
        .then(value => {
          resolveCache.set(key, { value, expiresAt: now + RESOLVE_TTL_MS })
          return value
        })
        .catch(error => {
          const value = { url: '', desc: error?.message || '快手播放地址获取失败' }
          resolveCache.set(key, { value, expiresAt: now + FAIL_TTL_MS })
          return value
        })
        .finally(() => {
          if (resolvePending.get(key) === pending) resolvePending.delete(key)
        })
      resolvePending.set(key, pending)
    }
    return await pending
  } catch (error) {
    return { url: '', desc: error?.message || '快手播放地址获取失败' }
  }
}

export function claimsRef(ref) {
  return REF_RE.test(String(ref || ''))
}

export function clearResolveCache() {
  resolveCache.clear()
  resolvePending.clear()
  streamPool.clear()
  manualPool.clear()
}
