import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ActiveSkill, Found, Suggestion, TopSkill } from '../types'
import { STRINGS } from './i18n'
import type { Lang } from './i18n'
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
} from './skills'
import type { SkillInfo, Stat } from './skills'

const PANE = 'skills-panel'
const TITLE = 'Skills'
const active = atom({ plugin: 'skills-panel', key: 'active' } as const, [] as ActiveSkill[])
const suggested = atom({ plugin: 'skills-panel', key: 'suggested' } as const, [] as Suggestion[])
const note = atom({ plugin: 'skills-panel', key: 'note' } as const, '')
const about = atom({ plugin: 'skills-panel', key: 'about' } as const, '')
const top = atom({ plugin: 'skills-panel', key: 'top' } as const, [] as TopSkill[])
const topAll = atom({ plugin: 'skills-panel', key: 'topAll' } as const, [] as TopSkill[])
const topScope = atom({ plugin: 'skills-panel', key: 'topScope' } as const, 'project')
const tagFilter = atom({ plugin: 'skills-panel', key: 'tagFilter' } as const, '')
const ruleNote = atom({ plugin: 'skills-panel', key: 'ruleNote' } as const, '')
const cacheNote = atom({ plugin: 'skills-panel', key: 'cacheNote' } as const, '')
const found = atom({ plugin: 'skills-panel', key: 'found' } as const, [] as Found[])
const foundQuery = atom({ plugin: 'skills-panel', key: 'foundQuery' } as const, '')
const tab = atom({ plugin: 'skills-panel', key: 'tab' } as const, 'suggested')
const TABS = ['suggested', 'discover', 'top']
const REGISTRY = 'https://skills.sh'

type InstalledPlugins = { plugins?: Record<string, { installPath?: string }[]> }
type Usage = Record<string, Record<string, Stat>>

