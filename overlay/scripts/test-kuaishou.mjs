#!/usr/bin/env node
/**
 * 快手直播模块的离线测试。
 * 夹具按真实 /live_api/gameboard/list、/live_api/non-gameboard/list 的响应裁剪，
 * 只保留模块用到的字段；播放地址都是拼出来的假签名，不会真的联网。
 */
import assert from 'node:assert/strict'
import kuaishou from '../extractors/kuaishou-live/index.js'
import {
  CATEGORIES,
  MANUAL_GAME_ID,
  NON_GAME_BASE,
  clearResolveCache,
  claimsRef,
  detailEndpoint,
  fetchRoomDetail,
  isGameCategory,
  listEndpoint,
  normalizeQuality,
  normalizeRoom,
  officialMediaUrl,
  parseCategoryIds,
  parseCookie,
  parseRoomLinks,
  pickRepresentation,
  representationsFromDetail,
  representationsOf,
} from '../extractors/kuaishou-live/api.js'
import { interleaveByRank } from '../extractors/kuaishou-live/index.js'
import { getModule, resolverFor } from '../extractors/registry.js'

function rep(bitrate, streamId, { hidden = false, host = 'tx-origin.pull.yximgs.com' } = {}) {
  const name = { 8000: '蓝光Plus', 4000: '蓝光', 2000: '超清', 1000: '高清' }[bitrate] || '直播'
  const qualityType = { 8000: 'BLUE_RAY', 4000: 'SUPER', 2000: 'HIGH', 1000: 'STANDARD' }[bitrate] || 'STANDARD'
  return {
    id: bitrate,
    name,
    qualityType,
    bitrate,
    hidden,
    url: `https://${host}/gifshow/${streamId}_${bitrate}.flv?txSecret=abc&txTime=6ad88330`,
  }
}

function row(streamId, { author = '主播', caption = '直播中', viewers = 100, bitrates = [2000], ...rest } = {}) {
  return {
    id: streamId,
    caption,
    watchingCount: viewers,
    living: false, // 快手网页列表里恒为 false，模块不拿它判断
    author: { id: `author-${streamId}`, name: author, avatar: `https://p66.a.kwimgs.com/${streamId}.jpg` },
    playUrls: bitrates.length
      ? [{ type: 'dynamic', adaptationSet: { representation: bitrates.map(b => rep(b, streamId)) } }]
      : [],
    ...rest,
  }
}

const pages = new Map()
pages.set('/live_api/gameboard/list?gameId=1001', { list: [
  row('g1', { author: '王者主播A', viewers: 900, bitrates: [8000, 4000, 2000, 1000] }),
  row('g2', { author: '王者主播B', viewers: 300, bitrates: [4000, 2000] }),
  row('g3', { author: '王者主播C', viewers: 5, bitrates: [2000] }),
  row('g4', { author: '无流房间', viewers: 800, bitrates: [] }),
], hasMore: true })
pages.set('/live_api/gameboard/list?gameId=1001&page=2', { list: [], hasMore: false })
pages.set('/live_api/gameboard/list?gameId=22008', { list: [
  row('p1', { author: '和平主播A', viewers: 500, bitrates: [4000, 2000] }),
], hasMore: false })
pages.set('/live_api/non-gameboard/list?gameId=1000020', { list: [
  row('s1', { author: '带货主播', viewers: 700, bitrates: [2000] }),
  row('s2', { author: '带货主播B', viewers: 400, bitrates: [2000] }),
], hasMore: true })
pages.set('/live_api/non-gameboard/list?gameId=1000003', { list: [
  row('m1', { author: '唱歌主播', viewers: 600, bitrates: [2000] }),
], hasMore: false })

