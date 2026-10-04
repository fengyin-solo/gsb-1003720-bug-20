import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  moduleStats,
  onDataChange,
  runAction as applyAction,
} from '@/api/local-service'
import type { ActionResult, ArchivedRow } from '@/data/types'

// 所有巡检/业务页面共用的清单逻辑：字段与动作来自模块元数据，
// 统计卡由状态机口径实时派生，数据层任何变更（含跨标签页、跨模块停用联动）都即时刷新。
export function useModulePage(key: string) {
  const meta = moduleMeta(key)
  const rows = ref<ArchivedRow[]>([])
  const total = ref(0)
  const archivedCount = ref(0)
  const errorMessage = ref('')
  const filters = reactive<Record<string, string>>({})
  const includeArchived = ref(false)
  const busy = ref(false)

  const filterFields = meta.fields.slice(0, 3)
  const stats = ref(moduleStats(key))

  const statusSummary = computed(() =>
    meta.statuses.map((status) => ({
      status,
      count: rows.value.filter((row) => String(row.status) === status).length,
    })),
  )

  function resetFilters() {
    for (const field of Object.keys(filters)) delete filters[field]
    reload()
  }

  function exportRows() {
    downloadEntries(meta.key)
  }

  async function runAction(action: string, row: ArchivedRow) {
    errorMessage.value = ''
    busy.value = true
    try {
      const result: ActionResult = await applyAction(meta.key, Number(row.id), action)
      if (!result.ok) {
        errorMessage.value = result.message
        return
      }
      reload()
    } finally {
      busy.value = false
    }
  }

  function reload() {
    errorMessage.value = ''
    try {
      const payload = listEntries(meta.key, filters, { includeArchived: includeArchived.value })
      rows.value = payload.items
      total.value = payload.total
      archivedCount.value = payload.archived
      stats.value = moduleStats(meta.key)
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : `${meta.name}列表读取失败`
    }
  }

  let unsubscribe: (() => void) | undefined
  onMounted(() => {
    reload()
    unsubscribe = onDataChange(reload)
  })
  onUnmounted(() => unsubscribe?.())

  return {
    meta,
    columns: meta.fields,
    actions: meta.actions,
    rows,
    total,
    archivedCount,
    errorMessage,
    filters,
    filterFields,
    includeArchived,
    busy,
    stats,
    statusSummary,
    reload,
    resetFilters,
    exportRows,
    runAction,
  }
}
