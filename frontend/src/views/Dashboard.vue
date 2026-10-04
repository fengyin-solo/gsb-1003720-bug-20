<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常；停用/撤销记录不计入当前统计。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" :disabled="recalculating" @click="refresh">
          {{ recalculating ? '重算中…' : '重新统计' }}
        </button>
        <span class="version-tag">数据版本 v{{ version }}</span>
      </div>
    </header>
    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>
    <table class="data-table">
      <thead>
        <tr>
          <th>业务模块</th><th>今日新增</th><th>待处理</th><th>异常量</th><th>停用/归档</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in moduleRows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td>{{ row.pending }}</td>
          <td>{{ row.abnormal }}</td>
          <td>{{ row.archived }}</td>
        </tr>
      </tbody>
    </table>

    <section class="snapshot-block">
      <h3>历史班次（沿用原快照，不随重算/停用变化）</h3>
      <p class="snapshot-label">{{ snapshot.label }}</p>
      <div class="stat-row">
        <article v-for="card in snapshot.cards" :key="card.label" class="stat-card dim">
          <span class="stat-label">{{ card.label }}</span>
          <strong class="stat-value">{{ card.value }}</strong>
        </article>
      </div>
      <table class="data-table">
        <thead>
          <tr><th>业务模块</th><th>登记总量</th><th>待处理</th><th>异常量</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in snapshot.modules" :key="row.name">
            <td>{{ row.name }}</td>
            <td>{{ row.created }}</td>
            <td>{{ row.pending }}</td>
            <td>{{ row.abnormal }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据；并发重算只接受最新版本。</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

import { loadOverview, onDataChange, recalcOverview } from '@/api/local-service'
import type { OverviewResult, ShiftSnapshot } from '@/data/types'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])
const version = ref(0)
const snapshot = ref<ShiftSnapshot>({ label: '', cards: [], modules: [] })
const recalculating = ref(false)
const errorMessage = ref('')

function applyPayload(payload: OverviewResult) {
  cards.value = payload.cards
  moduleRows.value = payload.modules
  version.value = payload.version
  snapshot.value = payload.snapshot
}

async function refresh() {
  if (recalculating.value) return // 并发重算：在途期间的再次触发直接忽略，只接受最新一版结果
  recalculating.value = true
  errorMessage.value = ''
  try {
    applyPayload(await recalcOverview())
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '重新统计失败'
  } finally {
    recalculating.value = false
  }
}

// 任何模块页面的落库、跨标签页写入都会推送数据层版本，概览同步重绘，不再停留旧值。
const unsubscribe = onDataChange(() => applyPayload(loadOverview()))
onMounted(() => applyPayload(loadOverview()))
onUnmounted(unsubscribe)
</script>