// 手动房间模式的 livedetail 夹具：真实接口的 playUrls 是 {h264:{档位名:url}, hevc:{...}}
function detailRow(overrides = {}) {
  return {
    result: 1,
    liveStream: {
      id: 'stream-liveguy',
      caption: '晚上好兄弟们',
      watchingCount: 2345,
      playUrls: {
        h264: {
          standard: 'https://tx-origin.pull.yximgs.com/gifshow/liveguy_1000.flv?txSecret=abc&txTime=6ad88330',
          high: 'https://tx-origin.pull.yximgs.com/gifshow/liveguy_2000.flv?txSecret=abc&txTime=6ad88330',
          super: 'https://tx-origin.pull.yximgs.com/gifshow/liveguy_4000.flv?txSecret=abc&txTime=6ad88330',
        },
        hevc: {},
      },
      ...overrides.liveStream,
    },
    author: { name: '手动主播', avatar: 'https://p66.a.kwimgs.com/liveguy.jpg', living: true },
    ...overrides,
  }
}
pages.set('/live_api/liveroom/livedetail?principalId=liveguy', detailRow())
// 「未开播」：Cookie 失效或真没播都是这个样子
pages.set('/live_api/liveroom/livedetail?principalId=offlineguy', {
  result: 2,
  liveStream: { playUrls: { h264: {}, hevc: {} }, url: 'https://m.gifshow.com/fw/live/undefined' },
  author: { living: false },
})

const requested = []
const fetchImpl = async (url, options = {}) => {
  const key = new URL(url).pathname + new URL(url).search
  requested.push({ key, cookie: options.headers?.Cookie || '', referer: options.headers?.Referer || '' })
  const payload = pages.get(key)
  return {
    ok: Boolean(payload),
    status: payload ? 200 : 404,
    json: async () => (payload ? { data: payload } : { data: { list: [] } }),
  }
}
const ctx = { fetchImpl, timeoutMs: 5000, config: { quality: 2000 } }

const checks = []
async function check(name, fn) {
  try { await fn(); checks.push(`  ✅ ${name}`) }
  catch (error) { checks.push(`  ❌ ${name}\n     ${error.message}`); process.exitCode = 1 }
}

await check('模块已登记，且能按引用找到它', async () => {
  assert.equal(getModule('kuaishou-live'), kuaishou)
  assert.equal(resolverFor('kuaishou-1001-g1'), kuaishou)
  assert.equal(resolverFor('kuaishou-1000020-s1'), kuaishou)
})

await check('引用格式：分区号 + 房间号，拒绝越界与多余片段', async () => {
  assert.equal(claimsRef('kuaishou-1001-iu5CvOuo8kQ'), true)
  assert.equal(claimsRef('kuaishou-1000020-0X-l89U9dfc'), true)
  assert.equal(claimsRef('kuaishou-1001-g1/extra'), false)
  assert.equal(claimsRef('kuaishou-abc-g1'), false)
  assert.equal(claimsRef('douyin-1001-g1'), false)
})

await check('游戏分区与非游戏分区走不同的列表接口', async () => {
  assert.equal(isGameCategory('1001'), true)
  assert.equal(isGameCategory(String(NON_GAME_BASE)), false)
  assert.match(listEndpoint('1001'), /\/live_api\/gameboard\/list\?gameId=1001$/)
  assert.match(listEndpoint('1000020'), /\/live_api\/non-gameboard\/list\?gameId=1000020$/)
  assert.match(listEndpoint('1001', 2), /[?&]page=2$/)
  // 第一页不带 page 参数，跟官网一致
  assert.ok(!listEndpoint('1001').includes('page='))
})

await check('分类号：越界、未知分类、注释与重复都要处理掉', async () => {
  assert.deepEqual(parseCategoryIds('1001\n22008\n# 注释\n1001\n99999999\nabc'), ['1001', '22008'])
  assert.deepEqual(parseCategoryIds(''), [])
  assert.deepEqual(parseCategoryIds('0\n-1'), [])
})

await check('播放地址只放行快手回源域名上的 FLV', async () => {
  assert.match(
    officialMediaUrl('http://tx-origin.pull.yximgs.com/gifshow/x.flv?a=1'),
    /^https:\/\/tx-origin\.pull\.yximgs\.com\/gifshow\/x\.flv/,
  )
  assert.throws(() => officialMediaUrl('https://evil.example.com/x.flv'), /域名不可信/)
  assert.throws(() => officialMediaUrl('https://tx-origin.pull.yximgs.com/x.m3u8'), /不是 FLV/)
  assert.throws(() => officialMediaUrl('ftp://tx-origin.pull.yximgs.com/x.flv'), /协议不正确/)
})

