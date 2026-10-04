// 核查脚本打包器：环境里的 esbuild 可执行文件可能是其他平台的占位（npm optional deps 已知问题），
// 这里直接用 esbuild 的 JS API 打包后用 node 执行，不依赖 .bin/esbuild 二进制。
import { build } from 'esbuild'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const entry = resolve(here, 'verify-data-layer.ts')
const out = resolve(here, '.verify-bundle.mjs')

const result = await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  alias: { '@': resolve(here, '..', 'src') },
})
writeFileSync(out, result.outputFiles[0].text)
await import(out)
