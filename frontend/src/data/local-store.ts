import { SEED_ROWS } from './seed'
import { buildSnapshot, clone, normalizeStore } from './derive'
import type { EntryRow, ShiftSnapshot } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都在。
// 每次有效落库都会让 version 单调 +1；写操作经串行队列提交，整批共用一次落库——
// 任一环节失败则整批回退（内存缓存保持提交前版本），并发提交按 requestId 幂等去重。

const STORAGE_KEY = 'hydrology-monitor-station:entries'

/** 历史班次：按示例库冻结一份，后续任何操作都不改它。 */
export const SNAPSHOT_LABEL = '2026-09-03 白班 08:00-20:00（历史快照）'
const FROZEN_SNAPSHOT: ShiftSnapshot = buildSnapshot(SNAPSHOT_LABEL, clone(SEED_ROWS))

export type StoreSnapshot = {
  version: number
  entries: Record<string, EntryRow[]>
}

type StorageDriver = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

function defaultDriver(): StorageDriver | null {
  if (typeof window === 'undefined' || !window.localStorage) return null
  return {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
  }
}

let driver: StorageDriver | null = defaultDriver()
let snapshot: StoreSnapshot | null = null
let queue: Promise<void> = Promise.resolve()
const inflight = new Map<string, Promise<{ version: number; noChange?: boolean }>>()
const finished = new Map<string, { version: number; at: number }>()
// 幂等窗口：窗口内的重复/重试提交视为同一意图，只落库一次；窗口外的全新操作（例如撤销后重做）正常受理。
const DEDUPE_TTL_MS = 5000
const listeners = new Set<() => void>()
let storageBound = false

function nowTs(): number {
  return typeof Date.now === 'function' ? Date.now() : 0
}

function pruneFinished(): void {
  const now = nowTs()
  for (const [key, item] of finished) {
    if (now - item.at > DEDUPE_TTL_MS) finished.delete(key)
  }
}

/** 供核查脚本注入可控存储（可模拟落库失败），页面运行时不会调用。 */
export function __setStorageDriver(custom: StorageDriver | null): void {
  driver = custom
  snapshot = null
  // 注入新存储视为全新数据域：清空幂等记录与在途状态，避免跨域 requestId 误去重。
  inflight.clear()
  finished.clear()
  queue = Promise.resolve()
}

function seedSnapshot(): StoreSnapshot {
  return { version: 0, entries: normalizeStore(clone(SEED_ROWS)) }
}

/** 迁移旧库：补齐缺失模块，并把行上残留的 pending/abnormal 旧标记统一重算成规范值。 */
function migrate(parsed: Partial<StoreSnapshot>): StoreSnapshot {
  const seed = seedSnapshot()
  const entries: Record<string, EntryRow[]> = { ...seed.entries }
  if (parsed.entries && typeof parsed.entries === 'object') {
    for (const [key, rows] of Object.entries(parsed.entries)) {
      if (Array.isArray(rows)) entries[key] = rows as EntryRow[]
    }
  }
  // 关键修复：历史持久化数据里的旧标记不再被信任，落库/读取时统一按状态机重算，
  // 这样「重新统计」即使面对旧版本数据也必然生效，异常量不会再按旧标记重复累计。
  return { version: Number(parsed.version) || 0, entries: normalizeStore(entries) }
}

function persist(next: StoreSnapshot): void {
  if (!driver) return
  // 整批共用一次写入：setItem 抛错（配额/拒绝写入）即视为本批失败，由调用方回退。
  driver.setItem(STORAGE_KEY, JSON.stringify(next))
}