await check('档位表：隐藏条目与错域名的条目跳过，按码率从高到低', async () => {
  const reps = representationsOf({
    playUrls: [{ adaptationSet: { representation: [
      rep(2000, 'x'),
      rep(4000, 'x', { hidden: true }),
      rep(1000, 'x'),
      rep(8000, 'x', { host: 'evil.example.com' }),
    ] } }],
  })
  assert.deepEqual(reps.map(r => r.bitrate), [2000, 1000])
})

await check('选档：命中就用，没有就往下一档找，0 表示最高档', async () => {
  const reps = [8000, 4000, 2000].map(b => ({ bitrate: b, name: String(b), url: `https://tx-origin.pull.yximgs.com/${b}.flv` }))
  assert.equal(pickRepresentation(reps, 0).bitrate, 8000)
  assert.equal(pickRepresentation(reps, 4000).bitrate, 4000)
  assert.equal(pickRepresentation(reps, 2000).bitrate, 2000)
  // 只有超清的房间请求蓝光时降到超清，而不是报错
  assert.equal(pickRepresentation([reps[2]], 8000).bitrate, 2000)
  assert.throws(() => pickRepresentation([], 2000), /没有可用的播放地址/)
})

await check('画质白名单：配置里存了非法值时回落默认档', async () => {
  assert.equal(normalizeQuality(4000), 4000)
  assert.equal(normalizeQuality('0'), 0)
  assert.equal(normalizeQuality(1234), 2000)
  assert.equal(normalizeQuality(undefined), 2000)
})

await check('房间规范化：没流没地址的房间不算频道', async () => {
  const room = normalizeRoom(row('ok1', { author: '主播甲', caption: '今晚八点' }))
  assert.equal(room.streamId, 'ok1')
  assert.equal(room.name, '主播甲 · 今晚八点')
  assert.equal(room.logo, 'https://p66.a.kwimgs.com/ok1.jpg')
  // 标题和主播名一样时不重复拼接
  assert.equal(normalizeRoom(row('ok2', { author: '同一句', caption: '同一句' })).name, '同一句')
  assert.throws(() => normalizeRoom(row('off', { bitrates: [] })), /没有播放地址/)
})

await check('分类轮流排：先每个分类第一名，再第二名', async () => {
  const order = interleaveByRank([[{ id: 'a1' }, { id: 'a2' }], [{ id: 'b1' }], [{ id: 'c1' }]], 2)
  assert.deepEqual(order.map(x => x.id), ['a1', 'b1', 'c1', 'a2'])
  assert.deepEqual(interleaveByRank([], 3), [])
})

