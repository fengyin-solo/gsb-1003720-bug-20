import { MODULES, MODULE_BY_KEY } from './modules'
import { SEED_ROWS } from './seed'
import type {
  CommitChangeSet,
  CommitRequest,
  CommitResult,
  EntryRow,
  OverviewSnapshot,
} from './types'

// 本地持久化：整份状态（版本 + 数据 + 快照）放在一个 localStorage 键里，
// 一次 setItem 原子提交；落库抛错时旧值原封不动，天然支持整批回退。
const STORAGE_KEY = 'hydrology-monitor-station:entries'
// 旧版本分别存放版本号与快照，迁移时用来兜底读取。
const LEGACY_VERSION_KEY = 'hydrology-monitor-station:version'
const LEGACY_SNAPSHOT_KEY = 'hydrology-monitor-station:snapshots'
const MAX_SNAPSHOTS = 50

// 站点模块特殊：它自己就是站点，停用/撤销都算「不在用」。
const STATION_MODULE = 'station'
// 挂在站点下的记录，所属站点进入这些状态即视为停用：仍登记在册，但不计待处理/异常。
const STATION_OFFLINE_STATUSES = ['暂停运行', '已撤销']
// 各业务状态里属于「异常」语义的状态。异常量只数这些，动作名不再参与判断，避免重复。
const ABNORMAL_STATUSES = new Set([
  '设备故障',
  '异常值',
  '超标',
  '需重测',
  '信号异常',
  '已驳回',
  '需检修',
  '发现故障',
  '通讯中断',
  '不合格',
])
// 已了结、无需再处理的状态（含正常完结、在修在施、停用撤销）。
// 注意不能用「最后一个状态」判断：数据类模块的末态是异常值，恰恰还要处理。
const RESOLVED_STATUSES = new Set([
  '汛期加强',
  '已通过',
  '已出报告',
  '已校核',
  '已刊印',
  '已调整',
  '施工中',
  '检修中',
  '已停用',
  '已废止',
  '已处置',
  '已合格',
  '已批准',
  '已完成',
  '已验收',
  '已复核',
])

export type DataState = {
  version: number
  rows: Record<string, EntryRow[]>
  snapshots: OverviewSnapshot[]
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isStationOffline(status: unknown): boolean {
  return STATION_OFFLINE_STATUSES.includes(String(status))
}

/** 站点是否在用：站点行自身状态不是停用/撤销。 */
function stationRowActive(row: EntryRow): boolean {
  return !isStationOffline(row.status)
}

/** 构建「站点业务键 -> 是否在用」索引，供挂站点模块级联判断。 */
function buildStationIndex(rows: Record<string, EntryRow[]>): Map<string, boolean> {
  const index = new Map<string, boolean>()
  for (const station of rows[STATION_MODULE] ?? []) {
    const code = String(station['站点编号'] ?? '').trim()
    if (code) {
      index.set(code, stationRowActive(station))
    }
  }
  return index
}

/**
 * 单一事实源是 status：pending/abnormal 全部由状态 + 站点在用情况派生，
 * 不再信任行里历史残留的标志（旧值、重复异常都来自这里）。
 */
export function deriveFlags(
  metaKey: string,
  row: EntryRow,
  stationIndex: Map<string, boolean>,
): { pending: boolean; abnormal: boolean } {
  const meta = MODULE_BY_KEY.get(metaKey)
  const status = String(row.status ?? '')

  let active = true
  if (metaKey === STATION_MODULE) {
    active = stationRowActive(row)
  } else if (meta?.stationField) {
    const ref = String(row[meta.stationField] ?? '').trim()
    if (ref) {
      // 索引里查得到才级联停用；查不到（示例数据站点对不上）视为在用，不擅自剔除。
      const known = stationIndex.get(ref)
      if (known !== undefined) {
        active = known
      }
    }
  }

  const abnormal = ABNORMAL_STATUSES.has(status)
  // 停用/撤销：登记在册，但既不算待处理也不算异常（停用是正常生命周期）。
  const pending = active && !RESOLVED_STATUSES.has(status)
  return { pending, abnormal: active && abnormal }
}

/** 就地把一批模块的派生标志重算一遍，返回同一引用便于链式使用。 */
export function reconcileRows(
  rows: Record<string, EntryRow[]>,
  keys: string[] = MODULES.map((m) => m.key),
): Record<string, EntryRow[]> {
  const stationIndex = buildStationIndex(rows)
  for (const key of keys) {
    const list = rows[key]
    if (!list) {
      continue
    }
    for (const row of list) {
      const { pending, abnormal } = deriveFlags(key, row, stationIndex)
      row.pending = pending
      row.abnormal = abnormal
    }
  }
  return rows
}

function seedState(): Record<string, EntryRow[]> {
  // 以模块表为准建表，避免 localStorage 里残留已下线模块的旧键（清单残留旧记录）。
  const base: Record<string, EntryRow[]> = {}
  for (const meta of MODULES) {
    base[meta.key] = clone(SEED_ROWS[meta.key] ?? [])
  }
  return reconcileRows(base)
}

function readJson<T>(key: string): T | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

type StoredEnvelope = {
  version: number
  rows: Record<string, EntryRow[]>
  snapshots: OverviewSnapshot[]
}

function isEnvelope(value: unknown): value is StoredEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    'rows' in value &&
    typeof (value as StoredEnvelope).rows === 'object'
  )
}

