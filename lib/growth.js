/**
 * dsh-agent-md —— 人格成长：观察、版本快照、候选改动与 diff。
 *
 * 设计目标是「人格不是模具」：插件只负责保存成长留下的痕迹，不替模型决定
 * 它该长成什么样。所有文件都在 `<DSH_HOME>/agents/growth/` 下：
 *
 *   observations.jsonl          一条一行的人格观察
 *   versions/<key>/<id>.md      某份人格的历史全文
 *   versions/<key>/<id>.json    对应的时间、原因、字数
 *   proposals/<key>.json        待审的候选全文
 *
 * 作用域：`global`（全局人格）或 `project`（本机项目人格）。项目内 AGENT.md
 * 跟着仓库走，不归插件管，也不在这里快照。
 */

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import {
  agentsRoot,
  displayNameFor,
  globalPath,
  normalizeText,
  readTextFile,
  slugFor,
  writeTextFile,
} from './persona.js'

export const MAX_OBSERVATION_CHARS = 2000
export const MAX_OBSERVATIONS = 300
export const MAX_VERSIONS = 24
export const MAX_PROPOSAL_BYTES = 512 * 1024

export function growthRoot() {
  return join(agentsRoot(), 'growth')
}

export function observationsPath() {
  return join(growthRoot(), 'observations.jsonl')
}

function safeKey(key) {
  const text = String(key ?? '').trim()
  return (text.replace(/[^0-9a-zA-Z_-]/g, '-').slice(0, 80) || 'default')
}

export function versionsDir(key) {
  return join(growthRoot(), 'versions', safeKey(key))
}

export function proposalPath(key) {
  return join(growthRoot(), 'proposals', `${safeKey(key)}.json`)
}

/**
 * 把 scope + cwd 解析成一份受管人格文件。
 * 只认全局人格和本机项目人格；项目内 AGENT.md 不归插件写。
 */
export function resolveGrowthTarget(scope, cwd) {
  const normalized = String(scope ?? 'global')
  if (normalized === 'global') {
    return { scope: 'global', cwd: '', key: 'global', file: globalPath(), label: '全局人格' }
  }
  if (normalized !== 'project') {
    throw Object.assign(new Error('scope 只能是 global 或 project'), { status: 400 })
  }
  const dir = String(cwd ?? '').trim()
  if (dir === '') throw Object.assign(new Error('项目人格需要 cwd'), { status: 400 })
  const slug = slugFor(dir)
  return {
    scope: 'project',
    cwd: dir,
    key: `project-${slug.slug}`,
    file: slug.path,
    label: displayNameFor(dir),
  }
}

function ensureGrowthDirs(key) {
  mkdirSync(growthRoot(), { recursive: true })
  mkdirSync(versionsDir(key), { recursive: true })
  mkdirSync(join(growthRoot(), 'proposals'), { recursive: true })
}

/** 追加一条观察。只留最近 MAX_OBSERVATIONS 条，防止日志无限长。 */
export function appendObservation(input) {
  const key = String(input?.key ?? '').trim()
  if (key === '') throw Object.assign(new Error('缺少人格 key'), { status: 400 })
  const text = normalizeText(String(input?.text ?? '')).trim()
  if (text === '') throw Object.assign(new Error('观察内容不能为空'), { status: 400 })
  if (text.length > MAX_OBSERVATION_CHARS) {
    throw Object.assign(new Error(`观察内容不能超过 ${MAX_OBSERVATION_CHARS} 字`), { status: 400 })
  }
  const tags = Array.isArray(input?.tags)
    ? input.tags
      .filter((t) => typeof t === 'string' && t.trim() !== '')
      .map((t) => t.trim().slice(0, 24))
      .slice(0, 6)
    : []
  const entry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    at: new Date().toISOString(),
    key,
    text,
    tags,
    source: input?.source === 'user' ? 'user' : 'agent',
  }
  ensureGrowthDirs(key)
  appendFileSync(observationsPath(), `${JSON.stringify(entry)}\n`, 'utf8')
  pruneObservations()
  return entry
}

function pruneObservations() {
  const raw = readTextFile(observationsPath())
  if (raw === null) return
  const lines = raw.split('\n').filter((line) => line.trim() !== '')
  if (lines.length <= MAX_OBSERVATIONS + 60) return
  writeTextFile(observationsPath(), `${lines.slice(-MAX_OBSERVATIONS).join('\n')}\n`)
}

/** 某份人格最近的观察，新的在前。 */
export function listObservations(key, limit = 12) {
  const raw = readTextFile(observationsPath())
  if (raw === null) return []
  const rows = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      const row = JSON.parse(line)
      if (row !== null && typeof row === 'object' && row.key === key && typeof row.text === 'string') rows.push(row)
    } catch {
      // 坏行跳过，不让一条脏数据拖垮整个成长区
    }
  }
  return rows.slice(-Math.max(1, limit)).reverse()
}

/** 给当前人格拍一张快照；空人格不值得存。 */
export function snapshotVersion(key, content, reason = 'save') {
  const text = normalizeText(String(content ?? ''))
  if (text.trim() === '') return null
  ensureGrowthDirs(key)
  const at = new Date().toISOString()
  const id = `${at.replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}`
  writeFileSync(join(versionsDir(key), `${id}.md`), text, 'utf8')
  writeFileSync(join(versionsDir(key), `${id}.json`), `${JSON.stringify({ id, at, reason, chars: text.length })}\n`, 'utf8')
  pruneVersions(key)
  return { id, at, reason, chars: text.length }
}

