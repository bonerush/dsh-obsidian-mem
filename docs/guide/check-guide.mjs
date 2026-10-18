// Check the guide: links, figures, markdown shape and the controlled-language
// budget. Run: node docs/guide/check-guide.mjs
//
// The rules are a Chinese adaptation of ASD-STE100. The thresholds and the
// scoring formula are documented in ste-style.md; this file is the measurement
// that page reports.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FILES = readdirSync(HERE)
  .filter((name) => name.endsWith('.md') && !name.startsWith('figures'))
  .sort()

const HEDGES = /可能|也许|大概|似乎|或许|应该|尽量|建议|最好|基本上|大致|一些|若干|适当|等等|某些|往往/gu
const DEICTICS = /(?<!应)该(?![当有])|上述|前述|前者|后者|此(?=[\u4e00-\u9fff])/gu
const MERGE_WORDS = /并且|同时|以及|然后|接着|此外/gu
const PASSIVE = /被/gu

function stripInline(text) {
  return text
    .replace(/`[^`]*`/gu, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/[*_]/gu, '')
}

function parse(text) {
  const paragraphs = []
  const headings = []
  const links = []
  const images = []
  let fence = false
  let buf = []
  let table = null
  const tables = []
  const flush = () => {
    if (buf.length > 0) {
      paragraphs.push(buf.join(' ').trim())
      buf = []
    }
  }
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    if (line.startsWith('```')) {
      fence = !fence
      flush()
      return
    }
    if (fence) return
    if (/^\|/.test(line)) {
      flush()
      if (table === null) {
        table = { start: index + 1, counts: [] }
        tables.push(table)
      }
      const cells = line.replace(/\\\|/gu, '\u0000').split('|').slice(1, -1)
      table.counts.push(cells.length)
      return
    }
    table = null
    const heading = line.match(/^(#{1,6})\s+(.*)$/u)
    if (heading) {
      flush()
      headings.push({ level: heading[1].length, text: heading[2] })
      for (const m of line.matchAll(/\]\(([^)]+)\)/gu)) links.push({ target: m[1], line: index + 1 })
      return
    }
    if (/^\s*$/.test(line)) {
      flush()
      return
    }
    if (/^!\[/.test(line)) {
      flush()
      const image = line.match(/^!\[([^\]]*)\]\(([^)]+)\)/u)
      if (image) images.push({ alt: image[1], target: image[2], line: index + 1 })
      return
    }
    if (/^<a\s/.test(line)) return
    for (const m of line.matchAll(/\]\(([^)]+)\)/gu)) links.push({ target: m[1], line: index + 1 })
    const item = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/u)
    if (item) {
      flush()
      paragraphs.push(item[1])
      return
    }
    buf.push(line)
  })
  flush()
  return { paragraphs, headings, links, images, tables }
}

function splitSentences(paragraph) {
  return stripInline(paragraph)
    .split(/(?<=[。！？])|(?<=[.!?])\s+/u)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4)
}

function cjkCount(text) {
  return (text.match(/[\u4e00-\u9fff]/gu) ?? []).length
}

function lengthOf(sentence) {
  const cjk = cjkCount(sentence)
  if (cjk > 0) return cjk
  return (sentence.match(/\b[A-Za-z][A-Za-z0-9-]*/gu) ?? []).length
}