/**
 * 读取持久化数据并做迁移清洗：
 * 1. 兼容新旧两种存储形态（新：单键整份状态；旧：数据单键 + 版本/快照旁路键）；
 * 2. 只保留当前模块表登记过的键，丢弃残留旧记录；
 * 3. pending/abnormal 一律按 status 重算，修掉历史脏标志。
 */
function loadState(): DataState {
  const fallback = seedState()
  if (typeof window === 'undefined' || !window.localStorage) {
    return { version: 0, rows: fallback, snapshots: [] }
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = seedState()
    writeStorage(0, seeded, [])
    return { version: 0, rows: seeded, snapshots: [] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    const seeded = seedState()
    writeStorage(0, seeded, [])
    return { version: 0, rows: seeded, snapshots: [] }
  }

  // 新形态：整份状态一个键。
  let storedRows: Record<string, EntryRow[]>
  let storedVersion = 0
  let storedSnapshots: OverviewSnapshot[] = []
  if (isEnvelope(parsed)) {
    storedRows = parsed.rows
    storedVersion = Math.max(0, Math.trunc(Number(parsed.version)) || 0)
    storedSnapshots = Array.isArray(parsed.snapshots) ? parsed.snapshots : []
  } else {
    // 旧形态：数据单键，版本与快照在旁路键。
    storedRows = parsed as Record<string, EntryRow[]>
    storedVersion = Math.max(0, Math.trunc(Number(readJson<number>(LEGACY_VERSION_KEY)) || 0))
    const legacySnapshots = readJson<OverviewSnapshot[]>(LEGACY_SNAPSHOT_KEY)
    storedSnapshots = Array.isArray(legacySnapshots) ? legacySnapshots : []
  }

  const cleaned: Record<string, EntryRow[]> = {}
  for (const meta of MODULES) {
    const stored = Array.isArray(storedRows[meta.key]) ? storedRows[meta.key] : null
    cleaned[meta.key] = stored ? clone(stored) : clone(SEED_ROWS[meta.key] ?? [])
  }
  reconcileRows(cleaned)

  return { version: storedVersion, rows: cleaned, snapshots: storedSnapshots }
}

/**
 * 整份状态一次 setItem 原子落库：要么旧值原样保留（抛错→调用方整批回退），
 * 要么版本/数据/快照同时生效，不会出现只写一半的撕裂状态。
 */
function writeStorage(version: number, rows: Record<string, EntryRow[]>, snapshots: OverviewSnapshot[]): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  const envelope: StoredEnvelope = { version, rows, snapshots }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope))
}

let cache: DataState | null = null

function state(): DataState {
  if (cache === null) {
    cache = loadState()
  }
  return cache
}

export function allRows(): Record<string, EntryRow[]> {
  return state().rows
}

export function listRows(key: string): EntryRow[] {
  return state().rows[key] ?? []
}

export function currentVersion(): number {
  return state().version
}

export function listSnapshots(): OverviewSnapshot[] {
  return clone(state().snapshots)
}

export function storageKey(): string {
  return STORAGE_KEY
}

// ---- 串行提交队列：并发提交排队进临界区，保证只有一个线程在做读-改-落库 ----

type QueueJob<T> = () => T
let chain: Promise<unknown> = Promise.resolve()

