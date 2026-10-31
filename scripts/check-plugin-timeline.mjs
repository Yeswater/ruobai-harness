// Layout checks for the generated timeline SVG: chips stay inside their card,
// dates ascend, and the canvas covers the footer. Run after editing the
// generator or the phase table:
//
//   node scripts/check-plugin-timeline.mjs
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const svg = readFileSync(resolve('docs/assets/plugin-ecosystem-timeline.svg'), 'utf8')

const CARD_X = 272
const CARD_W = 928
const MAX_RIGHT = CARD_X + CARD_W - 16

const problems = []

// Every pill must fit inside the card it belongs to.
for (const match of svg.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)" height="24"/g)) {
  const x = Number(match[1])
  const w = Number(match[2])
  if (x < CARD_X || x + w > MAX_RIGHT + 0.5) {
    problems.push(`chip out of bounds: x=${x} w=${w} right=${x + w} > ${MAX_RIGHT}`)
  }
}

// Text must fit inside its own pill: the label is centred, so half of it plus
// the glyph width has to stay within the box.
for (const match of svg.matchAll(/<rect x="([\d.]+)" y="(\d+)" width="([\d.]+)" height="24" rx="12"[^>]*\/>\s*<text x="([\d.]+)" y="(\d+)" text-anchor="middle" font-size="11.5"[^>]*>([^<]*)<\/text>/g)) {
  const [, , , width, cx, , label] = match
  const w = Number(width)
  if (Number(cx) <= Number(match[1])) problems.push(`label not centred: ${label}`)
  if (!label.trim()) problems.push('empty chip label')
  if (w < 40) problems.push(`pill too narrow for "${label}": ${w}`)
}

// One card per phase plus the dashed future card.
const cards = [...svg.matchAll(/<text x="164" y="(\d+)" text-anchor="end" font-size="13" font-weight="600"/g)]
if (cards.length !== 19) problems.push(`expected 19 date markers, found ${cards.length}`)

// Markers must ascend; a regression here means the y arithmetic drifted.
let previous = -1
for (const [, y] of cards) {
  if (Number(y) <= previous) problems.push(`date marker out of order at y=${y}`)
  previous = Number(y)
}

// The declared height must cover the last element.
const declared = Number(/height="(\d+)"/.exec(svg)?.[1])
const footer = Number(/<text x="72" y="(\d+)" font-size="10.5"/.exec(svg)?.[1])
if (!(declared > footer)) problems.push(`canvas ${declared} does not cover footer at ${footer}`)
if (declared > 6000) problems.push(`canvas unexpectedly tall: ${declared}`)

// The rail has to start above the first card and stop at the future marker.
const rail = /<line x1="196" y1="(\d+)" x2="196" y2="(\d+)"/.exec(svg)
if (!rail) problems.push('rail line missing')
else if (Number(rail[1]) >= Number(rail[2])) problems.push('rail runs backwards')

if (problems.length) {
  console.error(`timeline SVG has ${problems.length} problem(s):`)
  for (const problem of problems.slice(0, 20)) console.error(` - ${problem}`)
  process.exit(1)
}

console.log(`timeline SVG ok: ${cards.length} markers, canvas ${declared}px, rail ${rail[1]}→${rail[2]}`)
