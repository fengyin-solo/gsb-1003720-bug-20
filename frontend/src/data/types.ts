/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
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
  metrics: string[]
  /** 指向「所属站点」的业务字段；站点停用时按它级联重算。没有就是不挂站点的模块。 */
  stationField?: string
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
  /** 本次动作落库后的数据版本；被去重或冲突时也是获胜版本号。 */
  version?: number
  /** true 表示并发提交被去重，沿用了同键那次的有效落库结果。 */
  deduplicated?: boolean
  /** true 表示并发重算版本冲突，未产生新版本，已采用获胜版本。 */
  conflict?: boolean
}

/** 一个模块的派生汇总：登记总量 / 待处理 / 异常量。 */
export type ModuleSummary = {
  name: string
  created: number
  pending: number
  abnormal: number
}

/** 运营概览在某一时刻固化下来的不可变快照，历史班次沿用它回看。 */
export type OverviewSnapshot = {
  version: number
  shiftLabel: string
  operator: string
  createdAt: string
  reason: string
  cards: { label: string; value: number }[]
  modules: ModuleSummary[]
}

export type OverviewResult = {
  version: number
  cards: { label: string; value: number }[]
  modules: ModuleSummary[]
  snapshots: OverviewSnapshot[]
}

/** 一次落库要改的一批模块；这批要么整体生效，要么整体回退。 */
export type CommitChangeSet = {
  [moduleKey: string]: EntryRow[]
}

export type CommitRequest = {
  /** 调用方期望基于哪个版本做修改；与当前版本不一致即 CAS 冲突，不产生新版本。 */
  expectedVersion: number
  /** 去重键：相同键的并发提交共用一次有效落库。 */
  dedupeKey?: string
  /** 本次要整体写入的模块批次。 */
  changes: CommitChangeSet
  /** 快照上记录的班次标签与触发原因，历史班次回看用。 */
  shiftLabel: string
  operator: string
  reason: string
}

export type CommitResult = {
  ok: boolean
  version: number
  deduplicated: boolean
  conflict: boolean
  snapshot: OverviewSnapshot
}
