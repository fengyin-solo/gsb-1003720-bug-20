import { MODULE_BY_KEY, MODULES } from '@/data/modules'
import {
  allRows,
  commitState,
  currentVersion,
  listRows,
  listSnapshots,
  resetRows,
} from '@/data/local-store'
import { useSessionStore } from '@/stores/session'
import type {
  ActionResult,
  CommitResult,
  EntryRow,
  ModuleMeta,
  ModuleSummary,
  OverviewResult,
  OverviewSnapshot,
  PageResult,
} from '@/data/types'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/** 单模块的登记总量 / 待处理 / 异常量，全部来自服务层派生，页面不再各写一份。 */
export function moduleSummary(key: string): ModuleSummary {
  const meta = moduleMeta(key)
  const entries = listRows(key)
  return {
    name: meta.name,
    created: entries.length,
    pending: entries.filter((row) => row.pending).length,
    abnormal: entries.filter((row) => row.abnormal).length,
  }
}

function summaryCards(modules: ModuleSummary[]) {
  return [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
}

function snapshotToOverview(snapshot: OverviewSnapshot, snapshots: OverviewSnapshot[]): OverviewResult {
  return {
    version: snapshot.version,
    cards: snapshot.cards,
    modules: snapshot.modules,
    snapshots,
  }
}

/**
 * 运营概览：数字一律读当前（已按 status 派生）的行；同时返回历史班次快照供回看。
 * 传 version 则沿用那一版快照，历史班次看到的就是当时固化的数字。
 */
export function loadOverview(version?: number): OverviewResult {
  const snapshots = listSnapshots()
  if (typeof version === 'number') {
    const hit = snapshots.find((item) => item.version === version)
    if (hit) {
      return snapshotToOverview(hit, snapshots)
    }
  }
  const rows = allRows()
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
    version: currentVersion(),
    cards: summaryCards(modules),
    modules,
    snapshots,
  }
}

function shiftContext(): { shiftLabel: string; operator: string } {
  try {
    const store = useSessionStore()
    return { shiftLabel: store.shiftLabel, operator: store.operator }
  } catch {
    return { shiftLabel: '未分班', operator: '值班管理员' }
  }
}

/**
 * 重新统计：不改任何业务状态，只把全模块的派生标志重算一遍并固化一个新版本。
 * 并发重算靠 expectedVersion 做 CAS，只有一个版本会落库。
 */
export async function recalculate(
  expectedVersion: number,
  reason = '手动重新统计',
): Promise<CommitResult> {
  const changes: Record<string, EntryRow[]> = {}
  for (const meta of MODULES) {
    changes[meta.key] = listRows(meta.key)
  }
  const { shiftLabel, operator } = shiftContext()
  return commitState({
    expectedVersion,
    dedupeKey: `recalc:${expectedVersion}`,
    changes,
    shiftLabel,
    operator,
    reason,
  })
}

/**
 * 状态流转：改 status，由数据层统一派生 pending/abnormal。
 * 站点停用/撤销/恢复会级联重算所有挂站点模块，保证跨模块汇总立即一致。
 * 返回 ActionResult（含版本与并发标记），并发提交只算一次有效落库。
 */
export async function runAction(key: string, id: number, action: string): Promise<ActionResult> {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const currentStatus = String(rows[index].status)
  if (currentStatus === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }

  const nextRows = [...rows]
  nextRows[index] = { ...rows[index], status: target }

  // 站点状态变更会影响所有挂站点模块的派生标志，整批带上一起重算。
  const changes: Record<string, EntryRow[]> = { [key]: nextRows }
  if (key === 'station') {
    for (const linked of MODULES) {
      if (linked.stationField) {
        changes[linked.key] = listRows(linked.key)
      }
    }
  }

  const expectedVersion = currentVersion()
  const { shiftLabel, operator } = shiftContext()
  const result = await commitState({
    expectedVersion,
    dedupeKey: `action:${key}:${id}:${action}:v${expectedVersion}`,
    changes,
    shiftLabel,
    operator,
    reason: `${meta.name}#${id} 执行「${action}」`,
  })

  if (result.conflict) {
    return {
      ok: false,
      version: result.version,
      conflict: true,
      message: '数据刚被其他操作更新，本次未重复落库，请刷新后重试',
    }
  }
  if (result.deduplicated) {
    return {
      ok: true,
      version: result.version,
      deduplicated: true,
      message: `${meta.entity}已${action}，当前状态「${target}」（并发提交已合并）`,
    }
  }
  return {
    ok: true,
    version: result.version,
    message: `${meta.entity}已${action}，当前状态「${target}」`,
  }
}

export async function resetModule(key: string): Promise<PageResult> {
  await resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