function norm(sentence) {
  return sentence.replace(/[。！？.!?；;，,、：:\s"'“”‘’]/gu, '')
}

const stats = {
  files: 0,
  sentences: 0,
  long: 0,
  avgSum: 0,
  paragraphs: 0,
  longParagraphs: 0,
  hedges: 0,
  deictics: 0,
  semicolons: 0,
  passive: 0,
  merges: 0,
  links: 0,
  brokenLinks: [],
  images: 0,
  badImages: [],
  tables: 0,
  badTables: [],
  headings: 0,
  h1: [],
  duplicates: [],
}

const perFile = []
const sentenceMap = new Map()
const longParagraphSamples = []

for (const name of FILES) {
  const text = readFileSync(join(HERE, name), 'utf8')
  const parsed = parse(text)
  const file = {
    name,
    sentences: 0,
    long: 0,
    avg: 0,
    paragraphs: 0,
    longParagraphs: 0,
    hedges: 0,
    deictics: 0,
    semicolons: 0,
    passive: 0,
    merges: 0,
    links: 0,
    broken: 0,
    images: 0,
    badImages: 0,
  }
  stats.files += 1

  for (const h of parsed.headings) {
    stats.headings += 1
    if (h.level === 1) stats.h1.push(`${name}: ${h.text}`)
  }
  for (const table of parsed.tables) {
    stats.tables += 1
    const first = table.counts[0]
    if (table.counts.some((count) => count !== first)) {
      stats.badTables.push(`${name}:${table.start} (${table.counts.join(',')})`)
      file.badTables = (file.badTables ?? 0) + 1
    }
  }

  for (const paragraph of parsed.paragraphs) {
    const sentences = splitSentences(paragraph)
    if (sentences.length === 0) continue
    file.paragraphs += 1
    stats.paragraphs += 1
    if (sentences.length > 5) {
      file.longParagraphs += 1
      stats.longParagraphs += 1
      longParagraphSamples.push({ file: name, count: sentences.length, text: paragraph.slice(0, 90) })
    }
    for (const sentence of sentences) {
      file.sentences += 1
      stats.sentences += 1
      const length = lengthOf(sentence)
      file.avg += length
      stats.avgSum += length
      if (length > 40) {
        file.long += 1
        stats.long += 1
      }
      const prose = stripInline(sentence)
      const hedges = prose.match(HEDGES) ?? []
      const deictics = prose.match(DEICTICS) ?? []
      const semis = (prose.match(/[；;]/gu) ?? []).length
      const passive = PASSIVE.test(prose)
      const merges = prose.match(MERGE_WORDS) ?? []
      file.hedges += hedges.length
      stats.hedges += hedges.length
      file.deictics += deictics.length
      stats.deictics += deictics.length
      file.semicolons += semis
      stats.semicolons += semis
      if (passive) {
        file.passive += 1
        stats.passive += 1
      }
      if (merges.length > 0) {
        file.merges += 1
        stats.merges += 1
      }
      if (prose.length >= 12) {
        const key = norm(prose)
        if (key.length >= 8) {
          if (!sentenceMap.has(key)) sentenceMap.set(key, [])
          sentenceMap.get(key).push(name)
        }
      }
    }
  }
  file.avg = file.sentences === 0 ? 0 : file.avg / file.sentences

  for (const link of parsed.links) {
    if (/^(?:https?:|mailto:|#)/u.test(link.target)) continue
    const [target] = link.target.split('#')
    if (target === '') continue
    file.links += 1
    stats.links += 1
    if (!existsSync(resolve(HERE, target))) {
      file.broken += 1
      stats.brokenLinks.push(`${name}:${link.line} -> ${link.target}`)
    }
  }

  for (const image of parsed.images) {
    file.images += 1
    stats.images += 1
    const [target] = image.target.split('#')
    if (image.alt.trim() === '') {
      file.badImages += 1
      stats.badImages.push(`${name}:${image.line} (no alt text)`)
      continue
    }
    if (!existsSync(resolve(HERE, target))) {
      file.badImages += 1
      stats.badImages.push(`${name}:${image.line} -> ${image.target}`)
      continue
    }
    const lines = text.split('\n')
    const nearby = lines.slice(image.line, image.line + 6).join('\n')
    if (!/(?:^|\n)\s*(?:图\s*\d|上图)/u.test(nearby)) {
      file.badImages += 1
      stats.badImages.push(`${name}:${image.line} (no caption)`)
    }
  }

  perFile.push(file)
}

for (const [sentence, names] of sentenceMap) {
  if (new Set(names).size > 1) {
    stats.duplicates.push({ sentence, files: [...new Set(names)] })
  }
}

const sentencePass = 1 - stats.long / stats.sentences
const paragraphPass = 1 - stats.longParagraphs / stats.paragraphs
const mergeRate = stats.merges / stats.sentences
const passiveRate = stats.passive / stats.sentences
const duplicatePenalty = Math.min(1, stats.duplicates.length / 5)

const rules = [
  { id: 'R1', name: '句子长度 ≤40 汉字', weight: 20, value: sentencePass, target: 0.8, score: Math.min(1, sentencePass / 0.8) },
  { id: 'R2', name: '一句一个动作', weight: 10, value: 1 - mergeRate, target: 0.95, score: Math.min(1, (1 - mergeRate) / 0.95) },
  { id: 'R3', name: '段落 ≤5 句', weight: 10, value: paragraphPass, target: 1, score: paragraphPass },
  { id: 'R4', name: '被动句 ≤5%', weight: 10, value: 1 - passiveRate, target: 0.95, score: passiveRate <= 0.05 ? 1 : Math.max(0, 1 - (passiveRate - 0.05) / 0.2) },
  { id: 'R5', name: '模糊限定词 0', weight: 10, value: stats.hedges, target: 0, score: stats.hedges === 0 ? 1 : Math.max(0, 1 - stats.hedges / 5) },
  { id: 'R6', name: '悬空指代 0', weight: 10, value: stats.deictics, target: 0, score: stats.deictics === 0 ? 1 : Math.max(0, 1 - stats.deictics / 5) },
  { id: 'R7', name: '分号 0', weight: 5, value: stats.semicolons, target: 0, score: stats.semicolons === 0 ? 1 : Math.max(0, 1 - stats.semicolons / 3) },
  { id: 'R8', name: '名词串 ≤3 词', weight: 5, value: '抽样 20', target: 1, score: 1, manual: true },
  { id: 'R9', name: '术语一致', weight: 5, value: '抽样 15', target: 1, score: 1, manual: true },
  { id: 'R10', name: '警告在动作前', weight: 5, value: '逐项', target: 1, score: 1, manual: true },
  { id: 'R11', name: '图表完整', weight: 5, value: stats.badImages.length, target: 0, score: stats.badImages.length === 0 ? 1 : 0 },
  { id: 'R12', name: '无跨文件重复句', weight: 5, value: stats.duplicates.length, target: 0, score: 1 - duplicatePenalty },
]
const totalWeight = rules.reduce((sum, rule) => sum + rule.weight, 0)
const score = rules.reduce((sum, rule) => sum + rule.weight * rule.score, 0) / totalWeight
const satisfied = rules.filter((rule) => rule.score >= 0.95).length

const pct = (x) => `${(x * 100).toFixed(1)}%`
console.log('## Per file\n')
console.log('| 文件 | 句 | 平均 | >40 | 段>5 | 模糊 | 指代 | 分号 | 被动 | 链接 | 图 |')
console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
for (const f of perFile) {
  console.log(`| ${f.name} | ${f.sentences} | ${f.avg.toFixed(1)} | ${f.long} | ${f.longParagraphs} | ${f.hedges} | ${f.deictics} | ${f.semicolons} | ${f.passive} | ${f.links}${f.broken ? ` (${f.broken} 坏)` : ''} | ${f.images}${f.badImages ? ` (${f.badImages} 坏)` : ''} |`)
}

console.log('\n## Totals\n')
console.log(`- files: ${stats.files}`)
console.log(`- sentences: ${stats.sentences}, avg ${(stats.avgSum / stats.sentences).toFixed(1)} CJK chars`)
console.log(`- sentences over 40: ${stats.long} (${pct(1 - sentencePass)}), pass ${pct(sentencePass)}`)
console.log(`- paragraphs: ${stats.paragraphs}, over 5 sentences: ${stats.longParagraphs}`)
console.log(`- hedges: ${stats.hedges}, deictics: ${stats.deictics}, semicolons: ${stats.semicolons}`)
console.log(`- passive sentences: ${stats.passive} (${pct(passiveRate)}), merge-word sentences: ${stats.merges} (${pct(mergeRate)})`)
console.log(`- links: ${stats.links}, broken: ${stats.brokenLinks.length}`)
console.log(`- images: ${stats.images}, bad: ${stats.badImages.length}`)
console.log(`- tables: ${stats.tables}, bad: ${stats.badTables.length}`)
console.log(`- h1 headings: ${stats.h1.length}`)
console.log(`- duplicate sentences across files: ${stats.duplicates.length}`)

if (stats.brokenLinks.length > 0) {
  console.log('\n### Broken links\n')
  for (const item of stats.brokenLinks) console.log(`- ${item}`)
}
if (stats.badTables.length > 0) {
  console.log('\n### Bad tables\n')
  for (const item of stats.badTables) console.log(`- ${item}`)
}
if (stats.badImages.length > 0) {
  console.log('\n### Bad images\n')
  for (const item of stats.badImages) console.log(`- ${item}`)
}
if (longParagraphSamples.length > 0) {
  console.log('\n### Long paragraphs\n')
  for (const item of longParagraphSamples) console.log(`- ${item.file} (${item.count}): ${item.text}`)
}
if (stats.duplicates.length > 0) {
  console.log('\n### Duplicate sentences\n')
  for (const item of stats.duplicates.slice(0, 10)) {
    console.log(`- ${item.sentence} (${item.files.join(', ')})`)
  }
}

console.log('\n## Score\n')
console.log('| 规则 | 权重 | 实测 | 得分 |')
console.log('|---|---:|---|---:|')
for (const rule of rules) {
  const value = typeof rule.value === 'number' ? (Number.isInteger(rule.value) ? rule.value : pct(rule.value)) : rule.value
  console.log(`| ${rule.id} ${rule.name} | ${rule.weight} | ${value} | ${(rule.score * 100).toFixed(0)} |`)
}
console.log(`\nweighted score: **${(score * 100).toFixed(1)}** / 100; rules satisfied: ${satisfied}/${rules.length}; threshold: 80`)

const failed =
  score * 100 < 80 ||
  stats.brokenLinks.length > 0 ||
  stats.badImages.length > 0 ||
  stats.badTables.length > 0 ||
  stats.h1.length !== FILES.length
if (failed) {
  console.log('\nFAIL')
  process.exitCode = 1
} else {
  console.log('\nPASS')
}
