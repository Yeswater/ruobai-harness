// Generate docs/assets/plugin-ecosystem-timeline.svg from the per-phase table
// below. The timeline itself is hand-curated; only the layout arithmetic is
// mechanical, which is why this is a generator and not a test fixture.
//
//   node scripts/gen-plugin-timeline.mjs     # write the SVG
//   node scripts/check-plugin-timeline.mjs   # verify layout after editing it
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const W = 1240
const CARD_X = 272
const CARD_W = 928
const ACCENT = '#c96442'
const GREY = '#cecbc4'
const MAX_RIGHT = CARD_X + CARD_W - 16
const PAD = 24
const GAP = 8
const MINW = 43

/** Rough advance widths: CJK is nearly square, ASCII is about half of it. */
function textWidth(text) {
  let width = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (ch === ' ') width += 3.6
    else if (code >= 0x3000 && code <= 0x303f) width += 11.6
    else if (code >= 0x4e00 && code <= 0x9fff) width += 11.6
    else if (code >= 0xff00 && code <= 0xffef) width += 11.6
    else if ('·、：，（）'.includes(ch)) width += 11.6
    else if (/[A-Z0-9]/.test(ch)) width += 6.9
    else width += 6.1
  }
  return width
}

const PHASES = [
  ['10-24', '骨架与运行时', 'Cordis 插件树、配置驱动启动、Web UI 与 agent 主循环落地。',
    ['cordis', 'loader', 'include', 'schemastery', 'cli', 'web-server', 'llm', 'llm-mock', 'session', 'session-jsonl', 'tools', 'agent', 'modes', 'context', 'ui-app'], false],
  ['10-24', '能力基座', '会话管理、Shell 与 MCP 接入；权限、检查点、子 agent 与技能。',
    ['permissions', 'tool-bash', 'tool-fs', 'mcp', 'mcp-catalog', 'mcp-config', 'mcp-web', 'checkpoints', 'tool-task', 'skills', 'skills-web'], false],
  ['10-25', '客户端生态', '工作区、输入框、设置、命令面板、Git/文件面板与协议兼容。',
    ['workspace', 'workspace-web', 'settings-web', 'ui-slots', 'client-modules', 'git-web', 'checkpoints-web', 'a2a', 'a2a-web', 'web-static', 'web-ws', 'mermaid 渲染'], false],
  ['10-25', '过程可读', '思考与工具折叠、计时/计费落进日志，回合收成「已完成，用时」。',
    ['chat', 'chat-protocol', 'context', 'ui-app', '过程折叠 v1', '计时 / 计费投影'], false],
  ['10-26', '安全边界', '执行面拆出 shell；Seatbelt 插件链、拒绝升级与状态面板。',
    ['shell', 'shell-direct', 'shell-sandboxed', 'sandbox', 'sandbox-policy', 'sandbox-guards', 'sandbox-macos', 'sandbox-denial', 'sandbox-native-log', 'sandbox-escalation', 'sandbox-web', 'approval-deadline'], true],
  ['10-26', '轨迹与分层折叠', '轨迹投影与实时帧、每轮上下文快照，以及按正文分层的四级折叠。',
    ['trajectory', 'trajectory-web', 'context snapshot', '轨迹 MVP', '按正文分段', '四级折叠'], true],
  ['10-27', '门禁与宿主执行', 'Hook + Linter 确定性门禁；lint/typecheck 移到宿主执行器，Stop 层读取 tsc 诊断。',
    ['hooks', 'hooks-web', 'lint', 'shell-direct', 'Stop 诊断'], true],
  ['10-27', '记忆与 LLM Wiki', '双层知识：2k 记忆注入、LLM Wiki 检索、提案审核、来源/版本与混合检索。',
    ['memory', 'memory-distill', 'memory-web', 'wiki', 'wiki-web', 'wiki-embed', 'context-search', 'commands'], true],
  ['10-27', '插件治理与发布', '运行时开关插件；Gitee 浏览/发布/Issue；品牌与开源准备。',
    ['插件热开关', 'Gitee', '品牌 / favicon', 'MIT / README'], true],
  ['10-28', '设置与技能生态', 'WorkBuddy 式设置与知识库；SkillHub 浏览、安装、移除；专家/技能/连接器合并。',
    ['设置重构', 'SkillHub', '专家·技能·连接器', '知识库三视图', 'wiki 提案 diff'], true],
  ['10-28', '运行态与知识自动化', '运行中权限/排队；知识库目录分组与可选自动检索、空闲提案。',
    ['消息排队', '权限热切换', '应用内确认框', '知识库目录', '自动检索', '空闲提案', 'wiki-automation'], true],
  ['10-29', '回合内交互', '问题在回合内提出并等待回答；计划与提交变成卡片，确认不再靠对话往返。',
    ['ask', 'ask-web', '前置检查', '计划审批卡片', 'commit-prompt', '逐页向导'], true],
  ['10-29', '会话与面板', '没发消息的会话不落盘；右栏四视图统一成圆角卡片，终端并入右栏。',
    ['会话草稿', '工作区折叠 5 条', '会话栏独立', 'terminal 右侧面板', '圆角卡片', '操作行内联'], true],
  ['10-29', '预览与推送', '预览工具共享同一页面并可点击/输入，无头页实时投屏；更改面板提交、按托管平台推送。',
    ['无头页共享', '快照·点击·输入', 'screencast 投屏', '更改面板提交', '可插拔托管', '终端底色'], true],
  ['10-30', '交付契约与证据', '验收条款进系统提示并跨压缩保留；验收缺口阻断回合，交接包与客户只读审计视图就位。',
    ['contract', 'visibility 分层', '证据门禁', '验收绑定 todo', 'delivery', 'handoff', 'client-audit'], true],
  ['10-30', '交付面板与质量门', '交付状态进右侧信息栏；环境档案可建可删；技能草稿需批准才进技能根；诊断与评测产出提案或拒绝。',
    ['delivery-web', 'provider-catalog', '环境档案 CRUD', 'skill-distiller', 'skill-distiller-web', 'rubric', 'rubric-web', 'eval', 'eval-web'], true],
  ['10-30', '桌面壳与模型厂商', 'Electron 壳复用现有界面；三平台打包进流水线；厂商按 provider 注册，余额与今日用量可见。',
    ['apps/desktop', 'GH Actions 打包', 'llm-openai', 'llm-balance', 'llm-balance-web', '工具目录 defer', '余额与今日用量'], true],
  ['10-31', '设计系统与网络边界', '全站改用 token 与基础组件；网络出口收敛到本机代理；沙箱与审批以「边界即授权」衔接。',
    ['设计系统', 'CC / DeepSeek 皮肤', 'net', 'sandbox-proxy', '边界即授权', '域名白名单'], true],
]

