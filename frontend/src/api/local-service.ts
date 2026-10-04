import { MODULE_BY_KEY } from '@/data/modules'
import {
  commitBatch,
  currentVersion,
  getShiftSnapshot,
  getSnapshot,
  resetModuleRows,
  subscribe,
} from '@/data/local-store'
import {
  annotateStore,
  buildOverview,
  clone,
  countRows,
  metricValue,
  normalizeRow,
} from '@/data/derive'
import type {
  ActionResult,
  ArchivedRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: ArchivedRow[], filters: Record<string, string>): ArchivedRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

/** 当前生效记录（含归档标记的派生视图）。 */
function annotatedRows(key: string): ArchivedRow[] {
  const store = getSnapshot()
  return annotateStore(store.entries).rows[key] ?? []
}

export type ListOptions = {
  /** 是否带出已停用/已撤销及属于停用站点的归档记录，默认不含（清单不残留旧记录）。 */
  includeArchived?: boolean
}

export function listEntries(
  key: string,
  filters: Record<string, string> = {},
  options: ListOptions = {},
): PageResult {
  const meta = moduleMeta(key)
  const scoped = options.includeArchived
    ? annotatedRows(key)
    : annotatedRows(key).filter((row) => !row.archived)
  const matched = filterRows(scoped, filters)
  return {
    items: clone(matched),
    total: matched.length,
    page: 1,
    size: matched.length,
    archived: countRows(annotatedRows(key), meta).archived,
  }
}

export type ModuleStat = { label: string; value: number }

export function moduleStats(key: string): ModuleStat[] {
  const meta = moduleMeta(key)
  const rows = annotatedRows(key)
  return meta.metrics.map((metric) => ({
    label: metric.label,
    value: metricValue(metric, rows, meta),
  }))
}

export async function runAction(key: string, id: number, action: string): Promise<ActionResult> {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  // 同一记录 + 同一动作的短时重复/并发提交共用一个幂等键（不含版本，撤销后重做仍可正常受理）。
  const requestId = `${key}:${id}:${action}`

  try {
    const outcome = await commitBatch((current) => {
      const rows = clone(current.entries[key] ?? [])
      const index = rows.findIndex((row) => Number(row.id) === id)
      if (index < 0) {
        throw new Error(`没有找到编号为 ${id} 的${meta.entity}`)
      }
      if (String(rows[index].status) === target) {
        // 已被别的在途提交改到目标态：本批不再产生改动（不算一次有效落库）。
        return null
      }
      // 落库的新行完全按状态机派生 pending/abnormal，动作名不再参与异常判断。
      rows[index] = normalizeRow({ ...rows[index], status: target }, meta)
      return [{ key, rows }]
    }, requestId)

    if (outcome.noChange) {
      // producer 返回 null：记录已是目标状态，并非这次提交生效。
      return {
        ok: false,
        version: outcome.version,
        message: `${meta.entity}已经是「${target}」，不用重复操作`,
      }
    }
    return {
      ok: true,
      version: outcome.version,
      deduped: outcome.deduped,
      message: outcome.deduped
        ? `${meta.entity}「${action}」为重复提交，只计一次有效落库（v${outcome.version}）`
        : `${meta.entity}已${action}，当前状态「${target}」`,
    }
  } catch (error) {
    // 任一落库失败：本批未生效，清单与汇总仍保持提交前版本。
    return {
      ok: false,
      message: `落库失败，已整批回退：${error instanceof Error ? error.message : '未知错误'}`,
    }
  }
}

export async function resetModule(key: string): Promise<PageResult> {
  await resetModuleRows(key, `reset:${key}@${Date.now()}`)
  return listEntries(key)
}

/**
 * 重新统计（重算）：派生本身是纯计算，关键是并发时只接受最新一版。
 * 发起时记录数据版本，等待期间若已有更新版本落库，则本次结果作废，改用最新版本重算。
 */
export async function recalcOverview(): Promise<OverviewResult> {
  const startedAt = currentVersion()
  // 让出一个事件循环 tick，使并发的提交先进入串行队列；恢复后再取版本做仲裁。
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  const latest = currentVersion()
  const acceptedVersion = latest > startedAt ? latest : startedAt
  const store = getSnapshot()
  if (store.version !== acceptedVersion) {
    // 等待窗口里出现了更新的并发版本：只接受最新版本，旧版本结果直接丢弃。
    return buildOverview({
      version: store.version,
      annotated: annotateStore(store.entries),
      snapshot: getShiftSnapshot(),
    })
  }
  return buildOverview({
    version: acceptedVersion,
    annotated: annotateStore(store.entries),
    snapshot: getShiftSnapshot(),
  })
}

/** 数据层变更订阅：跨模块汇总、跨标签页写入后页面自动刷新，不再展示旧值。 */
export function onDataChange(listener: () => void): () => void {
  return subscribe(listener)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  // 导出沿用当前口径：默认不含停用/归档记录；归档记录仍可在勾选后导出。
  for (const row of listEntries(key, {}, { includeArchived: true }).items) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
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

export function loadOverview(): OverviewResult {
  const store = getSnapshot()
  return buildOverview({
    version: store.version,
    annotated: annotateStore(store.entries),
    snapshot: getShiftSnapshot(),
  })
}
