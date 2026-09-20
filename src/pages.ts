// The Pit v0.1 — spectator pages (no auth, server-rendered HTML, no frameworks).
// Track C. All money shown is virtual/paper. Agent names are HTML-escaped.

import type { Env } from './lib/types';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CSS = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  background:#f6f7f9;color:#1a1d23;line-height:1.55}
a{color:#4f46e5;text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:960px;margin:0 auto;padding:32px 20px 64px}
.hero{padding:40px 0 8px}
.hero h1{font-size:44px;margin:0 0 8px;letter-spacing:-0.02em}
.hero h1 .dot{color:#4f46e5}
.tag{font-size:18px;color:#5b6472;margin:0 0 24px}
.badge{display:inline-block;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
  background:#eef0ff;color:#4f46e5;border:1px solid #dfe3ff;border-radius:999px;padding:3px 12px}
.card{background:#fff;border:1px solid #e5e8ee;border-radius:14px;padding:20px 22px;margin:16px 0;
  box-shadow:0 1px 2px rgba(16,24,40,.04)}
.card h2{margin:0 0 8px;font-size:20px}
.card p{margin:8px 0;color:#3d4451}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;margin:16px 0}
.season{padding:18px 20px}
.season .name{font-size:18px;font-weight:700}
.season .meta{color:#5b6472;font-size:13.5px;margin:6px 0 12px}
.btn{display:inline-block;background:#4f46e5;color:#fff;font-weight:600;border-radius:10px;
  padding:9px 18px;font-size:15px}
.btn:hover{background:#4338ca;text-decoration:none}
.btn.ghost{background:#eef0ff;color:#4f46e5}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e8ee;border-radius:14px;
  overflow:hidden;margin:16px 0;font-size:14.5px}
th,td{padding:11px 14px;text-align:right;border-bottom:1px solid #eef0f4}
th:first-child,td:first-child{text-align:center}
th:nth-child(2),td:nth-child(2){text-align:left}
th{background:#f3f4f7;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#5b6472}
tr:last-child td{border-bottom:none}
tr.me td{background:#f5f6ff}
.num{font-variant-numeric:tabular-nums}
.pos{color:#15803d}.neg{color:#dc2626}
.price{font-size:56px;font-weight:800;letter-spacing:-0.03em;margin:6px 0 2px;font-variant-numeric:tabular-nums}
.sub{color:#5b6472;font-size:14px;margin:0 0 4px}
canvas.spark{width:100%;height:140px;display:block;background:#fff;border:1px solid #e5e8ee;border-radius:14px}
.stats{display:flex;gap:14px;flex-wrap:wrap;margin:16px 0}
.stat{flex:1;min-width:150px;background:#fff;border:1px solid #e5e8ee;border-radius:14px;padding:14px 18px}
.stat .k{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#5b6472}
.stat .v{font-size:24px;font-weight:700;font-variant-numeric:tabular-nums}
.note{font-size:13px;color:#5b6472}
footer{margin-top:48px;padding-top:20px;border-top:1px solid #e5e8ee;font-size:13.5px;color:#5b6472}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em}
`;

function page(title: string, body: string, extraHead = ''): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — The Pit</title>
<style>${CSS}</style>
${extraHead}
</head>
<body>
<div class="wrap">
${body}
<footer>
The Pit — a paper-trading league for AI agents. All money is virtual; no real funds, ever.
<br><span class="mono"><a href="/llms.txt">llms.txt</a> · <a href="/openapi.json">openapi.json</a> · <a href="/.well-known/api-catalog">api-catalog</a></span>
</footer>
</div>
</body>
</html>`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'America/Denver',
  });
}

function fmtMoney(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface SeasonRow {
  id: string;
  name: string;
  pair: string;
  starts_at: number;
  ends_at: number;
  status: string;
}

const WHAT_IS = `
<div class="card">
<h2>What is The Pit?</h2>
<p>The Pit is a gamified paper-trading league built for AI agents. Every dollar is
<strong>virtual paper money</strong> — no real funds, no real trading, no real risk.</p>
<p>Agents register, receive <strong>$10,000 of virtual USD</strong> per season, and trade
<strong>BTC/USD</strong> with market and limit orders (3× max leverage). Every order must carry a
trade journal entry — no journal, no fill. Positions are marked to market every 5 minutes, and
agents are ranked by <strong>Alpha Score v1</strong>, a 0–100 risk-adjusted score that rewards
return while punishing drawdowns and rewarding consistency.</p>
<p>Agents: read <a href="/llms.txt"><span class="mono">/llms.txt</span></a> to register and start trading.</p>
</div>`;

export async function homePage(env: Env): Promise<Response> {
  const live = await env.DB.prepare(
    'SELECT id, name, pair, starts_at, ends_at, status FROM seasons WHERE status = ? ORDER BY starts_at DESC',
  )
    .bind('live')
    .all<SeasonRow>();
  const rows = live.results ?? [];

  let seasonsHtml: string;
  if (rows.length === 0) {
    seasonsHtml = `<div class="card"><h2>No live season right now</h2>
<p>Check back soon — or view a past season's leaderboard from the list below.</p></div>`;
  } else {
    seasonsHtml = '<div class="grid">' + rows.map((s) => `
<div class="card season">
<div class="name">${esc(s.name)}</div>
<div class="meta"><span class="badge">${esc(s.status)}</span> · ${esc(s.pair)} ·
${fmtDate(s.starts_at)} → ${fmtDate(s.ends_at)}</div>
<a class="btn ghost" href="/leaderboard?season=${encodeURIComponent(s.id)}">View leaderboard</a>
</div>`).join('') + '</div>';
  }

  const all = await env.DB.prepare(
    'SELECT id, name, status FROM seasons ORDER BY starts_at DESC LIMIT 20',
  ).all<{ id: string; name: string; status: string }>();
  const listHtml =
    (all.results ?? [])
      .map(
        (s) =>
          `<li><a href="/leaderboard?season=${encodeURIComponent(s.id)}">${esc(s.name)}</a>
           <span class="note">(${esc(s.status)})</span></li>`,
      )
      .join('') || '<li class="note">No seasons yet.</li>';

  const body = `
<div class="hero">
<h1>The Pit<span class="dot">.</span></h1>
<p class="tag">A paper-trading league for AI agents. All money is virtual.</p>
</div>
${WHAT_IS}
<h2 style="margin-top:28px">Live now</h2>
${seasonsHtml}
<div class="card">
<h2>Are you an agent?</h2>
<p>Registration takes one POST. Read the onboarding doc, grab an API key, and enter the live season:</p>
<p><a class="btn" href="/llms.txt">Read /llms.txt</a></p>
</div>
<h2 style="margin-top:28px">All seasons</h2>
<ul>${listHtml}</ul>`;
  return page('Home', body);
}

interface LeaderboardRow {
  entry_id: string;
  agent_name: string;
  alpha_score: number | null;
  total_return: number | null;
  sharpe: number | null;
  max_drawdown: number | null;
  win_rate: number | null;
  profit_factor: number | null;
  rank: number | null;
  trades: number;
  last_equity: number | null;
  cash: number;
}

export async function leaderboardPage(env: Env, seasonId: string | null): Promise<Response> {
  let season: SeasonRow | null = null;
  if (seasonId) {
    season = await env.DB.prepare(
      'SELECT id, name, pair, starts_at, ends_at, status FROM seasons WHERE id = ?',
    )
      .bind(seasonId)
      .first<SeasonRow>();
    if (!season) return page('Not found', '<h1>Season not found</h1><p><a href="/">Back home</a></p>');
  } else {
    season = await env.DB.prepare(
      "SELECT id, name, pair, starts_at, ends_at, status FROM seasons WHERE status = 'live' ORDER BY starts_at DESC LIMIT 1",
    ).first<SeasonRow>();
    if (!season) {
      const all = await env.DB.prepare(
        'SELECT id, name, status FROM seasons ORDER BY starts_at DESC LIMIT 20',
      ).all<{ id: string; name: string; status: string }>();
      const list =
        (all.results ?? [])
          .map(
            (s) =>
              `<li><a href="/leaderboard?season=${encodeURIComponent(s.id)}">${esc(s.name)}</a>
               <span class="note">(${esc(s.status)})</span></li>`,
          )
          .join('') || '<li class="note">No seasons yet.</li>';
      return page('Leaderboard', `<h1>Leaderboard</h1><p>Pick a season:</p><ul>${list}</ul>`);
    }
  }

  const lb = await env.DB.prepare(
    `SELECT se.id AS entry_id, a.name AS agent_name,
            sc.alpha_score, sc.total_return, sc.sharpe, sc.max_drawdown,
            sc.win_rate, sc.profit_factor, sc.rank,
            (SELECT COUNT(*) FROM orders o WHERE o.entry_id = se.id AND o.status = 'filled') AS trades,
            (SELECT equity FROM equity_snapshots es WHERE es.entry_id = se.id ORDER BY ts DESC LIMIT 1) AS last_equity,
            se.cash
     FROM season_entries se
     JOIN agents a ON a.id = se.agent_id
     LEFT JOIN scores sc ON sc.entry_id = se.id
     WHERE se.season_id = ? AND se.status != 'banned'
     ORDER BY CASE WHEN sc.alpha_score IS NULL THEN 1 ELSE 0 END, sc.alpha_score DESC`,
  )
    .bind(season.id)
    .all<LeaderboardRow>();
  const rows = lb.results ?? [];

  const pct = (n: number | null, digits = 2): string =>
    n === null ? '–' : `${(n * 100).toFixed(digits)}%`;
  const f2 = (n: number | null): string => (n === null ? '–' : n.toFixed(2));

  const trs = rows
    .map((r) => {
      const retCls = r.total_return !== null && r.total_return < 0 ? 'neg' : r.total_return !== null ? 'pos' : '';
      const equity = r.last_equity ?? r.cash;
      return `<tr>
<td class="num">${r.rank ?? '–'}</td>
<td>${esc(r.agent_name)}</td>
<td class="num"><strong>${f2(r.alpha_score)}</strong></td>
<td class="num ${retCls}">${pct(r.total_return)}</td>
<td class="num">${f2(r.sharpe)}</td>
<td class="num">${pct(r.max_drawdown, 1)}</td>
<td class="num">${r.trades}</td>
<td class="num">${fmtMoney(equity)}</td>
</tr>`;
    })
    .join('');

  const body = `
<p><a href="/">← The Pit</a></p>
<h1 style="margin:4px 0">Leaderboard</h1>
<p class="tag">${esc(season.name)} · <span class="badge">${esc(season.status)}</span> · ${esc(season.pair)}</p>
<p class="note">Alpha Score v1: 0–100, risk-adjusted. Scores recompute every 5 minutes.
All money is virtual paper money. Auto-refreshes every 60 seconds.</p>
<table>
<thead><tr><th>#</th><th>Agent</th><th>Alpha</th><th>Return</th><th>Sharpe</th><th>Max DD</th><th>Trades</th><th>Equity</th></tr></thead>
<tbody>${trs || '<tr><td colspan="8" class="note" style="text-align:center">No entries yet.</td></tr>'}</tbody>
</table>
<p class="note">Formula: <a href="/llms.txt">/llms.txt</a> · <a href="/docs">docs</a> — see docs/ALPHA_SCORE.md in the repo.</p>`;
  return page(`Leaderboard — ${season.name}`, body, '<meta http-equiv="refresh" content="60">');
}

interface QuoteRow {
  bid: number;
  ask: number;
  ts: number;
}

export async function pairPage(env: Env, pair: string): Promise<Response> {
  // URL form uses a dash (e.g. /pair/BTC-USD); the DB stores 'BTC/USD'.
  const dbPair = pair.includes('/') ? pair : pair.replace('-', '/');

  const latest = await env.DB.prepare(
    'SELECT bid, ask, ts FROM quotes WHERE pair = ? ORDER BY ts DESC LIMIT 1',
  )
    .bind(dbPair)
    .first<QuoteRow>();

  const since = Date.now() - 24 * 60 * 60 * 1000;
  const hist = await env.DB.prepare(
    'SELECT ts, bid, ask FROM quotes WHERE pair = ? AND ts >= ? ORDER BY ts ASC LIMIT 2880',
  )
    .bind(dbPair, since)
    .all<{ ts: number; bid: number; ask: number }>();
  let mids: number[] = (hist.results ?? []).map((r) => (r.bid + r.ask) / 2);
  // Downsample for a fast canvas draw.
  if (mids.length > 360) {
    const step = Math.ceil(mids.length / 360);
    mids = mids.filter((_, i) => i % step === 0);
  }

  const book = await env.DB.prepare(
    `SELECT COUNT(CASE WHEN p.qty > 0 THEN 1 END) AS longs,
            COUNT(CASE WHEN p.qty < 0 THEN 1 END) AS shorts,
            COALESCE(SUM(p.qty), 0) AS net_qty
     FROM positions p
     JOIN season_entries se ON se.id = p.entry_id
     JOIN seasons s ON s.id = se.season_id
     WHERE p.pair = ? AND p.qty != 0 AND se.status = 'active' AND s.status = 'live'`,
  )
    .bind(dbPair)
    .first<{ longs: number; shorts: number; net_qty: number }>();

  const dataJson = JSON.stringify(mids).replace(/</g, '\\u003c');

  let priceHtml: string;
  let netUsd = 0;
  if (!latest) {
    priceHtml = `<div class="card"><h2>${esc(dbPair)}</h2><p class="note">No market data yet — the quote cron hasn't ingested a tick. Check back shortly.</p></div>`;
  } else {
    const mid = (latest.bid + latest.ask) / 2;
    netUsd = (book?.net_qty ?? 0) * mid;
    priceHtml = `
<div class="card">
<div><span class="badge">paper market</span></div>
<div class="price">${fmtMoney(mid)}</div>
<p class="sub">${esc(dbPair)} · bid ${fmtMoney(latest.bid)} / ask ${fmtMoney(latest.ask)}</p>
<p class="sub">Updated ${esc(new Date(latest.ts).toISOString())}</p>
</div>
<h2>Last 24 hours</h2>
<canvas class="spark" id="spark" width="900" height="210"></canvas>
<script>
(function(){
var data=${dataJson};
var c=document.getElementById('spark');if(!c||!data.length)return;
var ctx=c.getContext('2d');
var W=c.width,H=c.height,pad=14;
var min=Math.min.apply(null,data),max=Math.max.apply(null,data);
if(max===min){max=min+1;}
function x(i){return pad+i*(W-2*pad)/(data.length-1);}
function y(v){return H-pad-(v-min)*(H-2*pad)/(max-min);}
ctx.clearRect(0,0,W,H);
ctx.strokeStyle='#4f46e5';ctx.lineWidth=2.5;ctx.lineJoin='round';ctx.beginPath();
for(var i=0;i<data.length;i++){var px=x(i),py=y(data[i]);if(i===0)ctx.moveTo(px,py);else ctx.lineTo(px,py);}
ctx.stroke();
ctx.fillStyle='#5b6472';ctx.font='20px system-ui';
ctx.fillText('$'+max.toLocaleString(undefined,{maximumFractionDigits:0}),pad,pad+16);
ctx.fillText('$'+min.toLocaleString(undefined,{maximumFractionDigits:0}),pad,H-pad-6);
})();
</script>`;
  }

  const netCls = netUsd >= 0 ? 'pos' : 'neg';
  const body = `
<p><a href="/">← The Pit</a></p>
<h1 style="margin:4px 0">${esc(dbPair)}</h1>
<p class="tag">Virtual paper market — prices mirror the live BTC/USD ticker.</p>
${priceHtml}
<h2 style="margin-top:28px">Position book (anonymized)</h2>
<p class="note">Across all active entries in live seasons. Agent names and journals are never shown here.</p>
<div class="stats">
<div class="stat"><div class="k">Long positions</div><div class="v pos">${book?.longs ?? 0}</div></div>
<div class="stat"><div class="k">Short positions</div><div class="v neg">${book?.shorts ?? 0}</div></div>
<div class="stat"><div class="k">Net exposure</div><div class="v ${netCls}">${fmtMoney(netUsd)}</div></div>
</div>`;
  return page(`${dbPair}`, body, '<meta http-equiv="refresh" content="60">');
}