await (async () => {
  clearResolveCache()
  requested.length = 0
  const output = await kuaishou.fetch({
    categories: '1001\n22008\n1000020\n1000003',
    perCategory: 2,
    minViewers: 0,
    maxChannels: 10,
    quality: 2000,
  }, ctx)

  const list = output.groups?.[0]?.dataList || []
  await check('抓取：分成一个「快手」组，游戏与非游戏分区都能进来', async () => {
    assert.equal(output.groups.length, 1)
    assert.equal(output.groups[0].name, '快手')
    const refs = list.map(ch => ch.deferredRef)
    assert.ok(refs.includes('kuaishou-1001-g1'), '游戏分区房间应在')
    assert.ok(refs.includes('kuaishou-1000020-s1'), '非游戏分区房间应在')
    assert.ok(refs.includes('kuaishou-1000003-m1'), '娱乐分区房间应在')
  })

  await check('抓取：没有播放地址的房间被跳过', async () => {
    assert.ok(!list.some(ch => ch.deferredRef.endsWith('-g4')), '无流房间不应出现')
  })

  await check('抓取：每个分类按观看人数取前几名，轮流排', async () => {
    // 1001 分类取 g1(900)、g2(300)，跳过 g4(800 但无流) 与 g3(5 排在第3)
    const refs = list.map(ch => ch.deferredRef)
    assert.ok(refs.includes('kuaishou-1001-g2'))
    assert.ok(!refs.includes('kuaishou-1001-g3'), '第 3 名超出 perCategory 应排除')
    // 第一名们排在前 4 个位置
    assert.deepEqual(refs.slice(0, 4), [
      'kuaishou-1001-g1', 'kuaishou-22008-p1', 'kuaishou-1000020-s1', 'kuaishou-1000003-m1',
    ])
  })

  await check('抓取：总共最多加入几个频道的上限生效', async () => {
    const capped = await kuaishou.fetch({
      categories: '1001\n1000020', perCategory: 5, minViewers: 0, maxChannels: 2, quality: 2000,
    }, ctx)
    assert.equal(capped.groups[0].dataList.length, 2)
  })

  await check('抓取：最低观看人数过滤生效', async () => {
    return kuaishou.fetch({
      categories: '1001', perCategory: 5, minViewers: 400, maxChannels: 10, quality: 2000,
    }, ctx).then(result => {
      const refs = (result.groups[0]?.dataList || []).map(ch => ch.deferredRef)
      assert.deepEqual(refs, ['kuaishou-1001-g1'])
    })
  })

  await check('抓取：频道带台标、画质标签和所属分组', async () => {
    const first = list.find(ch => ch.deferredRef === 'kuaishou-1001-g1')
    assert.equal(first.groupTitle, '快手')
    assert.equal(first.qualityLabel, '超清')
    assert.match(first.logo, /^https:\/\//)
    assert.equal(first.catchup, 'none')
  })

  await check('抓取：没选分类时给一句说明而不是抛错', async () => {
    const empty = await kuaishou.fetch({ categories: '', perCategory: 2, maxChannels: 5 }, ctx)
    assert.deepEqual(empty.groups, [])
    assert.match(empty.meta.warnings.join(' '), /没有选择任何快手分类/)
  })

  clearResolveCache()
  requested.length = 0
  const played = await kuaishou.resolve('kuaishou-1001-g1', ctx)
  await check('播放：按分区号找到房间并给出 FLV 地址', async () => {
    assert.match(played.url, /^https:\/\/tx-origin\.pull\.yximgs\.com\/.*\.flv\?/)
    assert.equal(played.streamType, 'flv')
    assert.equal(typeof played.validateMediaUrl, 'function')
    assert.match(played.desc, /王者主播A/)
  })

  await check('播放：地址校验函数会拒绝被换掉的域名', async () => {
    assert.throws(() => played.validateMediaUrl('https://evil.example.com/x.flv'), /域名不可信/)
  })

  const before = requested.length
  await kuaishou.resolve('kuaishou-1001-g1', ctx)
  await check('播放：同一引用短时间内复用结果，不重复联网', async () => {
    assert.equal(requested.length, before, '第二次解析不应再发请求')
  })

  await check('播放：按画质覆盖取不同档位', async () => {
    const hd = await kuaishou.resolve('kuaishou-1001-g1', { ...ctx, query: { quality: '1000' } })
    assert.match(hd.url, /_1000\.flv/)
    const top = await kuaishou.resolve('kuaishou-1001-g1', { ...ctx, query: { quality: '0' } })
    assert.match(top.url, /_8000\.flv/)
  })

  await check('播放：房间已不在列表里时给出可读的失败原因', async () => {
    const gone = await kuaishou.resolve('kuaishou-1001-nothere', ctx)
    assert.equal(gone.url, '')
    assert.match(gone.desc, /已不在该分类的列表里/)
  })

  await check('播放：格式不对的引用不联网也不崩', async () => {
    const bad = await kuaishou.resolve('douyin-999', ctx)
    assert.equal(bad.url, '')
    assert.match(bad.desc, /引用格式错误/)
  })

  /* ============================== 手动房间模式 ============================== */

  await check('手动房间：链接解析认链接、裸 ID、注释与重复行', async () => {
    const { ids, skipped } = parseRoomLinks([
      '# 注释行',
      'https://live.kuaishou.com/u/liveguy?from=share',
      'www.kuaishou.com/profile/liveguy',
      'liveguy',
      'https://live.kuaishou.com/u/liveguy',
      '这不是链接!!',
      '',
    ].join('\n'))
    assert.deepEqual(ids, ['liveguy'])
    assert.deepEqual(skipped, ['这不是链接!!'])
    assert.deepEqual(parseRoomLinks('').ids, [])
  })

  await check('手动房间：Cookie 解析认原始值、Cookie: 前缀与 JSON，并只留快手域', async () => {
    assert.equal(parseCookie('did=web_abc; kpn=GAME_ZONE'), 'did=web_abc; kpn=GAME_ZONE')
    assert.equal(parseCookie('Cookie: did=web_abc; kpn=GAME_ZONE'), 'did=web_abc; kpn=GAME_ZONE')
    const json = JSON.stringify({ cookies: [
      { name: 'did', value: 'web_abc', domain: '.kuaishou.com' },
      { name: 'other', value: 'x', domain: '.baidu.com' },
      { name: 'kpn', value: 'GAME_ZONE', domain: 'kuaishou.com' },
    ] })
    assert.equal(parseCookie(json), 'did=web_abc; kpn=GAME_ZONE')
    assert.equal(parseCookie(''), '')
    assert.throws(() => parseCookie('只有一段没有等号'), /格式无效/)
    assert.throws(() => parseCookie('{"foo":1}'), /没有 cookie/)
  })

  await check('手动房间：livedetail 档位映射与域名白名单', async () => {
    const reps = representationsFromDetail({
      playUrls: {
        h264: {
          standard: 'https://tx-origin.pull.yximgs.com/a_1000.flv',
          high: 'https://tx-origin.pull.yximgs.com/a_2000.flv',
          super: 'https://evil.example.com/a.flv', // 坏域名条目要被丢掉
          mystery: 'https://tx-origin.pull.yximgs.com/a_mystery.flv', // 未知档位名不炸
        },
        hevc: {},
      },
    })
    assert.deepEqual(reps.map(r => r.bitrate), [2000, 1000, 0])
    assert.equal(reps[0].name, '超清')
    assert.equal(reps[2].name, 'mystery')
    // value 是对象（带 bitrate / url）时照常解析
    const obj = representationsFromDetail({
      playUrls: { h264: { high: { url: 'https://tx-origin.pull.yximgs.com/b.flv', bitrate: 2500 } } },
    })
    assert.equal(obj[0].bitrate, 2500)
    // h264 全空时回落 hevc
    const hevc = representationsFromDetail({
      playUrls: { h264: {}, hevc: { high: 'https://tx-origin.pull.yximgs.com/c.flv' } },
    })
    assert.equal(hevc.length, 1)
  })

  await check('手动房间：没 Cookie 时给出可操作提示，不发请求', async () => {
    const before = requested.length
    await assert.rejects(
      () => fetchRoomDetail('liveguy', { cookie: '', fetchImpl }),
      /需要登录 Cookie/,
    )
    assert.equal(requested.length, before)
  })

  await check('手动房间：取数要带上 Cookie 与房间页 Referer', async () => {
    requested.length = 0
    await fetchRoomDetail('liveguy', { cookie: 'did=web_abc; kpn=GAME_ZONE', fetchImpl })
    const call = requested.find(r => r.key === detailEndpoint('liveguy').replace('https://live.kuaishou.com', ''))
    assert.ok(call, 'livedetail 应被请求')
    assert.equal(call.cookie, 'did=web_abc; kpn=GAME_ZONE')
    assert.match(call.referer, /live\.kuaishou\.com\/u\/liveguy/)
  })

  await check('手动房间：未开播（或 Cookie 失效）按离线处理', async () => {
    await assert.rejects(
      () => fetchRoomDetail('offlineguy', { cookie: 'did=web_abc', fetchImpl }),
      error => error.name === 'KuaishouOfflineError' && /未开播|Cookie 失效/.test(error.message),
    )
  })

  clearResolveCache()
  requested.length = 0
  const manual = await kuaishou.fetch({
    rooms: 'https://live.kuaishou.com/u/liveguy\nofflineguy\nhttps://live.kuaishou.com/u/liveguy',
    cookie: 'did=web_abc; kpn=GAME_ZONE',
    quality: 2000,
  }, ctx)

  await check('手动抓取：只出填写的房间，顺序与链接一致，分类设置被忽略', async () => {
    const list = manual.groups?.[0]?.dataList || []
    assert.equal(manual.groups.length, 1)
    assert.equal(manual.groups[0].name, '快手')
    assert.deepEqual(list.map(ch => ch.deferredRef), ['kuaishou-0-liveguy'])
    assert.equal(list[0].name, '手动主播 · 晚上好兄弟们')
    assert.equal(list[0].groupTitle, '快手')
    assert.ok(!list.some(ch => ch.deferredRef.startsWith('kuaishou-1001-')), '分类频道不应出现')
    assert.match(manual.meta.warnings.join(' '), /offlineguy/)
  })

  await check('手动抓取：没填 Cookie 时空组返回并提示，不联网', async () => {
    const before = requested.length
    const noCookie = await kuaishou.fetch({ rooms: 'liveguy', cookie: '', quality: 2000 }, ctx)
    assert.deepEqual(noCookie.groups, [])
    assert.match(noCookie.meta.warnings.join(' '), /需要登录 Cookie/)
    assert.equal(requested.length, before)
  })

  await check('手动抓取：坏 Cookie 的报错原样透传给后台', async () => {
    const bad = await kuaishou.fetch({ rooms: 'liveguy', cookie: '没有等号', quality: 2000 }, ctx)
    assert.deepEqual(bad.groups, [])
    assert.match(bad.meta.warnings.join(' '), /格式无效/)
  })

  clearResolveCache()
  requested.length = 0
  const manualPlay = await kuaishou.resolve('kuaishou-0-liveguy', { ...ctx, config: { quality: 2000, cookie: 'did=web_abc; kpn=GAME_ZONE' } })
  await check('手动播放：分区号 0 的引用走 livedetail 并给出 FLV', async () => {
    assert.match(manualPlay.url, /^https:\/\/tx-origin\.pull\.yximgs\.com\/.*\.flv\?/)
    assert.equal(manualPlay.streamType, 'flv')
    assert.match(manualPlay.desc, /手动主播/)
    assert.ok(requested.some(r => r.key.includes('/live_api/liveroom/livedetail')), '应请求 livedetail')
  })

  await check('手动播放：fetch 刚抓过的房间直接复用，不再联网', async () => {
    // 上面 fetch 已把 liveguy 放进 manualPool；清掉 resolve 缓存但保留房间池
    clearResolveCache()
    // clearResolveCache 也会清 manualPool，所以这里先 fetch 一次再解析
    await kuaishou.fetch({ rooms: 'liveguy', cookie: 'did=web_abc', quality: 2000 }, ctx)
    requested.length = 0
    await kuaishou.resolve('kuaishou-0-liveguy', { ...ctx, config: { quality: 2000, cookie: 'did=web_abc' } })
    assert.equal(requested.filter(r => r.key.includes('livedetail')).length, 0, '不应再请求 livedetail')
  })

  await check('手动播放：档位覆盖照常生效', async () => {
    const top = await kuaishou.resolve('kuaishou-0-liveguy', { ...ctx, config: { quality: 0, cookie: 'did=web_abc' }, query: { quality: '0' } })
    assert.match(top.url, /_4000\.flv/)
  })

  console.log(checks.join('\n'))
  if (process.exitCode) {
    console.log('\n有测试未通过')
  } else {
    console.log(`\n全部通过：${checks.length} ✅`)
  }
})()
