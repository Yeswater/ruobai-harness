/**
 * Server-rendered read-only audit page.
 *
 * Deliberately not a client plugin: the customer's view must not boot the
 * console bundle, which carries write panels. One HTML document, one fetch per
 * view, no forms.
 */
export function renderAuditPage(sessionId: string): string {
  const id = JSON.stringify(sessionId)
  const escaped = escapeHtml(sessionId)
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>交付审计 · ${escaped}</title>
<style>
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{margin:0;background:#f6f4ef;color:#24221f;font:14px/1.55 system-ui,-apple-system,"PingFang SC",sans-serif}
  header{display:flex;align-items:baseline;gap:12px;padding:16px 24px;border-bottom:1px solid #ded8ce;background:#fbfaf7}
  header h1{margin:0;font-size:15px;font-weight:600}
  header .meta{font-size:12px;color:#6b6660}
  main{max-width:960px;margin:0 auto;padding:20px 24px 60px}
  section{margin-bottom:26px}
  h2{font-size:13px;margin:0 0 10px;color:#4b4640;letter-spacing:.02em}
  .badge{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;border:1px solid #ded8ce;background:#fff;font-size:12px}
  .dot{width:8px;height:8px;border-radius:50%;background:#9ca3af}
  .badge.pass .dot{background:#2e9e5b}.badge.fail .dot{background:#c0392b}.badge.unsure .dot{background:#d08b1e}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e6e0d6;border-radius:10px;overflow:hidden}
  th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #f0ebe2;font-size:12.5px;vertical-align:top}
  th{background:#faf7f2;font-weight:600;color:#4b4640}
  tr:last-child td{border-bottom:0}
  .muted{color:#6b6660}
  .entry{display:flex;gap:12px;padding:6px 0;border-bottom:1px dashed #eee7dc;font-size:12.5px}
  .entry:last-child{border-bottom:0}
  .seq{width:52px;flex:none;color:#9a938a;font-variant-numeric:tabular-nums}
  .type{width:130px;flex:none;color:#6b6660}
  a{color:#c2603d}
  .empty{color:#9a938a;font-size:12.5px}
</style></head>
<body>
<header>
  <h1>交付审计</h1>
  <span class="meta">只读视图 · 会话 ${escaped}</span>
</header>
<main>
  <section id="summary"><h2>概览</h2><div class="empty">加载中…</div></section>
  <section id="acceptance"><h2>验收条款</h2><div class="empty">加载中…</div></section>
  <section id="timeline"><h2>过程</h2><div class="empty">加载中…</div></section>
  <section id="changes"><h2>改动文件</h2><div class="empty">加载中…</div></section>
</main>
<script>
const sessionId = ${id}
const base = '/api/audit/' + encodeURIComponent(sessionId)

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

async function get(path) {
  const response = await fetch(base + path)
  if (!response.ok) throw new Error(response.status + ' ' + response.statusText)
  return response.json()
}

function badge(verdict) {
  const label = verdict === 'pass' ? '已通过' : verdict === 'unsure' ? '未判定' : '未通过'
  return '<span class="badge ' + esc(verdict) + '"><span class="dot"></span>' + label + '</span>'
}

get('/summary').then((data) => {
  document.getElementById('summary').innerHTML =
    '<h2>概览</h2>' +
    '<p>' + badge(data.verdict.status) + ' <span class="muted">' + data.verdict.accepted + '/' + data.verdict.total + ' 条验收通过</span></p>' +
    '<p class="muted">' + esc(data.session.title) + ' · 更新于 ' + new Date(data.session.updatedAt).toLocaleString() + '</p>'
}).catch(() => {
  document.getElementById('summary').innerHTML = '<h2>概览</h2><div class="empty">不可用</div>'
})

get('/acceptance').then((data) => {
  const node = document.getElementById('acceptance')
  if (!data.contract) {
    node.innerHTML = '<h2>验收条款</h2><div class="empty">本会话没有交付契约</div>'
    return
  }
  const rows = data.checks.map((check) => {
    const item = (data.contract.acceptance || []).find((candidate) => candidate.id === check.acceptanceId)
    return '<tr><td>' + esc(check.acceptanceId) + '</td><td>' + esc(item ? item.criterion : '-') +
      '</td><td>' + esc(check.status) + '</td><td class="muted">' + esc(check.reason) + '</td></tr>'
  }).join('')
  node.innerHTML = '<h2>验收条款 · ' + esc(data.contract.title) + '</h2>' +
    '<table><thead><tr><th>条款</th><th>内容</th><th>状态</th><th>说明</th></tr></thead><tbody>' + rows + '</tbody></table>'
}).catch(() => {
  document.getElementById('acceptance').innerHTML = '<h2>验收条款</h2><div class="empty">不可用</div>'
})

get('/timeline').then((data) => {
  const entries = data.entries.map((entry) =>
    '<div class="entry"><span class="seq">#' + entry.seq + '</span><span class="type">' + esc(entry.type) +
    '</span><span>' + esc(entry.summary) + '</span></div>').join('')
  document.getElementById('timeline').innerHTML = '<h2>过程</h2>' + (entries || '<div class="empty">没有可展示的记录</div>')
}).catch(() => {
  document.getElementById('timeline').innerHTML = '<h2>过程</h2><div class="empty">不可用</div>'
})

get('/changes').then((data) => {
  const rows = data.files.map((file) =>
    '<tr><td>' + esc(file.path) + '</td><td>' + esc(file.tool) + '</td><td class="muted">' + (file.bytes ?? '-') + '</td></tr>').join('')
  document.getElementById('changes').innerHTML = '<h2>改动文件</h2>' +
    (rows ? '<table><thead><tr><th>文件</th><th>工具</th><th>字节</th></tr></thead><tbody>' + rows + '</tbody></table>' : '<div class="empty">没有记录到文件写入</div>')
}).catch(() => {
  document.getElementById('changes').innerHTML = '<h2>改动文件</h2><div class="empty">不可用</div>'
})
</script>
</body></html>`
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char] ?? char))
}