// Fixed colors rather than theme keys: each surface renders theme keys differently and the API
// does not say which theme is active, so these are dark enough for white text (4.5:1+) everywhere.
const TAG_COLORS: Record<string, string> = {
  seo: '#1a7f37',
  video: '#cf222e',
  writing: '#b4532a',
  ecommerce: '#8a5a00',
  marketing: '#bf3989',
  design: '#8250df',
  data: '#1b7c83',
  dev: '#0969da',
  workflow: '#3b45c4',
  other: '#6e7781',
}
const RULE_COLOR = '#9a6700'
const ALL_COLOR = '#b4532a'
const tagColor = (tag: string) => TAG_COLORS[tag] ?? '#6e7781'
const scoreColor = (score: number) => (score >= 8 ? 'success' : score >= 5 ? 'warning' : 'subtle')
const bar = (score: number) => '█'.repeat(score) + '░'.repeat(10 - score)
const GAUGE_WIDTH = 96
const GAUGE_HEIGHT = 8
const GAUGE_HEX = (score: number) => (score >= 8 ? '#2DA44E' : score >= 5 ? '#D29922' : '#8B949E')
const gauge = (score: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${GAUGE_WIDTH}" height="${GAUGE_HEIGHT}" viewBox="0 0 ${GAUGE_WIDTH} ${GAUGE_HEIGHT}">` +
  `<rect width="${GAUGE_WIDTH}" height="${GAUGE_HEIGHT}" rx="${GAUGE_HEIGHT / 2}" fill="#8B949E" fill-opacity="0.25"/>` +
  `<rect width="${Math.max(GAUGE_HEIGHT, (GAUGE_WIDTH * score) / 10)}" height="${GAUGE_HEIGHT}" rx="${GAUGE_HEIGHT / 2}" fill="${GAUGE_HEX(score)}"/>` +
  '</svg>'
const thousands = (count: number) => String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
const compact = (count: number) =>
  count >= 1e6 ? `${(count / 1e6).toFixed(1).replace(/\.0$/, '')}M` : `${(count / 1e3).toFixed(1).replace(/\.0$/, '')}K`
// The registry's own install syntax; a name with spaces must be quoted.
const installCommand = (skill: Found) => {
  const target = `${skill.source}@${skill.name}`
  return `npx skills add ${/\s/.test(target) ? `"${target}"` : target} -g -y`
}

// Set from the plugin's userConfig each time the module loads.
let lang: Lang = 'en'
let minContextScore = 7
let maxSuggestions = 10
let isContextOn = true
let isDiscoverOn = true
const t = () => STRINGS[lang]
const tagLabel = (tag: string) => t().tags[tag] ?? tag

const JUDGE_INTENT =
  'Judge what the user actually wants done, not words that merely appear in the request: ' +
  'a question about a tool already being discussed, or a short confirmation, needs no unrelated skill.'

const situation = (conversation: string, request: string) =>
  (conversation === '' ? '' : `Recent conversation (the request may refer to it):\n${conversation}\n\n`) +
  `New request from the user to a coding agent:\n${request}`

const selectPrompt = (conversation: string, request: string) =>
  situation(conversation, request) +
  '\n\nFrom the skill catalog above, list up to 60 skill names that could help with the new request. ' +
  JUDGE_INTENT +
  ' Answer with a JSON array of exact names only, [] if none.'

const pickPrompt = (conversation: string, request: string, candidates: SkillInfo[], rules: string[]) =>
  situation(conversation, request) +
  '\n\nCandidate skills:\n' +
  candidates.map(skill => `- ${skill.name}: ${skill.description.slice(0, 200)}`).join('\n') +
  (rules.length > 0
    ? `\n\nThe project's CLAUDE.md requires these skills whenever the request involves what they cover: ${rules.join(', ')}.`
    : '') +
  `\n\nPick up to ${maxSuggestions} skills that would help with this request, most relevant first, ` +
  'including ones that are only moderately useful. ' +
  'Give each a relevance score from 1 (marginal) to 10 (essential). ' +
  'Answer with a JSON object only: {"search": "<2 to 4 English keywords to look this task up in a public skill registry>", ' +
  `"picks": [{"name": "<exact skill name>", "score": <1-10>, "why": "<reason in ${t().reasonLanguage}, 10 words max>"}]}. ` +
  JUDGE_INTENT +
  ' Leave picks empty if none is clearly relevant.'

const contextFor = (picks: Suggestion[], banned: string[]) =>
  `${t().context}\n` +
  picks.map(pick => `- ${pick.name} (${pick.score}/10${pick.isRule ? `, ${t().contextRule}` : ''}) : ${pick.why}`).join('\n') +
  (banned.length > 0 ? `\n${t().contextForbidden(banned)}` : '')

let index: SkillInfo[] = []
let catalog = ''
let byName = new Map<string, SkillInfo>()
let required: string[] = []
let forbidden: string[] = []
let project = ''

const tagOfName = (name: string) => tagOf(byName.get(name) ?? { name, description: '' })

async function scanDir($: EngineInterface, root: string, prefix: string): Promise<SkillInfo[]> {
  if (!(await $.fs.exists(root))) return []
  const entries = (await $.fs.list(root)).filter(entry => entry.kind === 'dir' || entry.isLink)
  const found = await Promise.all(
    entries.map(async entry => {
      const text = await $.fs.read(`${root}/${entry.name}/SKILL.md`).catch(() => undefined)
      if (text === undefined) return undefined
      const info = parseSkillMd(text, entry.name)
      return { ...info, name: prefix + info.name }
    }),
  )
  return found.filter(info => info !== undefined)
}

async function loadUsage($: EngineInterface): Promise<Usage> {
  return ((await $.store.get('usage')) ?? {}) as Usage
}

const ranked = (counts: Map<string, number>): TopSkill[] =>
  [...counts]
    .filter(([, count]) => count > 0)
    .map(([name, count]) => ({ name, count, tag: tagOfName(name) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 50)

async function refreshTop($: EngineInterface, usage: Usage) {
  const here = new Map<string, number>()
  const everywhere = new Map<string, number>()
  for (const [folder, stats] of Object.entries(usage)) {
    for (const [name, stat] of Object.entries(stats)) {
      const count = stat.used + stat.clicked
      everywhere.set(name, (everywhere.get(name) ?? 0) + count)
      if (folder === project) here.set(name, count)
    }
  }
  await update($, top, () => ranked(here))
  await update($, topAll, () => ranked(everywhere))
}

async function bump($: EngineInterface, names: string[], field: 'used' | 'clicked' | 'shown') {
  if (names.length === 0) return
  const usage = await loadUsage($)
  const stats = usage[project] ?? {}
  const now = await $.clock.now()
  for (const name of names) {
    const stat = stats[name] ?? { used: 0, clicked: 0, shown: 0, last: 0 }
    stats[name] = { ...stat, [field]: stat[field] + 1, last: field === 'shown' ? stat.last : now }
  }
  usage[project] = stats
  await $.store.set('usage', usage)
  await refreshTop($, usage)
}

async function setScope($: EngineInterface, scope: string) {
  await update($, topScope, () => scope)
  await update($, tagFilter, () => '')
  await $.store.set('topScope', scope)
}

async function setTab($: EngineInterface, value: string) {
  await update($, tab, () => value)
  await $.store.set('tab', value)
}

// Runs after the prompt has gone on, so the registry round trip never delays Claude's answer.
function lookUp($: EngineInterface, query: string) {
  if (!isDiscoverOn || query === '') return
  $.clock.after(0, () => void discover($, query))
}

async function discover($: EngineInterface, query: string) {
  await update($, foundQuery, () => query)
  const response = await $.http
    .fetch(`${REGISTRY}/api/search?q=${encodeURIComponent(query)}&limit=20`)
    .catch(() => undefined)
  const list = response?.ok ? parseFound(response.text, index.map(skill => skill.name)) : []
  await update($, found, () => list)
}

async function reindex($: EngineInterface): Promise<number> {
  const home = await $.env.get('HOME')
  const installed = JSON.parse(
    await $.fs.read(`${home}/.claude/plugins/installed_plugins.json`).catch(() => '{}'),
  ) as InstalledPlugins
  const roots: [string, string][] = [
    [`${home}/.claude/skills`, ''],
    ['.claude/skills', ''],
    ...Object.entries(installed.plugins ?? {}).flatMap(([key, installs]): [string, string][] => {
      const path = installs[0]?.installPath
      return path === undefined ? [] : [[`${path}/skills`, `${key.split('@')[0]}:`]]
    }),
  ]
  const all = (await Promise.all(roots.map(([root, prefix]) => scanDir($, root, prefix)))).flat()
  byName = new Map(all.map(skill => [skill.name, skill]))
  index = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  catalog = `Skill catalog (one name per line):\n${index.map(skill => skill.name).join('\n')}`

  const root = await $.session.root()
  project = root.split('/').filter(Boolean).pop() ?? root
  const claudeMd = await $.fs.ancestors({ names: ['CLAUDE.md'] })
  const rules = projectRules(
    claudeMd.map(file => file.content),
    index.map(skill => skill.name),
  )
  required = rules.required
  forbidden = rules.forbidden
  await update($, ruleNote, () =>
    [
      required.length > 0 ? t().rules(project, required) : '',
      forbidden.length > 0 ? t().forbidden(forbidden) : '',
    ]
      .filter(Boolean)
      .join('\n'),
  )
  const savedScope = await $.store.get('topScope')
  await update($, topScope, () => (savedScope === 'all' ? 'all' : 'project'))
  const savedTab = await $.store.get('tab')
  await update($, tab, () => (typeof savedTab === 'string' && TABS.includes(savedTab) ? savedTab : 'suggested'))
  await refreshTop($, await loadUsage($))
  await update($, note, () => t().indexed(index.length))
  return index.length
}

async function recommend($: EngineInterface, request: string): Promise<Suggestion[]> {
  await update($, note, () => t().analyzing)
  const recent = await $.session.messages().catch(() => [])
  const conversation = recent
    .filter(message => message.text.trim() !== '')
    .slice(-4)
    .map(message => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text.slice(0, 500)}`)
    .join('\n\n')
  // The catalog block never changes between prompts, so the API serves it from its cache.
  const selection = await $.model.complete({
    model: 'haiku',
    maxTokens: 900,
    timeoutMs: 8000,
    system: [{ text: catalog, cache: true }],
    prompt: selectPrompt(conversation, request),
  })
  const { cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWritten, input_tokens: sent } =
    selection.usage
  await update($, cacheNote, () =>
    cacheRead > 0
      ? t().cacheRead(thousands(cacheRead))
      : cacheWritten > 0
        ? t().cacheWritten(thousands(cacheWritten))
        : t().cacheOff(thousands(sent)),
  )
  const selected = selection.isAnswered ? parseNames(selection.text, byName, 60) : []
  const ruled = required.flatMap(name => byName.get(name) ?? [])
  const candidates = [
    ...new Map(
      [...ruled, ...selected, ...shortlist(index, tokenize(request), 20)]
        .filter(skill => !forbidden.includes(skill.name))
        .map(skill => [skill.name, skill]),
    ).values(),
  ]
  const fallbackQuery = tokenize(request).slice(0, 4).join(' ')
  if (candidates.length === 0) {
    await settle($, request, [])
    lookUp($, fallbackQuery)
    return []
  }
  const reply = await $.model.complete({
    model: 'haiku',
    maxTokens: 1000,
    timeoutMs: 8000,
    prompt: pickPrompt(conversation, request, candidates, required),
  })
  const stats = (await loadUsage($))[project] ?? {}
  const picks = (reply.isAnswered ? parsePicks(reply.text, candidates, maxSuggestions) : [])
    .map(pick => {
      const isRule = required.includes(pick.name)
      return { ...pick, isRule, score: adjust(pick.score, stats[pick.name], isRule), tag: tagOfName(pick.name) }
    })
    .sort((a, b) => b.score - a.score)
  await settle($, request, picks)
  lookUp($, (reply.isAnswered ? parseSearch(reply.text) : '') || fallbackQuery)
  await bump(
    $,
    picks.map(pick => pick.name),
    'shown',
  )
  return picks
}

// A prompt with no pick keeps the previous suggestions on screen.
async function settle($: EngineInterface, request: string, picks: Suggestion[]) {
  let isEmpty = picks.length === 0
  await update($, suggested, previous => {
    isEmpty = picks.length === 0 && (previous ?? []).length === 0
    return picks.length > 0 ? picks : (previous ?? [])
  })
  if (picks.length > 0) await update($, about, () => request)
  await update($, note, () => (isEmpty ? t().nothingYet : ''))
}

async function statsReport($: EngineInterface): Promise<string> {
  const usage = await loadUsage($)
  const totals = new Map<string, number>()
  for (const stats of Object.values(usage)) {
    for (const [name, stat] of Object.entries(stats)) {
      totals.set(name, (totals.get(name) ?? 0) + stat.used + stat.clicked)
    }
  }
  const used = [...totals].filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1])
  const byTag = new Map<string, { used: number; unused: number }>()
  for (const skill of index) {
    const tag = tagOf(skill)
    const row = byTag.get(tag) ?? { used: 0, unused: 0 }
    if ((totals.get(skill.name) ?? 0) > 0) row.used += 1
    else row.unused += 1
    byTag.set(tag, row)
  }

  return [
    t().statsTitle(index.length, used.length),
    '',
    t().statsTop,
    t().statsTopHeader,
    '|---|---|---|---|',
    ...used
      .slice(0, 15)
      .map(([name, count], rank) => `| ${rank + 1} | ${name} | ${tagLabel(tagOfName(name))} | ${count} |`),
    '',
    t().statsByTag,
    t().statsByTagHeader,
    '|---|---|---|',
    ...[...byTag]
      .sort((a, b) => b[1].used - a[1].used || b[1].unused - a[1].unused)
      .map(([tag, row]) => `| ${tagLabel(tag)} | ${row.used} | ${row.unused} |`),
  ].join('\n')
}

export const register: Register = (on, options) => {
  lang = options.language === 'fr' ? 'fr' : 'en'
  minContextScore = typeof options.contextMinScore === 'number' ? options.contextMinScore : 7
  maxSuggestions = typeof options.maxSuggestions === 'number' ? options.maxSuggestions : 10
  isContextOn = options.shareWithClaude !== false
  isDiscoverOn = options.discover !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'skills-panel', description: t().commandPanel })
    await $.command.register({ name: 'skills-rescan', description: t().commandRescan })
    await $.command.register({ name: 'skills-stats', description: t().commandStats })
    await update($, suggested, () => [])
    await update($, note, () => t().indexing)
    $.clock.after(0, () => void reindex($))
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'skills-panel' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: t().paneOpened }
  })

  on('command.run', { command: 'skills-rescan' }, async $ => {
    const count = await reindex($)

    return { text: t().rescanned(count) }
  })

  on('command.run', { command: 'skills-stats' }, async $ => ({ text: await statsReport($) }))

  // Awaited before next(e) so the suggestions are drawn, and handed to the model, before it answers.
  on('prompt.submit', async ($, e, next) => {
    const text = e.text.trim()
    const isEligible = e.origin.kind === 'composer' && !text.startsWith('/') && text.length >= 12
    if (!isEligible || index.length === 0) return next(e)
    const strong = (await recommend($, text)).filter(pick => pick.score >= minContextScore)
    if (!isContextOn || strong.length === 0) return next(e)

    return next({ ...e, context: [...(e.context ?? []), contextFor(strong, forbidden)] })
  })

  on('skill.prompt', async ($, e, next) => {
    await update($, active, list =>
      list.some(skill => skill.name === e.skill)
        ? list.map(skill => (skill.name === e.skill ? { ...skill, count: skill.count + 1 } : skill))
        : [...list, { name: e.skill, count: 1 }],
    )
    await bump($, [e.skill], 'used')

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    const Svg = 'Svg' in elements ? elements.Svg : undefined
    const used = await read($, active)
    const picks = await read($, suggested)
    const status = await read($, note)
    const prompt = await read($, about)
    const scope = await read($, topScope)
    const ranking = scope === 'all' ? await read($, topAll) : await read($, top)
    const filter = await read($, tagFilter)
    const rules = await read($, ruleNote)
    const cache = await read($, cacheNote)
    const finds = await read($, found)
    const query = await read($, foundQuery)
    const view = await read($, tab)
    const tagCounts = ranking.reduce(
      (counts, skill) => counts.set(skill.tag, (counts.get(skill.tag) ?? 0) + skill.count),
      new Map<string, number>(),
    )
    const shownTop = ranking.filter(skill => filter === '' || skill.tag === filter).slice(0, 10)
    const countWidth = Math.max(1, ...shownTop.map(skill => String(skill.count).length))
    const append = async (addition: string) => {
      const { text } = await $.prompt.read()
      const separator = text === '' || /\s$/.test(text) ? '' : ' '
      await $.prompt.fill({ text: `${text}${separator}${addition} `, mode: 'replace' })
    }
    const insert = async (name: string) => {
      await bump($, [name], 'clicked')
      await append(`/${name}`)
    }
    const pill = (label: string, color: string) => (
      <Text backgroundColor={color} color="white">{` ${label} `}</Text>
    )
    const segment = (key: string, label: string, isOn: boolean, onPress: () => unknown) => (
      <Button key={key} label={label} variant={isOn ? 'primary' : 'secondary'} dimColor={!isOn} onPress={onPress} />
    )
    const filterPill = (key: string, label: string, color: string, isOn: boolean, onPress: () => unknown) => (
      // Button takes a color only on hover, so the filled background never sits behind the label at rest.
      <Box key={`${key}-pill`} hover={{ scope: `filter-${key}`, backgroundColor: color }} paddingRight={1} gap={1}>
        <Text backgroundColor={isOn ? color : undefined} color={isOn ? 'white' : color}>{' ● '}</Text>
        <Button key={key} plain label={label} dimColor={!isOn} hover={{ scope: `filter-${key}`, color: 'white' }} onPress={onPress} />
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
          <Text bold>{t().active}</Text>
          {used.length === 0 && <Text dimColor>{t().noActive}</Text>}
          {used.map(skill => (
            <Box gap={1}>
              <Text>{skill.name}</Text>
              {skill.count > 1 && <Text dimColor>{`x${skill.count}`}</Text>}
              {pill(tagLabel(tagOfName(skill.name)), tagColor(tagOfName(skill.name)))}
            </Box>
          ))}
        </Box>

        <Box gap={1} flexWrap="wrap">
          {segment('tab-suggested', picks.length > 0 ? `${t().suggested} ${picks.length}` : t().suggested, view === 'suggested', () =>
            setTab($, 'suggested'),
          )}
          {segment('tab-discover', finds.length > 0 ? `${t().discover} ${finds.length}` : t().discover, view === 'discover', () =>
            setTab($, 'discover'),
          )}
          {segment('tab-top', t().topUsed, view === 'top', () => setTab($, 'top'))}
        </Box>

        {view === 'suggested' && (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
              {prompt !== '' && picks.length > 0 && (
                <Text dimColor>{t().forPrompt(prompt.length > 60 ? `${prompt.slice(0, 60)}...` : prompt)}</Text>
              )}
              {status !== '' && <Text dimColor>{status}</Text>}
              {picks.map((pick, rank) => (
                <Box flexDirection="column" marginTop={1}>
                  <Box gap={1}>
                    <Text dimColor>{`${rank + 1}.`}</Text>
                    <Button key={`use-${pick.name}`} plain label={`/${pick.name}`} onPress={() => insert(pick.name)} />
                  </Box>
                  <Box gap={1} alignItems="center">
                    {Svg === undefined ? (
                      <Text color={scoreColor(pick.score)}>{bar(pick.score)}</Text>
                    ) : (
                      <Svg source={gauge(pick.score)} alt={t().scoreAlt(pick.score)} width={GAUGE_WIDTH} height={GAUGE_HEIGHT} />
                    )}
                    <Text bold color={scoreColor(pick.score)}>{`${pick.score}`}</Text>
                    {pill(tagLabel(pick.tag), tagColor(pick.tag))}
                    {pick.isRule && pill(t().rule, RULE_COLOR)}
                  </Box>
                  <Text dimColor>{pick.why}</Text>
                </Box>
              ))}
            </Box>
            {rules !== '' && <Text dimColor>{rules}</Text>}
            {cache !== '' && <Text dimColor>{cache}</Text>}
          </Box>
        )}

        {view === 'discover' && (
          <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
            {!isDiscoverOn && <Text dimColor>{t().discoverOff}</Text>}
            {isDiscoverOn && query === '' && <Text dimColor>{t().discoverIdle}</Text>}
            {isDiscoverOn && query !== '' && <Text dimColor>{t().discoverFor(query)}</Text>}
            {isDiscoverOn && query !== '' && finds.length === 0 && <Text dimColor>{t().discoverNone}</Text>}
            {finds.map((skill, rank) => {
              const kind = tagOf({ name: skill.name, description: '' })
              return (
                <Box flexDirection="column" marginTop={1}>
                  <Box gap={1}>
                    <Text dimColor>{`${rank + 1}.`}</Text>
                    <Button key={`add-${skill.name}`} plain label={skill.name} onPress={() => append(installCommand(skill))} />
                    {pill(tagLabel(kind), tagColor(kind))}
                  </Box>
                  <Text dimColor>{`${skill.source}, ${t().installs(compact(skill.installs))}`}</Text>
                </Box>
              )
            })}
            {finds.length > 0 && (
              <Box marginTop={1}>
                <Text dimColor>{t().discoverHint}</Text>
              </Box>
            )}
          </Box>
        )}

        {view === 'top' && (
          <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
            <Box gap={1}>
              {segment('scope-project', project === '' ? t().project : project, scope !== 'all', () => setScope($, 'project'))}
              {segment('scope-all', t().allProjects, scope === 'all', () => setScope($, 'all'))}
            </Box>
            {ranking.length === 0 && <Text dimColor>{scope === 'all' ? t().noHistory : t().noHistoryHere}</Text>}
            {ranking.length > 0 && (
              <Box flexWrap="wrap" columnGap={1} rowGap={0} marginTop={1}>
                {filterPill('tag-all', t().all, ALL_COLOR, filter === '', () => update($, tagFilter, () => ''))}
                {[...tagCounts].map(([tag, count]) =>
                  filterPill(`tag-${tag}`, `${tagLabel(tag)} ${count}`, tagColor(tag), filter === tag, () =>
                    update($, tagFilter, current => (current === tag ? '' : tag)),
                  ),
                )}
              </Box>
            )}
            {shownTop.map((skill, rank) => (
              <Box gap={1}>
                <Text dimColor>{`${rank + 1}.`}</Text>
                <Text bold color="claude">{String(skill.count).padStart(countWidth)}</Text>
                <Text>{skill.name}</Text>
                {pill(tagLabel(skill.tag), tagColor(skill.tag))}
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
