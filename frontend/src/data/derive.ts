import { MODULES, MODULE_BY_KEY } from './modules'
import type { ArchivedRow, ArchiveReason, EntryRow, MetricSpec, ModuleMeta, ShiftSnapshot } from './types'

// 跨模块汇总的唯一口径层：概览、各模块页面、历史班次快照都从这里取数。
// pending / abnormal 不再读行上持久化的旧标记，而是按模块状态机实时派生；
// 停用（撤销/废止）的行以及引用停用站点的跨模块行记为「已归档」，只在当前计数里剔除，
// 记录本身仍保留在清单中，历史班次快照也沿用归档前的原快照，不被改动。

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function doneStatuses(meta: ModuleMeta): Set<string> {
  return new Set(meta.done ?? [meta.statuses[meta.statuses.length - 1]])
}

export function inactiveStatuses(meta: ModuleMeta): Set<string> {
  return new Set(meta.inactive ?? [])
}

export function abnormalStatuses(meta: ModuleMeta): Set<string> {
  return new Set(meta.abnormalStatuses ?? [])
}

/** 状态机派生：待处理 = 非终态；异常 = 命中异常状态集合。停用记录两项都不计。 */
export function isPending(row: EntryRow, meta: ModuleMeta): boolean {
  return !doneStatuses(meta).has(row.status) && !inactiveStatuses(meta).has(row.status)
}

export function isAbnormal(row: EntryRow, meta: ModuleMeta): boolean {
  return abnormalStatuses(meta).has(row.status)
}

/** 当前处于停用/撤销/废止状态的站点编号集合（跨模块联动的依据）。 */
export function inactiveStationCodes(rowsByKey: Record<string, EntryRow[]>): Set<string> {
  const codes = new Set<string>()
  for (const meta of MODULES) {
    if (!meta.stationField || inactiveStatuses(meta).size === 0) continue
    for (const row of rowsByKey[meta.key] ?? []) {
      if (inactiveStatuses(meta).has(row.status)) {
        codes.add(String(row[meta.stationField]))
      }
    }
  }
  return codes
}

export type { ArchivedRow, ArchiveReason }

/**
 * 给行打上归档标记：
 * - 本模块停用/撤销/废止 → inactive
 * - 本模块配置了站点关联字段、且该站点编号已停用 → station-inactive（站点停用联动）
 */
export function annotateRows(
  key: string,
  rows: EntryRow[],
  inactiveStations: Set<string>,
): ArchivedRow[] {
  const meta = MODULE_BY_KEY.get(key)
  return rows.map((row) => {
    if (meta && inactiveStatuses(meta).has(row.status)) {
      return { ...row, archived: true, archiveReason: 'inactive' as const }
    }
    if (meta?.stationField && inactiveStations.has(String(row[meta.stationField]))) {
      return { ...row, archived: true, archiveReason: 'station-inactive' as const }
    }
    return { ...row, archived: false }
  })
}

export type ModuleCounts = {
  created: number
  pending: number
  abnormal: number
  archived: number
}

/** 当前口径计数：归档记录不参与任何计数；异常量按记录去重，一条记录只计一次。 */
export function countRows(rows: ArchivedRow[], meta: ModuleMeta): ModuleCounts {
  const active = rows.filter((row) => !row.archived)
  return {
    created: active.length,
    pending: active.filter((row) => isPending(row, meta)).length,
    abnormal: active.filter((row) => isAbnormal(row, meta)).length,
    archived: rows.length - active.length,
  }
}

export function metricValue(metric: MetricSpec, rows: ArchivedRow[], meta: ModuleMeta): number {
  const active = rows.filter((row) => !row.archived)
  switch (metric.kind) {
    case 'total':
      return active.length
    case 'pending':
      return active.filter((row) => isPending(row, meta)).length
    case 'abnormal':
      // 异常量只认状态，且天然按行去重，杜绝重复显示。
      return active.filter((row) => isAbnormal(row, meta)).length
    case 'status':
      return active.filter((row) => row.status === metric.status).length
    default:
      return 0
  }
}

export type AnnotatedStore = {
  rows: Record<string, ArchivedRow[]>
  inactiveStations: Set<string>
}

export function annotateStore(rowsByKey: Record<string, EntryRow[]>): AnnotatedStore {
  const inactiveStations = inactiveStationCodes(rowsByKey)
  const rows: Record<string, ArchivedRow[]> = {}
  for (const meta of MODULES) {
    rows[meta.key] = annotateRows(meta.key, rowsByKey[meta.key] ?? [], inactiveStations)
  }
  return { rows, inactiveStations }
}

/** 修正行上持久化的 pending/abnormal：统一回填成状态机派生出的规范值。 */
export function normalizeRow(row: EntryRow, meta: ModuleMeta): EntryRow {
  return {
    ...row,
    pending: isPending(row, meta),
    abnormal: isAbnormal(row, meta),
  }
}

export function normalizeStore(rowsByKey: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const next: Record<string, EntryRow[]> = {}
  for (const meta of MODULES) {
    next[meta.key] = (rowsByKey[meta.key] ?? []).map((row) => normalizeRow(row, meta))
  }
  return next
}

export type OverviewInput = {
  version: number
  annotated: AnnotatedStore
  snapshot: ShiftSnapshot
}

/** 概览汇总：登记总量/待处理/异常量全部按当前口径跨模块求和，异常量按记录唯一去重。 */
export function buildOverview(input: OverviewInput) {
  const modules = MODULES.map((meta) => {
    const counts = countRows(input.annotated.rows[meta.key] ?? [], meta)
    return { name: meta.name, ...counts }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { version: input.version, cards, modules, snapshot: input.snapshot }
}

/**
 * 历史班次快照：基于一份冻结数据（初始示例库）按规范口径算一次，结果即固定。
 * 之后的重算、停用、状态流转都不再影响这份数字。
 */
export function buildSnapshot(
  label: string,
  rowsByKey: Record<string, EntryRow[]>,
): ShiftSnapshot {
  const annotated = annotateStore(rowsByKey)
  const modules = MODULES.map((meta) => {
    const { created, pending, abnormal } = countRows(annotated.rows[meta.key] ?? [], meta)
    return { name: meta.name, created, pending, abnormal }
  })
  const cards = [
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { label, cards, modules }
}
