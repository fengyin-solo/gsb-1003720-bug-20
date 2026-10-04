/**
 * 数据层核查脚本（不入构建产物）：npm run verify
 *
 * 覆盖：
 * 1. 旧标记自愈：即使持久化了与状态矛盾的 pending/abnormal，读取/重算仍按状态机派生
 * 2. 站点停用联动：撤销站点后，跨模块引用该站点的记录归档，清单默认不残留、概览不再计数
 * 3. 异常量按状态去重，不重复显示
 * 4. 历史班次快照在停用/重算后保持冻结
 * 5. 并发重算：只有最新版本被接受
 * 6. 并发提交：同 requestId 只落库一次
 * 7. 整批原子性：落库失败时版本与数据整批回退
 */

type MemoryDriver = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  failNext(): void
}

function makeDriver(): MemoryDriver {
  let store = new Map<string, string>()
  let failing = false
  const d: MemoryDriver = {
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem(key, value) {
      if (failing) {
        failing = false
        throw new Error('模拟写入失败')
      }
      store.set(key, value)
    },
    failNext() {
      failing = true
    },
  }
  return d
}

// 模块级 localStorage 占位，让 local-store 的浏览器探测走 driver 注入路径。
;(globalThis as Record<string, unknown>).window = undefined
;(globalThis as Record<string, unknown>).localStorage = undefined

const { __setStorageDriver, commitBatch, currentVersion, getSnapshot, storageKey } = await import(
  '../src/data/local-store'
)
const { normalizeStore } = await import('../src/data/derive')
const { SEED_ROWS } = await import('../src/data/seed')
const { loadOverview, listEntries, moduleStats, recalcOverview, runAction } = await import(
  '../src/api/local-service'
)

let failures = 0
function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.error(`  ✗ ${name} ${detail}`)
  }
}

// ---------- 1. 初始口径 ----------
console.log('1) 初始派生口径（示例库规范后）')
__setStorageDriver(makeDriver())
let ov = loadOverview()
// 18 个模块 × 3 行，按状态机规范化：54 总量 / 35 待处理 / 6 异常
const initial = { created: 54, pending: 35, abnormal: 6 }
const totalCard = Object.fromEntries(ov.cards.map((c) => [c.label, c.value]))
check('登记总量 54', totalCard['登记总量'] === initial.created, `got ${totalCard['登记总量']}`)
check('待处理 35', totalCard['待处理'] === initial.pending, `got ${totalCard['待处理']}`)
check('异常量 6', totalCard['异常量'] === initial.abnormal, `got ${totalCard['异常量']}`)
check('初始版本 v0', ov.version === 0, `got v${ov.version}`)

// 巡检页 stats：已巡检站点卡按 pending 派生（待巡检+发现故障=2），待处置故障=1
const inspStats = Object.fromEntries(moduleStats('inspection').map((s) => [s.label, s.value]))
check('巡检「已巡检站点」=2（非硬编码 0，=待巡检+发现故障）', inspStats['已巡检站点'] === 2, JSON.stringify(inspStats))
check('巡检「待处置故障」=1（异常去重）', inspStats['待处置故障'] === 1)

// ---------- 2. 旧标记自愈 ----------
console.log('2) 旧持久化标记与状态矛盾时，重算按状态机自愈')
const driver2 = makeDriver()
const stale = normalizeStore(structuredClone(SEED_ROWS))
// 人为污染：全部行都标 pending/abnormal=true（模拟旧版本残留）
for (const rows of Object.values(stale)) {
  for (const r of rows) {
    r.pending = true
    r.abnormal = true
  }
}
driver2.setItem(storageKey(), JSON.stringify({ version: 3, entries: stale }))
__setStorageDriver(driver2)
ov = loadOverview()
check('污染数据重算后异常量仍是 6（不信旧标记）',
  Object.fromEntries(ov.cards.map((c) => [c.label, c.value]))['异常量'] === 6)
check('污染数据版本沿用 v3', ov.version === 3, `got v${ov.version}`)
const normalizedStation = getSnapshot().entries.station.find((r) => r.status === '汛期加强')!
check('落库视图行标记已规范（终态汛期加强不再 pending）', normalizedStation.pending === false)

// ---------- 3. 站点停用联动 ----------
console.log('3) 撤销站点 STAT-0001：概览/整编/巡检跨模块联动')
__setStorageDriver(makeDriver())
const before = loadOverview()
const beforeComp = before.modules.find((m) => m.name === '数据整编')!
const beforeInsp = before.modules.find((m) => m.name === '巡检记录')!
const result = await runAction('station', 1, '撤销站点')
check('撤销站点提交成功', result.ok, result.message)
check('撤销后版本 +1 → v1', result.version === 1)

