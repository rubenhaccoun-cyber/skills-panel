import { expect, mock, test } from 'claude-code/testing'

import {
  adjust,
  parseFound,
  parseNames,
  parsePicks,
  parseSearch,
  parseSkillMd,
  projectRules,
  shortlist,
  tagOf,
  tokenize,
} from '../hooks/skills'

const SKILLS = [
  { name: 'stripe-integration', description: 'Integrate Stripe payments, checkout and webhooks' },
  { name: 'seo-audit', description: 'Audit a website for SEO issues' },
  { name: 'shopify-development', description: 'Build Shopify Hydrogen storefronts' },
]

const PANE_PROPS = {
  title: 'Skills',
  isFocused: false,
  bodyColumns: 40,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

test('reads name and description from inline and block frontmatter', () => {
  expect(parseSkillMd('---\nname: commit\ndescription: "Write a commit"\n---\nbody', 'dir')).toEqual({
    name: 'commit',
    description: 'Write a commit',
  })
  expect(parseSkillMd('---\ndescription: |\n  First line\n  second line\nother: x\n---', 'dir')).toEqual({
    name: 'dir',
    description: 'First line second line',
  })
})

test('tokenize drops accents and stopwords', () => {
  expect(tokenize('Ajoute le paiement Stripe dans la page détail')).toEqual([
    'ajoute',
    'paiement',
    'stripe',
    'page',
    'detail',
  ])
})

test('shortlist ranks name matches first and drops non-matches', () => {
  const picked = shortlist(SKILLS, ['stripe', 'payments'])
  expect(picked.map(skill => skill.name)).toEqual(['stripe-integration'])
})

test('parsePicks keeps known names, sorted by score, up to the limit', () => {
  const reply =
    'Here: [{"name":"seo-audit","score":4,"why":"audit SEO"},' +
    '{"name":"made-up","score":9,"why":"x"},' +
    '{"name":"stripe-integration","score":8,"why":"paiement"}]'
  expect(parsePicks(reply, SKILLS)).toEqual([
    { name: 'stripe-integration', score: 8, why: 'paiement' },
    { name: 'seo-audit', score: 4, why: 'audit SEO' },
  ])
  expect(parsePicks(reply, SKILLS, 1)).toEqual([{ name: 'stripe-integration', score: 8, why: 'paiement' }])
  expect(parsePicks('no json', SKILLS)).toEqual([])
})

test('parseNames keeps known names in order, up to the limit', () => {
  const byName = new Map(SKILLS.map(skill => [skill.name, skill]))
  expect(parseNames('["seo-audit","nope","stripe-integration"]', byName, 5).map(skill => skill.name)).toEqual([
    'seo-audit',
    'stripe-integration',
  ])
  expect(parseNames('["seo-audit","stripe-integration"]', byName, 1).map(skill => skill.name)).toEqual(['seo-audit'])
  expect(parseNames('none', byName, 5)).toEqual([])
})

test('parseSearch reads the registry keywords from the scoring reply', () => {
  expect(parseSearch('{"search": " product reviews schema ", "picks": []}')).toEqual('product reviews schema')
  expect(parseSearch('[{"name":"seo-audit","score":4,"why":"x"}]')).toEqual('')
})

test('parseFound keeps popular skills not installed, most installed first', () => {
  const body = JSON.stringify({
    skills: [
      { id: 'a/b/schema', source: 'a/b', skillId: 'schema', name: 'schema', installs: 69666 },
      { id: 'c/d/schema', source: 'c/d', skillId: 'schema', name: 'schema', installs: 605 },
      { id: 'e/f/seo-audit', source: 'e/f', skillId: 'seo-audit', name: 'seo-audit', installs: 9000 },
      { id: 'g/h/reviews', source: 'g/h', skillId: 'reviews', name: 'Review Widgets', installs: 1200 },
      { id: 'i/j/tiny', source: 'i/j', skillId: 'tiny', name: 'tiny', installs: 40 },
    ],
  })
  expect(parseFound(body, ['claude-seo:seo-audit'])).toEqual([
    { name: 'schema', source: 'a/b', installs: 69666 },
    { name: 'Review Widgets', source: 'g/h', installs: 1200 },
  ])
  expect(parseFound('not json', [])).toEqual([])
})

test('tagOf puts each skill in one tag', () => {
  expect(SKILLS.map(tagOf)).toEqual(['ecommerce', 'seo', 'ecommerce'])
  expect(tagOf({ name: 'humaniseur-fr', description: 'Rend un texte plus naturel' })).toEqual('writing')
  expect(tagOf({ name: 'weather', description: 'Forecast' })).toEqual('other')
  expect(tagOf({ name: 'superpowers:brainstorming', description: 'Explores intent, requirements and design' })).toEqual(
    'workflow',
  )
  expect(tagOf({ name: 'update-config', description: 'Configure settings.json' })).toEqual('workflow')
  expect(tagOf({ name: 'claude-seo:seo-audit', description: 'Audit with a design review' })).toEqual('seo')
})

test('projectRules splits required and forbidden skills from CLAUDE.md', () => {
  const claudeMd =
    'Rediger avec `copywriting-hooks`, puis `humaniseur-fr` en une passe. ' +
    'Jamais `copy-editing` ni `de-ai-ify` sur un texte francais. Lancer `npm run build`.'
  const names = ['copywriting-hooks', 'humaniseur-fr', 'copy-editing', 'de-ai-ify', 'ecc:seo']
  expect(projectRules([claudeMd], names)).toEqual({
    required: ['copywriting-hooks', 'humaniseur-fr'],
    forbidden: ['copy-editing', 'de-ai-ify'],
  })
  expect(projectRules(['Utilise `seo`.'], names)).toEqual({ required: ['ecc:seo'], forbidden: [] })
})

test('adjust rewards used skills, rules, and demotes ignored ones', () => {
  expect(adjust(6, undefined, false)).toEqual(6)
  expect(adjust(6, { used: 4, clicked: 0, shown: 4, last: 0 }, false)).toEqual(8)
  expect(adjust(6, { used: 0, clicked: 0, shown: 5, last: 0 }, false)).toEqual(5)
  expect(adjust(10, undefined, true)).toEqual(10)
  expect(adjust(5, undefined, true)).toEqual(6)
})

test('suggestions reach the pane and the model before the prompt goes on', async ($, on) => {
  const order: string[] = []
  let context: readonly string[] = []
  mock.store(on)
  mock.clock(on)
  mock.env(on, { HOME: '/home/test' })
  on('session.root', () => ({ value: '/work/demo' }))
  on('fs.ancestors', () => ({
    value: [
      { dir: '/work/demo', name: 'CLAUDE.md', content: 'Utilise `seo-images`. Jamais `copy-editing`.', parts: [] },
    ],
  }))
  on('fs.exists', (_, e) => ({ value: e.path === '/home/test/.claude/skills' }))
  on('fs.list', () => ({
    value: ['seo-images', 'copy-editing'].map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', (_, e) => {
    const name = /skills\/([^/]+)\/SKILL\.md$/.exec(e.path)?.[1]
    return name === undefined
      ? { deny: 'missing' }
      : { value: `---\nname: ${name}\ndescription: Optimize images and copy for SEO\n---` }
  })
  on('session.messages', () => ({
    value: [{ role: 'user' as const, text: 'on parle du portfolio', toolUses: [] }],
  }))
  on('model.complete', (_, e) => {
    order.push('model')
    const raw: unknown = e.system
    const blocks = e.systemBlocks ?? (Array.isArray(raw) ? (raw as { text: string; cache?: true }[]) : [])
    const isSelection = blocks[0]?.text.startsWith('Skill catalog') === true
    if (isSelection) {
      expect(e.prompt).toContain('on parle du portfolio')
      expect(blocks[0]?.cache).toBe(true)
    }
    const text = isSelection
      ? '["seo-images","copy-editing"]'
      : '[{"name":"seo-images","score":8,"why":"images SEO"},{"name":"copy-editing","score":9,"why":"x"}]'
    return {
      value: {
        isAnswered: true as const,
        text,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: isSelection ? 10120 : 0,
          cache_creation_input_tokens: 0,
        },
      },
    }
  })
  on('prompt.submit', (_, e) => {
    order.push('submit')
    context = e.context ?? []
    return { text: e.text }
  })
  await $.command.run({
    command: 'skills-rescan',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  await $.prompt.submit({
    text: 'optimise les images du portfolio pour le SEO',
    wait: false,
    origin: { kind: 'composer' },
  })
  expect(order).toEqual(['model', 'model', 'submit'])
  expect(context.join('\n')).toContain('seo-images (9/10, project rule)')
  expect(context.join('\n')).toContain('Forbidden in this project: copy-editing')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'skills-panel',
      surface,
      component: 'Pane',
      requestId: 'skills-panel',
      props: PANE_PROPS,
    })
    expect(await ui.find({ key: 'use-seo-images' })).toBeDefined()
    expect(await ui.find({ key: 'use-copy-editing' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: ' rule ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'cache: read 10 120 tokens' })).toBeDefined()
    await ui.unmount()
  }
})

test('the pane lists loaded skills and the top used with tags', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  on('skill.prompt', (_, e) => ({ text: e.text }))
  await $.skill.prompt({ skill: 'commit', text: 'x' })
  await $.skill.prompt({ skill: 'commit', text: 'x' })
  await $.skill.prompt({ skill: 'seo-audit', text: 'x' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'skills-panel',
      surface,
      component: 'Pane',
      requestId: 'skills-panel',
      props: PANE_PROPS,
    })
    expect(await ui.find({ type: 'Text', text: /^x2$/ })).toBeDefined()
    await ui.press({ key: 'tab-top' })
    expect(await ui.find({ key: 'tag-seo' })).toBeDefined()
    await ui.press({ key: 'tag-seo' })
    expect(await ui.find({ type: 'Text', text: 'seo-audit' })).toBeDefined()
    expect(await ui.findAll({ type: 'Text', text: 'commit' })).toHaveLength(1)
    await ui.press({ key: 'tag-all' })
    expect(await ui.findAll({ type: 'Text', text: 'commit' })).toHaveLength(2)
    await ui.press({ key: 'scope-all' })
    expect(await ui.find({ type: 'Text', text: /^x2$/ })).toBeDefined()
    await ui.press({ key: 'scope-project' })
    await ui.unmount()
  }
})

test('the pane speaks French when language is fr', { options: { language: 'fr' } }, async ($, on) => {
  mock.store(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'skills-panel',
      surface,
      component: 'Pane',
      requestId: 'skills-panel',
      props: PANE_PROPS,
    })
    expect(await ui.find({ type: 'Text', text: 'Actifs' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Aucun skill chargé dans cette session.' })).toBeDefined()
    expect(await ui.find({ key: 'tab-discover' })).toBeDefined()
    await ui.press({ key: 'tab-top' })
    expect(await ui.find({ key: 'scope-all' })).toBeDefined()
    await ui.unmount()
  }
})

test('clicking a suggestion appends it after the text already typed', async ($, on) => {
  const filled: string[] = []
  mock.store(on)
  mock.clock(on)
  mock.env(on, { HOME: '/home/test' })
  on('session.root', () => ({ value: '/work/demo' }))
  on('fs.ancestors', () => ({ value: [] }))
  on('fs.exists', (_, e) => ({ value: e.path === '/home/test/.claude/skills' }))
  on('fs.list', () => ({ value: [{ name: 'seo-images', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }] }))
  on('fs.read', (_, e) =>
    e.path.endsWith('SKILL.md')
      ? { value: '---\nname: seo-images\ndescription: Optimize images for SEO\n---' }
      : { deny: 'missing' },
  )
  on('session.messages', () => ({ value: [] }))
  on('model.complete', (_, e) => ({
    value: {
      isAnswered: true as const,
      text: e.prompt.includes('Candidate skills')
        ? '[{"name":"seo-images","score":8,"why":"images"}]'
        : '["seo-images"]',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('prompt.read', () => ({ value: { text: filled.length === 0 ? 'optimise les images' : '', cursor: 0 } }))
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  await $.command.run({
    command: 'skills-rescan',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  await $.prompt.submit({ text: 'optimise les images du portfolio', wait: false, origin: { kind: 'composer' } })
  const ui = await $.ui.mount({
    plugin: 'skills-panel',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'skills-panel',
    props: PANE_PROPS,
  })
  await ui.press({ key: 'use-seo-images' })
  await ui.press({ key: 'use-seo-images' })
  expect(filled).toEqual(['optimise les images /seo-images ', '/seo-images '])
  await ui.unmount()
})

test('the Discover tab lists registry skills after the prompt has gone on', async ($, on) => {
  const order: string[] = []
  const urls: string[] = []
  const filled: string[] = []
  mock.store(on)
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/test' })
  on('session.root', () => ({ value: '/work/demo' }))
  on('fs.ancestors', () => ({ value: [] }))
  on('fs.exists', (_, e) => ({ value: e.path === '/home/test/.claude/skills' }))
  on('fs.list', () => ({ value: [{ name: 'seo-images', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }] }))
  on('fs.read', (_, e) =>
    e.path.endsWith('SKILL.md')
      ? { value: '---\nname: seo-images\ndescription: Optimize images for SEO\n---' }
      : { deny: 'missing' },
  )
  on('session.messages', () => ({ value: [] }))
  on('model.complete', (_, e) => ({
    value: {
      isAnswered: true as const,
      text: e.prompt.includes('Candidate skills')
        ? '{"search": "product reviews", "picks": [{"name":"seo-images","score":8,"why":"images"}]}'
        : '["seo-images"]',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))
  on('http.fetch', (_, e) => {
    order.push('fetch')
    urls.push(e.url)
    const skills = [
      { id: 'a/b/reviews', source: 'a/b', skillId: 'reviews', name: 'reviews', installs: 4200 },
      { id: 'c/d/seo-images', source: 'c/d', skillId: 'seo-images', name: 'seo-images', installs: 9000 },
    ]
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ skills }) } }
  })
  on('prompt.submit', (_, e) => {
    order.push('submit')
    return { text: e.text }
  })
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  await $.command.run({
    command: 'skills-rescan',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  await $.prompt.submit({ text: 'show the reviews from the old site', wait: false, origin: { kind: 'composer' } })
  await clock.advance(1)
  expect(order).toEqual(['submit', 'fetch'])
  expect(urls).toEqual(['https://skills.sh/api/search?q=product%20reviews&limit=20'])

  const ui = await $.ui.mount({
    plugin: 'skills-panel',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'skills-panel',
    props: PANE_PROPS,
  })
  expect(await ui.find({ key: 'tab-discover', text: 'Discover 1' })).toBeDefined()
  await ui.press({ key: 'tab-discover' })
  expect(await ui.find({ key: 'add-seo-images' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'a/b, 4.2K installs' })).toBeDefined()
  await ui.press({ key: 'add-reviews' })
  expect(filled).toEqual(['npx skills add a/b@reviews -g -y '])
  await ui.unmount()
})

test('discovery off sends nothing to the registry', { options: { discover: false } }, async ($, on) => {
  let fetches = 0
  mock.store(on)
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/test' })
  on('session.root', () => ({ value: '/work/demo' }))
  on('fs.ancestors', () => ({ value: [] }))
  on('fs.exists', (_, e) => ({ value: e.path === '/home/test/.claude/skills' }))
  on('fs.list', () => ({ value: [{ name: 'seo-images', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }] }))
  on('fs.read', (_, e) =>
    e.path.endsWith('SKILL.md')
      ? { value: '---\nname: seo-images\ndescription: Optimize images for SEO\n---' }
      : { deny: 'missing' },
  )
  on('session.messages', () => ({ value: [] }))
  on('model.complete', () => ({
    value: {
      isAnswered: true as const,
      text: '{"search": "images", "picks": [{"name":"seo-images","score":8,"why":"images"}]}',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))
  on('http.fetch', () => {
    fetches += 1
    return { value: { status: 200, ok: true, headers: {}, text: '{"skills":[]}' } }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.command.run({
    command: 'skills-rescan',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  await $.prompt.submit({ text: 'optimise les images du portfolio', wait: false, origin: { kind: 'composer' } })
  await clock.advance(1)
  expect(fetches).toEqual(0)
})
