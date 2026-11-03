#!/usr/bin/env node
/**
 * 构建时把 kuaishou-live 注入上游 registry.js。
 *
 * 为什么是「打补丁」而不是「整文件覆盖」：
 *   overlay 曾直接用自带 registry.js 覆盖上游的。上游一旦增删模块
 *   （例如 v4.59 删除了 institution），覆盖后的 registry 就会 import
 *   一个已经不存在的目录，app.js 启动即崩、端口不开。
 *   改为每次构建基于上游最新 registry 注入两行，上游怎么变都不怕。
 *
 * 用法（在叠加 overlay 之后、构建之前执行）：
 *   node patches/patch-registry.mjs
 * 退出码非 0 = 注入或校验失败，构建必须中止。
 */
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const root = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)))
const regPath = path.join(root, 'extractors', 'registry.js')
const ksPath = path.join(root, 'extractors', 'kuaishou-live', 'index.js')

function die(message) {
  console.error(`::error::patch-registry: ${message}`)
  process.exit(1)
}

if (!fs.existsSync(regPath)) die(`找不到 ${regPath}`)
if (!fs.existsSync(ksPath)) die('extractors/kuaishou-live/index.js 不存在，overlay 不完整')

let src = fs.readFileSync(regPath, 'utf8')

/* 1) 注入 import -------------------------------------------------------- */

if (!src.includes("kuaishou-live/index.js")) {
  // 优先贴着 douyu-live 的 import；找不到就放在最后一个模块 import 之后。
  const anchor = "import douyuLive from './douyu-live/index.js'"
  const importLine = "import kuaishouLive from './kuaishou-live/index.js'"
  if (src.includes(anchor)) {
    src = src.replace(anchor, `${anchor}\n${importLine}`)
  } else {
    const imports = [...src.matchAll(/^import\s.+from\s+'\.\/[\w-]+\/index\.js'$/gm)]
    if (!imports.length) die('registry.js 里找不到可插入的模块 import 行，上游结构可能大改，请人工检查')
    const last = imports[imports.length - 1]
    const at = src.indexOf(last[0]) + last[0].length
    src = src.slice(0, at) + `\n${importLine}` + src.slice(at)
  }
  console.log('已注入 import kuaishouLive')
} else {
  console.log('registry.js 已含 kuaishou import，跳过注入')
}

/* 2) 注入 MODULES 数组项 ------------------------------------------------- */

if (!/^\s*kuaishouLive,\s*$/m.test(src)) {
  const arrayAnchor = /^\s*douyuLive,\s*$/m
  if (arrayAnchor.test(src)) {
    src = src.replace(arrayAnchor, (m) => `${m}\n  kuaishouLive,`)
  } else if (/const MODULES = \[\s*$/.test(src)) {
    src = src.replace(/const MODULES = \[\s*$/, 'const MODULES = [\n  kuaishouLive,')
  } else {
    die("registry.js 里找不到 MODULES 数组或 douyuLive 锚点，请人工检查")
  }
  console.log('已注入 MODULES 数组项 kuaishouLive')
} else {
  console.log('MODULES 已含 kuaishouLive，跳过注入')
}

/* 3) 校验：registry 里每个相对 import 都必须真实存在 ---------------------- */
/*    这是本脚本的核心价值——上游删模块、改路径都能在这里被拦下，          */
/*    而不是等目标机启动时才崩溃。                                        */

function resolveRelative(baseFile, spec) {
  let p = path.resolve(path.dirname(baseFile), spec)
  for (const candidate of [p, `${p}.js`, path.join(p, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  return null
}

const specs = [
  ...[...src.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1]),
  ...[...src.matchAll(/^import\s+'(\.[^']+)'/gm)].map((m) => m[1]),
]
const missing = []
for (const spec of specs) {
  if (!resolveRelative(regPath, spec)) missing.push(spec)
}
if (missing.length) {
  die(`registry.js 引用了不存在的文件：\n  ${missing.join('\n  ')}\n上游可能删除或移动了这些模块，请确认后再构建`)
}
console.log(`import 校验通过（${specs.length} 个相对引用全部存在）`)

/* 4) 写回 --------------------------------------------------------------- */

fs.writeFileSync(regPath, src)
console.log('patch-registry 完成')
