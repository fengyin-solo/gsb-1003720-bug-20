<template>
  <section class="page" :data-module="meta.key">
    <header class="page-head">
      <div>
        <h2>{{ meta.name }}管理</h2>
        <p class="page-desc">{{ meta.desc }}</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" disabled>登记{{ meta.entity }}</button>
        <button class="btn" type="button" @click="exportRows">导出{{ meta.name }}清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <label class="filter-item filter-check">
        <input v-model="includeArchived" type="checkbox" @change="reload" />
        <span>含停用/撤销记录（{{ archivedCount }}）</span>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-archived': row.archived }">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            {{ row.status }}
            <span v-if="row.archived" class="archived-tag" :title="archiveHint(row)">已停用</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              :disabled="busy"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">
            暂无{{ meta.name }}数据{{ includeArchived ? '' : '（停用/撤销记录默认不显示，可勾选上方开关核查）' }}
          </td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条{{ meta.name }}记录</span>
      <span v-if="archivedCount && !includeArchived" class="archived-note">
        另有 {{ archivedCount }} 条停用/撤销或关联停用站点的记录已不计入当前统计
      </span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { useRoute } from 'vue-router'

import { useModulePage } from '@/composables/useModulePage'
import type { ArchivedRow } from '@/data/types'

const route = useRoute()
const {
  meta,
  columns,
  actions,
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
} = useModulePage(String(route.meta.moduleKey))

function archiveHint(row: ArchivedRow): string {
  return row.archiveReason === 'station-inactive'
    ? '关联站点已停用，随站点归档，不参与当前统计'
    : '记录已停用/撤销，不参与当前统计'
}
</script>