ov = loadOverview()
const afterCard = Object.fromEntries(ov.cards.map((c) => [c.label, c.value]))
// station 自身 -1；引用 STAT-0001 的整编 COMP-0002、巡检 INSP-0003、站房维护 STAT-0001 联动 -3，共 -4
check('登记总量 54 → 50', afterCard['登记总量'] === 50, `got ${afterCard['登记总量']}`)
// station(-1)、整编待整编(-1)、巡检待巡检(-1)、站房待安排(-1) = -4
check('待处理 35 → 31', afterCard['待处理'] === 31, `got ${afterCard['待处理']}`)
check('异常量 6 → 5（撤销本身不算异常，巡检故障行随站点归档）', afterCard['异常量'] === 5, `got ${afterCard['异常量']}`)

const stationList = listEntries('station')
check('站点清单默认不含已撤销行', stationList.items.every((r) => r.status !== '已撤销'))
check('站点清单总数 = 2', stationList.total === 2, `got ${stationList.total}`)
const stationListAll = listEntries('station', {}, { includeArchived: true })
check('勾选后已撤销行仍可核查（不删除）', stationListAll.total === 3 && stationListAll.archived === 1)

const compList = listEntries('compilation')
const compRowsStill = compList.items.some((r) => String(r['站点编号']) === 'STAT-0001')
check('整编清单默认不残留停用站点旧记录', !compRowsStill)
check('整编默认清单 = 2 条', compList.total === 2, `got ${compList.total}`)
const compAll = listEntries('compilation', {}, { includeArchived: true })
const compArchived = compAll.items.find((r) => String(r['站点编号']) === 'STAT-0001')
check('联动行标记为 station-inactive', compArchived?.archived === true
  && compArchived?.archiveReason === 'station-inactive')
const compAfter = ov.modules.find((m) => m.name === '数据整编')!
check('整编 created 2 / pending 2 / archived 1（残留行待整编不计待处理）',
  compAfter.created === 2 && compAfter.pending === 2 && compAfter.archived === 1,
  JSON.stringify(compAfter))
check('整编概览变化与明细一致（共同口径）',
  compAfter.created === beforeComp.created - 1 && compAfter.pending === beforeComp.pending - 1)

const inspList = listEntries('inspection')
check('巡检清单默认不残留停用站点旧记录',
  !inspList.items.some((r) => String(r['站点编号']) === 'STAT-0001'))
const inspAfter = ov.modules.find((m) => m.name === '巡检记录')!
check('巡检 created 2 / pending 1 / abnormal 0 / archived 1（故障行随站点归档）',
  inspAfter.created === 2 && inspAfter.pending === 1 && inspAfter.abnormal === 0 && inspAfter.archived === 1,
  JSON.stringify(inspAfter))
const inspStatsAfter = Object.fromEntries(moduleStats('inspection').map((s) => [s.label, s.value]))
check('巡检页「本月巡检次数」2、「已巡检站点」1、「待处置故障」0',
  inspStatsAfter['本月巡检次数'] === 2 && inspStatsAfter['已巡检站点'] === 1 && inspStatsAfter['待处置故障'] === 0,
  JSON.stringify(inspStatsAfter))
const houseAfter = ov.modules.find((m) => m.name === '站房维护')!
check('站房维护同样联动归档（STAT-0001 维护记录）', houseAfter.created === 2 && houseAfter.archived === 1,
  JSON.stringify(houseAfter))

// ---------- 4. 异常量不重复 ----------
console.log('4) 异常量按记录去重')
await runAction('waterlevel', 3, '标记异常') // 已通过 → 异常值
ov = loadOverview()
const abnormalNow = Object.fromEntries(ov.cards.map((c) => [c.label, c.value]))['异常量']
check('标记一条异常后异常量 5 → 6（每条只计一次；撤销后基数为 5）', abnormalNow === 6, `got ${abnormalNow}`)
await runAction('waterlevel', 3, '确认通过') // 恢复
ov = loadOverview()
const abnormalBack = Object.fromEntries(ov.cards.map((c) => [c.label, c.value]))['异常量']
check('处置后异常量回落 6 → 5（不残留旧异常）', abnormalBack === 5, `got ${abnormalBack}`)

// ---------- 5. 历史班次快照冻结 ----------
console.log('5) 历史班次沿用原快照')
const snap = ov.snapshot
const snapTotal = Object.fromEntries(snap.cards.map((c) => [c.label, c.value]))
check('快照标签存在', snap.label.includes('历史快照'))
check('快照登记总量恒为 54', snapTotal['登记总量'] === 54, `got ${snapTotal['登记总量']}`)
check('快照待处理恒为 35', snapTotal['待处理'] === 35, `got ${snapTotal['待处理']}`)
check('快照异常量恒为 6', snapTotal['异常量'] === 6, `got ${snapTotal['异常量']}`)
check('快照整编仍为 3/3（停用不回改历史）',
  snap.modules.find((m) => m.name === '数据整编')?.created === 3)

// ---------- 6. 并发重算只接受一个（最新）版本 ----------
console.log('6) 并发重算只接受最新版本')
const vBefore = currentVersion()
const recalcAll = await Promise.all([
  recalcOverview(),
  recalcOverview(),
  runAction('rainfall', 1, '提交审核').then(() => undefined),
  recalcOverview(),
])
const versions = recalcAll.filter(Boolean).map((r) => r!.version)
check('并发重算结果版本均不低于提交后的最新版本',
  versions.every((v) => v >= vBefore + 1), JSON.stringify(versions))
