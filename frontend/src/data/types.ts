/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ArchiveReason = 'inactive' | 'station-inactive'

/** 运行期派生行：不改动持久化记录，额外携带停用/归档标记。 */
export type ArchivedRow = EntryRow & {
  archived: boolean
  archiveReason?: ArchiveReason
}

/** 指标卡口径：total/pending/abnormal 走派生口径，status 统计指定状态的可见记录数。 */
export type MetricSpec = {
  label: string
  kind: 'total' | 'pending' | 'abnormal' | 'status'
  status?: string
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: MetricSpec[]
  /** 终态：无需继续处理（不计待处理）。缺省取状态序列的最后一个。 */
  done?: string[]
  /** 停用/撤销/废止类终态：停用后不参与当前登记总量、待处理、异常量计数。 */
  inactive?: string[]
  /** 异常类状态：异常量唯一以此为准，不再读行上残留的 abnormal 旧标记。 */
  abnormalStatuses?: string[]
  /** 关联站点编号字段：站点停用后，引用该站点的跨模块记录联动归档。 */
  stationField?: string
}

export type PageResult = {
  items: ArchivedRow[]
  total: number
  page: number
  size: number
  /** 当前过滤口径下被归档（停用/撤销或属于停用站点）的记录数。 */
  archived: number
}

export type ActionResult = {
  ok: boolean
  message: string
  version?: number
  /** 命中并发去重：与在途请求同版本同内容，只算一次有效落库。 */
  deduped?: boolean
}

export type ShiftSnapshot = {
  label: string
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

export type OverviewResult = {
  version: number
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number; archived: number }[]
  /** 历史班次快照：落库即冻结，不随当前重算/停用而变化。 */
  snapshot: ShiftSnapshot
}