function enqueue<T>(job: QueueJob<T>): Promise<T> {
  const run = chain.then(job, job)
  // 不让单个任务的异常打断后续排队任务。
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

// ---- 在途提交去重：相同 dedupeKey 的并发提交只算一次有效落库 ----

type PendingDedupe = {
  key: string
  result: Promise<CommitResult>
}
const inflight = new Map<string, PendingDedupe>()

function validateChanges(changes: CommitChangeSet): void {
  for (const [key, rows] of Object.entries(changes)) {
    if (!MODULE_BY_KEY.has(key)) {
      throw new Error(`未知业务模块「${key}」，拒绝落库`)
    }
    if (!Array.isArray(rows)) {
      throw new Error(`模块「${key}」的清单不是数组，拒绝落库`)
    }
    const seen = new Set<number>()
    for (const row of rows) {
      if (typeof row?.id !== 'number' || !Number.isFinite(row.id)) {
        throw new Error(`模块「${key}」存在无编号记录，拒绝落库`)
      }
      if (seen.has(row.id)) {
        throw new Error(`模块「${key}」编号 ${row.id} 重复，拒绝落库`)
      }
      seen.add(row.id)
    }
  }
}

function buildSnapshot(
  version: number,
  rows: Record<string, EntryRow[]>,
  req: CommitRequest,
  createdAt: string,
): OverviewSnapshot {
  const modules = MODULES.map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  return {
    version,
    shiftLabel: req.shiftLabel,
    operator: req.operator,
    createdAt,
    reason: req.reason,
    cards: [
      { label: '业务模块', value: modules.length },
      { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
      { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
      { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
    ],
    modules,
  }
}

/**
 * 唯一的落库入口。
 * - CAS：expectedVersion 与当前版本不一致就拒绝，不产生新版本（并发重算只接受一个版本）；
 * - 去重：相同 dedupeKey 的并发提交复用同一次有效落库；
 * - 事务：整批先在内存合并、校验、派生，再一次性持久化，任一步失败整体回退。
 */
export function commitState(req: CommitRequest): Promise<CommitResult> {
  if (req.dedupeKey) {
    const hit = inflight.get(req.dedupeKey)
    if (hit) {
      return hit.result.then((result) => ({ ...result, deduplicated: true }))
    }
  }

  const result = enqueue<CommitResult>(() => {
    const current = state()

    const expected = Math.trunc(Number(req.expectedVersion)) || 0
    if (current.version !== expected) {
      // 版本冲突：并发重算只接受一个版本，冲突方采用获胜版本，不另起新版本。
      const winner = buildSnapshot(current.version, current.rows, req, new Date().toISOString())
      return {
        ok: false,
        version: current.version,
        deduplicated: false,
        conflict: true,
        snapshot: winner,
      }
    }

    validateChanges(req.changes)

    // 内存里先合并整批：以模块表为底，覆盖被改的模块，未涉及模块原样保留。
    const merged: Record<string, EntryRow[]> = {}
    for (const meta of MODULES) {
      merged[meta.key] = clone(
        Object.prototype.hasOwnProperty.call(req.changes, meta.key)
          ? req.changes[meta.key]
          : current.rows[meta.key] ?? [],
      )
    }
    // 派生标志在整批合并后统一重算（站点停用要级联到挂站点模块）。
    reconcileRows(merged)

    const nextVersion = current.version + 1
    const nextSnapshots = [...current.snapshots]
    const snapshotRecord = buildSnapshot(nextVersion, merged, req, new Date().toISOString())
    nextSnapshots.push(snapshotRecord)
    while (nextSnapshots.length > MAX_SNAPSHOTS) {
      nextSnapshots.shift()
    }

    // 持久化失败则不触碰缓存，整批回退到提交前状态。
    try {
      writeStorage(nextVersion, merged, nextSnapshots)
    } catch (error) {
      cache = current
      throw new Error(
        `落库失败，整批已回退：${error instanceof Error ? error.message : String(error)}`,
      )
    }

    cache = { version: nextVersion, rows: merged, snapshots: nextSnapshots }
    return {
      ok: true,
      version: nextVersion,
      deduplicated: false,
      conflict: false,
      snapshot: clone(snapshotRecord),
    }
  })

  if (req.dedupeKey) {
    const entry: PendingDedupe = { key: req.dedupeKey, result }
    inflight.set(req.dedupeKey, entry)
    result.finally(() => {
      if (inflight.get(req.dedupeKey!) === entry) {
        inflight.delete(req.dedupeKey!)
      }
    })
  }

  return result
}

/** 重置单个模块到示例数据，同样走版本化落库。 */
export async function resetRows(key: string): Promise<EntryRow[]> {
  const rows = clone(SEED_ROWS[key] ?? [])
  const result = await commitState({
    expectedVersion: currentVersion(),
    changes: { [key]: rows },
    shiftLabel: '系统',
    operator: '系统',
    reason: `重置「${MODULE_BY_KEY.get(key)?.name ?? key}」到示例数据`,
  })
  if (!result.ok) {
    throw new Error('重置时数据版本已变化，请重试')
  }
  // 提交串行执行，此刻缓存即本次落库结果；返回该模块经派生重算后的清单。
  return state().rows[key] ?? rows
}