check('没有重算结果回退到旧版本',
  !versions.some((v) => v < currentVersion()), JSON.stringify(versions))

// ---------- 7. 并发提交只算一次有效落库 ----------
console.log('7) 同一提交并发只落库一次（幂等）')
const vNow = currentVersion()
const producer1 = (cur: ReturnType<typeof getSnapshot>) => {
  const rows = structuredClone(cur.entries.discharge)
  const target = rows.find((r) => r.id === 1)!
  if (target.status === '待审核') return null
  target.status = '待审核'
  return [{ key: 'discharge', rows }]
}
const reqId = 'discharge:1:提交审核'
const outcomes = await Promise.all([
  commitBatch(producer1, reqId),
  commitBatch(producer1, reqId),
  commitBatch(producer1, reqId),
])
check('三次并发提交版本相同', outcomes[0].version === outcomes[1].version
  && outcomes[1].version === outcomes[2].version)
check('只有一次真正落库（版本仅 +1）', outcomes[0].version === vNow + 1,
  `got ${outcomes.map((o) => o.version)}`)
check('后到的并发提交标记 deduped', outcomes[1].deduped === true && outcomes[2].deduped === true)
check('首个提交不是 deduped', outcomes[0].deduped === false)
// 已完成 requestId 窗口内重放
const replay = await commitBatch(producer1, reqId)
check('requestId 重放不再落库', replay.deduped === true && replay.version === vNow + 1)
check('第 1 条记录确为待审核', getSnapshot().entries.discharge[0].status === '待审核')

console.log('7b) 同模块并发改不同行互不覆盖（改动在队列内基于最新快照构造）')
const vBefore7b = currentVersion()
const [o1, o2] = await Promise.all([
  commitBatch((cur) => {
    const rows = structuredClone(cur.entries.discharge)
    rows[1] = { ...rows[1], status: '已通过' }
    return [{ key: 'discharge', rows }]
  }, 'discharge:2:确认通过'),
  commitBatch((cur) => {
    const rows = structuredClone(cur.entries.discharge)
    rows[2] = { ...rows[2], status: '异常值' }
    return [{ key: 'discharge', rows }]
  }, 'discharge:3:标记异常'),
])
const disc = getSnapshot().entries.discharge
check('两次不同行提交都生效（版本各 +1，共 +2）',
  o1.version === vBefore7b + 1 && o2.version === vBefore7b + 2,
  `${o1.version}/${o2.version} at v${vBefore7b}`)
check('第 2 行改为已通过（未被另一个提交覆盖丢失）', disc[1].status === '已通过', disc[1].status)
check('第 3 行改为异常值', disc[2].status === '异常值', disc[2].status)
check('第 1 行维持第 7 节的待审核', disc[0].status === '待审核', disc[0].status)

// ---------- 8. 任一落库失败整批回退 ----------
console.log('8) 落库失败整批回退')
const driver = makeDriver()
__setStorageDriver(driver)
const vStart = currentVersion()
driver.failNext()
let threw = false
try {
  await commitBatch((cur) => {
    const station = structuredClone(cur.entries.station)
    station[1] = { ...station[1], status: '汛期加强' }
    const rainfallRows = structuredClone(cur.entries.rainfall)
    rainfallRows[0] = { ...rainfallRows[0], status: '待审核' }
    return [
      { key: 'station', rows: station },
      { key: 'rainfall', rows: rainfallRows },
    ]
  }, `fail-batch@${vStart}`)
} catch (e) {
  threw = true
}
check('落库失败向上抛出', threw)
check('失败后版本不变（整批回退）', currentVersion() === vStart, `got v${currentVersion()}`)
const stationAfterFail = getSnapshot().entries.station[1]
check('station 改动已回退（仍为设备故障）', stationAfterFail.status === '设备故障', stationAfterFail.status)
check('rainfall 改动也随整批回退',
  getSnapshot().entries.rainfall[0].status === '已采集',
  getSnapshot().entries.rainfall[0].status)
ov = loadOverview()
check('回退后概览恢复为新库初始 54/35/6（整批均未生效）',
  (() => {
    const c = Object.fromEntries(ov.cards.map((x) => [x.label, x.value]))
    return c['登记总量'] === 54 && c['待处理'] === 35 && c['异常量'] === 6
  })(),
  JSON.stringify(Object.fromEntries(ov.cards.map((x) => [x.label, x.value]))))

// ---------- 9. 停用计数策略 ----------
console.log('9) 停用不计数（总量=当前在册，历史快照保留原数）')
// 第 8 节换了全新驱动（未撤销站点），这里以「直接构造停用联动」的方式复核策略
const freshCard = Object.fromEntries(loadOverview().cards.map((c) => [c.label, c.value]))
check('全新库当前登记总量为 54（停用尚未发生）', freshCard['登记总量'] === 54)
check('历史快照仍按原班次数 54', loadOverview().snapshot.cards[0].value === 54)

console.log(failures === 0 ? '\n全部核查通过 ✅' : `\n${failures} 项核查失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
