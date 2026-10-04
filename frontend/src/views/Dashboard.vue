<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" :disabled="busy" @click="recompute">
          {{ busy ? '统计中…' : '重新统计' }}
        </button>
      </div>
    </header>

    <p class="status-legend">
      <span class="legend-item">
        当前数据版本：v{{ overview.version }}
      </span>
      <span v-if="viewingVersion === null" class="legend-item">查看：当前班次实时汇总</span>
      <button v-else class="link" type="button" @click="viewCurrent">
        正在回看历史快照 v{{ viewingVersion }}，点此返回当前
      </button>
      <span class="legend-item">停用/撤销站点仍计入登记总量，但不计入待处理与异常量</span>
    </p>

    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>

    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>登记总量</th><th>待处理</th><th>异常量</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in moduleRows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td>{{ row.pending }}</td>
          <td>{{ row.abnormal }}</td>
        </tr>
      </tbody>
    </table>

    <section v-if="overview.snapshots.length" class="snapshot-box">
      <h3>历史班次快照</h3>
      <p class="page-desc">每次有效落库固化一版，历史班次沿用当时快照，重算不会改写旧版。</p>
      <ul class="snapshot-list">
        <li v-for="snap in reversedSnapshots" :key="snap.version">
          <button
            class="link"
            type="button"
            :class="{ 'snapshot-active': viewingVersion === snap.version }"
            @click="viewSnapshot(snap.version)"
          >
            v{{ snap.version }}
          </button>
          <span>{{ snap.shiftLabel }} · {{ snap.operator }} · {{ formatTime(snap.createdAt) }}</span>
          <span class="snapshot-reason">{{ snap.reason }}</span>
        </li>
      </ul>
    </section>

    <footer class="page-foot">
      <span v-if="message" :class="messageError ? 'error-text' : 'snapshot-ok'">{{ message }}</span>
      <span v-else>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { loadOverview, recalculate } from '@/api/local-service'
import type { OverviewResult } from '@/data/types'

const overview = ref<OverviewResult>({ version: 0, cards: [], modules: [], snapshots: [] })
const viewingVersion = ref<number | null>(null)
const busy = ref(false)
const message = ref('')
const messageError = ref(false)

const cards = computed(() => overview.value.cards)
const moduleRows = computed(() => overview.value.modules)
const reversedSnapshots = computed(() => [...overview.value.snapshots].reverse())

function refresh(version?: number | null) {
  const payload = loadOverview(version ?? undefined)
  overview.value = payload
}

async function recompute() {
  if (busy.value) {
    return
  }
  busy.value = true
  message.value = ''
  messageError.value = false
  try {
    // 期望版本取当前实时版本；并发重算只有一个版本能通过 CAS。
    const baseVersion = loadOverview().version
    const result = await recalculate(baseVersion)
    if (result.conflict) {
      messageError.value = true
      message.value = `并发重算检测到版本冲突，只保留了 v${result.version}，本次未重复落库`
    } else if (result.deduplicated) {
      message.value = `已有相同重算在进行，沿用同一次有效落库 v${result.version}`
    } else {
      message.value = `已重新统计并固化为 v${result.version}`
    }
    viewingVersion.value = null
    refresh()
  } catch (error) {
    messageError.value = true
    message.value = error instanceof Error ? error.message : '重新统计失败，整批已回退'
  } finally {
    busy.value = false
  }
}

function viewSnapshot(version: number) {
  viewingVersion.value = version
  message.value = ''
  refresh(version)
}

function viewCurrent() {
  viewingVersion.value = null
  refresh()
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return iso
  }
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

onMounted(() => refresh())
</script>