function pruneVersions(key) {
  let files = []
  try {
    files = readdirSync(versionsDir(key)).filter((name) => name.endsWith('.md')).sort().reverse()
  } catch {
    return
  }
  for (const name of files.slice(MAX_VERSIONS)) {
    const id = name.slice(0, -3)
    for (const target of [join(versionsDir(key), `${id}.md`), join(versionsDir(key), `${id}.json`)]) {
      try { unlinkSync(target) } catch { /* 已经不在 */ }
    }
  }
}

/** 历史版本清单，新的在前。 */
export function listVersions(key, limit = 10) {
  let files = []
  try {
    files = readdirSync(versionsDir(key)).filter((name) => name.endsWith('.md')).sort().reverse()
  } catch {
    return []
  }
  const out = []
  for (const name of files.slice(0, Math.max(1, limit))) {
    const id = name.slice(0, -3)
    let meta = {}
    try { meta = JSON.parse(readFileSync(join(versionsDir(key), `${id}.json`), 'utf8')) } catch { meta = {} }
    let chars = typeof meta.chars === 'number' ? meta.chars : 0
    let at = typeof meta.at === 'string' ? meta.at : ''
    if (chars === 0 || at === '') {
      try {
        const stat = statSync(join(versionsDir(key), name))
        if (at === '') at = stat.mtime.toISOString()
        if (chars === 0) chars = readFileSync(join(versionsDir(key), name), 'utf8').length
      } catch {
        // 文件刚好被删：跳过
      }
    }
    out.push({ id, at, chars, reason: typeof meta.reason === 'string' ? meta.reason : '' })
  }
  return out
}

export function readVersion(key, id) {
  const safe = String(id ?? '').trim()
  if (!/^[0-9A-Za-z._-]+$/.test(safe) || safe.includes('..')) {
    throw Object.assign(new Error('版本 id 不合法'), { status: 400 })
  }
  return readTextFile(join(versionsDir(key), `${safe}.md`))
}

/** 读取待审候选；没有就返回 null。 */
export function readProposal(key) {
  const raw = readTextFile(proposalPath(key))
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.content !== 'string') return null
    return {
      content: normalizeText(parsed.content),
      at: typeof parsed.at === 'string' ? parsed.at : '',
      note: typeof parsed.note === 'string' ? parsed.note : '',
      chars: normalizeText(parsed.content).length,
    }
  } catch {
    return null
  }
}

export function writeProposal(key, content, note = '') {
  const text = normalizeText(String(content ?? ''))
  if (Buffer.byteLength(text, 'utf8') > MAX_PROPOSAL_BYTES) {
    throw Object.assign(new Error(`候选人格不能超过 ${Math.round(MAX_PROPOSAL_BYTES / 1024)} KB`), { status: 413 })
  }
  ensureGrowthDirs(key)
  const entry = {
    key,
    at: new Date().toISOString(),
    note: String(note ?? '').trim().slice(0, 500),
    content: text,
  }
  writeTextFile(proposalPath(key), `${JSON.stringify(entry, null, 2)}\n`)
  return { ...entry, chars: text.length }
}

export function clearProposal(key) {
  try { unlinkSync(proposalPath(key)) } catch { /* 本来就没有 */ }
}

/** 给 UI 用的候选状态：带上和当前人格的 unified diff。 */
export function proposalState(key, current) {
  const proposal = readProposal(key)
  if (proposal === null) return null
  return { ...proposal, diff: unifiedDiff(current, proposal.content) }
}

/** 按行做 LCS diff；人格文件不大，够用且没有依赖。 */
export function unifiedDiff(before, after, context = 3) {
  const a = normalizeText(String(before ?? '')).split('\n')
  const b = normalizeText(String(after ?? '')).split('\n')
  if (a.join('\n') === b.join('\n')) return ''

  // 超过 800 行就退化成整段替换，避免 O(n*m) 把设置页卡死。
  if (a.length > 800 || b.length > 800) {
    return ['--- 当前', '+++ 候选', `@@ -1,${a.length} +1,${b.length} @@`, ...a.map((l) => `-${l}`), ...b.map((l) => `+${l}`)].join('\n')
  }

  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: ' ', text: a[i] })
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: '-', text: a[i] })
      i += 1
    } else {
      ops.push({ type: '+', text: b[j] })
      j += 1
    }
  }
  while (i < n) { ops.push({ type: '-', text: a[i] }); i += 1 }
  while (j < m) { ops.push({ type: '+', text: b[j] }); j += 1 }

  const changed = []
  for (let k = 0; k < ops.length; k += 1) {
    if (ops[k].type !== ' ') changed.push(k)
  }
  if (changed.length === 0) return ''

  const ranges = []
  for (const index of changed) {
    const start = Math.max(0, index - context)
    const end = Math.min(ops.length, index + context + 1)
    const last = ranges[ranges.length - 1]
    if (last !== undefined && start <= last.end) last.end = Math.max(last.end, end)
    else ranges.push({ start, end })
  }

  const lines = ['--- 当前', '+++ 候选']
  for (const range of ranges) {
    let oldStart = 1
    let newStart = 1
    for (let k = 0; k < range.start; k += 1) {
      if (ops[k].type !== '+') oldStart += 1
      if (ops[k].type !== '-') newStart += 1
    }
    let oldCount = 0
    let newCount = 0
    for (let k = range.start; k < range.end; k += 1) {
      if (ops[k].type !== '+') oldCount += 1
      if (ops[k].type !== '-') newCount += 1
    }
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    for (let k = range.start; k < range.end; k += 1) lines.push(`${ops[k].type}${ops[k].text}`)
  }
  return lines.join('\n')
}