const FUTURE = ['下一阶段', 'future', '时间尺只画到已发生的事；这些是设计里已定、尚未落地的下一步。',
  ['jail 部署层', 'Linux / Windows provider', '轨迹行级虚拟化', '时间概览', '交付证据评测']]

function wrap(chips) {
  const lines = []
  let current = []
  let x = CARD_X + 24
  for (const chip of chips) {
    const width = Math.max(MINW, Math.round((textWidth(chip) + PAD) * 10) / 10)
    if (current.length && x + width > MAX_RIGHT) {
      lines.push(current)
      current = []
      x = CARD_X + 24
    }
    current.push({ chip, width, x })
    x += width + GAP
  }
  if (current.length) lines.push(current)
  return lines
}

function card({ y, date, phase, title, desc, chips, accent, future }) {
  const lines = wrap(chips)
  const height = 134 + 32 * (lines.length - 1)
  const out = []
  out.push(`  <g${future ? '' : ''}>`)
  out.push(`    <text x="164" y="${y + 222}" text-anchor="end" font-size="13" font-weight="600" fill="${future ? '#96938b' : '#6c6a64'}">${date}</text>`)
  out.push(`    <text x="164" y="${y + 242}" text-anchor="end" font-size="10.5" fill="#96938b">${phase}</text>`)
  if (future) {
    out.push(`    <circle cx="196" cy="${y + 216}" r="6" fill="#f7f7f5" stroke="#b0453a" stroke-width="2" stroke-dasharray="3 2"/>`)
    out.push(`    <rect x="${CARD_X}" y="${y + 196}" width="${CARD_W}" height="${height}" rx="12" fill="#fbfaf8" stroke="#cecbc4" stroke-dasharray="6 4"/>`)
    out.push(`    <text x="296" y="${y + 226}" font-size="16" font-weight="650" fill="#3a3936">${title}</text>`)
    out.push(`    <text x="296" y="${y + 248}" font-size="12" fill="#96938b">${desc}</text>`)
  } else {
    out.push(`    <circle cx="196" cy="${y + 216}" r="6" fill="${accent ? ACCENT : GREY}" stroke="#f7f7f5" stroke-width="3"/>`)
    out.push(`    <rect x="${CARD_X}" y="${y + 196}" width="${CARD_W}" height="${height}" rx="12" fill="#ffffff" stroke="#e4e2dd"/>`)
    out.push(`    <rect x="${CARD_X}" y="${y + 196}" width="3" height="${height}" rx="1.5" fill="${accent ? ACCENT : GREY}"/>`)
    out.push(`    <text x="296" y="${y + 226}" font-size="16" font-weight="650" fill="#1f1f1d">${title}</text>`)
    out.push(`    <text x="296" y="${y + 248}" font-size="12" fill="#6c6a64">${desc}</text>`)
  }
  lines.forEach((line, row) => {
    for (const { chip, width, x } of line) {
      const stroke = future ? ' stroke="#cecbc4" stroke-dasharray="4 3"' : ' stroke="#e4e2dd"'
      const fill = future ? '#6c6a64' : '#3a3936'
      out.push(`    <rect x="${round(x)}" y="${y + 268 + row * 32}" width="${width}" height="24" rx="12" fill="#ffffff"${stroke}/>`)
      out.push(`    <text x="${round(x + width / 2)}" y="${y + 284 + row * 32}" text-anchor="middle" font-size="11.5" fill="${fill}">${chip}</text>`)
    }
  })
  out.push('  </g>')
  return { svg: out.join('\n'), height }
}