function load(): StoreSnapshot {
  if (snapshot) return snapshot
  if (!driver) {
    snapshot = seedSnapshot()
    return snapshot
  }
  const raw = driver.getItem(STORAGE_KEY)
  if (!raw) {
    const initial = seedSnapshot()
    try {
      persist(initial)
    } catch {
      // 首播失败不阻塞使用，退回内存态；真正的业务提交失败会在 commitBatch 里抛出。
    }
    snapshot = initial
    return snapshot
  }
  try {
    snapshot = migrate(JSON.parse(raw) as Partial<StoreSnapshot>)
  } catch {
    const fallback = seedSnapshot()
    try {
      persist(fallback)
    } catch {
      /* 同上，退回内存态 */
    }
    snapshot = fallback
  }
  return snapshot
}

export function currentVersion(): number {
  return load().version
}

export function getSnapshot(): StoreSnapshot {
  return load()
}

export function getShiftSnapshot(): ShiftSnapshot {
  return FROZEN_SNAPSHOT
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  bindStorageEvent()
  return () => listeners.delete(listener)
}

function notify(): void {
  for (const listener of listeners) listener()
}

function bindStorageEvent(): void {
  if (storageBound || typeof window === 'undefined' || !window.addEventListener) return
  storageBound = true
  // 跨标签页写入后，本标签页缓存作废并通知页面重新派生，避免继续展示旧值。
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return
    snapshot = null
    notify()
  })
}

export type BatchChange = { key: string; rows: EntryRow[] }

/** 在串行队列内、基于提交前最新快照产出本批改动；返回 null 表示无需落库。 */
export type BatchProducer = (current: StoreSnapshot) => BatchChange[] | null

export type CommitOutcome = {
  version: number
  deduped: boolean
  /** producer 判定无需改动（记录已是目标态）：不产生新版本，不算一次有效落库。 */
  noChange?: boolean
}

/**
 * 串行化、幂等、原子的批量提交：
 * - 相同 requestId 的并发请求共用同一个在途任务，只落库一次（后到者标记 deduped）；
 * - 已完成的 requestId 重放直接返回原版本，不会再次落库；
 * - 改动在队列内基于最新快照构造，整批一次性持久化，避免同模块并发互相覆盖；
 * - 落库抛错则缓存不动（整批回退）。
 */
export function commitBatch(
  produce: BatchProducer,
  requestId: string,
): Promise<CommitOutcome> {
  pruneFinished()
  const done = finished.get(requestId)
  if (done) return Promise.resolve({ ...done, deduped: true })
  const pendingTask = inflight.get(requestId)
  if (pendingTask) {
    return pendingTask.then((item) => ({ ...item, deduped: true }))
  }

  const task = queue.then(() => {
    const prior = finished.get(requestId)
    if (prior) return { ...prior, deduped: true }

    const current = load()
    const changes = produce(current)
    if (!changes || changes.length === 0) {
      return { version: current.version, deduped: false, noChange: true }
    }
    const entries: Record<string, EntryRow[]> = { ...current.entries }
    for (const change of changes) {
      entries[change.key] = clone(change.rows)
    }
    // 提交进库的数据也统一过一遍规范口径，防止任何调用方带入旧标记。
    const next: StoreSnapshot = { version: current.version + 1, entries: normalizeStore(entries) }

    persist(next) // 抛错时下面赋值不会执行：缓存仍是 current，整批回退
    snapshot = next
    const outcome = { version: next.version, deduped: false, noChange: false, at: nowTs() }
    finished.set(requestId, outcome)
    notify()
    return outcome
  })
  queue = task.then(
    () => undefined,
    () => undefined,
  )
  inflight.set(
    requestId,
    task.then(({ version, noChange }) => ({ version, noChange })),
  )
  task.finally(() => inflight.delete(requestId))
  return task
}

/** 重置某模块回示例数据，同样走批量提交（成功才生效，失败回退）。 */
export function resetModuleRows(key: string, requestId: string): Promise<CommitOutcome> {
  return commitBatch(
    () => [{ key, rows: clone(SEED_ROWS[key] ?? []) }],
    requestId,
  )
}

export function storageKey(): string {
  return STORAGE_KEY
}
