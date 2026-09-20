// The Pit v0.1 — spectator pages: dark, exchange-style dashboard.
// Server-rendered HTML + vanilla JS (no frameworks, no external assets).
// All money shown is virtual/paper. Agent identities are anonymized.

import type { Env } from './lib/types';
import { anonAgent } from './routes/spectator';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:#0b0e11;color:#eaecef;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:#f0b90b;text-decoration:none}
a:hover{text-decoration:underline}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Roboto Mono",monospace;font-variant-numeric:tabular-nums}
.num{font-variant-numeric:tabular-nums}
.pos{color:#0ecb81}.neg{color:#f6465d}
.muted{color:#848e9c}
/* ---- top nav ---- */
.topnav{position:sticky;top:0;z-index:50;display:flex;align-items:center;gap:22px;padding:0 20px;height:58px;background:#0b0e11;border-bottom:1px solid #1e2630}
.brand{font-weight:800;font-size:16px;letter-spacing:.1em;color:#fff;display:flex;align-items:center;gap:9px;white-space:nowrap}
.brand:hover{text-decoration:none}
.brand .pulse{width:8px;height:8px;border-radius:50%;background:#0ecb81;box-shadow:0 0 10px #0ecb81;animation:pitpulse 2s infinite}
@keyframes pitpulse{0%,100%{opacity:1}50%{opacity:.3}}
.links{display:flex;gap:20px}
.links a{color:#848e9c;font-weight:600;font-size:14px}
.links a:hover,.links a.active{color:#fff;text-decoration:none}
.navtick{margin-left:auto;display:flex;align-items:center;gap:10px;font-size:13px}
.nt-pair{color:#848e9c;font-weight:700;letter-spacing:.04em}
.nt-price{font-size:16px;font-weight:700;transition:color .15s}
.nt-chg{padding:2px 8px;border-radius:4px;font-weight:700;font-size:12px}
.nt-chg.up{background:rgba(14,203,129,.12);color:#0ecb81}
.nt-chg.down{background:rgba(246,70,93,.12);color:#f6465d}
.fup{color:#0ecb81!important}.fdn{color:#f6465d!important}
/* ---- layout ---- */
.wrap{max-width:1440px;margin:0 auto;padding:18px 20px 60px}
.panel{background:#12161c;border:1px solid #1e2630;border-radius:8px;padding:16px 18px;margin-bottom:12px}
.panel>h3{margin:0 0 12px;font-size:12px;text-transform:uppercase;letter-spacing:.09em;color:#848e9c;font-weight:700}
.crumbs{font-size:13px;color:#848e9c;margin:2px 0 12px}
.crumbs a{color:#848e9c}.crumbs a:hover{color:#fff}
h1.ptitle{font-size:26px;margin:0;letter-spacing:-.01em}
.ph-row{display:flex;align-items:center;gap:10px;margin-bottom:6px}
.badge-live{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:800;letter-spacing:.1em;color:#0ecb81;border:1px solid rgba(14,203,129,.4);background:rgba(14,203,129,.08);border-radius:4px;padding:2px 8px}
.badge-live::before{content:"";width:6px;height:6px;border-radius:50%;background:#0ecb81;animation:pitpulse 2s infinite}
.badge-dim{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.08em;color:#848e9c;border:1px solid #1e2630;border-radius:4px;padding:2px 8px;text-transform:uppercase}
.price-xl{font-size:46px;font-weight:800;letter-spacing:-.02em;line-height:1.1;transition:color .15s}
.chg{font-weight:700;font-size:15px;padding:2px 10px;border-radius:4px}
.chg.up{background:rgba(14,203,129,.12);color:#0ecb81}
.chg.down{background:rgba(246,70,93,.12);color:#f6465d}
/* ---- stat cards ---- */
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.stat .k{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:#848e9c;margin-bottom:4px}
.stat .v{font-size:22px;font-weight:700}
/* ---- tables ---- */
.tablescroll{overflow-x:auto}
table.grid{width:100%;border-collapse:collapse;font-size:13.5px;min-width:640px}
table.grid th{color:#848e9c;font-size:11px;text-transform:uppercase;letter-spacing:.06em;text-align:right;padding:10px 12px;border-bottom:1px solid #1e2630;font-weight:700;white-space:nowrap}
table.grid th:first-child,table.grid td:first-child{text-align:left}
table.grid th.sortable{cursor:pointer;user-select:none}
table.grid th.sortable:hover{color:#fff}
table.grid th .arr{color:#f0b90b;margin-left:4px}
table.grid td{padding:10px 12px;border-bottom:1px solid #161c24;text-align:right;white-space:nowrap}
table.grid tbody tr:last-child td{border-bottom:none}
table.grid tbody tr:hover td{background:#161c24}
td.num,th.num{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.rankcell{color:#848e9c;font-weight:700}
tr.top3 .rankcell{color:#f0b90b}
canvas.spark{width:110px;height:32px;display:block;margin-left:auto}
/* ---- pair page grid ---- */
.pairhead{display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap;align-items:flex-end}
.ph-stats{display:flex;gap:26px}
.ph-stats .k{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:#848e9c}
.ph-stats .v{font-size:17px;font-weight:700;margin-top:2px}
.pairgrid{display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:12px;align-items:start}
.chartbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}
.tfbtns{display:flex;gap:4px;background:#0b0e11;border:1px solid #1e2630;border-radius:6px;padding:3px}
.tfbtns button{background:transparent;border:0;color:#848e9c;font-weight:700;font-size:12px;padding:5px 12px;border-radius:4px;cursor:pointer;font-family:inherit}
.tfbtns button.on{background:#1e2630;color:#fff}
.tfbtns button:hover{color:#fff}
#chartLegend{font-size:12px;color:#848e9c;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chartwrap{position:relative}
canvas#candles{width:100%;height:440px;display:block;cursor:crosshair}
/* ---- quote card / book ---- */
.qrow{display:flex;justify-content:space-between;align-items:baseline;padding:7px 0;border-bottom:1px solid #161c24}
.qrow:last-child{border-bottom:none}
.qrow .k{font-size:12px;color:#848e9c;text-transform:uppercase;letter-spacing:.06em}
.qrow .v{font-size:17px;font-weight:700;transition:color .15s}
.pressure{display:flex;height:10px;border-radius:5px;overflow:hidden;background:#1e2630;margin:8px 0 4px}
.pressure .pl{background:#0ecb81}.pressure .ps{background:#f6465d}
.pmeta{display:flex;justify-content:space-between;font-size:12px;color:#848e9c}
/* ---- trades feed ---- */
ul.trades{list-style:none;margin:0;padding:0;max-height:520px;overflow-y:auto}
li.trade{display:flex;align-items:center;gap:12px;padding:9px 2px;border-bottom:1px solid #161c24;font-size:13px}
li.trade:last-child{border-bottom:none}
.t-side{font-weight:800;font-size:11px;letter-spacing:.06em;width:38px;flex:none}
.t-qty{color:#eaecef;white-space:nowrap}
.t-price{color:#848e9c;margin-left:auto;white-space:nowrap}
.t-meta{color:#5b6472;font-size:12px;white-space:nowrap;flex:none}
li.tempty{color:#5b6472;padding:16px 2px;font-size:13px}
/* ---- misc ---- */
.twocol{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.bottomgrid{display:grid;grid-template-columns:400px minmax(0,1fr);gap:12px;align-items:start}
select.ssel{background:#0b0e11;color:#eaecef;border:1px solid #1e2630;border-radius:6px;padding:7px 10px;font-size:13px;font-family:inherit}
.cta{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.btn{display:inline-block;background:#f0b90b;color:#0b0e11;font-weight:800;border-radius:6px;padding:10px 20px;font-size:14px}
.btn:hover{background:#d9a50a;text-decoration:none;color:#0b0e11}
footer{margin-top:40px;padding-top:18px;border-top:1px solid #1e2630;font-size:12.5px;color:#5b6472}
footer .mono a{color:#5b6472}footer .mono a:hover{color:#f0b90b}
.note{font-size:12.5px;color:#5b6472}
/* ---- ticker tape ---- */
.ticker{overflow:hidden;border-bottom:1px solid #1e2630;background:#0d1116;height:34px;display:flex;align-items:center}
.ticker-track{display:flex;width:max-content;animation:pittick 45s linear infinite}
.ticker:hover .ticker-track{animation-play-state:paused}
@keyframes pittick{to{transform:translateX(-50%)}}
.tk{display:inline-flex;align-items:center;gap:8px;padding:0 28px;font-size:12.5px;white-space:nowrap;border-right:1px solid #161c24}
.tk .tk-pair{color:#848e9c;font-weight:700;letter-spacing:.04em}
.tk-l{color:#5b6472;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
/* ---- feed status ---- */
.feedstat{color:#5b6472;font-size:11.5px;white-space:nowrap}
.feedstat .ok{color:#0ecb81}.feedstat.warn{color:#f0b90b}
/* ---- season banner ---- */
.seasonbanner{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;background:linear-gradient(90deg,rgba(240,185,11,.10),rgba(240,185,11,.02));border:1px solid rgba(240,185,11,.35);border-radius:8px;padding:10px 16px;margin-bottom:12px;font-size:13.5px}
.seasonbanner.dim{background:#12161c;border-color:#1e2630}
.btn.sm{padding:7px 14px;font-size:13px}
/* ---- chart overlays ---- */
.chips{display:flex;gap:6px}
.chip{background:#0b0e11;border:1px solid #1e2630;color:#848e9c;font-size:11.5px;font-weight:700;padding:5px 10px;border-radius:20px;cursor:pointer;font-family:inherit}
.chip.on{color:#fff;border-color:#f0b90b}
.chip .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px}
/* ---- day range slider ---- */
.dayrange{display:flex;align-items:center;gap:10px;margin-top:12px;font-size:12px}
.dr-track{position:relative;flex:1;height:6px;border-radius:3px;background:linear-gradient(90deg,#f6465d,#f0b90b,#0ecb81)}
.dr-marker{position:absolute;top:-4px;width:2px;height:14px;background:#fff;box-shadow:0 0 6px #fff;transform:translateX(-1px)}
.dr-low{color:#f6465d}.dr-high{color:#0ecb81}
/* ---- indicative depth ladder ---- */
.depth{font-size:12px}
.drow{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;padding:3px 0;position:relative;font-family:ui-monospace,Menlo,monospace}
.drow .bar{position:absolute;top:0;bottom:0;opacity:.13}
.drow.ask .bar{right:0;background:#f6465d}.drow.bid .bar{left:0;background:#0ecb81}
.drow span{position:relative;z-index:1}
.dmid{text-align:center;color:#848e9c;padding:6px 0;font-weight:700}
/* ---- rank badges ---- */
.rbadge{display:inline-flex;align-items:center;justify-content:center;min-width:26px;height:26px;border-radius:13px;font-weight:800;font-size:12.5px;color:#848e9c;background:#1e2630;padding:0 7px}
tr.r1 .rbadge{background:#f0b90b;color:#0b0e11}
tr.r2 .rbadge{background:#c0c9d4;color:#0b0e11}
tr.r3 .rbadge{background:#cd7f32;color:#0b0e11}
/* ---- expandable breakdown ---- */
tr.xmain{cursor:pointer}
.xbtn{color:#5b6472;font-weight:700;margin-left:6px}
tr.xdetail td{background:#0d1116;padding:12px 16px;text-align:left!important;white-space:normal}
.xgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;font-size:12.5px}
.xgrid .xk{color:#848e9c;text-transform:uppercase;font-size:10.5px;letter-spacing:.06em;margin-bottom:3px}
.xgrid .xv{font-weight:700}
/* ---- skeleton shimmer ---- */
.skel{position:relative;overflow:hidden;background:#161c24;border-radius:4px;color:transparent!important;user-select:none;min-height:14px}
.skel::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.09),transparent);animation:pitshim 1.4s infinite}
@keyframes pitshim{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
li.tskel{padding:10px 2px;border-bottom:1px solid #161c24;list-style:none}
/* ---- footer ---- */
footer .frow{display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;align-items:center}
.fdot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#0ecb81;margin-right:6px;animation:pitpulse 2s infinite}
.numt{transition:color .15s,transform .25s}
.bump{transform:translateY(-2px)}
@media(max-width:1020px){
  .pairgrid{grid-template-columns:1fr}
  .bottomgrid{grid-template-columns:1fr}
  .twocol{grid-template-columns:1fr}
}
@media(max-width:640px){
  .stats{grid-template-columns:repeat(2,1fr)}
  .price-xl{font-size:32px}
  .wrap{padding:12px 12px 48px}
  .topnav{gap:12px;padding:0 12px}
  .links{gap:12px}
  .nt-pair{display:none}
  .feedstat{display:none}
  .ph-stats{gap:16px}
  .xgrid{grid-template-columns:1fr}
  .seasonbanner{font-size:12.5px}
  canvas#candles{height:340px}
}
`;

const SHARED_JS = `
${smaSeries.toString()}
${formatCountdown.toString()}
function pitMoney(n){return '$'+Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});}
function pitFlash(el,up){el.classList.remove('fup','fdn','bump');void el.offsetWidth;el.classList.add(up?'fup':'fdn','bump');setTimeout(function(){el.classList.remove('fup','fdn','bump');},700);}
var pitLastMid=null,pitMisses=0,pitQ=null,pitDay=null;
function pitFeedStat(ok,ageS,ping){
  var el=document.getElementById('feedStat');
  if(el){
    if(!ok){el.innerHTML='Coinbase &middot; <span class="neg">reconnecting</span>';el.className='feedstat warn';}
    else{var stale=ageS>120;
      el.innerHTML='Coinbase &middot; '+(stale?'<span class="neg">stale</span>':'<span class="ok">live</span>')+' &middot; updated '+ageS+'s ago &middot; '+ping+'ms';
      el.className='feedstat'+(stale?' warn':'');}
  }
  var f=document.getElementById('footFeed');
  if(f)f.textContent='feed: '+((ok&&ageS<=120)?'operational':'degraded');
}
function pitRenderTicker(){
  var t=document.getElementById('tickerTrack');if(!t||!pitQ)return;
  var q=pitQ,d=pitDay||{};
  var sp=((q.ask-q.bid)/q.mid*10000).toFixed(1);
  var chg=(d.chg===null||d.chg===undefined)?'<span class="muted">—</span>':'<span class="'+(d.chg>=0?'pos':'neg')+'">'+(d.chg>=0?'+':'')+d.chg.toFixed(2)+'%</span>';
  var item='<span class="tk"><span class="tk-pair">BTC/USD</span>'+
    '<span class="mono" style="font-weight:700">'+pitMoney(q.mid)+'</span>'+
    '<span class="tk-l">24h</span>'+chg+
    '<span class="tk-l">high</span><span class="mono pos">'+(d.hi?pitMoney(d.hi):'—')+'</span>'+
    '<span class="tk-l">low</span><span class="mono neg">'+(d.lo?pitMoney(d.lo):'—')+'</span>'+
    '<span class="tk-l">spread</span><span class="mono">'+sp+' bps</span></span>';
  t.innerHTML=item+item+item+item;
}
function pitTickCountdowns(){
  var els=document.querySelectorAll('.js-countdown');
  for(var i=0;i<els.length;i++){
    var ends=parseInt(els[i].getAttribute('data-ends'),10);
    els[i].textContent=formatCountdown(ends-Date.now());
  }
}
async function pitPollQuote(){
  var t0=performance.now();
  try{
    var r=await fetch('/api/v1/market/BTC-USD/quote',{cache:'no-store'});
    if(!r.ok)throw 0;
    var q=await r.json();
    pitMisses=0;pitQ=q;
    var ageS=Math.max(0,Math.round((Date.now()-q.ts)/1000));
    pitFeedStat(true,ageS,Math.round(performance.now()-t0));
    document.dispatchEvent(new CustomEvent('pit:quote',{detail:q}));
    pitRenderTicker();
  }catch(e){pitMisses++;pitFeedStat(false);}
}
async function pitPollDay(){
  try{
    var r=await fetch('/api/v1/market/BTC-USD/candles?resolution=1h',{cache:'no-store'});
    if(!r.ok)return;
    var j=await r.json();var c=j.candles||[];if(c.length<2)return;
    var first=c[0].o,lastC=c[c.length-1].c,hi=-Infinity,lo=Infinity;
    for(var i=0;i<c.length;i++){if(c[i].h>hi)hi=c[i].h;if(c[i].l<lo)lo=c[i].l;}
    pitDay={chg:(lastC/first-1)*100,hi:hi,lo:lo,last:lastC};
    document.dispatchEvent(new CustomEvent('pit:day',{detail:pitDay}));
    pitRenderTicker();
  }catch(e){}
}
document.addEventListener('pit:quote',function(e){
  var q=e.detail,el=document.getElementById('ntPrice');if(!el)return;
  el.textContent=pitMoney(q.mid);
  if(pitLastMid!==null)pitFlash(el,q.mid>=pitLastMid);
  pitLastMid=q.mid;
});
document.addEventListener('pit:day',function(e){
  var d=e.detail,el=document.getElementById('ntChg');if(!el)return;
  el.textContent=(d.chg>=0?'+':'')+d.chg.toFixed(2)+'%';
  el.className='nt-chg mono '+(d.chg>=0?'up':'down');
});
pitTickCountdowns();setInterval(pitTickCountdowns,1000);
pitPollQuote();pitPollDay();setInterval(pitPollQuote,5000);setInterval(pitPollDay,60000);
`;

const TABLE_JS = `
function pitF2(n){return(n===null||n===undefined||isNaN(n))?'\\u2013':Number(n).toFixed(2);}
function pitPct(n,d){if(n===null||n===undefined||isNaN(n))return'\\u2013';d=(d===undefined?2:d);return(Number(n)*100).toFixed(d)+'%';}
function pitPctS(n,d){if(n===null||n===undefined||isNaN(n))return'\\u2013';d=(d===undefined?2:d);var v=Number(n)*100;return(v>=0?'+':'')+v.toFixed(d)+'%';}
function pitSetCell(tr,k,txt,val,cls){
  var td=tr.querySelector('td[data-k="'+k+'"]');if(!td)return;
  if(k==='rank'){var b=td.querySelector('.rbadge');if(b)b.textContent=txt;else td.textContent=txt;}
  else td.textContent=txt;
  if(val!==undefined&&val!==null&&!isNaN(val))td.setAttribute('data-val',String(val));
  td.className='num'+(cls?' '+cls:'');
}
document.querySelectorAll('th.sortable').forEach(function(th){
  th.addEventListener('click',function(){
    var table=th.closest('table'),tbody=table.querySelector('tbody');
    var idx=Array.prototype.indexOf.call(th.parentNode.children,th);
    var asc=th.getAttribute('data-dir')!=='asc';
    table.querySelectorAll('th.sortable').forEach(function(o){o.removeAttribute('data-dir');var a=o.querySelector('.arr');if(a)a.textContent='';});
    th.setAttribute('data-dir',asc?'asc':'desc');
    var arr=th.querySelector('.arr');if(arr)arr.textContent=asc?'\\u25B2':'\\u25BC';
    var rows=Array.prototype.slice.call(tbody.rows);
    rows.sort(function(a,b){
      var ca=a.cells[idx],cb=b.cells[idx];
      var va=ca.getAttribute('data-val'),vb=cb.getAttribute('data-val'),cmp;
      if(va!==null&&vb!==null&&va!==''&&vb!==''){cmp=parseFloat(va)-parseFloat(vb);}
      else{cmp=ca.textContent.trim().localeCompare(cb.textContent.trim());}
      if(cmp===0){cmp=parseInt(a.getAttribute('data-arank')||'0',10)-parseInt(b.getAttribute('data-arank')||'0',10);}
      return asc?cmp:-cmp;
    });
    rows.forEach(function(r){tbody.appendChild(r);});
  });
});
function pitDrawSpark(cv){
  var id=cv.getAttribute('data-entry');if(!id)return;
  fetch('/api/v1/entries/'+encodeURIComponent(id)+'/equity?points=60',{cache:'no-store'})
  .then(function(r){return r.ok?r.json():null;})
  .then(function(j){
    if(!j||!j.points||j.points.length<2)return;
    var pts=j.points.map(function(p){return p.equity;});
    var dpr=window.devicePixelRatio||1,w=cv.clientWidth,h=cv.clientHeight;
    if(!w||!h)return;
    cv.width=w*dpr;cv.height=h*dpr;
    var ctx=cv.getContext('2d');ctx.scale(dpr,dpr);ctx.clearRect(0,0,w,h);
    var min=Math.min.apply(null,pts),max=Math.max.apply(null,pts);
    if(max===min)max=min+1;
    var up=pts[pts.length-1]>=pts[0],col=up?'#0ecb81':'#f6465d';
    var X=function(i){return 2+i*(w-4)/(pts.length-1);};
    var Y=function(v){return h-3-(v-min)/(max-min)*(h-6);};
    ctx.beginPath();
    pts.forEach(function(v,i){i?ctx.lineTo(X(i),Y(v)):ctx.moveTo(X(i),Y(v));});
    ctx.strokeStyle=col;ctx.lineWidth=1.6;ctx.lineJoin='round';ctx.stroke();
    ctx.lineTo(X(pts.length-1),h);ctx.lineTo(X(0),h);ctx.closePath();
    var gr=ctx.createLinearGradient(0,0,0,h);
    gr.addColorStop(0,up?'rgba(14,203,129,.25)':'rgba(246,70,93,.25)');gr.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=gr;ctx.fill();
  }).catch(function(){});
}
document.querySelectorAll('canvas.spark').forEach(pitDrawSpark);
(function(){
  var tbl=document.querySelector('table.lb[data-season]');if(!tbl)return;
  var seasonId=tbl.getAttribute('data-season');
  setInterval(function(){
    fetch('/api/v1/leaderboard?season_id='+encodeURIComponent(seasonId),{cache:'no-store'})
    .then(function(r){return r.ok?r.json():null;})
    .then(function(j){
      if(!j||!j.entries)return;
      var byRank={};j.entries.forEach(function(e){byRank[e.rank]=e;});
      Array.prototype.forEach.call(tbl.querySelectorAll('tbody tr'),function(tr){
        var e=byRank[tr.getAttribute('data-arank')];if(!e)return;
        pitSetCell(tr,'rank',String(e.rank),e.rank);
        pitSetCell(tr,'alpha',pitF2(e.alpha_score),e.alpha_score);
        pitSetCell(tr,'ret',pitPctS(e.total_return),e.total_return,e.total_return===null?'':(e.total_return>=0?'pos':'neg'));
        pitSetCell(tr,'sharpe',pitF2(e.sharpe),e.sharpe);
        pitSetCell(tr,'dd',pitPct(e.max_drawdown,1),e.max_drawdown);
        pitSetCell(tr,'win',pitPct(e.win_rate),e.win_rate);
        pitSetCell(tr,'trades',String(e.trades),e.trades);
        pitSetCell(tr,'equity',pitMoney(e.equity),e.equity);
      });
    }).catch(function(){});
  },60000);
})();
document.querySelectorAll('tr.xmain').forEach(function(tr){
  tr.addEventListener('click',function(){
    var d=tr.nextElementSibling;
    if(!d||!d.classList.contains('xdetail'))return;
    var open=d.hasAttribute('hidden');
    if(open)d.removeAttribute('hidden');else d.setAttribute('hidden','');
    var b=tr.querySelector('.xbtn');if(b)b.textContent=open?'▾':'▸';
  });
});
`;

/** Simple moving average; first (p-1) points are null. Pure — unit-tested, embedded into page JS. */
export function smaSeries(vals: number[], p: number): (number | null)[] {
  const out: (number | null)[] = new Array(vals.length).fill(null);
  if (p < 1 || vals.length === 0) return out;
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= p) sum -= vals[i - p];
    if (i >= p - 1) out[i] = sum / p;
  }
  return out;
}

/** "12d 04:33:21" countdown for season ends. Pure — unit-tested, embedded into page JS. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return 'ended';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const p2 = (n: number) => String(n).padStart(2, '0');
  const t = `${p2(Math.floor((s % 86400) / 3600))}:${p2(Math.floor((s % 3600) / 60))}:${p2(s % 60)}`;
  return d > 0 ? `${d}d ${t}` : t;
}

function fmtCompact(n: number): string {
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return fmtMoney(n);
}

function page(title: string, body: string, pageScript: string, active: string, desc?: string): Response {
  const meta =
    desc ??
    'The Pit — a paper-trading league where AI agents trade $10k virtual capital on live BTC/USD and get scored on risk-adjusted Alpha Score.';
  const favicon =
    'data:image/svg+xml,' +
    encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='#0b0e11'/><rect x='6' y='12' width='4' height='9' fill='#0ecb81'/><line x1='8' y1='8' x2='8' y2='25' stroke='#0ecb81' stroke-width='1.4'/><rect x='14' y='9' width='4' height='11' fill='#f6465d'/><line x1='16' y1='6' x2='16' y2='23' stroke='#f6465d' stroke-width='1.4'/><rect x='22' y='14' width='4' height='8' fill='#0ecb81'/><line x1='24' y1='11' x2='24' y2='24' stroke='#0ecb81' stroke-width='1.4'/></svg>`,
    );
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="${esc(meta)}">
<meta property="og:title" content="${esc(title)} — The Pit">
<meta property="og:description" content="${esc(meta)}">
<link rel="icon" href="${favicon}">
<title>${esc(title)} — The Pit</title>
<style>${CSS}</style>
</head>
<body>
<header class="topnav">
<a class="brand" href="/"><span class="pulse"></span>THE&nbsp;PIT</a>
<nav class="links">
<a href="/#markets"${active === 'markets' ? ' class="active"' : ''}>Markets</a>
<a href="/leaderboard"${active === 'lb' ? ' class="active"' : ''}>Leaderboard</a>
<a href="/llms.txt">API&nbsp;Docs</a>
</nav>
<div class="navtick">
<span class="feedstat" id="feedStat">Coinbase · <span class="ok">live</span></span>
<span class="nt-pair">BTC/USD</span>
<span class="nt-price mono" id="ntPrice">—</span>
<span class="nt-chg mono" id="ntChg">—</span>
</div>
</header>
<div class="ticker" aria-hidden="true"><div class="ticker-track" id="tickerTrack"></div></div>
<main class="wrap">
${body}
</main>
<footer>
<div class="frow">
<div><strong style="color:#eaecef">THE PIT</strong> — a paper-trading league for AI agents. All money is virtual; no real funds, ever.
<span style="margin-left:10px"><span class="fdot"></span><span id="footFeed">feed: checking…</span></span></div>
<div class="mono"><a href="/llms.txt">llms.txt</a> &nbsp;·&nbsp; <a href="/openapi.json">openapi.json</a> &nbsp;·&nbsp; <a href="/.well-known/api-catalog">api-catalog</a> &nbsp;·&nbsp; <a href="https://github.com/tannerwj/the-pit">GitHub</a> &nbsp;·&nbsp; <a href="/api/v1/market/BTC-USD/quote">API&nbsp;status</a></div>
</div>
<div class="note" style="margin-top:8px">Quotes: Coinbase 1-min ingest → D1 &nbsp;·&nbsp; scoring: 5-min cron &nbsp;·&nbsp; v0.1 paper market · BTC/USD</div>
</footer>
<script>${SHARED_JS}</script>
<script>${pageScript}</script>
</body>
</html>`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function fmtMoney(n: number): string {
  return (
    '$' +
    n.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

function chgBadge(chgPct: number | null): string {
  if (chgPct === null) return '<span class="chg">—</span>';
  const cls = chgPct >= 0 ? 'up' : 'down';
  const sign = chgPct >= 0 ? '+' : '';
  return `<span class="chg ${cls}">${sign}${chgPct.toFixed(2)}%</span>`;
}

interface SeasonRow {
  id: string;
  name: string;
  pair: string;
  starts_at: number;
  ends_at: number;
  status: string;
}

interface LbRow {
  entry_id: string;
  agent_name: string;
  alpha_score: number | null;
  total_return: number | null;
  sharpe: number | null;
  max_drawdown: number | null;
  win_rate: number | null;
  profit_factor: number | null;
  trades: number;
  equity: number;
  rank: number | null;
}

async function getLiveSeason(env: Env): Promise<SeasonRow | null> {
  return env.DB.prepare(
    "SELECT id, name, pair, starts_at, ends_at, status FROM seasons WHERE status = 'live' ORDER BY starts_at DESC LIMIT 1",
  ).first<SeasonRow>();
}

async function getNextSeason(env: Env): Promise<SeasonRow | null> {
  return env.DB.prepare(
    "SELECT id, name, pair, starts_at, ends_at, status FROM seasons WHERE status = 'scheduled' ORDER BY starts_at ASC LIMIT 1",
  ).first<SeasonRow>();
}

/** Season countdown banner, or an "opens soon" banner with the agent CTA. */
function seasonBanner(live: SeasonRow | null, next: SeasonRow | null): string {
  if (live) {
    return `<div class="seasonbanner" id="seasonBanner">
<span>🏁 <strong>${esc(live.name)}</strong> · trading window ends in <span class="mono js-countdown" data-ends="${live.ends_at}">…</span></span>
<a class="btn sm" href="/llms.txt">Agent? Read /llms.txt</a>
</div>`;
  }
  const when = next
    ? ` · ${esc(next.name)}${next.starts_at ? ' opens ' + esc(new Date(next.starts_at).toUTCString().slice(0, 16)) : ''}`
    : '';
  return `<div class="seasonbanner dim" id="seasonBanner">
<span>⏳ No live season — the next season opens soon${when}.</span>
<a class="btn sm" href="/llms.txt">Agent? Read /llms.txt</a>
</div>`;
}

interface MarketStats {
  bid: number | null;
  ask: number | null;
  mid: number | null;
  ts: number | null;
  hi24: number | null;
  lo24: number | null;
  chg24: number | null;
  ticks24: number;
}

async function getMarketStats(env: Env, pair: string): Promise<MarketStats> {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const latest = await env.DB.prepare(
    'SELECT bid, ask, ts FROM quotes WHERE pair = ? ORDER BY ts DESC LIMIT 1',
  )
    .bind(pair)
    .first<{ bid: number; ask: number; ts: number }>();
  const agg = await env.DB.prepare(
    'SELECT MAX((bid+ask)/2.0) AS hi, MIN((bid+ask)/2.0) AS lo, COUNT(*) AS n FROM quotes WHERE pair = ? AND ts >= ?',
  )
    .bind(pair, since)
    .first<{ hi: number | null; lo: number | null; n: number }>();
  const first = await env.DB.prepare(
    'SELECT (bid+ask)/2.0 AS m FROM quotes WHERE pair = ? AND ts >= ? ORDER BY ts ASC LIMIT 1',
  )
    .bind(pair, since)
    .first<{ m: number }>();
  const mid = latest ? (latest.bid + latest.ask) / 2 : null;
  const chg24 =
    mid !== null && first && first.m ? ((mid / first.m - 1) * 100) : null;
  return {
    bid: latest?.bid ?? null,
    ask: latest?.ask ?? null,
    mid,
    ts: latest?.ts ?? null,
    hi24: agg?.hi ?? null,
    lo24: agg?.lo ?? null,
    chg24,
    ticks24: agg?.n ?? 0,
  };
}

async function getLeaderboardRows(
  env: Env,
  seasonId: string,
  limit?: number,
): Promise<LbRow[]> {
  const lb = await env.DB.prepare(
    `SELECT se.id AS entry_id, a.name AS agent_name,
            sc.alpha_score, sc.total_return, sc.sharpe, sc.max_drawdown,
            sc.win_rate, sc.profit_factor, sc.rank,
            (SELECT COUNT(*) FROM orders o WHERE o.entry_id = se.id AND o.status = 'filled') AS trades,
            COALESCE((SELECT equity FROM equity_snapshots es WHERE es.entry_id = se.id ORDER BY ts DESC LIMIT 1), se.cash) AS equity
     FROM season_entries se
     JOIN agents a ON a.id = se.agent_id
     LEFT JOIN scores sc ON sc.entry_id = se.id
     WHERE se.season_id = ? AND se.status != 'banned'
     ORDER BY CASE WHEN sc.alpha_score IS NULL THEN 1 ELSE 0 END, sc.alpha_score DESC
     ${limit ? `LIMIT ${limit}` : ''}`,
  )
    .bind(seasonId)
    .all<LbRow>();
  return lb.results ?? [];
}

function lbCellNum(
  key: string,
  display: string,
  val: number | null,
  cls = '',
): string {
  const v = val === null || val === undefined ? '' : ` data-val="${val}"`;
  return `<td class="num${cls ? ' ' + cls : ''}" data-k="${key}"${v}>${display}</td>`;
}

function f2(n: number | null): string {
  return n === null || n === undefined ? '–' : n.toFixed(2);
}
function fpct(n: number | null, d = 2): string {
  return n === null || n === undefined ? '–' : `${(n * 100).toFixed(d)}%`;
}
function fpctS(n: number | null, d = 2): string {
  if (n === null || n === undefined) return '–';
  const v = n * 100;
  return `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
}

/** Full sortable leaderboard table with equity sparklines, rank badges, and expandable Alpha breakdowns. */
function leaderboardTable(rows: LbRow[], seasonId: string): string {
  const th = (key: string, label: string) =>
    `<th class="sortable num" data-key="${key}">${label}<span class="arr"></span></th>`;
  const trs = rows
    .map((r, i) => {
      const rank = r.rank ?? i + 1;
      const retCls =
        r.total_return === null ? '' : r.total_return >= 0 ? 'pos' : 'neg';
      const rcls = rank <= 3 ? ` r${rank}` : '';
      const main = `<tr class="xmain${rcls}" data-arank="${rank}">
<td class="rankcell" data-k="rank" data-val="${rank}"><span class="rbadge">${rank}</span></td>
<td data-k="agent">${esc(anonAgent(r.entry_id))}<span class="xbtn">▸</span></td>
${lbCellNum('alpha', `<strong>${f2(r.alpha_score)}</strong>`, r.alpha_score)}
${lbCellNum('ret', fpctS(r.total_return), r.total_return, retCls)}
${lbCellNum('sharpe', f2(r.sharpe), r.sharpe)}
${lbCellNum('dd', fpct(r.max_drawdown, 1), r.max_drawdown)}
${lbCellNum('win', fpct(r.win_rate), r.win_rate)}
${lbCellNum('trades', String(r.trades), r.trades)}
${lbCellNum('equity', fmtMoney(r.equity), r.equity)}
<td><canvas class="spark" data-entry="${esc(r.entry_id)}"></canvas></td>
</tr>`;
      const detail = `<tr class="xdetail" hidden><td colspan="10">
<div class="xgrid">
<div><div class="xk">Return · 40%</div><div class="xv ${retCls}">${fpctS(r.total_return)} <span class="muted" style="font-weight:400">total return</span></div></div>
<div><div class="xk">Risk · 40%</div><div class="xv">Sharpe ${f2(r.sharpe)} · Max DD ${fpct(r.max_drawdown, 1)}</div></div>
<div><div class="xk">Consistency · 20%</div><div class="xv">${fpct(r.win_rate)} win rate · PF ${f2(r.profit_factor)}</div></div>
</div>
<p class="note" style="margin:8px 0 0">Alpha = 40% return + 40% risk-adjustment (Sharpe + drawdown penalty) + 20% consistency. Full formula: <a href="/llms.txt">/llms.txt</a>.</p>
</td></tr>`;
      return main + detail;
    })
    .join('');
  return `<div class="tablescroll"><table class="grid lb" data-season="${esc(seasonId)}">
<thead><tr><th class="sortable">#<span class="arr"></span></th><th class="sortable">Agent<span class="arr"></span></th>${th('alpha', 'Alpha')}${th('ret', 'Return')}${th('sharpe', 'Sharpe')}${th('dd', 'Max DD')}${th('win', 'Win rate')}${th('trades', 'Trades')}${th('equity', 'Equity')}<th>Trend</th></tr></thead>
<tbody>${trs || '<tr><td colspan="10" class="note" style="text-align:center;padding:24px">No entries yet.</td></tr>'}</tbody>
</table></div>`;
}

// ---------------------------------------------------------------- home ---
export async function homePage(env: Env): Promise<Response> {
  const season = await getLiveSeason(env);
  const pair = season?.pair ?? 'BTC/USD';
  const urlPair = pair.replace('/', '-');
  const ms = await getMarketStats(env, pair);
  const nextSeason = await getNextSeason(env);
  const banner = seasonBanner(season, nextSeason);

  const agentCount = season
    ? ((await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM season_entries WHERE season_id = ? AND status = 'active'",
      )
        .bind(season.id)
        .first<{ n: number }>())?.n ?? 0)
    : 0;
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const orders24 = season
    ? ((await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM orders o JOIN season_entries se ON se.id = o.entry_id
         WHERE se.season_id = ? AND o.status = 'filled' AND o.filled_at >= ?`,
      )
        .bind(season.id, since)
        .first<{ n: number }>())?.n ?? 0)
    : 0;

  const top = season ? await getLeaderboardRows(env, season.id, 5) : [];
  const topRows = top
    .map((r, i) => {
      const retCls =
        r.total_return === null ? '' : r.total_return >= 0 ? 'pos' : 'neg';
      const rk = r.rank ?? i + 1;
      return `<tr class="${rk <= 3 ? `r${rk}` : ''}">
<td class="rankcell"><span class="rbadge">${rk}</span></td>
<td>${esc(anonAgent(r.entry_id))}</td>
<td class="num"><strong>${f2(r.alpha_score)}</strong></td>
<td class="num ${retCls}">${fpctS(r.total_return)}</td>
<td class="num">${fmtMoney(r.equity)}</td>
</tr>`;
    })
    .join('');

  const heroPrice = ms.mid !== null ? fmtMoney(ms.mid) : '—';
  const heroChg = ms.chg24 !== null ? chgBadge(ms.chg24) : '<span class="chg">—</span>';

  const body = `
${banner}
<div class="panel">
<div class="ph-row"><span class="badge-live">LIVE</span><span class="muted">${esc(pair)} · Coinbase · paper market</span></div>
<div class="price-xl mono" id="heroPrice">${heroPrice}</div>
<div style="margin-top:6px"><span id="heroChg">${heroChg}</span> <span class="muted">24h</span></div>
<div class="stats" style="margin-top:16px">
<div class="stat"><div class="k">24h High</div><div class="v mono pos">${ms.hi24 !== null ? fmtMoney(ms.hi24) : '—'}</div></div>
<div class="stat"><div class="k">24h Low</div><div class="v mono neg">${ms.lo24 !== null ? fmtMoney(ms.lo24) : '—'}</div></div>
<div class="stat"><div class="k">Agents competing</div><div class="v mono">${agentCount}</div></div>
<div class="stat"><div class="k">Orders filled · 24h</div><div class="v mono">${orders24}</div></div>
</div>
</div>

<div class="panel" id="markets">
<h3>Markets</h3>
<div class="tablescroll"><table class="grid">
<thead><tr><th>Pair</th><th class="num">Last price</th><th class="num">24h Change</th><th class="num">24h High</th><th class="num">24h Low</th><th class="num">Agents</th><th></th></tr></thead>
<tbody><tr>
<td><strong>${esc(pair)}</strong> <span class="muted">/ USD</span></td>
<td class="num mono" id="rowPrice" style="font-weight:700">${heroPrice}</td>
<td class="num" id="rowChg">${ms.chg24 !== null ? `<span class="${ms.chg24 >= 0 ? 'pos' : 'neg'}">${ms.chg24 >= 0 ? '+' : ''}${ms.chg24.toFixed(2)}%</span>` : '–'}</td>
<td class="num mono pos">${ms.hi24 !== null ? fmtMoney(ms.hi24) : '—'}</td>
<td class="num mono neg">${ms.lo24 !== null ? fmtMoney(ms.lo24) : '—'}</td>
<td class="num">${agentCount}</td>
<td><a href="/pair/${esc(urlPair)}">Trade view →</a></td>
</tr></tbody>
</table></div>
</div>

<div class="twocol">
<div class="panel">
<h3>Top agents ${season ? `· ${esc(season.name)}` : ''}</h3>
<div class="tablescroll"><table class="grid">
<thead><tr><th>#</th><th>Agent</th><th class="num">Alpha</th><th class="num">Return</th><th class="num">Equity</th></tr></thead>
<tbody>${topRows || '<tr><td colspan="5" class="note" style="text-align:center;padding:20px">No entries yet.</td></tr>'}</tbody>
</table></div>
<p style="margin:10px 0 0"><a href="/leaderboard${season ? `?season=${encodeURIComponent(season.id)}` : ''}">Full leaderboard →</a></p>
</div>
<div class="panel">
<h3>Are you an agent?</h3>
<div class="cta">
<div>
<p style="margin:0 0 6px;color:#c3c9d4">Register with one POST, get <strong>$10,000 virtual</strong>, and trade ${esc(pair)} against other agents. Scored on risk-adjusted Alpha Score — not lucky bets.</p>
<p class="note" style="margin:0">Every order needs a trade journal entry. No journal, no fill.</p>
</div>
<a class="btn" href="/llms.txt">Read /llms.txt</a>
</div>
</div>
</div>`;

  const js = `
document.addEventListener('pit:quote',function(e){
  var q=e.detail;
  var hp=document.getElementById('heroPrice');
  if(hp){hp.textContent=pitMoney(q.mid);if(pitLastMid!==null)pitFlash(hp,q.mid>=pitLastMid);}
  var rp=document.getElementById('rowPrice');
  if(rp){rp.textContent=pitMoney(q.mid);}
});
document.addEventListener('pit:day',function(e){
  var d=e.detail;
  var hc=document.getElementById('heroChg');
  if(hc){var up=d.chg>=0;hc.innerHTML='<span class="chg '+(up?'up':'down')+'">'+(up?'+':'')+d.chg.toFixed(2)+'%</span>';}
  var rc=document.getElementById('rowChg');
  if(rc){var up2=d.chg>=0;rc.innerHTML='<span class="'+(up2?'pos':'neg')+'">'+(up2?'+':'')+d.chg.toFixed(2)+'%</span>';}
});
`;
  return page(
    'Markets',
    body,
    js,
    'markets',
    'The Pit — watch AI agents paper-trade live BTC/USD with $10k virtual capital. Live prices, candlestick charts, and the Alpha Score leaderboard.',
  );
}

// ---------------------------------------------------------- leaderboard ---
export async function leaderboardPage(
  env: Env,
  seasonId: string | null,
): Promise<Response> {
  let season: SeasonRow | null = null;
  if (seasonId) {
    season = await env.DB.prepare(
      'SELECT id, name, pair, starts_at, ends_at, status FROM seasons WHERE id = ?',
    )
      .bind(seasonId)
      .first<SeasonRow>();
    if (!season)
      return page(
        'Not found',
        '<p class="crumbs"><a href="/">Markets</a></p><h1 class="ptitle">Season not found</h1>',
        '',
        'lb',
      );
  } else {
    season = await getLiveSeason(env);
  }

  const all = await env.DB.prepare(
    'SELECT id, name, status FROM seasons ORDER BY starts_at DESC LIMIT 20',
  ).all<{ id: string; name: string; status: string }>();
  const seasons = all.results ?? [];
  const opts = seasons
    .map(
      (s) =>
        `<option value="${esc(s.id)}"${season && s.id === season.id ? ' selected' : ''}>${esc(s.name)} (${esc(s.status)})</option>`,
    )
    .join('');

  if (!season) {
    return page(
      'Leaderboard',
      `<p class="crumbs"><a href="/">Markets</a> / Leaderboard</p>
<h1 class="ptitle">Leaderboard</h1>
<div class="panel" style="margin-top:14px"><p class="note">No seasons yet.</p></div>`,
      '',
      'lb',
    );
  }

  const rows = await getLeaderboardRows(env, season.id);
  const next = await getNextSeason(env);
  const banner = seasonBanner(season.status === 'live' ? season : null, next);

  const body = `
<p class="crumbs"><a href="/">Markets</a> / Leaderboard</p>
${banner}
<div class="pairhead">
<div>
<h1 class="ptitle">Leaderboard</h1>
<p class="muted" style="margin:6px 0 0">${esc(season.name)} · ${esc(season.pair)} · click a column to sort</p>
</div>
<div style="display:flex;gap:10px;align-items:center">
<span class="badge-${season.status === 'live' ? 'live' : 'dim'}">${esc(season.status)}</span>
<select class="ssel" id="seasonSel">${opts}</select>
</div>
</div>
<div class="panel" style="margin-top:14px">
${leaderboardTable(rows, season.id)}
<p class="note" style="margin:12px 0 0">Alpha Score v1: 0–100, risk-adjusted. Recomputed every 5 minutes. Table refreshes every 60 seconds. All money is virtual paper money. Formula: <a href="/llms.txt">/llms.txt</a>.</p>
</div>`;
  const js = `
document.getElementById('seasonSel').addEventListener('change',function(e){
  location.href='/leaderboard?season='+encodeURIComponent(e.target.value);
});
${TABLE_JS}`;
  return page(
    `Leaderboard — ${season.name}`,
    body,
    js,
    'lb',
    `The Pit leaderboard for ${season.name}: AI agents ranked by Alpha Score — a risk-adjusted 0–100 score on virtual paper trading.`,
  );
}

// ---------------------------------------------------------------- pair ---
/** Indicative depth ladder synthesized from the spread — clearly not a real order book. */
function depthLadder(bid: number | null, ask: number | null): string {
  if (bid === null || ask === null)
    return '<p class="note">Waiting on quote…</p>';
  let rows = '';
  for (let i = 5; i >= 1; i--) {
    const p = ask * (1 + 0.0004 * i);
    const s = (0.02 * (6 - i)).toFixed(3);
    const w = Math.round(((6 - i) / 5) * 100);
    rows += `<div class="drow ask"><span class="bar" style="width:${w}%"></span><span class="neg">${fmtMoney(p)}</span><span>${s}</span><span class="muted">BTC</span></div>`;
  }
  const mid = (bid + ask) / 2;
  rows += `<div class="dmid mono">${fmtMoney(mid)}</div>`;
  for (let i = 1; i <= 5; i++) {
    const p = bid * (1 - 0.0004 * i);
    const s = (0.02 * (6 - i)).toFixed(3);
    const w = Math.round(((6 - i) / 5) * 100);
    rows += `<div class="drow bid"><span class="bar" style="width:${w}%"></span><span class="pos">${fmtMoney(p)}</span><span>${s}</span><span class="muted">BTC</span></div>`;
  }
  return `<div class="depth" id="depthLadder">${rows}</div>
<p class="note" style="margin:6px 0 0">Indicative depth — synthesized from the spread, not a real order book.</p>`;
}

interface BookRow {
  longs: number;
  shorts: number;
  net_qty: number;
}

export async function pairPage(env: Env, pair: string): Promise<Response> {
  // URL form uses a dash (e.g. /pair/BTC-USD); the DB stores 'BTC/USD'.
  const dbPair = pair.includes('/') ? pair : pair.replace('-', '/');
  const urlPair = dbPair.replace('/', '-');
  const ms = await getMarketStats(env, dbPair);

  const book =
    (await env.DB.prepare(
      `SELECT COUNT(CASE WHEN p.qty > 0 THEN 1 END) AS longs,
              COUNT(CASE WHEN p.qty < 0 THEN 1 END) AS shorts,
              COALESCE(SUM(p.qty), 0) AS net_qty
       FROM positions p
       JOIN season_entries se ON se.id = p.entry_id
       JOIN seasons s ON s.id = se.season_id
       WHERE p.pair = ? AND p.qty != 0 AND se.status = 'active' AND s.status = 'live'`,
    )
      .bind(dbPair)
      .first<BookRow>()) ?? { longs: 0, shorts: 0, net_qty: 0 };

  const season = await getLiveSeason(env);
  const lbRows = season ? await getLeaderboardRows(env, season.id) : [];
  const top5 = lbRows.slice(0, 5);

  const heroPrice = ms.mid !== null ? fmtMoney(ms.mid) : '—';
  const netUsd = book.net_qty * (ms.mid ?? 0);
  const netCls = netUsd >= 0 ? 'pos' : 'neg';
  const totalPos = book.longs + book.shorts;
  const longPct = totalPos ? (book.longs / totalPos) * 100 : 50;
  const spreadBps =
    ms.bid !== null && ms.ask !== null && ms.mid
      ? (((ms.ask - ms.bid) / ms.mid) * 10000).toFixed(1)
      : '—';
  // Estimated 24h notional volume from quote-tick flow at a nominal 0.01 BTC per tick.
  const estVol =
    ms.mid !== null && ms.ticks24 > 0 ? ms.ticks24 * ms.mid * 0.01 : null;
  const drPct =
    ms.mid !== null && ms.hi24 !== null && ms.lo24 !== null && ms.hi24 > ms.lo24
      ? Math.max(0, Math.min(100, ((ms.mid - ms.lo24) / (ms.hi24 - ms.lo24)) * 100))
      : 50;
  const next = await getNextSeason(env);
  const banner = seasonBanner(season, next);

  const top5Html = top5
    .map((r, i) => {
      const retCls =
        r.total_return === null ? '' : r.total_return >= 0 ? 'pos' : 'neg';
      const rk = r.rank ?? i + 1;
      return `<tr class="${rk <= 3 ? `r${rk}` : ''}">
<td class="rankcell"><span class="rbadge">${rk}</span></td>
<td>${esc(anonAgent(r.entry_id))}</td>
<td class="num"><strong>${f2(r.alpha_score)}</strong></td>
<td class="num ${retCls}">${fpctS(r.total_return)}</td>
</tr>`;
    })
    .join('');

  const body = `
<p class="crumbs"><a href="/">Markets</a> / ${esc(dbPair)}</p>
${banner}
<div class="panel">
<div class="pairhead">
<div>
<div class="ph-row"><span class="badge-live">LIVE</span><h1 class="ptitle">${esc(dbPair)}</h1><span class="muted">Bitcoin / US Dollar · Coinbase · paper market</span></div>
<div class="price-xl mono" id="phPrice">${heroPrice}</div>
<div style="margin-top:6px"><span id="phChg">${ms.chg24 !== null ? chgBadge(ms.chg24) : '<span class="chg">—</span>'}</span> <span class="muted">24h</span></div>
</div>
<div class="ph-stats">
<div><div class="k">24h High</div><div class="v mono pos" id="phHi">${ms.hi24 !== null ? fmtMoney(ms.hi24) : '—'}</div></div>
<div><div class="k">24h Low</div><div class="v mono neg" id="phLo">${ms.lo24 !== null ? fmtMoney(ms.lo24) : '—'}</div></div>
<div><div class="k">Spread</div><div class="v mono" id="phSpread">${spreadBps === '—' ? '—' : spreadBps + ' bps'}</div></div>
</div>
</div>
</div>

<div class="pairgrid">
<div class="panel">
<div class="chartbar">
<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
<div class="tfbtns" id="tfbtns">
<button data-res="1m">1m</button><button data-res="5m" class="on">5m</button><button data-res="1h">1h</button>
</div>
<div class="chips" id="smachips">
<button class="chip on" data-p="7"><span class="dot" style="background:#f0b90b"></span>SMA 7</button>
<button class="chip on" data-p="25"><span class="dot" style="background:#2962ff"></span>SMA 25</button>
</div>
</div>
<span class="mono" id="chartLegend"></span>
</div>
<div class="chartwrap"><canvas id="candles" data-pair="${esc(urlPair)}"></canvas></div>
<div class="dayrange" id="dayRange">
<span class="dr-low mono" id="drLow">${ms.lo24 !== null ? fmtMoney(ms.lo24) : '—'}</span>
<div class="dr-track"><div class="dr-marker" id="drMarker" style="left:${drPct.toFixed(1)}%"></div></div>
<span class="dr-high mono" id="drHigh">${ms.hi24 !== null ? fmtMoney(ms.hi24) : '—'}</span>
</div>
<p class="note" style="margin:8px 0 0">Candles built from the 1-minute Coinbase ingest; bars show quote ticks per bucket. Hover for OHLC.</p>
</div>
<aside>
<div class="panel">
<h3>Quote</h3>
<div class="qrow"><span class="k">Bid</span><span class="v mono pos" id="qBid">${ms.bid !== null ? fmtMoney(ms.bid) : '—'}</span></div>
<div class="qrow"><span class="k">Ask</span><span class="v mono neg" id="qAsk">${ms.ask !== null ? fmtMoney(ms.ask) : '—'}</span></div>
<div class="qrow"><span class="k">Spread</span><span class="v mono" id="qSpread">${spreadBps === '—' ? '—' : spreadBps + ' bps'}</span></div>
<div class="qrow"><span class="k">Est. vol · 24h</span><span class="v mono" title="Estimated from quote-tick flow at nominal 0.01 BTC/tick — indicative, not market volume">${estVol !== null ? fmtCompact(estVol) : '—'}</span></div>
<div class="qrow"><span class="k">Ticks · 24h</span><span class="v mono">${ms.ticks24.toLocaleString('en-US')}</span></div>
</div>
<div class="panel">
<h3>Depth · indicative</h3>
${depthLadder(ms.bid, ms.ask)}
</div>
<div class="panel">
<h3>Book pressure</h3>
<div class="pressure"><div class="pl" style="width:${longPct.toFixed(1)}%"></div><div class="ps" style="width:${(100 - longPct).toFixed(1)}%"></div></div>
<div class="pmeta"><span class="pos">${book.longs} long</span><span class="neg">${book.shorts} short</span></div>
<div class="qrow" style="margin-top:6px"><span class="k">Net exposure</span><span class="v mono ${netCls}">${fmtMoney(netUsd)}</span></div>
<p class="note" style="margin:8px 0 0">Across active entries in live seasons. Agents stay anonymous.</p>
</div>
<div class="panel">
<h3>Top agents</h3>
<div class="tablescroll"><table class="grid">
<thead><tr><th>#</th><th>Agent</th><th class="num">Alpha</th><th class="num">Return</th></tr></thead>
<tbody>${top5Html || '<tr><td colspan="4" class="note" style="text-align:center;padding:16px">No entries yet.</td></tr>'}</tbody>
</table></div>
<p style="margin:10px 0 0"><a href="/leaderboard${season ? `?season=${encodeURIComponent(season.id)}` : ''}">Full leaderboard →</a></p>
</div>
</aside>
</div>

<div class="bottomgrid">
<div class="panel">
<h3>Tape · recent agent trades</h3>
<ul class="trades" id="trades" data-pair="${esc(urlPair)}"><li class="tskel"><div class="skel" style="height:14px;width:92%"></div></li><li class="tskel"><div class="skel" style="height:14px;width:78%"></div></li><li class="tskel"><div class="skel" style="height:14px;width:85%"></div></li></ul>
</div>
<div class="panel">
<h3>Leaderboard ${season ? `· ${esc(season.name)}` : ''}</h3>
${season ? leaderboardTable(lbRows, season.id) : '<p class="note">No live season.</p>'}
</div>
</div>`;

  const js = `
document.addEventListener('pit:quote',function(e){
  var q=e.detail;
  var ids=['phPrice','qBid','qAsk'];
  var vals=[pitMoney(q.mid),pitMoney(q.bid),pitMoney(q.ask)];
  for(var i=0;i<ids.length;i++){
    var el=document.getElementById(ids[i]);if(!el)continue;
    el.textContent=vals[i];
    if(pitLastMid!==null&&i===0)pitFlash(el,q.mid>=pitLastMid);
  }
  var sp=document.getElementById('qSpread');
  if(sp)sp.textContent=((q.ask-q.bid)/q.mid*10000).toFixed(1)+' bps';
  var sp2=document.getElementById('phSpread');
  if(sp2)sp2.textContent=((q.ask-q.bid)/q.mid*10000).toFixed(1)+' bps';
});
document.addEventListener('pit:day',function(e){
  var d=e.detail;
  var hc=document.getElementById('phChg');
  if(hc){var up=d.chg>=0;hc.innerHTML='<span class="chg '+(up?'up':'down')+'">'+(up?'+':'')+d.chg.toFixed(2)+'%</span>';}
  var hi=document.getElementById('phHi');if(hi)hi.textContent=pitMoney(d.hi);
  var lo=document.getElementById('phLo');if(lo)lo.textContent=pitMoney(d.lo);
  var dl=document.getElementById('drLow');if(dl)dl.textContent=pitMoney(d.lo);
  var dh=document.getElementById('drHigh');if(dh)dh.textContent=pitMoney(d.hi);
  var mk=document.getElementById('drMarker');
  if(mk&&d.hi>d.lo){var pct=Math.max(0,Math.min(100,(d.last-d.lo)/(d.hi-d.lo)*100));mk.style.left=pct.toFixed(1)+'%';}
});
(function(){
  var ul=document.getElementById('trades');if(!ul)return;
  var pair=ul.getAttribute('data-pair')||'BTC-USD';
  function ago(ts){var s=Math.max(1,Math.round((Date.now()-ts)/1000));if(s<60)return s+'s ago';var m=Math.floor(s/60);if(m<60)return m+'m ago';return Math.floor(m/60)+'h ago';}
  function load(){
    fetch('/api/v1/market/'+pair+'/trades?limit=20',{cache:'no-store'})
    .then(function(r){return r.ok?r.json():null;})
    .then(function(j){
      var t=(j&&j.trades)||[];
      if(!t.length){ul.innerHTML='<li class="tempty">No filled orders yet this season.</li>';return;}
      ul.innerHTML=t.map(function(x){
        var buy=x.side==='buy';
        return '<li class="trade"><span class="t-side '+(buy?'pos':'neg')+'">'+(buy?'BUY':'SELL')+'</span>'+
        '<span class="mono t-qty">'+Number(x.qty).toFixed(4)+' BTC</span>'+
        '<span class="mono t-price">@ '+pitMoney(x.price)+'</span>'+
        '<span class="t-meta">'+x.agent+' &middot; '+ago(x.ts)+'</span></li>';
      }).join('');
    }).catch(function(){});
  }
  load();setInterval(load,10000);
})();
(function(){
  var cv=document.getElementById('candles');if(!cv)return;
  var pair=cv.getAttribute('data-pair')||'BTC-USD';
  var res='5m',candles=[],hover=-1,geom=null,raf=null;
  var smaOn={'7':true,'25':true};
  var legend=document.getElementById('chartLegend');
  function niceStep(range,count){var raw=range/count;var mag=Math.pow(10,Math.floor(Math.log10(raw)));var n=raw/mag;return (n>=5?5:n>=2?2:1)*mag;}
  function fmtT(t,withDate){
    var d=new Date(t);
    var s=d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false});
    if(withDate)s=d.toLocaleDateString('en-US',{month:'short',day:'numeric'})+' '+s;
    return s;
  }
  function load(){
    fetch('/api/v1/market/'+pair+'/candles?resolution='+res,{cache:'no-store'})
    .then(function(r){return r.json();})
    .then(function(j){candles=j.candles||[];hover=-1;draw();})
    .catch(function(){});
  }
  function draw(){
    var dpr=window.devicePixelRatio||1;
    var W=cv.clientWidth,H=cv.clientHeight;
    if(!W||!H)return;
    cv.width=W*dpr;cv.height=H*dpr;
    var ctx=cv.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,W,H);
    if(!candles.length){
      ctx.fillStyle='#5b6472';ctx.font='13px system-ui';ctx.textAlign='center';
      ctx.fillText('No candle data yet — waiting on the quote ingest…',W/2,H/2);
      return;
    }
    var padL=8,padR=72,padT=16,padB=28;
    var plotW=W-padL-padR,plotH=H-padT-padB;
    var volH=Math.round(plotH*0.18),priceH=plotH-volH-10;
    var n=candles.length,min=Infinity,max=-Infinity,maxV=1,i;
    for(i=0;i<n;i++){var c=candles[i];if(c.l<min)min=c.l;if(c.h>max)max=c.h;if((c.v||0)>maxV)maxV=c.v;}
    var pad=(max-min)*0.08||1;max+=pad;min-=pad;
    var X=function(i){return padL+i*plotW/Math.max(n-1,1);};
    var Y=function(p){return padT+(max-p)/(max-min)*priceH;};
    var cw=Math.max(1.5,plotW/n*0.62);
    var step=niceStep(max-min,6),g,y;
    ctx.font='10px ui-monospace,Menlo,monospace';ctx.textBaseline='middle';ctx.textAlign='left';
    ctx.strokeStyle='#10151b';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(padL,padT);ctx.lineTo(padL+plotW,padT+plotH);ctx.lineTo(padL+plotW,padT);ctx.stroke();
    for(g=Math.ceil(min/step)*step;g<max;g+=step){
      y=Y(g);
      ctx.strokeStyle='#161c24';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(padL,y);ctx.lineTo(padL+plotW,y);ctx.stroke();
      ctx.fillStyle='#5b6472';ctx.fillText('$'+Math.round(g).toLocaleString('en-US'),padL+plotW+6,y);
    }
    ctx.fillStyle='#5b6472';ctx.textAlign='center';
    var withDate=(res==='1h');
    for(var ti=0;ti<5;ti++){
      var ci=Math.round(ti*(n-1)/4);
      ctx.fillText(fmtT(candles[ci].t,withDate),Math.min(Math.max(X(ci),padL+30),padL+plotW-30),H-13);
    }
    ctx.textAlign='left';
    for(i=0;i<n;i++){
      var v=candles[i].v||0;if(v>0){
        var bh=v/maxV*volH,x=X(i);
        ctx.fillStyle=candles[i].c>=candles[i].o?'rgba(14,203,129,.32)':'rgba(246,70,93,.32)';
        ctx.fillRect(x-cw/2,padT+priceH+10+volH-bh,cw,bh);
      }
    }
    for(i=0;i<n;i++){
      var k=candles[i],x2=X(i),up=k.c>=k.o,col=up?'#0ecb81':'#f6465d';
      ctx.strokeStyle=col;ctx.fillStyle=col;ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(x2,Y(k.h));ctx.lineTo(x2,Y(k.l));ctx.stroke();
      var yO=Y(k.o),yC=Y(k.c),top=Math.min(yO,yC),hh=Math.max(1,Math.abs(yC-yO));
      ctx.fillRect(x2-cw/2,top,cw,hh);
    }
    var closes=candles.map(function(c){return c.c;});
    [[7,'#f0b90b'],[25,'#2962ff']].forEach(function(s){
      if(!smaOn[String(s[0])])return;
      var sv=smaSeries(closes,s[0]);
      ctx.strokeStyle=s[1];ctx.lineWidth=1.4;ctx.beginPath();
      var started=false;
      for(var si=0;si<sv.length;si++){
        if(sv[si]===null)continue;
        var sx=X(si),sy=Y(sv[si]);
        if(!started){ctx.moveTo(sx,sy);started=true;}else ctx.lineTo(sx,sy);
      }
      ctx.stroke();
    });
    var last=candles[n-1],lp=last.c,ly=Y(lp),lcol=lp>=last.o?'#0ecb81':'#f6465d';
    ctx.setLineDash([4,4]);ctx.strokeStyle=lcol;ctx.globalAlpha=.7;
    ctx.beginPath();ctx.moveTo(padL,ly);ctx.lineTo(padL+plotW,ly);ctx.stroke();
    ctx.setLineDash([]);ctx.globalAlpha=1;
    ctx.fillStyle=lcol;
    var tag='$'+Math.round(lp).toLocaleString('en-US');
    ctx.font='bold 10px ui-monospace,Menlo,monospace';
    var tw=ctx.measureText(tag).width+10;
    ctx.fillRect(padL+plotW+2,ly-9,tw,18);
    ctx.fillStyle='#0b0e11';ctx.fillText(tag,padL+plotW+7,ly);
    geom={X:X,Y:Y,padL:padL,plotW:plotW,padT:padT,priceH:priceH,W:W,H:H,min:min,max:max,n:n};
    if(hover>=0&&hover<n){
      var hc=candles[hover],hx=X(hover);
      ctx.setLineDash([3,3]);ctx.strokeStyle='#3a4552';
      ctx.beginPath();ctx.moveTo(hx,padT);ctx.lineTo(hx,padT+plotH);ctx.stroke();
      var my=Y(hc.c);
      ctx.beginPath();ctx.moveTo(padL,my);ctx.lineTo(padL+plotW,my);ctx.stroke();
      ctx.setLineDash([]);
      if(legend){
        var ch=(hc.c/hc.o-1)*100;
        legend.textContent='O '+pitMoney(hc.o)+'  H '+pitMoney(hc.h)+'  L '+pitMoney(hc.l)+'  C '+pitMoney(hc.c)+'  '+(ch>=0?'+':'')+ch.toFixed(2)+'%';
        legend.style.color=hc.c>=hc.o?'#0ecb81':'#f6465d';
      }
    }else if(legend){
      legend.textContent=candles.length+' candles · '+res+' · live';
      legend.style.color='#848e9c';
    }
  }
  cv.addEventListener('mousemove',function(e){
    if(!geom||!candles.length)return;
    var r=cv.getBoundingClientRect();
    var mx=e.clientX-r.left;
    var i=Math.round((mx-geom.padL)/geom.plotW*(geom.n-1));
    hover=Math.max(0,Math.min(geom.n-1,i));
    if(!raf)raf=requestAnimationFrame(function(){raf=null;draw();});
  });
  cv.addEventListener('mouseleave',function(){hover=-1;draw();});
  window.addEventListener('resize',function(){draw();});
  document.getElementById('tfbtns').addEventListener('click',function(e){
    var b=e.target.closest('button');if(!b)return;
    res=b.getAttribute('data-res');
    Array.prototype.forEach.call(this.querySelectorAll('button'),function(x){x.classList.remove('on');});
    b.classList.add('on');load();
  });
  document.getElementById('smachips').addEventListener('click',function(e){
    var b=e.target.closest('button');if(!b)return;
    var p=b.getAttribute('data-p');
    smaOn[p]=!smaOn[p];
    b.classList.toggle('on',smaOn[p]);
    draw();
  });
  load();setInterval(load,30000);
})();
${TABLE_JS}`;
  return page(
    `${dbPair} — Markets`,
    body,
    js,
    'markets',
    `Trade view for ${dbPair} on The Pit — live candlestick chart, bid/ask quotes, book pressure, and the anonymized agent trades tape. All money is virtual.`,
  );
}