function round(value) {
  return Math.round(value * 10) / 10
}

const body = []
let y = 196
PHASES.forEach(([date, title, desc, chips, accent], index) => {
  const built = card({ y, date, phase: `phase ${String(index + 1).padStart(2, '0')}`, title, desc, chips, accent, future: false })
  body.push(built.svg)
  y += built.height + 30
})

const futureY = y
const future = card({ y: futureY, date: FUTURE[0], phase: FUTURE[1], title: '继续向前', desc: FUTURE[2], chips: FUTURE[3], accent: false, future: true })
body.push(future.svg)
y += future.height + 30

const footerY = futureY + future.height + 36
const height = footerY + 34

const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" font-family="-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', sans-serif">
  <defs>
    <linearGradient id="rail" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#d8d4cc"/>
      <stop offset="0.72" stop-color="#cecbc4"/>
      <stop offset="1" stop-color="#e4e2dd"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${height}" fill="#f7f7f5"/>
  <text x="72" y="72" font-size="26" font-weight="700" fill="#1f1f1d">Harness 插件生态发展时间尺</text>
  <text x="72" y="100" font-size="13" fill="#6c6a64">2026-10-24 → 2026-10-31 · 105 个包 · 从“一个插件树”到“可观测、可升级、可交付的安全边界”</text>
  <g font-size="11" fill="#96938b">
    <circle cx="884" cy="92" r="4" fill="#c96442"/>
    <text x="896" y="96">插件 / 能力</text>
    <rect x="988" y="87" width="18" height="10" rx="5" fill="none" stroke="#b0453a" stroke-dasharray="3 2"/>
    <text x="1012" y="96">下一阶段</text>
  </g>
  <line x1="196" y1="150" x2="196" y2="${futureY + 148}" stroke="url(#rail)" stroke-width="2"/>`

const foot = `  <text x="72" y="${footerY}" font-size="10.5" fill="#96938b">数据来源：git log（2026-10-24 → 2026-10-31）与 packages/ 清单 · 生成于 2026-10-31 · 规范见 AGENTS.md</text>
</svg>
`

writeFileSync(resolve('docs/assets/plugin-ecosystem-timeline.svg'), `${head}\n${body.join('\n')}\n${foot}`)
console.log('height', height, 'futureY', futureY, 'phases', PHASES.length)
