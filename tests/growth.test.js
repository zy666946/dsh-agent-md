/**
 * 人格成长：观察、版本、候选 diff、应用/回滚，以及注入协议。
 *
 * 环境隔离同样要在 import 之前设 DSH_HOME；测试文件由 node --test 单独起进程。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = mkdtempSync(join(tmpdir(), 'agent-md-growth-'))
process.env.DSH_HOME = SANDBOX

const growth = await import('../lib/growth.js')
const persona = await import('../lib/persona.js')
const plugin = await import('../lib/index.js')

function makeCtx() {
  const registered = []
  const sections = []
  const ctx = {
    effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
    on() { return () => {} },
    get() { return undefined },
    logger: { info() {}, warn() {} },
    systemPrompt: {
      context(def) { sections.push(def); return () => {} },
      section(def) { sections.push(def); return () => {} },
    },
    webServer: { register(route) { registered.push(route); return () => {} } },
  }
  return { ctx, registered, sections }
}

async function callRoute(route, { method = 'GET', url = '/', body = null } = {}) {
  const req = {
    method,
    url,
    on(event, cb) {
      if (event === 'data' && body !== null) cb(Buffer.from(JSON.stringify(body), 'utf8'))
      if (event === 'end') cb()
    },
    destroy() {},
  }
  const chunks = []
  const res = {
    statusCode: 0,
    writeHead(status) { this.statusCode = status },
    end(buf) { if (buf !== undefined) chunks.push(Buffer.from(buf)) },
  }
  await route.handler(req, res)
  const text = Buffer.concat(chunks).toString('utf8')
  return { status: res.statusCode, body: text === '' ? null : JSON.parse(text) }
}

test('人格成长全量行为', async (t) => {
  await t.test('scope 解析：全局 / 项目 / 非法', () => {
    const g = growth.resolveGrowthTarget('global', '')
    assert.equal(g.key, 'global')
    assert.equal(g.file, persona.globalPath())

    const ws = join(SANDBOX, 'ws', 'growth-project')
    mkdirSync(ws, { recursive: true })
    const p = growth.resolveGrowthTarget('project', ws)
    assert.equal(p.key, `project-${persona.slugFor(ws).slug}`)
    assert.equal(p.file, persona.slugFor(ws).path)

    assert.throws(() => growth.resolveGrowthTarget('project', ''), /cwd/)
    assert.throws(() => growth.resolveGrowthTarget('template', ws), /scope/)
  })

  await t.test('观察：追加、按 key 过滤、新的在前', () => {
    growth.appendObservation({ key: 'global', text: '第一条', tags: ['a'] })
    growth.appendObservation({ key: 'global', text: '第二条', source: 'user' })
    growth.appendObservation({ key: 'other', text: '别的' })
    const rows = growth.listObservations('global')
    assert.equal(rows.length, 2)
    assert.equal(rows[0].text, '第二条')
    assert.equal(rows[0].source, 'user')
    assert.equal(rows[1].tags[0], 'a')
    assert.throws(() => growth.appendObservation({ key: 'global', text: '   ' }), /不能为空/)
  })

  await t.test('版本：快照、清单、读取、防穿越', () => {
    const v1 = growth.snapshotVersion('global', '# 我\n\n旧版本\n', 'before-save')
    assert.ok(v1 && v1.id)
    assert.equal(growth.listVersions('global')[0].id, v1.id)
    assert.equal(growth.readVersion('global', v1.id), '# 我\n\n旧版本\n')
    assert.throws(() => growth.readVersion('global', '../x'), /不合法/)
  })

  await t.test('候选：写入、diff、清空', () => {
    growth.writeProposal('global', '# 我\n\n新版本\n\n- 新的一条\n', '第一版')
    const p = growth.proposalState('global', '# 我\n\n旧版本\n')
    assert.ok(p)
    assert.equal(p.note, '第一版')
    assert.ok(p.diff.includes('-旧版本'))
    assert.ok(p.diff.includes('+新版本'))
    growth.clearProposal('global')
    assert.equal(growth.readProposal('global'), null)
  })

  await t.test('unifiedDiff：无变化返回空，改动带上下文', () => {
    assert.equal(growth.unifiedDiff('a\nb\n', 'a\nb\n'), '')
    const d = growth.unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 1)
    assert.ok(d.startsWith('--- 当前\n+++ 候选'))
    assert.ok(d.includes('-b'))
    assert.ok(d.includes('+B'))
    assert.ok(d.includes(' a'))
  })

  await t.test('API：观察 → 候选 → 应用 → 回滚', async () => {
    const { ctx, registered, sections } = makeCtx()
    plugin.apply(ctx)
    const route = registered.find((r) => r.path === '/api/agent-md')
    assert.ok(route)

    persona.writeTextFile(persona.globalPath(), '# 我\n\n旧版本\n')

    let r = await callRoute(route, { url: '/api/agent-md/growth?scope=global' })
    assert.equal(r.status, 200)
    assert.equal(r.body.current.chars, 9)
    assert.equal(r.body.proposal, null)

    r = await callRoute(route, {
      method: 'POST',
      url: '/api/agent-md/growth/observe',
      body: { scope: 'global', text: '发现自己会先接情绪', tags: ['对话'] },
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.observation.text, '发现自己会先接情绪')

    r = await callRoute(route, {
      method: 'POST',
      url: '/api/agent-md/growth/propose',
      body: { scope: 'global', content: '# 我\n\n新版本\n\n- 新的一条\n', note: 'v1' },
    })
    assert.equal(r.status, 200)
    assert.ok(r.body.proposal.diff.includes('+新版本'))

    r = await callRoute(route, { method: 'POST', url: '/api/agent-md/growth/apply', body: { scope: 'global' } })
    assert.equal(r.status, 200)
    assert.ok(r.body.version && r.body.version.id)
    assert.ok(persona.readTextFile(persona.globalPath()).includes('新版本'))

    r = await callRoute(route, { url: '/api/agent-md/growth?scope=global' })
    assert.equal(r.body.proposal, null)
    assert.ok(r.body.versions.length >= 1)
    const versionId = r.body.versions[0].id

    r = await callRoute(route, {
      method: 'POST',
      url: '/api/agent-md/growth/rollback',
      body: { scope: 'global', version: versionId },
    })
    assert.equal(r.status, 200)
    assert.ok(persona.readTextFile(persona.globalPath()).includes('旧版本'))

    // 注入协议存在，但只在开关打开时
    const text = await sections[0].text({ agent: { session: { header: { cwd: '' } } } })
    assert.ok(text.includes('人格成长（插件内置）'))
    assert.ok(text.includes('/api/agent-md/growth/observe'))

    r = await callRoute(route, { method: 'POST', url: '/api/agent-md/config', body: { growthEnabled: false } })
    assert.equal(r.status, 200)
    const noGrowth = await sections[0].text({ agent: { session: { header: { cwd: '' } } } })
    assert.ok(!noGrowth.includes('人格成长（插件内置）'))
  })
})
