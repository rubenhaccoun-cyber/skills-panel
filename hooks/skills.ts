export type SkillInfo = { name: string; description: string }
export type RawPick = { name: string; why: string; score: number }
export type Stat = { used: number; clicked: number; shown: number; last: number }
export type Found = { name: string; source: string; installs: number }

// find-skills advises against recommending registry skills under 1,000 installs.
const MIN_INSTALLS = 1000

const STOPWORDS = new Set(
  (
    'les des une pour dans avec sur que qui est pas plus par mon mes ton tes son ses nous vous leur ' +
    'cette ces aux fait faire peux peut veux tout tous comme mais donc alors aussi bien tres ' +
    'the and for with this that from into your you are can how what when use using'
  ).split(' '),
)

const unquote = (value: string) => value.replace(/^(['"])([\s\S]*)\1$/, '$2')

export function parseSkillMd(text: string, fallback: string): SkillInfo {
  const lines = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]?.split(/\r?\n/) ?? []
  const field = (key: string): string => {
    const at = lines.findIndex(line => line.startsWith(`${key}:`))
    if (at < 0) return ''
    const inline = (lines[at] ?? '').slice(key.length + 1).trim()
    if (inline !== '' && !/^[|>][+-]?$/.test(inline)) return unquote(inline)
    const block: string[] = []
    for (const line of lines.slice(at + 1)) {
      if (!/^\s+\S/.test(line)) break
      block.push(line.trim())
    }
    return block.join(' ')
  }

  return { name: field('name') || fallback, description: field('description').slice(0, 300) }
}

export function tokenize(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length >= 3 && !STOPWORDS.has(word))
}

export function shortlist(skills: SkillInfo[], words: string[], limit = 25): SkillInfo[] {
  const unique = [...new Set(words)]

  return skills
    .map(skill => {
      const name = skill.name.toLowerCase()
      const description = skill.description.toLowerCase()
      const score = unique.reduce(
        (sum, word) => sum + (name.includes(word) ? 3 : 0) + (description.includes(word) ? 1 : 0),
        0,
      )
      return { skill, score }
    })
    .filter(scored => scored.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(scored => scored.skill)
}

export function parsePicks(reply: string, candidates: SkillInfo[], limit = 10): RawPick[] {
  const known = new Set(candidates.map(skill => skill.name))
  const json = /\[[\s\S]*\]/.exec(reply)?.[0]
  if (json === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  return parsed
    .filter(
      (pick): pick is RawPick =>
        typeof pick?.name === 'string' &&
        typeof pick?.why === 'string' &&
        typeof pick?.score === 'number' &&
        known.has(pick.name),
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

const TAG_RULES: [string, RegExp][] = [
  ['seo', /\bseo\b|schema|sitemap|serp|backlink|search console|indexing/],
  ['video', /video|vidéo|\breels?\b|remotion|ffmpeg|heygen|short-form/],
  ['writing', /copywrit|humani|writing|writer|copy-edit|redaction|de-ai|article|blog|newsletter/],
  ['ecommerce', /shopify|e-?commerce|stripe|checkout|payment|storefront|merchant/],
  ['marketing', /marketing|campaign|\bads\b|social|instagram|linkedin|launch|\bcro\b|email/],
  ['design', /design|\bui\b|\bux\b|figma|tailwind|typograph|animation|motion|visual|\bcss\b|brand|interface/],
  ['data', /\bdata\b|analytics|\bsql\b|chart|dashboard|statistic|spreadsheet|xlsx/],
  ['dev', /react|next\.?js|typescript|javascript|python|\bapi\b|backend|frontend|debug|\btest|\bgit\b|deploy|vercel|supabase|database|code/],
  ['workflow', /brainstorm|\bplan|workflow|subagent|\bagents?\b|hook|config|setup|session|memory|worktree|prompt/],
]

const firstTag = (text: string) => TAG_RULES.find(([, rule]) => rule.test(text))?.[0]

// The name alone decides first: a description often mentions other domains in passing.
export function tagOf(skill: SkillInfo): string {
  const name = skill.name.toLowerCase()
  return firstTag(name) ?? firstTag(`${name} ${skill.description.toLowerCase()}`) ?? 'other'
}

// Skills named in backticks in CLAUDE.md: required, unless the sentence forbids them.
export function projectRules(texts: string[], names: string[]): { required: string[]; forbidden: string[] } {
  const byShort = new Map<string, string>()
  for (const name of names) {
    byShort.set(name, name)
    const short = name.split(':').pop()
    if (short !== undefined && !byShort.has(short)) byShort.set(short, name)
  }
  const required = new Set<string>()
  const forbidden = new Set<string>()
  for (const sentence of texts.join('\n').split(/[.;\n]/)) {
    const isBan = /\b(jamais|never|interdit|forbidden|do not|don't)\b/i.test(sentence)
    for (const [, token] of sentence.matchAll(/`([a-z0-9][a-z0-9:-]*)`/g)) {
      const name = token === undefined ? undefined : byShort.get(token)
      if (name === undefined) continue
      if (isBan) forbidden.add(name)
      else required.add(name)
    }
  }

  return { required: [...required].filter(name => !forbidden.has(name)), forbidden: [...forbidden] }
}

export function adjust(score: number, stat: Stat | undefined, isRule: boolean): number {
  const bonus = stat === undefined ? 0 : Math.min(2, (stat.used + stat.clicked) * 0.5)
  const penalty = stat !== undefined && stat.shown >= 5 && stat.used + stat.clicked === 0 ? 1 : 0

  return Math.max(1, Math.min(10, Math.round(score + bonus - penalty + (isRule ? 1 : 0))))
}

export function parseSearch(reply: string): string {
  return (/"search"\s*:\s*"([^"]{1,80})"/.exec(reply)?.[1] ?? '').trim()
}

// skills.sh search results, minus skills already installed and little-used ones, most installed first.
export function parseFound(body: string, installed: string[], limit = 5): Found[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  const skills = (parsed as { skills?: unknown } | null)?.skills
  if (!Array.isArray(skills)) return []
  const have = new Set(installed.map(name => (name.split(':').pop() ?? name).toLowerCase()))
  const best = new Map<string, Found>()
  for (const skill of skills) {
    if (typeof skill?.name !== 'string' || typeof skill?.source !== 'string' || typeof skill?.installs !== 'number') continue
    const key = skill.name.toLowerCase()
    const id = typeof skill.skillId === 'string' ? skill.skillId.toLowerCase() : key
    if (skill.installs < MIN_INSTALLS || have.has(key) || have.has(id)) continue
    if ((best.get(key)?.installs ?? -1) < skill.installs) {
      best.set(key, { name: skill.name, source: skill.source, installs: skill.installs })
    }
  }

  return [...best.values()].sort((a, b) => b.installs - a.installs).slice(0, limit)
}

export function parseNames(reply: string, byName: Map<string, SkillInfo>, limit: number): SkillInfo[] {
  const json = /\[[\s\S]*\]/.exec(reply)?.[0]
  if (json === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  return parsed
    .flatMap(name => (typeof name === 'string' ? (byName.get(name) ?? []) : []))
    .slice(0, limit)
}
