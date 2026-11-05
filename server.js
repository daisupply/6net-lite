// 6ixNetworks server — Node 18+ (built-in fetch; one optional dep, undici,
// only used when UPSTREAM_PROXY is set)
// Run: node server.js   (uses PORT env or 8080)

const http = require('http');
const { URL } = require('url');
const zlib = require('zlib');
const { pipeline, Readable } = require('stream');

const PORT = process.env.PORT || 8080;
function cookieDomain(req) { const h = String((req.headers && req.headers.host) || '').split(':')[0]; return (h === 'usareme.site' || h.endsWith('.usareme.site')) ? '; Domain=.usareme.site' : ''; }

// ---------- optional egress proxy / VPN ----------
// A Cloudflare Worker can never choose its egress IP — but this Node
// server can. Set UPSTREAM_PROXY to any http(s) proxy endpoint
// (a VPN provider's proxy, a local WARP/vpn client proxy, a proxy you
// run) and ALL upstream traffic leaves through it, from that IP.
// Or skip this entirely and run the server on a machine that is itself
// on a VPN — the server's fetches then use the VPN's IP automatically.
if (process.env.UPSTREAM_PROXY) {
  try {
    const { ProxyAgent, setGlobalDispatcher } = require('undici');
    setGlobalDispatcher(new ProxyAgent(process.env.UPSTREAM_PROXY));
    console.log('egress: upstream proxy on (' + process.env.UPSTREAM_PROXY.replace(/\/\/[^@]*@/, '//***@') + ')');
  } catch (e) {
    console.log('egress: UPSTREAM_PROXY set but undici is unavailable — run npm install. (' + e.message + ')');
  }
}

// ---------- helpers ----------
function b64urlEncode(str) {
  return Buffer.from(str, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  return Buffer.from(b64 + pad, 'base64').toString('utf8');
}
function proxied(absUrl) {
  return '/browse/' + b64urlEncode(absUrl);
}
// v210: hosts that break inside the UV engine ride virtual direct
// (the light relay) no matter where they're opened from — snapchat
// first, per his ask. Matched by base domain (covers web./accounts.).
const VD_HOSTS = ['snapchat.com', 'youtube.com', 'youtu.be'];
function isVdHost(dest) {
  try {
    const u = new URL(dest);
    const h = u.hostname.toLowerCase();
    if (VD_HOSTS.some(d => h === d || h.endsWith('.' + d))) return true;
    // now.gg: ONLY roblox rides vd (his ask) — matched by its app
    // path, since the whole domain would open every game on there.
    if ((h === 'now.gg' || h.endsWith('.now.gg')) && (/roblox/i.test(u.pathname) || u.pathname.startsWith('/apps/a/19900/'))) return true;
    return false;
  } catch { return false; }
}

function gproxied(absUrl) {
  return '/gproxy/' + b64urlEncode(absUrl);
}
// ---------- proxy shim ----------
// Injected at the very top of every proxied page. The static rewriter only
// catches URLs written in HTML — this patches the runtime too: fetch, XHR,
// dynamically-set src/href, link clicks, form posts and DOM insertions all
// get routed back through the proxy, so a page's own code can't wander off
// to its base network. Everything stays inside 6ixNetworks.
const PROXY_SHIM = `(function(){
var TGT=%%TGT%%, PRE=%%PRE%%;
function b64(s){ return btoa(unescape(encodeURIComponent(s))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,''); }
function rw(u){ try{ if(typeof u!=='string') return u; if(!u || u.indexOf(PRE)===0 || u.indexOf('/browse/')===0 || u.indexOf('/gproxy/')===0 || u.indexOf('/px/')===0 || /^(data|blob|about|javascript|mailto|tel):/i.test(u)) return u; var a=new URL(u, TGT); if(!/^https?:$/.test(a.protocol)) return u; try{ if(a.host===location.host) return u; }catch(e){} return PRE + b64(a.href); }catch(e){ return u; } }
var of=window.fetch;
if(of) window.fetch=function(input, init){ try{ if(typeof input==='string') input=rw(input); else if(input && input.url) input=new Request(rw(input.url), input); }catch(e){} return of.call(this, input, init); };
var oo=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m, u){ try{ arguments[1]=rw(u); }catch(e){} return oo.apply(this, arguments); };
[['HTMLImageElement','src'],['HTMLScriptElement','src'],['HTMLMediaElement','src'],['HTMLSourceElement','src'],['HTMLIFrameElement','src'],['HTMLLinkElement','href'],['HTMLAnchorElement','href']].forEach(function(pair){
  var el=window[pair[0]]; if(!el) return;
  var desc=Object.getOwnPropertyDescriptor(el.prototype, pair[1]);
  if(desc && desc.set && desc.configurable){ Object.defineProperty(el.prototype, pair[1], { configurable:true, enumerable:desc.enumerable, get:desc.get, set:function(v){ desc.set.call(this, rw(v)); } }); }
});
document.addEventListener('click', function(e){ var a=e.target && e.target.closest ? e.target.closest('a[href]') : null; if(a){ var h=a.getAttribute('href'); var r=rw(h); if(r!==h) a.setAttribute('href', r); } }, true);
document.addEventListener('submit', function(e){ var f=e.target; if(f && f.getAttribute && f.getAttribute('action')){ var r=rw(f.getAttribute('action')); f.setAttribute('action', r); } }, true);
function fixNode(node){ if(node.nodeType!==1) return; var list=[node]; if(node.querySelectorAll) list=list.concat(Array.prototype.slice.call(node.querySelectorAll('img,script,link,video,audio,source,iframe,a'))); list.forEach(function(el){ if(!el.getAttribute) return; if(el.hasAttribute && el.hasAttribute('ping')) el.removeAttribute('ping'); if(el.tagName==='META' && (el.getAttribute('http-equiv')||'').toLowerCase()==='refresh'){ var c=el.getAttribute('content')||''; var mm=c.match(/url\\s*=\\s*(.+)$/i); if(mm){ var r2=rw(mm[1].replace(/^\\s+|\\s+$/g,'')); if(r2!==mm[1]) el.setAttribute('content', c.slice(0, c.length-mm[1].length)+r2); } } ['src','href'].forEach(function(at){ var v=el.getAttribute(at); if(v){ var r=rw(v); if(r!==v) el.setAttribute(at, r); } }); }); }
try{ new MutationObserver(function(ms){ ms.forEach(function(m){ m.addedNodes.forEach(fixNode); }); }).observe(document.documentElement, { childList:true, subtree:true }); }catch(e){}
try{ var _lr=window.location.replace.bind(window.location); window.location.replace=function(u){ _lr(rw(u)); }; }catch(e){}
try{ var _la=window.location.assign.bind(window.location); window.location.assign=function(u){ _la(rw(u)); }; }catch(e){}
window.open=function(u){ if(u){ window.location.href=rw(u); } return null; };
try{ var OWS=window.WebSocket; if(OWS){ window.WebSocket=function(u, protos){ try{ var a=new URL(typeof u==='string'?u:'', TGT); if(/^wss?:$/.test(a.protocol) && a.host!==location.host){ var t=(location.protocol==='https:'?'wss://':'ws://')+location.host+'/wsx?u='+b64(a.href); return protos!==undefined?new OWS(t, protos):new OWS(t); } }catch(e){} return protos!==undefined?new OWS(u, protos):new OWS(u); }; window.WebSocket.prototype=OWS.prototype; ['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(function(k){ window.WebSocket[k]=OWS[k]; }); } }catch(e){}
try{ var OES=window.EventSource; if(OES){ window.EventSource=function(u, cfg){ return new OES(rw(u), cfg); }; window.EventSource.prototype=OES.prototype; } }catch(e){}
try{ var OWk=window.Worker; if(OWk){ window.Worker=function(u, o){ return new OWk(rw(u), o); }; window.Worker.prototype=OWk.prototype; } }catch(e){}
try{ var OSh=window.SharedWorker; if(OSh){ window.SharedWorker=function(u, o){ return new OSh(rw(u), o); }; window.SharedWorker.prototype=OSh.prototype; } }catch(e){}
try{ if(navigator && navigator.sendBeacon){ var ob=navigator.sendBeacon.bind(navigator); navigator.sendBeacon=function(u, d){ return ob(rw(u), d); }; } }catch(e){}
try{ var ORTC=window.RTCPeerConnection||window.webkitRTCPeerConnection; if(ORTC){ var RTCW=function(cfg){ var c={}; try{ for(var k in (cfg||{})) c[k]=cfg[k]; }catch(e){} c.iceServers=[]; c.iceTransportPolicy='relay'; return new ORTC(c); }; RTCW.prototype=ORTC.prototype; window.RTCPeerConnection=RTCW; if(window.webkitRTCPeerConnection) window.webkitRTCPeerConnection=RTCW; } }catch(e){}
})();`;

function privCode() {
  const A = 'abcdefghjkmnpqrstuvwxyz23456789';
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += A[x % A.length];
  return s;
}
let fontCssCache = { css: '', at: 0 };
const fontFileCache = new Map();
function injectProxyShim(html, tgt, pre) {
  const shim = '<script>' + PROXY_SHIM.replace('%%TGT%%', JSON.stringify(tgt)).replace('%%PRE%%', JSON.stringify(pre)) + '</' + 'script>' + sixAnswerSnippet(tgt);
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, m => m + shim);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, m => m + shim);
  return shim + html;
}

// ---------- browser identity + cookie handling ----------
// Present as one consistent, ordinary desktop Chrome browser (same UA +
// client hints + fetch headers every time), and persist each site's cookies
// by translating them onto the proxy's own domain, namespaced per host.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
function hostKey(hostname) { return 'px_' + hostname.replace(/[^a-zA-Z0-9]/g, '_') + '_'; }
function buildUpstreamCookies(cookieHeader, hostname) {
  if (!cookieHeader) return '';
  const prefix = hostKey(hostname);
  const out = [];
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('='); if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name.startsWith(prefix)) out.push(name.slice(prefix.length) + '=' + part.slice(eq + 1).trim());
  }
  return out.join('; ');
}

// The page the browser was actually on, translated back to target-space:
// its referer points at a /browse or /gproxy URL on this host, so decode
// it and hand the site the real page URL as the referer.
function proxyReferer(ref, target) {
  if (ref) {
    try {
      const u = new URL(ref);
      const m = u.pathname.match(/^\/(?:browse|gproxy)\/(.+)$/);
      if (m) {
        const decoded = b64urlDecode(m[1]);
        if (/^https?:\/\//i.test(decoded)) return decoded;
      }
    } catch { /* fall through */ }
  }
  return target.origin + '/';
}
function translateSetCookie(setCookieStr, hostname) {
  const prefix = hostKey(hostname);
  const segments = setCookieStr.split(';').map(s => s.trim());
  const first = segments[0];
  const eq = first.indexOf('='); if (eq < 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1);
  let out = prefix + name + '=' + value + '; Path=/';
  for (const attr of segments.slice(1)) {
    if (/^(max-age|expires)=/i.test(attr)) out += '; ' + attr;
  }
  return out + '; HttpOnly; SameSite=Lax';
}
function getSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h === '::1') return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

// Bing result links don't point at the result — they point at Bing's own
// click-tracker (bing.com/ck/a?...&u=a1<base64 of the real URL>), which
// serves a fragile JS interstitial that dies or loops from datacenter
// IPs. The real destination is sitting right there in the link, so we
// decode it and skip the tracker entirely.
function debingUrl(abs) {
  try {
    if (!/(^|\.)bing\.com$/i.test(abs.hostname)) return null;
    if (!abs.pathname.startsWith('/ck/')) return null;
    const p = abs.searchParams.get('u');
    if (!p || p.slice(0, 2) !== 'a1') return null;
    const real = b64urlDecode(p.slice(2).replace(/\+/g, '-').replace(/\//g, '_'));
    return /^https?:\/\//i.test(real) ? real : null;
  } catch { return null; }
}

function resolveAndProxy(rawValue, baseUrl) {
  const v = (rawValue || '').trim();
  if (!v || v.startsWith('#') || /^(data|javascript|mailto|tel|blob|about):/i.test(v)) return rawValue;
  try {
    const abs = new URL(v, baseUrl).toString();
    const real = debingUrl(new URL(abs));
    return proxied(real || abs);
  } catch { return rawValue; }
}
function rewriteSrcset(value, baseUrl) {
  return value.split(',').map(part => {
    const seg = part.trim();
    if (!seg) return seg;
    const bits = seg.split(/\s+/);
    bits[0] = resolveAndProxy(bits[0], baseUrl);
    return bits.join(' ');
  }).join(', ');
}
// Browsers hand us attribute values HTML-escaped (&amp; for &). Encoding
// the escaped text into the proxy URL corrupts the query string — Bing's
// result links died as blank 204s because of exactly this. Decode first.
function unescapeAttr(s) {
  return s.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}
function rewriteChunk(html, baseUrl) {
  // v3: ONE pass over the document (was 4-5 passes). On Cloudflare's free
  // plan only 10ms of CPU is allowed per request, so scan count matters.
  // v234: strip referrer suppression. embed players set <meta
  // name="referrer" content="origin"> + referrerpolicy attributes, which
  // cut the browser's referer to the bare proxy origin — and token-gated
  // player frames (vidsrc's gate) 403 on exactly that, leaving movies on
  // "tuning in..." forever while every hop individually loads fine.
  // inside the proxy everything is same-origin, so full referers are the
  // natural behavior; the server decodes them back to the real page url.
  html = html.replace(/<meta[^>]+name\s*=\s*["']referrer["'][^>]*>/gi, '').replace(/\sreferrerpolicy\s*=\s*["'][^"']*["']/gi, '');
  const pattern = /<base[^>]*>|\b(href|src|action|poster|cite|background|data-src|data-href|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))|url\(\s*(['"]?)([^'")]+)\5\s*\)/gi;
  return html.replace(pattern, (m, attr, dq, sq, uq, urlQuote, urlVal) => {
    if (urlVal !== undefined) {
      const q = urlQuote || '';
      return `url(${q}${resolveAndProxy(urlVal, baseUrl)}${q})`;
    }
    if (attr === undefined) return ''; // <base ...> tag: drop it
    const val = unescapeAttr(dq !== undefined ? dq : (sq !== undefined ? sq : uq));
    const quote = dq !== undefined ? '"' : (sq !== undefined ? "'" : '');
    const rewritten = attr.toLowerCase() === 'srcset' ? rewriteSrcset(val, baseUrl) : resolveAndProxy(val, baseUrl);
    return `${attr}=${quote}${rewritten}${quote}`;
  }).replace(/\s+target\s*=\s*("_blank"|'_blank'|_blank)/gi, '');
}
function rewriteHtml(html, baseUrl) {
  // never run the attribute rewriter through script/style bodies: inline
  // code full of src=/href= lookalikes got shredded into invalid js
  // (v208 — one bad line poisoned whole inline scripts on proxied pages).
  // script tags keep their src rewrite; style bodies keep url() fixes.
  const parts = html.split(/(<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>)/gi);
  return parts.map((part, i) => {
    if (i % 2 !== 1) return rewriteChunk(part, baseUrl);
    const tagEnd = part.indexOf('>') + 1;
    const closeAt = part.lastIndexOf('<');
    const openTag = part.slice(0, tagEnd);
    const body = part.slice(tagEnd, closeAt);
    const closeTag = part.slice(closeAt);
    const isScript = /^<script/i.test(part);
    return rewriteChunk(openTag, baseUrl) + (isScript ? body : rewriteCss(body, baseUrl)) + closeTag;
  }).join('');
}
function rewriteCss(css, baseUrl) {
  let out = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (m, q, u) => `url(${q}${resolveAndProxy(u.trim(), baseUrl)}${q})`);
  out = out.replace(/@import\s+(["'])([^"']+)\1/gi,
    (m, q, u) => `@import ${q}${resolveAndProxy(u, baseUrl)}${q}`);
  return out;
}



function rewritePlaylist(text, baseUrl, gameMode) {
  // HLS playlists are address books: every variant, key and segment URI
  // inside must point back through the proxy, or the player resolves
  // them against the proxy URL and stalls forever (v209).
  const px = gameMode ? gproxied : proxied;
  const abs = (u) => { try { return px(new URL(u, baseUrl).toString()); } catch { return u; } };
  return text.split('\n').map((line) => {
    const cr = line.endsWith('\r') ? '\r' : '';
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) return t.replace(/URI="([^"]+)"/g, (m, u) => 'URI="' + abs(u) + '"') + cr;
    return abs(t) + cr;
  }).join('\n');
}

// ---------- tab cloak ----------
// One click makes this tab look like Google / Classroom / Docs (title +
// favicon), or opens the whole page inside an about:blank tab whose tab
// itself says Google — the classic cloak.
const CLOAK_JS = `
function cloakTab(kind){
  var presets={
    google:{t:'Google',i:'https://www.google.com/favicon.ico'},
    classroom:{t:'Google Classroom',i:'https://ssl.gstatic.com/classroom/favicon.png'},
    docs:{t:'Google Docs',i:'https://ssl.gstatic.com/docs/documents/images/kix-favicon7.ico'},
    drive:{t:'My Drive - Google Drive',i:'https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_32dp.png'}
  };
  var p=presets[kind]||presets.google;
  try{ localStorage.setItem('six_disguise', kind); }catch(e){}
  if (window.parent !== window) { try { window.parent.postMessage({ sixCloak: kind }, '*'); } catch (e) {} }
  document.title=p.t;
  var l=document.querySelector("link[rel~='icon']")||document.createElement('link');
  l.rel='icon'; l.href=p.i; document.head.appendChild(l);
}
function cloakOpen(){
  var url=location.href;
  var kind='google'; try{ var v=localStorage.getItem('six_disguise'); if(v) kind=v; }catch(e){}
  var presets={ google:{t:'Google',i:'https://www.google.com/favicon.ico'}, classroom:{t:'Google Classroom',i:'https://ssl.gstatic.com/classroom/favicon.png'}, docs:{t:'Google Docs',i:'https://ssl.gstatic.com/docs/documents/images/kix-favicon7.ico'}, drive:{t:'My Drive - Google Drive',i:'https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_32dp.png'} };
  var p=presets[kind]||presets.google;
  var w=null;
  try{ w=window.open('about:blank','_blank'); }catch(e){}
  if(!w){ try{ if(window.top && window.top!==window) w=window.top.open('about:blank','_blank'); }catch(e){} }
  if(!w){ alert('ur browser blocked the popup - in chrome tap the lock icon by the address bar, site settings, popups, allow, then hit it again. on a school chromebook popups can be locked by policy; the tab style buttons still disguise this tab.'); return; }
  var tries=0;
  (function build(){
    var ok=false;
    try{
      var d=w.document;
      if(d && d.body){
        d.title=p.t;
        var l=d.createElement('link'); l.rel='icon'; l.href=p.i; if(d.head) d.head.appendChild(l);
        d.body.style.margin='0';
        var fr=d.createElement('iframe');
        fr.src=url;
        fr.setAttribute('style','border:0;width:100vw;height:100vh;display:block');
        fr.setAttribute('allow','camera; microphone; autoplay; fullscreen');
        fr.setAttribute('allowfullscreen','');
        d.body.appendChild(fr);
        ok=true;
      }
    }catch(e){}
    if(!ok){ if(++tries<50){ setTimeout(build,60); } else { try{ w.close(); }catch(e){} alert('that tab wouldnt take the page - try hitting it again'); } }
  })();
}
// every tab cloaks itself on load: the saved disguise (picked anywhere on
// the site) applies everywhere; no choice saved yet = google by default,
// so a fresh tab never shows the real name either.
(function(){ var want='google'; try{ var v=localStorage.getItem('six_disguise'); if(v==='google'||v==='classroom'||v==='docs'||v==='drive') want=v; }catch(e){} cloakTab(want); })();
(function(){ function rep(){ try { if (window.parent === window) return; var tb = document.getElementById('tabbar'); var on = !!tb && window.matchMedia('(max-width:820px)').matches; window.parent.postMessage({ sixChrome: on ? 'tabbar' : 'plain' }, '*'); } catch (e) {} } rep(); window.addEventListener('resize', rep); })();


function gxClickoff(){
  var on=false; try{ on=localStorage.getItem('six_clickoff')==='1'; }catch(e){}
  on=!on;
  try{ localStorage.setItem('six_clickoff', on?'1':'0'); }catch(e){}
  gxClickoffPaint();
  if(on) alert('clickoff on - switch tabs or click away n this page instantly dresses up as ur tab style. tap the fake page to come back.');
}
function gxClickoffPaint(){
  var on=false; try{ on=localStorage.getItem('six_clickoff')==='1'; }catch(e){}
  document.querySelectorAll('[data-clickoff]').forEach(function(b){ b.textContent='clickoff: '+(on?'on':'off'); b.classList.toggle('on', on); });
}
function gxDecoy(){
  if(document.getElementById('gxDecoy')) return;
  var kind='google'; try{ var v=localStorage.getItem('six_disguise'); if(v) kind=v; }catch(e){}
  try{ cloakTab(kind); }catch(e){}
  var bars=''; var widths=[92,97,88,95,90,96,84,93,98,87,94,78];
  for(var i=0;i<widths.length;i++){ bars+='<div style="height:11px;border-radius:6px;background:#e8eaed;margin:0 0 15px;width:'+widths[i]+'%"></div>'; }
  var d=document.createElement('div');
  d.id='gxDecoy';
  d.setAttribute('style','position:fixed;inset:0;z-index:2147483000;background:#fff;color:#202124;font-family:Arial,sans-serif;cursor:pointer;overflow:auto');
  d.innerHTML='<div style="display:flex;align-items:center;gap:11px;padding:10px 16px;border-bottom:1px solid #e0e0e0"><svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285f4" d="M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><path fill="#a8c7fa" d="M14 2v4h4z"/><path stroke="#fff" stroke-width="1.6" stroke-linecap="round" d="M8 12h8M8 15.5h8M8 8.5h5"/></svg><span style="font-size:15px">Untitled document</span><span style="margin-left:auto;font-size:12px;color:#5f6368">All changes saved</span></div><div style="max-width:700px;margin:36px auto;padding:0 26px"><div style="height:24px;border-radius:7px;background:#dadce0;width:46%;margin-bottom:26px"></div>'+bars+'</div><div style="position:fixed;left:0;right:0;bottom:14px;text-align:center;font-size:12px;color:#9aa0a6">click anywhere to go back</div>';
  d.addEventListener('click', function(){ d.remove(); });
  document.body.appendChild(d);
}
(function(){
  function armed(){ try{ return localStorage.getItem('six_clickoff')==='1'; }catch(e){ return false; } }
  document.addEventListener('visibilitychange', function(){ if(document.hidden && armed()) gxDecoy(); });
  if(window===window.top) window.addEventListener('blur', function(){ if(armed()) gxDecoy(); });
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', gxClickoffPaint); else gxClickoffPaint();
})();
`;
const NOTIF_JS = '';
const CLOAK_BAR = `<div style="margin-top:26px;display:flex;gap:8px;flex-wrap:wrap;justify-content:center;align-items:center;color:#9a9a9a;font-size:13px">
<button onclick="cloakTab('google')" style="background:rgba(255,255,255,.07);color:#f4f4f5;border:1px solid rgba(255,255,255,.35);border-radius:999px;padding:7px 13px;cursor:pointer">google</button>
<button onclick="cloakTab('classroom')" style="background:rgba(255,255,255,.07);color:#f4f4f5;border:1px solid rgba(255,255,255,.35);border-radius:999px;padding:7px 13px;cursor:pointer">classroom</button>
<button onclick="cloakTab('docs')" style="background:rgba(255,255,255,.07);color:#f4f4f5;border:1px solid rgba(255,255,255,.35);border-radius:999px;padding:7px 13px;cursor:pointer">docs</button>
<button onclick="cloakTab('drive')" style="background:rgba(255,255,255,.07);color:#f4f4f5;border:1px solid rgba(255,255,255,.35);border-radius:999px;padding:7px 13px;cursor:pointer">drive</button><button onclick="cloakOpen()" style="background:rgba(255,255,255,.07);color:#f4f4f5;border:1px solid rgba(255,255,255,.35);border-radius:999px;padding:7px 13px;cursor:pointer">open in a tab</button><button type="button" data-clickoff onclick="gxClickoff()">clickoff: off</button></div>`;
const TABBAR_HTML = `<nav id="tabbar"><a href="/home"><svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/></svg><span>home</span></a><a href="/gs"><svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg><span>games</span></a><a href="/yt"><svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="4"/><path d="M10 9.5l5 2.5-5 2.5z" fill="currentColor" stroke="none"/></svg><span>6ixtube</span></a><a href="/apps"><svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></svg><span>apps</span></a><button id="tabMore" type="button"><svg width="21" height="21" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg><span>more</span></button></nav>
<div id="tabSheet"><a href="/yt"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="4"/><path d="m10 9 5 3-5 3z" fill="currentColor" stroke="none"/></svg><span>6ixtube</span></a><a href="/search"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg><span>search</span></a><a href="/apps"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M12 18h.01"/></svg><span>apps</span></a><a href="/emu"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="11" rx="5"/><path d="M7.5 10.5v4M5.5 12.5h4"/><circle cx="16.5" cy="11" r=".4" fill="currentColor"/><circle cx="18.5" cy="14" r=".4" fill="currentColor"/></svg><span>emulator</span></a><div class="tsh-sec">tab style</div><div class="tsh-cloak"><button onclick="cloakTab('google')">google</button><button onclick="cloakTab('classroom')">classroom</button><button onclick="cloakTab('docs')">docs</button><button onclick="cloakTab('drive')">drive</button><button onclick="cloakOpen()">open in a tab</button><button type="button" data-clickoff onclick="gxClickoff()">clickoff: off</button></div></div>
<script>
(function(){ if (window.parent !== window) { document.documentElement.classList.add('gx-framed'); var bar0 = document.getElementById('tabbar'); if (bar0) bar0.style.bottom = '6px'; var sh0 = document.getElementById('tabSheet'); if (sh0) sh0.style.bottom = '80px'; } var p = location.pathname; document.querySelectorAll('#tabbar a, #tabSheet a').forEach(function(a){ if (a.getAttribute('href') === p) a.classList.add('on'); }); document.querySelectorAll('#tabbar a').forEach(function(a){ a.addEventListener('click', function(e){ if (a.getAttribute('href') === p) { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); } }); }); var tm = document.getElementById('tabMore'), sh = document.getElementById('tabSheet'); if (tm && sh) { tm.addEventListener('click', function(){ sh.classList.toggle('open'); }); document.addEventListener('click', function(e){ if (sh.classList.contains('open') && !sh.contains(e.target) && !tm.contains(e.target)) sh.classList.remove('open'); }); } })();
</script>`;
const SIDEBAR_HTML = `<canvas id=\"stars\"></canvas><script src=\"/stars.js?e=96\"></script><style>
#siderail{display:none}
@media(min-width:1100px){
body[data-nav=\"side\"]{padding:22px 18px 48px 250px}
body[data-nav=\"side\"] #siderail{display:flex;position:fixed;left:0;top:0;bottom:0;width:232px;z-index:55;flex-direction:column;gap:4px;padding:16px 12px;box-sizing:border-box;background:rgba(9,8,18,.82);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);border-right:1px solid rgba(255,255,255,.09);overflow-y:auto}
body[data-nav=\"side\"] #topbar{background:none;border:0;box-shadow:none;pointer-events:none;-webkit-backdrop-filter:none;backdrop-filter:none}
body[data-nav=\"side\"] #topbar .tb-logo,body[data-nav=\"side\"] #topbar .tb-links,body[data-nav=\"side\"] #topbar .tb-search{display:none}
body[data-nav=\"side\"] .tb-menuwrap{position:fixed;top:12px;right:12px;pointer-events:auto}
}
#siderail .rl-logo{font-size:19px;font-weight:800;letter-spacing:-.02em;color:#fafafa;text-decoration:none;padding:4px 10px 14px;background:linear-gradient(94deg,#f0abfc,#a78bfa 25%,#38bdf8 48%,#34d399 68%,#facc15 85%,#fb7185);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
#siderail .rl-logo span{color:transparent}
#siderail .rl{display:flex;flex-direction:column;gap:2px}
#siderail .rl a{display:flex;align-items:center;gap:11px;color:#d8d3e4;text-decoration:none;font-size:14.5px;font-weight:600;padding:8px 10px;border-radius:11px}
#siderail .rl a:hover{background:rgba(255,255,255,.06);color:#fff}
#siderail .rl a.on{background:rgba(var(--acc),.18);color:#fff}
#siderail .rl-foot{margin-top:auto;border-top:1px solid rgba(255,255,255,.09);padding-top:10px;display:flex;flex-direction:column;gap:2px}
#siderail .rl-foot a,#siderail .rl-foot button{display:flex;align-items:center;gap:11px;color:#d8d3e4;text-decoration:none;font-size:14.5px;font-weight:600;padding:8px 10px;border-radius:11px;background:none;border:0;cursor:pointer;font-family:inherit;text-align:left}
#siderail .rl-foot a:hover,#siderail .rl-foot button:hover{background:rgba(255,255,255,.06);color:#fff}
.dm-pers button.on{background:rgba(var(--acc),.25);border-color:rgba(var(--star),.5);color:#fff}
body[data-acc=\"crimson\"]{--acc:235,64,80;--acc2:176,28,46;--acc3:255,122,133;--star:255,170,170}
body[data-acc=\"crimson\"] .tb-logo span,body[data-acc=\"crimson\"] #siderail .rl-logo span{color:#ff8291}
body[data-acc=\"crimson\"] .lcard svg{color:#ff9aa2}
body[data-acc=\"azure\"]{--acc:56,132,255;--acc2:30,90,200;--acc3:120,180,255;--star:170,210,255}
body[data-acc=\"azure\"] .tb-logo span,body[data-acc=\"azure\"] #siderail .rl-logo span{color:#7db4ff}
body[data-acc=\"azure\"] .lcard svg{color:#a8ccff}
body[data-acc=\"toxic\"]{--acc:120,220,60;--acc2:74,160,32;--acc3:180,245,130;--star:200,250,170}
body[data-acc=\"toxic\"] .tb-logo span,body[data-acc=\"toxic\"] #siderail .rl-logo span{color:#a5ec7d}
body[data-acc=\"toxic\"] .lcard svg{color:#c0f2a0}
body[data-acc=\"gold\"]{--acc:240,180,40;--acc2:190,130,20;--acc3:255,214,100;--star:255,226,150}
body[data-acc=\"gold\"] .tb-logo span,body[data-acc=\"gold\"] #siderail .rl-logo span{color:#ffd166}
body[data-acc=\"gold\"] .lcard svg{color:#ffdd94}
body[data-acc=\"rose\"]{--acc:244,114,182;--acc2:200,60,140;--acc3:255,170,214;--star:255,190,225}
body[data-acc=\"rose\"] .tb-logo span,body[data-acc=\"rose\"] #siderail .rl-logo span{color:#ff9ecd}
body[data-acc=\"rose\"] .lcard svg{color:#ffbfe3}
body[data-motion=\"off\"] *,body[data-motion=\"off\"] *::before,body[data-motion=\"off\"] *::after{animation-duration:.001s!important;transition-duration:.001s!important}
body[data-motion=\"off\"] #stars{display:none}
body[data-motion=\"off\"] #stars.gx-home{display:block}
#tbMe{display:flex;align-items:center;text-decoration:none}
#tbMe[hidden]{display:none}
#tbMe .tbme-login{font-size:13.5px;font-weight:700;color:#0a0a0b;background:#f4f4f5;border-radius:999px;padding:7px 14px;white-space:nowrap}
#tbMe .meav{border:2px solid rgba(var(--star),.45)}
.meav{display:inline-flex;align-items:center;justify-content:center;width:31px;height:31px;border-radius:50%;overflow:hidden;flex:none;font-size:13px;color:#fff;font-weight:800}
.meav.sm{width:21px;height:21px;font-size:10px}
.meav img{width:100%;height:100%;object-fit:cover}
#siderail .rl-foot .rmeta{display:flex;flex-direction:column;line-height:1.2;min-width:0}
#siderail .rl-foot .rmeta b{font-size:14.5px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#siderail .rl-foot .rmeta i{font-style:normal;font-size:12px;color:#9d99ad;font-weight:500}
#tabSheet a .meav{width:26px;height:26px;font-size:11px}
@media(min-width:1100px){body[data-nav=\"side\"] #tbMe{display:none}}

</style><header id=\"topbar\"><a class=\"tb-logo\" href=\"/home\">6net<span>lite</span></a><nav class=\"tb-links\"><a href=\"/home\"><svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z\"/><path d=\"M9 22V12h6v10\"/></svg>home</a><a href=\"/gs\"><svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"3\" y=\"3\" width=\"7\" height=\"7\" rx=\"1\"/><rect x=\"14\" y=\"3\" width=\"7\" height=\"7\" rx=\"1\"/><rect x=\"14\" y=\"14\" width=\"7\" height=\"7\" rx=\"1\"/><rect x=\"3\" y=\"14\" width=\"7\" height=\"7\" rx=\"1\"/></svg>games</a></nav><a class=\"tb-search\" href=\"/search\" aria-label=\"search\"><svg width=\"17\" height=\"17\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"11\" cy=\"11\" r=\"7\"/><path d=\"m21 21-4.3-4.3\"/></svg></a><div class=\"tb-menuwrap\"><button id=\"menuBtn\" type=\"button\" aria-label=\"menu\">menu<svg width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"m6 9 6 6 6-6\"/></svg></button><div id=\"dropmenu\"><div class=\"dm-grid\"><a href=\"/home\"><svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z\"/><path d=\"M9 22V12h6v10\"/></svg>home</a><a href=\"/gs\"><svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"3\" y=\"3\" width=\"7\" height=\"7\" rx=\"1\"/><rect x=\"14\" y=\"3\" width=\"7\" height=\"7\" rx=\"1\"/><rect x=\"14\" y=\"14\" width=\"7\" height=\"7\" rx=\"1\"/><rect x=\"3\" y=\"14\" width=\"7\" height=\"7\" rx=\"1\"/></svg>games</a><a href=\"/yt\"><svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"2\" y=\"5\" width=\"20\" height=\"14\" rx=\"4\"/><path d=\"m10 9 5 3-5 3z\" fill=\"currentColor\" stroke=\"none\"/></svg>6ixtube</a><a href=\"/search\"><svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"11\" cy=\"11\" r=\"7\"/><path d=\"m21 21-4.3-4.3\"/></svg>search</a><a href=\"/apps\"><svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"7\" y=\"2\" width=\"10\" height=\"20\" rx=\"2\"/><path d=\"M12 18h.01\"/></svg>apps</a><a href=\"/emu\"><svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"2\" y=\"7\" width=\"20\" height=\"11\" rx=\"5\"/><path d=\"M7.5 10.5v4M5.5 12.5h4\"/><circle cx=\"16.5\" cy=\"11\" r=\".4\" fill=\"currentColor\"/><circle cx=\"18.5\" cy=\"14\" r=\".4\" fill=\"currentColor\"/></svg>emulator</a></div><div class=\"dm-sec\">ask six</div><form id=\"dmAsk\"><input id=\"dmQ\" type=\"text\" placeholder=\"ask six anything...\" autocomplete=\"off\"><button type=\"submit\">ask</button></form><div id=\"dmAns\" hidden></div><div class=\"dm-sec\">tab style</div><div class=\"sb-cloak\"><button onclick=\"cloakTab('google')\">google</button><button onclick=\"cloakTab('classroom')\">classroom</button><button onclick=\"cloakTab('docs')\">docs</button><button onclick=\"cloakTab('drive')\">drive</button><button onclick=\"cloakOpen()\">open in a tab</button><button type="button" data-clickoff onclick="gxClickoff()">clickoff: off</button></div><div class=\"dm-sec\">sky</div><div class=\"sb-cloak dm-sky\"><button type=\"button\" data-sky=\"nebula\" onclick=\"gxSetSky('nebula')\">nebula</button><button type=\"button\" data-sky=\"amber\" onclick=\"gxSetSky('amber')\">amber</button><button type=\"button\" data-sky=\"violet\" onclick=\"gxSetSky('violet')\">violet</button><button type=\"button\" data-sky=\"ice\" onclick=\"gxSetSky('ice')\">ice</button><button type=\"button\" data-sky=\"blood\" onclick=\"gxSetSky('blood')\">blood moon</button></div><div class=\"dm-sec\">personalize</div><div class=\"sb-cloak dm-pers\"><button type=\"button\" data-navm=\"bar\" onclick=\"gxSetNav('bar')\">top bar</button><button type=\"button\" data-navm=\"side\" onclick=\"gxSetNav('side')\">sidebar</button><button type=\"button\" data-accm=\"\" onclick=\"gxSetAcc('')\">accent: sky</button><button type=\"button\" data-accm=\"crimson\" onclick=\"gxSetAcc('crimson')\">crimson</button><button type=\"button\" data-accm=\"azure\" onclick=\"gxSetAcc('azure')\">azure</button><button type=\"button\" data-accm=\"toxic\" onclick=\"gxSetAcc('toxic')\">toxic</button><button type=\"button\" data-accm=\"gold\" onclick=\"gxSetAcc('gold')\">gold</button><button type=\"button\" data-accm=\"rose\" onclick=\"gxSetAcc('rose')\">rose</button><button type=\"button\" data-motion onclick=\"gxToggleMotion()\">animations: on</button><button type=\"button\" data-lights onclick=\"gxToggleLights()\">christmas lights: on</button></div></div></div></header><aside id=\"siderail\"><a class=\"rl-logo\" href=\"/home\">6net<span>lite</span></a><nav class=\"rl\"><a href=\"/home\"><svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z\"/><path d=\"M9 22V12h6v10\"/></svg><span>home</span></a><a href=\"/gs\"><svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"3\" y=\"3\" width=\"7\" height=\"7\" rx=\"1\"/><rect x=\"14\" y=\"3\" width=\"7\" height=\"7\" rx=\"1\"/><rect x=\"14\" y=\"14\" width=\"7\" height=\"7\" rx=\"1\"/><rect x=\"3\" y=\"14\" width=\"7\" height=\"7\" rx=\"1\"/></svg><span>games</span></a><a href=\"/yt\"><svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"2\" y=\"5\" width=\"20\" height=\"14\" rx=\"4\"/><path d=\"m10 9 5 3-5 3z\" fill=\"currentColor\" stroke=\"none\"/></svg><span>6ixtube</span></a><a href=\"/search\"><svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"11\" cy=\"11\" r=\"7\"/><path d=\"m21 21-4.3-4.3\"/></svg><span>search</span></a><a href=\"/apps\"><svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"7\" y=\"2\" width=\"10\" height=\"20\" rx=\"2\"/><path d=\"M12 18h.01\"/></svg><span>apps</span></a><a href=\"/emu\"><svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"2\" y=\"7\" width=\"20\" height=\"11\" rx=\"5\"/><path d=\"M7.5 10.5v4M5.5 12.5h4\"/><circle cx=\"16.5\" cy=\"11\" r=\".4\" fill=\"currentColor\"/><circle cx=\"18.5\" cy=\"14\" r=\".4\" fill=\"currentColor\"/></svg><span>emulator</span></a></nav><div class=\"rl-foot\"><button id=\"railMenu\" type=\"button\"><svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M4 6h9M19 6h1M4 12h3M13 12h7M4 18h11M21 18h-1\"/><circle cx=\"16\" cy=\"6\" r=\"2\"/><circle cx=\"10\" cy=\"12\" r=\"2\"/><circle cx=\"18\" cy=\"18\" r=\"2\"/></svg><span>more</span></button></div></aside><div class=\"xlights xsite\" aria-hidden=\"true\"></div>${TABBAR_HTML}<script>
(function(){ document.body.classList.add('has-tb'); var p = location.pathname; document.querySelectorAll('.tb-links a,.dm-grid a').forEach(function(a){ if (a.getAttribute('href') === p) a.classList.add('on'); });
var mb = document.getElementById('menuBtn');
if (mb) mb.addEventListener('click', function(e){ e.stopPropagation(); document.body.classList.toggle('menu-open'); });
document.addEventListener('click', function(e){ if (document.body.classList.contains('menu-open') && !e.target.closest('#dropmenu')) document.body.classList.remove('menu-open'); });
document.addEventListener('keydown', function(e){ if (e.key === 'Escape') document.body.classList.remove('menu-open'); }); })();
</script><script>
window.gxSetSky = function(m){ try{ localStorage.setItem('gx_sky', m); }catch(e){} document.body.setAttribute('data-sky', m); window.dispatchEvent(new CustomEvent('gxsky', { detail: m })); document.querySelectorAll('.dm-sky button').forEach(function(b){ b.classList.toggle('on', b.getAttribute('data-sky') === m); }); };
(function(){ var cur = 'nebula'; try{ cur = localStorage.getItem('gx_sky') || 'nebula'; }catch(e){} document.body.setAttribute('data-sky', cur); document.querySelectorAll('.dm-sky button').forEach(function(b){ b.classList.toggle('on', b.getAttribute('data-sky') === cur); });
var logo = document.querySelector('.tb-logo'); var holdT = null, held = false;
if (logo) { logo.addEventListener('pointerdown', function(){ held = false; holdT = setTimeout(function(){ held = true; if (window.panic) panic(); else location.href = 'https://classroom.google.com/'; }, 620); }); ['pointerup','pointerleave','pointercancel'].forEach(function(ev){ logo.addEventListener(ev, function(){ if (holdT) clearTimeout(holdT); }); }); logo.addEventListener('click', function(e){ if (held) { e.preventDefault(); held = false; } }); }
var f = document.getElementById('dmAsk');
if (f) { f.addEventListener('submit', function(ev){ ev.preventDefault(); var q = document.getElementById('dmQ').value.trim(); if (!q) return; var ans = document.getElementById('dmAns'); ans.hidden = false; ans.textContent = 'six is thinkin...'; fetch('/ai/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: q }] }) }).then(function(r){ return r.json(); }).then(function(o){ ans.textContent = (o && o.text) || 'six had nothin for that one'; }).catch(function(){ ans.textContent = 'six is unreachable rn — open the six ai page'; }); }); }
})();
</script><script>
window.gxSetNav = function(m){ try{ localStorage.setItem('gx_nav2', m); }catch(e){} document.body.setAttribute('data-nav', m); document.querySelectorAll('.dm-pers [data-navm]').forEach(function(b){ b.classList.toggle('on', b.getAttribute('data-navm') === m); }); };
window.gxSetAcc = function(m){ try{ if (m) localStorage.setItem('gx_acc', m); else localStorage.removeItem('gx_acc'); }catch(e){} if (m) document.body.setAttribute('data-acc', m); else document.body.removeAttribute('data-acc'); document.querySelectorAll('.dm-pers [data-accm]').forEach(function(b){ b.classList.toggle('on', (b.getAttribute('data-accm') || '') === (m || '')); }); };
window.gxToggleMotion = function(){ var off = document.body.getAttribute('data-motion') === 'off'; try{ localStorage.setItem('gx_motion', off ? 'on' : 'off'); }catch(e){} if (off) document.body.removeAttribute('data-motion'); else document.body.setAttribute('data-motion', 'off'); gxPersLabels(); };
window.gxToggleLights = function(){ var off = document.body.getAttribute('data-lights') === 'on'; try{ localStorage.setItem('gx_lights', off ? 'off' : 'on'); }catch(e){} if (off) document.body.removeAttribute('data-lights'); else document.body.setAttribute('data-lights', 'on'); gxPersLabels(); };
window.gxPersLabels = function(){ var mb = document.querySelector('.dm-pers [data-motion]'); if (mb) mb.textContent = 'animations: ' + (document.body.getAttribute('data-motion') === 'off' ? 'off' : 'on'); var lb = document.querySelector('.dm-pers [data-lights]'); if (lb) lb.textContent = 'christmas lights: ' + (document.body.getAttribute('data-lights') === 'on' ? 'on' : 'off'); };

window.gxBuildSiteLights = function(){
  var boxes = document.querySelectorAll('.xlights.xsite');
  if (!boxes.length) return;
  var cols = ['#ff4646', '#ffd23e', '#3e8bff', '#3ee06a', '#ff5da2'];
  var dark = ['#c81e1e', '#d99a06', '#1e56c8', '#12963a', '#c2185b'];
  boxes.forEach(function(box, bi){
    var W = box.clientWidth || window.innerWidth || 1200, H = 54;
    var n = Math.max(1, Math.round(W / (W < 600 ? W / 2 : 340)));
    var swagW = W / n, sag = W < 600 ? 20 : 24, cy = 2 * sag - 2, uid = 'sg' + bi + 'x';
    var defs = '';
    for (var ci = 0; ci < 5; ci++) {
      defs += '<radialGradient id="' + uid + 'g' + ci + '"><stop offset="0%" stop-color="' + cols[ci] + '" stop-opacity=".55"/><stop offset="100%" stop-color="' + cols[ci] + '" stop-opacity="0"/></radialGradient>';
      defs += '<radialGradient id="' + uid + 'b' + ci + '" cx="38%" cy="28%" r="85%"><stop offset="0%" stop-color="#ffffff" stop-opacity=".95"/><stop offset="35%" stop-color="' + cols[ci] + '"/><stop offset="100%" stop-color="' + dark[ci] + '"/></radialGradient>';
    }
    defs += '<linearGradient id="' + uid + 's" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#3a3f45"/><stop offset="100%" stop-color="#14161a"/></linearGradient>';
    var out = '', idx = 0;
    function bulb(px, py, ci, big) {
      var by = py + (big ? 11 : 8), hr = big ? 12 : 8, br = big ? 4.6 : 3;
      var s = '<circle class="xg" cx="' + px.toFixed(1) + '" cy="' + by.toFixed(1) + '" r="' + hr + '" fill="url(#' + uid + 'g' + ci + ')" style="animation-delay:-' + ((idx * 0.37) % 2.6).toFixed(2) + 's"/>';
      s += '<rect x="' + (px - 2.1).toFixed(1) + '" y="' + py.toFixed(1) + '" width="4.2" height="5" rx="1.2" fill="url(#' + uid + 's)"/>';
      s += '<circle class="xb" cx="' + px.toFixed(1) + '" cy="' + by.toFixed(1) + '" r="' + br + '" fill="url(#' + uid + 'b' + ci + ')" style="animation-delay:-' + ((idx * 0.29) % 1.8).toFixed(2) + 's"/>';
      idx++; return s;
    }
    for (var sg = 0; sg < n; sg++) {
      var x0 = sg * swagW, x1 = x0 + swagW, xm = x0 + swagW / 2;
      out += '<path d="M' + x0 + ' -2 Q' + xm + ' ' + cy + ' ' + x1 + ' -2" fill="none" stroke="rgba(0,0,0,.5)" stroke-width="1.6"/>';
      var steps = Math.max(4, Math.floor(swagW / 44));
      for (var k = 0; k <= steps; k++) {
        var t = k / steps, mt = 1 - t;
        var px = mt * mt * x0 + 2 * mt * t * xm + t * t * x1;
        var py = mt * mt * -2 + 2 * mt * t * cy + t * t * -2;
        if (py > 3) out += bulb(px, py, idx % 5, true);
        if (k < steps) {
          var t2 = (k + 0.5) / steps, m2 = 1 - t2;
          var qx = m2 * m2 * x0 + 2 * m2 * t2 * xm + t2 * t2 * x1;
          var qy = m2 * m2 * -2 + 2 * m2 * t2 * cy + t2 * t2 * -2;
          if (qy > 3) out += bulb(qx, qy, idx % 5, false);
        }
      }
    }
    box.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '" aria-hidden="true"><defs>' + defs + '</defs>' + out + '</svg>';
  });
};
(function(){ function go(){ window.gxBuildSiteLights(); } if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go(); var gxr; window.addEventListener('resize', function(){ clearTimeout(gxr); gxr = setTimeout(go, 220); }); })();
(function(){ var nav = 'side', acc = '', motion = 'on', lights = ''; try{ nav = localStorage.getItem('gx_nav2') || 'side'; acc = localStorage.getItem('gx_acc') || ''; motion = localStorage.getItem('gx_motion') || 'on'; lights = localStorage.getItem('gx_lights') || ''; }catch(e){}
document.body.setAttribute('data-nav', nav); if (acc) document.body.setAttribute('data-acc', acc); if (motion === 'off') document.body.setAttribute('data-motion', 'off');
if (lights === 'on' || (lights !== 'off' && [10, 11, 0].indexOf(new Date().getMonth()) >= 0)) document.body.setAttribute('data-lights', 'on');
document.querySelectorAll('.dm-pers [data-navm]').forEach(function(b){ b.classList.toggle('on', b.getAttribute('data-navm') === nav); });
document.querySelectorAll('.dm-pers [data-accm]').forEach(function(b){ b.classList.toggle('on', (b.getAttribute('data-accm') || '') === acc); });
window.gxPersLabels();
var rb = document.getElementById('railMenu'); if (rb) rb.addEventListener('click', function(e){ e.stopPropagation(); var mb = document.getElementById('menuBtn'); if (mb) mb.click(); });
var p = location.pathname; document.querySelectorAll('#siderail .rl a').forEach(function(a){ if (a.getAttribute('href') === p) a.classList.add('on'); });
})();
</script><script>
(function(){
  function esc(x){ return String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function avBg(me){ return (me.hue !== null && me.hue !== undefined) ? 'hsl(' + me.hue + ',45%,38%)' : '#3f3f46'; }
  function avHTML(me, sm){ if (me.av) return '<img src="' + me.av + '" alt="">'; return esc((me.disp || me.user || '?').slice(0, 1).toUpperCase()); }
  function paint(me){
    var tb = document.getElementById('tbMe');
    var rail = document.querySelector('#siderail .rl-foot a[href="/account"]');
    var dm = document.querySelector('#dropmenu a[href="/account"]');
    var sheet = document.querySelector('#tabSheet a[href="/account"]');
    if (!me || !me.user) {
      if (tb) { tb.hidden = false; tb.href = '/login'; tb.innerHTML = '<span class="tbme-login">log in</span>'; }
      return;
    }
    var prof = '/u/' + encodeURIComponent(me.user);
    var nm = esc(me.disp || me.user);
    if (tb) { tb.hidden = false; tb.href = prof; tb.title = nm + ' — ur profile'; tb.innerHTML = '<span class="meav" style="background:' + avBg(me) + '">' + avHTML(me) + '</span>'; }
    if (rail) { rail.href = prof; rail.innerHTML = '<span class="meav" style="background:' + avBg(me) + '">' + avHTML(me) + '</span><span class="rmeta"><b>' + nm + '</b><i>@' + esc(me.user) + '</i></span>'; }
    if (dm) { dm.href = prof; dm.innerHTML = '<span class="meav sm" style="background:' + avBg(me) + '">' + avHTML(me, 1) + '</span>' + nm; }
    if (sheet) { sheet.href = prof; sheet.innerHTML = '<span class="meav" style="background:' + avBg(me) + '">' + avHTML(me) + '</span><span>' + nm + '</span>'; }
  }
  var cached = null; try { cached = JSON.parse(localStorage.getItem('six_me2') || 'null'); } catch(e){}
  if (cached && cached.user) paint(cached);
  fetch('/auth/me').then(function(r){ return r.json(); }).then(function(o){
    if (o && o.user) { var me = { user: o.user, disp: o.disp || '', hue: (o.hue === undefined ? null : o.hue), av: o.av || '' }; try { localStorage.setItem('six_me2', JSON.stringify(me)); } catch(e){} paint(me); }
    else { try { localStorage.removeItem('six_me2'); } catch(e){} paint(null); }
  }).catch(function(){});
  fetch('/auth/friends').then(function(r){ return r.json(); }).then(function(o){
    if (!o || !o.ok || !o.friends) return;
    var n = o.friends.filter(function(f){ return f.online; }).length;
    if (!n) return;
    var i = document.querySelector('#siderail .rl-foot .rmeta i');
    if (i) i.textContent = i.textContent + ' \u00b7 ' + n + ' friend' + (n === 1 ? '' : 's') + ' online';
  }).catch(function(){});
})();
</script><style>
#veil{position:fixed;inset:0;background:#050508;opacity:0;pointer-events:none;transition:opacity .16s ease;z-index:400}
#veil.on{opacity:1;pointer-events:all}
#pbar{position:fixed;top:0;left:0;height:2px;width:100%;background:linear-gradient(90deg,rgb(var(--acc)),rgb(var(--star)));transform-origin:0 50%;transform:scaleX(0);z-index:210;pointer-events:none}
.wrap{animation:gxFade .35s ease both}
@keyframes gxFade{from{opacity:0}to{opacity:1}}
.rv{opacity:0;transform:translateY(16px)}
.rv.in{opacity:1;transform:none;transition:opacity .5s ease,transform .5s cubic-bezier(.2,.7,.2,1)}
@media(hover:hover) and (pointer:fine){
.card,.ppcard,.lcard{position:relative}
.card::after,.ppcard::after,.lcard::after{content:'';position:absolute;inset:0;border-radius:inherit;background:radial-gradient(320px circle at var(--mx,50%) var(--my,50%),rgba(255,255,255,.09),transparent 65%);opacity:0;transition:opacity .25s;pointer-events:none}
.card:hover::after,.ppcard:hover::after,.lcard:hover::after{opacity:1}
}
</style><div id="veil"></div><div id="pbar"></div><script>
(function(){
  var off = false;
  try { off = localStorage.getItem('gx_motion') === 'off'; } catch(e){}
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) off = true;
  var veil = document.getElementById('veil');
  if (!off && veil) {
    document.addEventListener('click', function(ev){
      if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
      if (!a) return;
      var href = a.getAttribute('href') || '';
      if (!href || href.charAt(0) === '#' || a.target === '_blank' || a.hasAttribute('download')) return;
      if (href.indexOf('/dl') === 0 || href.indexOf('/go') === 0) return;
      var url; try { url = new URL(a.href, location.href); } catch(e){ return; }
      if (url.origin !== location.origin) return;
      if (url.pathname === location.pathname && url.search === location.search) return;
      ev.preventDefault();
      veil.classList.add('on');
      setTimeout(function(){ location.href = a.href; }, 150);
    }, true);
  }
  var pb = document.getElementById('pbar');
  if (pb) {
    var tk = false;
    function upd(){ tk = false; var h = document.documentElement; var max = h.scrollHeight - h.clientHeight; pb.style.transform = 'scaleX(' + (max > 0 ? Math.min(1, h.scrollTop / max) : 0) + ')'; }
    window.addEventListener('scroll', function(){ if (!tk) { tk = true; requestAnimationFrame(upd); } }, { passive: true });
    upd();
  }
  if (!off && window.IntersectionObserver) {
    var io = new IntersectionObserver(function(es){ es.forEach(function(en){ if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }); }, { threshold: 0.08 });
    var groups = ['#grid', '#mvGrid', '#newsFeed', '#cfFeed', '.pp-grid', '#ppLog', '#actList', '.launch'];
    function scan(){
      groups.forEach(function(sel){
        document.querySelectorAll(sel).forEach(function(box){
          var kids = box.children;
          for (var i = 0; i < kids.length; i++) {
            var k = kids[i];
            if (!k.classList.contains('rv') && !k.classList.contains('in')) { k.classList.add('rv'); k.style.transitionDelay = Math.min(i, 10) * 35 + 'ms'; io.observe(k); }
          }
        });
      });
    }
    scan();
    if (window.MutationObserver) { var t; new MutationObserver(function(){ clearTimeout(t); t = setTimeout(scan, 250); }).observe(document.body, { childList: true, subtree: true }); }
  }
  if (window.matchMedia && matchMedia('(hover: hover) and (pointer: fine)').matches) {
    document.addEventListener('pointermove', function(ev){
      var c = ev.target && ev.target.closest ? ev.target.closest('.card, .ppcard, .lcard') : null;
      if (!c) return;
      var r = c.getBoundingClientRect();
      if (!r.width) return;
      c.style.setProperty('--mx', ((ev.clientX - r.left) / r.width * 100) + '%');
      c.style.setProperty('--my', ((ev.clientY - r.top) / r.height * 100) + '%');
    }, { passive: true });
  }
})();
</script>`;
// ---------- galaxy theme ----------
// relaxing deep-space look shared by every page: layered nebula gradients,
// a slow twinkling starfield canvas (served from /stars.js), glass panels,
// soft rounded type (Inter + Inter), all-lowercase niche copy.
const FONT_LINKS = '<link href="/fonts.css" rel="stylesheet">';
const STAR_CANVAS = ''; // minimal theme: no starfield
const GALAXY_CSS = `
.xlights{display:none;pointer-events:none}body[data-lights="on"] .xlights{display:block}.xlights svg{width:100%;height:100%;display:block;overflow:visible}.xlights.xsite{position:fixed !important;top:-14px !important;left:0 !important;right:0 !important;height:54px !important;z-index:3}body[data-nav="bar"] .xlights.xsite{top:36px !important}@media (max-width:1099px){.xlights.xsite{top:36px !important}}.xlights .xb{animation:xblink 1.8s linear infinite}.xlights .xg{animation:xglowp 2.6s ease-in-out infinite}@keyframes xblink{0%,52%{opacity:1}62%,100%{opacity:.15}}@keyframes xglowp{0%,100%{opacity:.65}50%{opacity:.12}}body[data-motion="off"] .xlights .xb,body[data-motion="off"] .xlights .xg{animation:none}@media (prefers-reduced-motion: reduce){.xlights .xb,.xlights .xg{animation:none}}
*{box-sizing:border-box;margin:0}
html{background:#030304}
body{background:#030304;color:#f4f4f5;font-family:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:56px 16px 48px;overflow-x:hidden;-webkit-font-smoothing:antialiased}
h1{font-size:clamp(28px,5vw,38px);font-weight:600;letter-spacing:-.02em;text-transform:lowercase;color:#fafafa;margin-bottom:10px;text-align:center}
p.sub{color:#a1a1aa;margin-bottom:30px;font-size:15px;text-align:center;max-width:600px;line-height:1.55;font-weight:400}
form{display:flex;width:100%;max-width:640px;gap:10px}
input{flex:1;background:#131315;border:1px solid rgba(255,255,255,.12);border-radius:10px;color:#fff;padding:13px 16px;font-size:16px;outline:none;font-family:inherit;transition:border-color .15s, box-shadow .15s}
input::placeholder{color:#63636b}
input:focus{border-color:rgba(255,255,255,.35);box-shadow:0 0 0 3px rgba(255,255,255,.08)}
button{background:#fafafa;color:#0a0a0b;border:1px solid #fafafa;border-radius:10px;padding:13px 22px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit;transition:background .15s, border-color .15s}
button:hover{background:#e4e4e7;border-color:#e4e4e7}
.links{margin-top:32px;display:flex;flex-wrap:wrap;gap:8px;justify-content:center;max-width:680px}
.links a{color:#d4d4d8;text-decoration:none;background:#131315;border:1px solid rgba(255,255,255,.1);padding:9px 15px;border-radius:999px;font-size:14px;font-weight:500;transition:border-color .15s, background .15s}
.links a:hover{border-color:rgba(255,255,255,.28);background:#1a1a1d}
footer,.foot{margin-top:auto;padding-top:44px;color:#63636b;font-size:12.5px;text-align:center;max-width:640px;line-height:1.6}
::selection{background:rgba(var(--acc),.4)}
::-webkit-scrollbar{width:10px}::-webkit-scrollbar-thumb{background:#2c2c30;border-radius:8px}::-webkit-scrollbar-track{background:transparent}
.wrap{width:100%;max-width:1120px;margin:0 auto}
a.back{display:inline-flex;align-items:center;gap:6px;color:#f4f4f5;text-decoration:none;font-size:13.5px;font-weight:600;background:rgba(10,9,20,.55);border:1px solid rgba(var(--star),.22);border-radius:999px;padding:8px 14px;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
.bar{display:flex;gap:10px;flex-wrap:wrap;margin:6px 0 20px;width:100%;max-width:1120px}
.bar input{flex:1;min-width:200px;padding:12px 15px;font-size:15px}
.bar select{background:#131315;border:1px solid rgba(255,255,255,.12);border-radius:10px;color:#f4f4f5;padding:12px;font-size:15px;font-family:inherit;outline:none}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px;width:100%;max-width:1120px}
.card{background:#101012;border:1px solid rgba(255,255,255,.08);border-radius:12px;overflow:hidden;text-decoration:none;color:#f4f4f5;display:block;transition:border-color .15s}
.card:hover{border-color:rgba(255,255,255,.24)}
.card img{width:100%;aspect-ratio:4/3;object-fit:cover;display:block;background:#17171a}
.noimg{width:100%;aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;color:#63636b;background:#17171a;font-size:12px}
.gicon{padding:0}.gicon svg{width:100%;height:100%;display:block}
.gt{padding:10px 12px 2px;font-size:14px;font-weight:600}
.gc{padding:0 12px 12px;font-size:12px;color:#8b8b93}
body.playbody{padding:0;height:100vh}
.top{display:flex;gap:8px;align-items:center;padding:9px 12px;background:#0e0e10;border-bottom:1px solid rgba(255,255,255,.09);flex-wrap:wrap;width:100%}
.top .title{font-weight:600;margin-right:auto;font-size:15px;letter-spacing:-.01em}
.top a,.top button{background:#17171a;color:#e4e4e7;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:8px 13px;cursor:pointer;text-decoration:none;font-size:13px;font-weight:600;font-family:inherit}
.top button.on{border-color:rgba(var(--star),.55);color:#fff;background:rgba(var(--acc),.2)}
iframe.gameframe{flex:1;width:100%;border:0;background:#000}

#sbBtn{position:fixed;top:14px;left:14px;z-index:60;width:40px;height:40px;display:flex;align-items:center;justify-content:center;background:#131315;border:1px solid rgba(255,255,255,.12);border-radius:10px;color:#f4f4f5;cursor:pointer;padding:0}
#sbScrim{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:55;opacity:0;pointer-events:none;transition:opacity .2s}
#sb{position:fixed;top:0;left:0;bottom:0;width:236px;z-index:56;background:#0e0e10;border-right:1px solid rgba(255,255,255,.08);padding:20px 14px;display:flex;flex-direction:column;gap:2px;transform:translateX(-105%);transition:transform .22s ease;overflow-y:auto;text-align:left}
body.sb-open #sb{transform:none}
body.sb-open #sbScrim{opacity:1;pointer-events:auto}
.sb-logo{font-weight:700;font-size:17px;color:#fafafa;text-decoration:none;letter-spacing:-.02em;padding:4px 10px 16px}
.sb-logo span{color:#63636b;font-weight:600}
#sb nav{display:flex;flex-direction:column;gap:2px}
#sb nav a{display:flex;align-items:center;gap:11px;padding:9px 10px;border-radius:8px;color:#c9c9ce;text-decoration:none;font-size:14px;font-weight:500}
#sb nav a:hover{background:#17171a;color:#fff}
#sb nav a.on{background:rgba(var(--acc),.16);color:#fff}
#sb nav a svg{flex:none;opacity:.8}
.sb-sec{margin:20px 10px 7px;font-size:11px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:#63636b}
.sb-cloak{display:flex;flex-wrap:wrap;gap:6px;padding:0 2px}
.sb-cloak button{background:#17171a;color:#d4d4d8;border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:6px 11px;font-size:12.5px;font-weight:500;cursor:pointer;font-family:inherit}
.sb-cloak button:hover{border-color:rgba(255,255,255,.3);color:#fff}
.sb-foot{margin-top:auto;padding:16px 10px 2px;color:#4b4b52;font-size:12px;line-height:1.55}
@media(min-width:900px){ #sb{transform:none} #sbBtn{display:none} body:has(aside#sb),body.has-sb{padding-left:252px} }
.launch{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;width:100%;max-width:640px;margin-top:36px;text-align:left}
.starfield{position:fixed;inset:0;z-index:0;pointer-events:none;background-image:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='480' height='480'><circle cx='169' cy='81' r='1.6' fill='%23c4b5fd' fill-opacity='0.55'/><circle cx='278' cy='52' r='1.3' fill='white' fill-opacity='0.55'/><circle cx='113' cy='23' r='1' fill='white' fill-opacity='1'/><circle cx='127' cy='50' r='2' fill='%23c4b5fd' fill-opacity='1'/><circle cx='293' cy='67' r='1' fill='white' fill-opacity='0.55'/><circle cx='207' cy='29' r='1' fill='white' fill-opacity='0.55'/><circle cx='72' cy='152' r='1.6' fill='white' fill-opacity='0.7'/><circle cx='296' cy='161' r='2' fill='%23c4b5fd' fill-opacity='0.7'/><circle cx='296' cy='331' r='1' fill='%23c4b5fd' fill-opacity='0.85'/><circle cx='368' cy='36' r='2' fill='white' fill-opacity='0.55'/><circle cx='258' cy='352' r='2' fill='white' fill-opacity='1'/><circle cx='242' cy='303' r='1.6' fill='white' fill-opacity='0.85'/><circle cx='410' cy='96' r='2.4' fill='%23c4b5fd' fill-opacity='0.7'/><circle cx='157' cy='272' r='1.6' fill='white' fill-opacity='0.85'/><circle cx='151' cy='315' r='1' fill='white' fill-opacity='0.55'/><circle cx='88' cy='391' r='1.3' fill='white' fill-opacity='0.7'/><circle cx='219' cy='24' r='2.4' fill='white' fill-opacity='0.55'/><circle cx='297' cy='408' r='1.3' fill='white' fill-opacity='0.85'/><circle cx='308' cy='258' r='2' fill='%23c4b5fd' fill-opacity='1'/><circle cx='51' cy='142' r='1.6' fill='%23c4b5fd' fill-opacity='0.55'/><circle cx='363' cy='162' r='2.4' fill='white' fill-opacity='1'/><circle cx='201' cy='458' r='2.4' fill='%23c4b5fd' fill-opacity='0.85'/><circle cx='240' cy='185' r='1' fill='white' fill-opacity='0.55'/><circle cx='115' cy='397' r='1.3' fill='white' fill-opacity='0.7'/><circle cx='207' cy='204' r='1.6' fill='%23c4b5fd' fill-opacity='0.55'/><circle cx='209' cy='285' r='1.3' fill='white' fill-opacity='0.7'/></svg>");background-size:480px 480px;animation:sfTw 7s ease-in-out infinite alternate}
.starfield::before{content:'';position:absolute;inset:0;background-image:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='700' height='700'><circle cx='300' cy='89' r='1' fill='white' fill-opacity='0.85'/><circle cx='546' cy='370' r='1' fill='white' fill-opacity='0.7'/><circle cx='18' cy='230' r='2' fill='white' fill-opacity='1'/><circle cx='112' cy='91' r='2.4' fill='white' fill-opacity='1'/><circle cx='528' cy='646' r='2.4' fill='white' fill-opacity='1'/><circle cx='62' cy='214' r='1' fill='white' fill-opacity='0.85'/><circle cx='639' cy='225' r='2.4' fill='white' fill-opacity='0.85'/><circle cx='381' cy='589' r='1.3' fill='white' fill-opacity='0.85'/><circle cx='489' cy='185' r='2.4' fill='white' fill-opacity='1'/><circle cx='462' cy='695' r='2.4' fill='%23c4b5fd' fill-opacity='0.7'/><circle cx='186' cy='550' r='1.3' fill='white' fill-opacity='0.7'/><circle cx='88' cy='104' r='1.6' fill='white' fill-opacity='0.55'/><circle cx='590' cy='291' r='2' fill='%23c4b5fd' fill-opacity='0.85'/><circle cx='299' cy='559' r='1.3' fill='white' fill-opacity='1'/><circle cx='268' cy='157' r='1' fill='white' fill-opacity='0.55'/><circle cx='508' cy='247' r='1.3' fill='white' fill-opacity='0.7'/><circle cx='610' cy='106' r='1.6' fill='white' fill-opacity='0.7'/><circle cx='38' cy='61' r='2.4' fill='white' fill-opacity='1'/></svg>");background-size:700px 700px;animation:sfTwB 4.3s ease-in-out infinite}
.starfield::after{content:'';position:absolute;inset:0;background:radial-gradient(560px 380px at 18% 12%,rgba(139,92,246,.16),transparent 65%),radial-gradient(700px 500px at 85% 78%,rgba(96,80,220,.12),transparent 65%)}
@keyframes sfTw{from{opacity:.88}to{opacity:1}}
@keyframes sfTwB{0%{opacity:.95}17%{opacity:.35}33%{opacity:.9}52%{opacity:.45}71%{opacity:1}86%{opacity:.55}100%{opacity:.92}}
.starfield .tw{position:absolute;border-radius:50%;background:#fff;opacity:.2;animation:sfStar 2.8s ease-in-out infinite}
.starfield .tv{background:#c4b5fd}
@keyframes sfStar{0%,100%{opacity:.15;transform:scale(.72)}50%{opacity:1;transform:scale(1.18)}}
body[data-motion="off"] .starfield::before,body[data-motion="off"] .starfield .tw{animation:none}
.wrap{position:relative;z-index:1}
.lcard{background:#101012;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:16px;text-decoration:none;color:#f4f4f5;display:block;transition:border-color .15s}
.lcard:hover{border-color:rgba(255,255,255,.24)}
.lcard svg{color:#e4e4e7;margin-bottom:11px}
.lcard b{display:block;font-size:15px;font-weight:600;margin-bottom:3px}
.lcard span{font-size:12.5px;color:#8b8b93;line-height:1.45;display:block}
.quick{margin-top:24px;color:#63636b;font-size:13px}
.quick a{color:#a1a1aa;text-decoration:none}
.quick a:hover{color:#fff}

body{-webkit-tap-highlight-color:transparent;overscroll-behavior-y:none}
button,a{touch-action:manipulation}
#sb{padding-bottom:env(safe-area-inset-bottom)}
#sbBtn{top:calc(14px + env(safe-area-inset-top))}
@media(max-width:820px){ input[type=text],input[type=number],input[type=search],input[type=password],textarea,select{font-size:16px} }
::selection{background:rgba(var(--acc),.35)}
html{scrollbar-color:rgba(255,255,255,.22) transparent}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:rgba(255,255,255,.18);border-radius:8px;border:2px solid #0a0a0b}
::-webkit-scrollbar-track{background:transparent}
button,.btn,.chip{cursor:pointer;transition:background .15s ease,border-color .15s ease,color .15s ease,opacity .15s ease}
button:hover,.btn:hover,.chip:hover{border-color:rgba(255,255,255,.32)}
button:active,.btn:active,.chip:active{transform:scale(.98)}
:focus{outline:none}
:focus-visible{outline:2px solid rgba(var(--star),.75);outline-offset:2px}
button:disabled,.btn:disabled,.chip:disabled{opacity:.45;cursor:not-allowed;transform:none}
input,textarea,select{transition:border-color .15s ease,background .15s ease}
input:focus,textarea:focus,select:focus{border-color:rgba(var(--star),.6)}
.card{transition:border-color .15s ease,background .15s ease}
.card:hover{border-color:rgba(255,255,255,.28);background:#12100a}
a{transition:color .15s ease}
#tabbar{display:none}
#tabSheet{display:none}
@media (max-width:820px){
#tabbar{display:flex;position:fixed;left:10px;right:10px;bottom:calc(8px + env(safe-area-inset-bottom));z-index:50;background:rgba(22,22,27,.52);-webkit-backdrop-filter:blur(22px) saturate(1.7);backdrop-filter:blur(22px) saturate(1.7);border:1px solid rgba(255,255,255,.16);border-radius:28px;box-shadow:0 10px 34px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.15),inset 0 -1px 0 rgba(255,255,255,.05);padding:7px 6px;justify-content:space-around;align-items:stretch}
#tabbar a,#tabbar button{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;background:none;border:0;color:#c9c9d1;font-size:10px;font-weight:600;letter-spacing:.02em;text-decoration:none;padding:6px 0 4px;border-radius:19px;cursor:pointer;font-family:inherit}
#tabbar a.on{color:#fff;background:rgba(var(--acc),.22);box-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 0 14px rgba(var(--acc),.18)}
#tabbar a.on svg{color:#e4e4e7}
#tabSheet.open{display:block;position:fixed;left:10px;right:10px;bottom:calc(90px + env(safe-area-inset-bottom));z-index:51;background:rgba(22,22,27,.6);-webkit-backdrop-filter:blur(22px) saturate(1.7);backdrop-filter:blur(22px) saturate(1.7);border:1px solid rgba(255,255,255,.16);border-radius:22px;box-shadow:0 10px 34px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.15);padding:10px}
#tabSheet a{display:flex;align-items:center;gap:12px;padding:11px 10px;border-radius:14px;color:#f4f4f5;text-decoration:none;font-weight:600;font-size:14.5px}
#tabSheet a.on{background:rgba(255,255,255,.1)}
#tabSheet a svg{color:#c9c9d1;flex:none}
#tabSheet a.on svg{color:#e4e4e7}
.tsh-sec{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;opacity:.5;margin:10px 4px 6px}
.tsh-cloak{display:flex;flex-wrap:wrap;gap:6px}
.tsh-cloak button{background:#17171a;color:#d4d4d8;border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:6px 11px;font-size:12.5px;font-weight:500;cursor:pointer;font-family:inherit;box-shadow:none}
.tsh-cloak button:hover{border-color:rgba(167,139,250,.55);color:#fff;background:rgba(167,139,250,.14)}
.tsh-cloak button{flex:1;padding:8px 6px;font-size:12.5px;white-space:nowrap}
#sbBtn{display:none}
body.has-sb{padding-bottom:118px}
.app6{padding-bottom:104px}
html.gx-framed body.has-sb{padding-bottom:86px}
html.gx-framed .app6{padding-bottom:78px}
}



/* ===== v86 space system — black + amber, starfield first ===== */
body{background:radial-gradient(1200px 700px at 50% -12%,rgba(var(--acc),.08),transparent 62%),#030304}
h1{font-weight:800;letter-spacing:-.035em;font-size:clamp(30px,5vw,42px)}
p.sub{color:#9d9da6;font-size:15.5px}
input{background:#0d0b08;border-color:rgba(255,255,255,.13);border-radius:13px}
input:focus{border-color:rgba(var(--star),.6);box-shadow:0 0 0 3px rgba(var(--acc),.18)}
button{border-radius:12px;font-weight:700;box-shadow:0 8px 22px rgba(0,0,0,.32)}
button:hover{transform:translateY(-1px)}
button:active{transform:scale(.98)}
.links a{background:#0d0b08;border-color:rgba(255,255,255,.11);padding:10px 16px}
.links a:hover{background:#100e1c;border-color:rgba(var(--star),.45);color:#fff}
.bar select{border-radius:12px;background:#0a0918}
.bar input{border-radius:12px}
.grid{gap:16px}
.card{background:linear-gradient(180deg,#121009,#0c0a07);border-color:rgba(255,255,255,.09);border-radius:16px;box-shadow:0 2px 10px rgba(0,0,0,.25)}
.card:hover{background:linear-gradient(180deg,#161209,#100d08);border-color:rgba(255,255,255,.26);transform:translateY(-2px);box-shadow:0 16px 36px rgba(0,0,0,.5)}
.gt{font-weight:700;padding-top:11px}
.gc{color:#8f8f98}
.noimg{background:#12100a}
.lcard{background:linear-gradient(180deg,#121009,#0c0a07);border-color:rgba(255,255,255,.09);border-radius:16px;padding:18px;box-shadow:0 2px 10px rgba(0,0,0,.25)}
.lcard:hover{border-color:rgba(227,154,45,.5);transform:translateY(-2px);box-shadow:0 16px 36px rgba(0,0,0,.5)}
.lcard b{font-weight:700}
a.back:hover{text-decoration:none;border-color:rgba(var(--star),.5);background:rgba(var(--acc),.16)}
.top{background:#0b0b0d;border-bottom-color:rgba(255,255,255,.08)}
.top a,.top button{border-radius:10px;background:#14110b}
#sbBtn{background:rgba(17,17,19,.82);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);border-radius:12px;border-color:rgba(255,255,255,.14)}
#sb{background:linear-gradient(180deg,#0c0c0e,#09090b);border-right-color:rgba(255,255,255,.07)}
.sb-logo{font-weight:800;font-size:18px;padding-bottom:18px}
#sb nav a{border-radius:10px;padding:10px;font-weight:550}
#sb nav a.on{background:rgba(var(--acc),.18);box-shadow:inset 0 0 0 1px rgba(var(--star),.3)}
#sb nav a.on svg{color:#e4e4e7;opacity:1}
.sb-cloak button{background:#12100a}
footer,.foot{color:#5d5d66}
@media (max-width:820px){
#tabbar{background:radial-gradient(120% 200% at 12% -60%,rgba(var(--acc),.22),transparent 55%),radial-gradient(120% 200% at 88% -60%,rgba(var(--acc2),.16),transparent 55%),rgba(10,9,20,.55);border-color:rgba(var(--star),.18);border-radius:30px;box-shadow:0 14px 40px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.14),0 0 26px rgba(var(--acc),.12)}
#tabSheet{background:rgba(19,19,23,.62);border-color:rgba(255,255,255,.15)}
}

/* ===== v87 top bar + drip-down menu + animated sky ===== */
#stars{position:fixed;inset:0;z-index:-1;pointer-events:none;opacity:.5}
body>*{position:relative;z-index:1}
body{--acc:167,139,250;--acc2:139,92,246;--acc3:196,181,253;--star:221,214,254}
h1,h2{letter-spacing:-.03em;font-weight:800}
/* v181: real layered backgrounds for every sky mood + slow nebula drift */
body[data-sky]{background-color:#060609;background-image:radial-gradient(1100px 700px at 50% -10%,rgba(var(--star),.07),rgba(0,0,0,0) 60%),radial-gradient(920px 640px at 88% 108%,rgba(var(--acc),.15),rgba(0,0,0,0) 62%),radial-gradient(780px 560px at 4% 96%,rgba(var(--acc2),.13),rgba(0,0,0,0) 60%)}
body::before{content:'';position:fixed;inset:-12%;z-index:-2;pointer-events:none;background:radial-gradient(620px 430px at 22% 30%,rgba(var(--acc),.10),rgba(0,0,0,0) 65%),radial-gradient(720px 520px at 78% 72%,rgba(var(--star),.05),rgba(0,0,0,0) 65%);animation:skyDrift 48s ease-in-out infinite alternate}
@keyframes skyDrift{from{transform:translate3d(-1.6%,-1%,0) scale(1)}to{transform:translate3d(1.6%,1.2%,0) scale(1.07)}}
body[data-motion="off"]::before{animation:none}
body[data-sky="amber"]{--acc:178,168,152;--acc2:138,128,112;--acc3:216,208,196;--star:240,236,228}
body[data-sky="violet"]{--acc:165,163,175;--acc2:118,116,130;--acc3:214,212,220;--star:243,242,246}
body[data-sky="ice"]{--acc:158,172,184;--acc2:110,126,142;--acc3:208,220,230;--star:240,246,250}
body[data-sky="blood"]{--acc:178,150,148;--acc2:138,112,110;--acc3:218,198,194;--star:246,238,236}
@keyframes gxSheen{from{background-position:0% 50%}to{background-position:200% 50%}}
@keyframes gxBreathe{0%,100%{box-shadow:inset 0 0 0 1px rgba(var(--star),.35),0 0 14px rgba(var(--acc),.18)}50%{box-shadow:inset 0 0 0 1px rgba(var(--star),.5),0 0 24px rgba(var(--acc),.34)}}
@media (prefers-reduced-motion: reduce){.tb-logo span{animation:none}.tb-links a.on{animation:none}}
#topbar{position:fixed;top:0;left:0;right:0;z-index:60;height:50px;display:flex;align-items:center;gap:12px;padding:0 12px;background:radial-gradient(120% 180% at 8% -40%,rgba(var(--acc),.28),transparent 55%),radial-gradient(120% 200% at 88% -60%,rgba(var(--acc2),.22),transparent 55%),radial-gradient(90% 160% at 55% -80%,rgba(var(--acc3),.12),transparent 60%),rgba(7,6,14,.72);-webkit-backdrop-filter:blur(18px) saturate(1.5);backdrop-filter:blur(18px) saturate(1.5);border-bottom:1px solid rgba(var(--star),.16);box-shadow:0 1px 24px rgba(var(--acc),.12),0 10px 34px rgba(0,0,0,.35)}
.tb-logo{font-weight:800;font-size:16px;color:#fafafa;text-decoration:none;letter-spacing:-.02em;flex:none}
.tb-logo span{font-weight:700;background:linear-gradient(94deg,#f0abfc,#a78bfa 25%,#38bdf8 48%,#34d399 68%,#facc15 85%,#fb7185);background-size:200% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent}
.tb-links{display:flex;gap:3px;margin-left:2px}
.tb-links a{display:flex;align-items:center;gap:7px;color:#c9c9ce;text-decoration:none;font-size:13.5px;font-weight:550;padding:7px 12px;border-radius:99px}
.tb-links a svg{opacity:.75}
.tb-links a:hover{background:rgba(255,255,255,.07);color:#fff}
.tb-links a.on{background:linear-gradient(120deg,rgba(var(--acc),.34),rgba(var(--acc2),.22));color:#fff;animation:gxBreathe 5s ease-in-out infinite}
.tb-links a.on svg{color:rgb(var(--star))}
.tb-links a.on svg{color:#e4e4e7;opacity:1}
.tb-menuwrap{position:relative;flex:none}
.tb-search{margin-left:auto;display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:50%;color:#e8e8ec;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);flex:none;text-decoration:none}
.tb-search:hover{background:rgba(var(--acc),.2);border-color:rgba(var(--star),.35)}
#menuBtn{display:flex;align-items:center;gap:7px;background:rgba(255,255,255,.06);color:#f4f4f5;border:1px solid rgba(255,255,255,.14);border-radius:99px;padding:8px 14px;font-size:13.5px;font-weight:600;box-shadow:none;cursor:pointer;font-family:inherit}
#menuBtn:hover{background:rgba(255,255,255,.1);transform:none}
#menuBtn svg{transition:transform .25s ease}
body.menu-open #menuBtn svg{transform:rotate(180deg)}
body.menu-open #menuBtn{background:rgba(var(--acc),.18);border-color:rgba(var(--star),.45)}
#dropmenu{z-index:300;position:absolute;top:calc(100% + 8px);right:0;width:min(432px,calc(100vw - 20px));background:radial-gradient(130% 90% at 12% -10%,rgba(var(--acc),.30),transparent 55%),radial-gradient(120% 90% at 95% 0%,rgba(var(--acc2),.24),transparent 55%),radial-gradient(100% 70% at 50% 115%,rgba(var(--acc3),.16),transparent 60%),rgba(9,8,18,.94);-webkit-backdrop-filter:blur(26px) saturate(1.6);backdrop-filter:blur(26px) saturate(1.6);border:1px solid rgba(var(--star),.18);border-radius:18px;box-shadow:0 24px 60px rgba(0,0,0,.65),0 0 44px rgba(var(--acc),.14);padding:14px;max-height:calc(100vh - 88px);max-height:calc(100dvh - 88px);overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;opacity:0;transform:translateY(-10px) scale(.97);transform-origin:top right;pointer-events:none;transition:opacity .2s ease,transform .24s cubic-bezier(.2,.9,.3,1.25)}
body.menu-open #dropmenu{opacity:1;transform:none;pointer-events:auto}
body.menu-open #menuBtn{border-color:rgba(var(--star),.45);box-shadow:0 0 16px rgba(var(--acc),.3)}
#dropmenu::-webkit-scrollbar{width:8px}
#dropmenu::-webkit-scrollbar-thumb{background:rgba(255,255,255,.16);border-radius:99px}
#dropmenu::-webkit-scrollbar-track{background:transparent}
.dm-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px}
.dm-grid a{display:flex;align-items:center;gap:11px;padding:9px 10px;border-radius:11px;color:#dcdce0;text-decoration:none;font-size:14.5px;font-weight:550}
.dm-grid a svg{color:rgb(var(--star));flex:none;opacity:.9}
.dm-grid a:hover{background:rgba(255,255,255,.07);color:#fff}
.dm-grid a.on{background:linear-gradient(120deg,rgba(var(--acc),.3),rgba(var(--acc2),.18));color:#fff;box-shadow:inset 0 0 0 1px rgba(var(--star),.3)}
.dm-grid a.on svg{color:#e4e4e7}
.dm-sec{margin:10px 4px 6px;font-size:11px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:rgba(var(--star),.55)}
#dropmenu .sb-cloak{padding:0}
.dm-foot{margin-top:10px;padding:0 4px 4px;color:#5d564a;font-size:12px;line-height:1.5}
body.has-tb{padding-top:84px}
#sbBtn,#sb,#sbScrim{display:none!important}
@media(max-width:900px){ .tb-links{display:none} }

/* ===== v88 calm menu tiles — glass over the sky, no lift, soft glow ===== */
.launch{gap:14px;margin-top:40px}
.lcard{background:rgba(18,14,10,.5);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);border:1px solid rgba(255,236,200,.09);border-radius:20px;padding:20px;box-shadow:none;transition:border-color .35s ease,background .35s ease,box-shadow .35s ease}
.lcard:hover{transform:none;background:rgba(26,20,13,.62);border-color:rgba(246,207,141,.3);box-shadow:0 0 28px rgba(227,154,45,.09)}
.lcard svg{color:#e3c48c;opacity:.85}
.lcard b{font-weight:650;color:#efe9dc}
.lcard span{color:#99917f}

/* ===== v93 sky moods + menu ask-six ===== */
#dmAsk{display:flex;gap:8px;padding:0 2px}
#dmAsk input{flex:1;min-width:0;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.13);border-radius:11px;color:#fff;padding:10px 12px;font-size:14px;font-family:inherit;outline:none}
#dmAsk button{background:linear-gradient(120deg,rgb(var(--star)),rgb(var(--acc3)));color:#0d0a18;border:0;border-radius:11px;padding:10px 16px;font-weight:700;cursor:pointer;font-family:inherit;box-shadow:none}
#dmAns{margin:10px 2px 0;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:11px 13px;font-size:14px;line-height:1.55;color:#ece7dd;white-space:pre-wrap;max-height:220px;overflow-y:auto}
.dm-sky button.on{border-color:rgba(var(--star),.6);color:#fff;background:rgba(var(--acc),.22);box-shadow:0 0 12px rgba(var(--acc),.25)}
body[data-sky="violet"] .tb-logo span{color:#c4a5ff}
body[data-sky="violet"] .lcard svg{color:#cdb2ff}
body[data-sky="violet"] .lcard:hover{border-color:rgba(196,165,255,.35);box-shadow:0 0 28px rgba(150,110,255,.1)}
body[data-sky="violet"] .cr-item.on{background:rgba(150,110,255,.32)}
body[data-sky="nebula"]{background:#070518;background-image:radial-gradient(1000px 650px at 50% 28%,rgba(255,255,255,.05),rgba(10,8,32,0) 62%),radial-gradient(820px 620px at 84% 88%,rgba(37,80,235,.17),rgba(10,8,32,0) 60%)}
body[data-sky="nebula"] .tb-logo span{color:#b79cff}
body[data-sky="nebula"] .lcard svg{color:#c9b8ff}
body[data-sky="nebula"] .lcard:hover{border-color:rgba(167,139,250,.35);box-shadow:0 0 28px rgba(124,77,255,.12)}
body[data-sky="nebula"] .cr-item.on{background:rgba(124,77,255,.32)}
body[data-sky="ice"] .tb-logo span{color:#a8d4ff}
body[data-sky="ice"] .lcard svg{color:#bfe0ff}
body[data-sky="ice"] .lcard:hover{border-color:rgba(168,212,255,.35);box-shadow:0 0 28px rgba(110,180,255,.1)}
body[data-sky="ice"] .cr-item.on{background:rgba(110,180,255,.3)}
body[data-sky="blood"] .tb-logo span{color:#ff9a86}
body[data-sky="blood"] .lcard svg{color:#ffb4a3}
body[data-sky="blood"] .lcard:hover{border-color:rgba(255,154,134,.35);box-shadow:0 0 28px rgba(235,70,50,.1)}
body[data-sky="blood"] .cr-item.on{background:rgba(235,70,50,.3)}

/* ===== v94 solid tiles — tiles sit ON the sky, never see-through ===== */
body .card, body .lcard{ background:radial-gradient(130% 120% at 12% -10%,rgba(var(--acc),.15),transparent 55%),linear-gradient(165deg,#121214,#0b0b0d); -webkit-backdrop-filter:none; backdrop-filter:none; border-color:rgba(var(--star),.15) }
body .lcard b{color:#f2f0fa} body .lcard span{color:#9d99ad}
body .card:hover{ background:radial-gradient(130% 120% at 12% -10%,rgba(var(--acc),.22),transparent 55%),linear-gradient(165deg,#141416,#0c0c0e); border-color:rgba(var(--star),.38) }
body .lcard:hover{ background:radial-gradient(130% 120% at 12% -10%,rgba(var(--acc),.22),transparent 55%),linear-gradient(165deg,#141416,#0c0c0e); border-color:rgba(var(--star),.38); box-shadow:0 0 24px rgba(var(--acc),.13) }

/* MINIMAL v146 */
.tb-logo span{background:none!important;-webkit-background-clip:initial;background-clip:initial;-webkit-text-fill-color:#e7e7ea;color:#e7e7ea;animation:none!important}
.lcard svg{color:#d9d9de!important}
.lcard:hover{border-color:rgba(255,255,255,.22)!important;box-shadow:none!important}
.card,.appRow{box-shadow:none!important}

/* v166 beauty pass - motion + touch polish */
html{scroll-behavior:smooth}
@keyframes gxUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
.launch .lcard{animation:gxUp .55s cubic-bezier(.2,.8,.3,1) both}
.launch .lcard:nth-child(2){animation-delay:.05s}.launch .lcard:nth-child(3){animation-delay:.1s}.launch .lcard:nth-child(4){animation-delay:.15s}.launch .lcard:nth-child(5){animation-delay:.2s}.launch .lcard:nth-child(6){animation-delay:.25s}.launch .lcard:nth-child(7){animation-delay:.3s}.launch .lcard:nth-child(8){animation-delay:.35s}.launch .lcard:nth-child(9){animation-delay:.4s}.launch .lcard:nth-child(10){animation-delay:.45s}
.lcard{transition:transform .18s ease,border-color .18s ease}
.lcard:hover{transform:translateY(-3px)}
.dcord{animation:gxUp .55s .5s cubic-bezier(.2,.8,.3,1) both}
@media (prefers-reduced-motion: reduce){ .launch .lcard,.dcord{animation:none} html{scroll-behavior:auto} }

/* v187 phone pass — app-pattern polish */
.lcard:active{transform:scale(.98)}
#grid .card:active{transform:scale(.985)}
@media (max-width:820px){
#tabbar{background:rgba(17,17,21,.6);-webkit-backdrop-filter:blur(24px) saturate(1.8);backdrop-filter:blur(24px) saturate(1.8)}
#tabbar a svg,#tabbar button svg{width:24px;height:24px}
#tabbar a,#tabbar button{font-size:10.5px;letter-spacing:.01em}
#dropmenu{position:fixed;top:auto;bottom:calc(88px + env(safe-area-inset-bottom));left:10px;right:10px;width:auto;max-height:68vh;max-height:68dvh;border-radius:24px;transform-origin:bottom center;transform:translateY(16px) scale(.98);padding-top:24px}
#dropmenu::before{content:'';position:absolute;top:9px;left:50%;transform:translateX(-50%);width:38px;height:5px;border-radius:99px;background:rgba(255,255,255,.3)}
body.menu-open #topbar{-webkit-backdrop-filter:none;backdrop-filter:none}
.launch{grid-template-columns:1fr 1fr;gap:10px;margin-top:24px}
body .lcard{padding:16px;min-height:118px;display:flex;flex-direction:column;justify-content:space-between;background:radial-gradient(120% 130% at 15% -10%,rgba(var(--acc),.22),transparent 55%),linear-gradient(165deg,#141416,#0b0b0d)}
.lcard svg{width:26px;height:26px}
.lcard b{font-size:16.5px}
}

/* ===== v198 polish — zinc-true surfaces, one depth language ===== */
body{text-rendering:optimizeLegibility}
::placeholder{color:#5f5f68;opacity:1}
::-webkit-scrollbar{width:9px;height:9px}
::-webkit-scrollbar-thumb{background:rgba(255,255,255,.16);border:2px solid transparent;background-clip:padding-box}
::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.3);background-clip:padding-box}
.wrap{animation:gxFadeIn .32s ease}
@keyframes gxFadeIn{from{opacity:0}to{opacity:1}}
h2{font-size:21px;font-weight:750;letter-spacing:-.02em}
input,textarea{background:#0e0e11}
input:hover{border-color:rgba(255,255,255,.22)}
.card,.lcard{background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.014) 42%,rgba(0,0,0,.22)),#101013;border-color:rgba(255,255,255,.09);box-shadow:0 1px 2px rgba(0,0,0,.45),0 12px 32px rgba(0,0,0,.3)}
.card{transition:transform .25s cubic-bezier(.22,.9,.28,1),border-color .2s ease,box-shadow .25s ease}
.card:hover{transform:translateY(-3px);border-color:rgba(var(--star),.38);box-shadow:0 2px 4px rgba(0,0,0,.45),0 24px 48px rgba(0,0,0,.52),0 0 26px rgba(var(--acc),.1)}
.card img{transition:transform .55s cubic-bezier(.22,.9,.28,1)}
.card:hover img{transform:scale(1.05)}
.lcard{transition:transform .25s cubic-bezier(.22,.9,.28,1),border-color .2s ease,box-shadow .25s ease}
.lcard:hover{transform:translateY(-3px);border-color:rgba(var(--star),.38);box-shadow:0 2px 4px rgba(0,0,0,.45),0 24px 48px rgba(0,0,0,.52),0 0 26px rgba(var(--acc),.1)}
.gt{letter-spacing:-.01em}
.sec-h{font-size:12.5px;font-weight:800;letter-spacing:.13em;text-transform:uppercase;color:rgba(var(--star),.78)}
.popc{transition:transform .25s cubic-bezier(.22,.9,.28,1),box-shadow .25s ease}
.popc:hover{transform:translateY(-3px)}
body #feat{background:radial-gradient(120% 160% at 15% -20%,rgba(var(--acc),.3),transparent 55%),radial-gradient(100% 140% at 95% 0%,rgba(var(--acc2),.22),transparent 55%),linear-gradient(180deg,#141318,#0a0a0c)}
body .mvcard{transition:transform .25s cubic-bezier(.22,.9,.28,1)}
body .mvcard:hover{transform:translateY(-3px)}
body .mvcard img{box-shadow:0 10px 26px rgba(0,0,0,.45)}
body .ncard{transition:border-color .2s ease,background .2s ease,transform .25s cubic-bezier(.22,.9,.28,1)}
body .ncard:hover{transform:translateY(-2px)}
.nbrief{box-shadow:0 18px 44px rgba(0,0,0,.4)}
.cfcard,.rqcard,.hwcard{background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.014) 45%,rgba(0,0,0,.2)),#101013;border-color:rgba(255,255,255,.09)}
#doc{line-height:1.75}
#doc p{margin:0 0 12px}
#doc h1,#doc h2,#doc h3{margin:20px 0 8px;letter-spacing:-.015em;line-height:1.25}
#doc ul,#doc ol{margin:0 0 12px;padding-left:22px}
#doc li{margin-bottom:5px}
.chip{transition:background .15s ease,border-color .15s ease,color .15s ease,box-shadow .2s ease}
body #gbar{background:rgba(9,9,13,.8);-webkit-backdrop-filter:blur(16px) saturate(1.35);backdrop-filter:blur(16px) saturate(1.35)}
.empty6{text-align:center;color:#8b8b93;padding:44px 20px;font-size:14.5px;line-height:1.6}
.skel{position:relative;overflow:hidden;background:rgba(255,255,255,.05);border-radius:10px}
.skel::after{content:'';position:absolute;inset:0;background:linear-gradient(100deg,transparent 30%,rgba(255,255,255,.07) 50%,transparent 70%);animation:gxShimmer 1.4s infinite}
@keyframes gxShimmer{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
@media (prefers-reduced-motion: reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}
`;
const PWA_MANIFEST = JSON.stringify({ name: '6ixNetworks', short_name: '6ix', description: '6ixNetworks — search, games, 6ixChat, six ai', start_url: '/', scope: '/', display: 'standalone', background_color: '#0a0a0b', theme_color: '#0a0a0b', icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }] });
const SW_JS = `self.addEventListener('install', function(e){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function(e){});
// pass-through on purpose: this is a proxy — remote content must never be cached or intercepted
`;
const ICON_512 = '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';
const ICON_192 = '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';
const ICON_180 = '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';
const STARS_JS = `
(function(){
  var c=document.getElementById('stars'); if(!c) return;
  var _pp=location.pathname; if(_pp!=='/space'){ c.remove(); return; }
  
  var ctx=c.getContext('2d'); var W=0,H=0,stars=[],meteor=null,t0=Date.now();
  var DPR=Math.min(window.devicePixelRatio||1,1);
  var reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var MOODS={
    nebula:{clouds:['43,43,50','34,34,40','50,50,57','58,58,64'],star:'232,232,238',line:'140,140,148'},
    amber:{clouds:['48,44,38','38,35,30','56,51,44','62,57,50'],star:'238,233,224',line:'152,146,134'},
    violet:{clouds:['44,43,50','35,34,41','51,50,58','59,58,66'],star:'234,233,240',line:'144,142,152'},
    ice:{clouds:['40,46,54','32,38,46','48,56,66','56,65,76'],star:'233,240,246',line:'138,152,164'},
    blood:{clouds:['50,42,41','40,33,32','58,49,47','66,56,53'],star:'240,233,230',line:'156,140,136'}
  };
  var mood='nebula';
  try{ var sv=localStorage.getItem('gx_sky'); if(sv && MOODS[sv]) mood=sv; }catch(e){}
  function applyMood(){ try{ document.body.setAttribute('data-sky', mood); }catch(e){} }
  applyMood();
  window.addEventListener('gxsky', function(e){ if(e.detail && MOODS[e.detail]){ mood=e.detail; applyMood(); } });
  var tx=0, ty=0, px=0, py=0;
  window.addEventListener('mousemove', function(e){ tx=(e.clientX/window.innerWidth-0.5)*2; ty=(e.clientY/window.innerHeight-0.5)*2; });
  if(window.DeviceOrientationEvent){ window.addEventListener('deviceorientation', function(e){ if(e.gamma===null||e.gamma===undefined) return; tx=Math.max(-1,Math.min(1,e.gamma/22)); ty=Math.max(-1,Math.min(1,(e.beta-38)/22)); }); }
  function clockFx(){ var h=new Date().getHours(); if(h>=23||h<4) return {star:1.25, cloud:0.92}; if(h>=19) return {star:1.08, cloud:1.05}; if(h>=17) return {star:0.95, cloud:1.18}; if(h>=7&&h<17) return {star:0.8, cloud:1}; return {star:1, cloud:1}; }
  var clouds=[];
  var CDEFS=[{a:0.07},{a:0.052},{a:0.064},{a:0.04},{a:0.058}];
  function seedClouds(){ clouds=[];
    for(var i=0;i<CDEFS.length;i++){ var d=CDEFS[i];
      clouds.push({x:0.12+Math.random()*0.76,y:0.1+Math.random()*0.7,vx:0,vy:0,tx:0.12+Math.random()*0.76,ty:0.1+Math.random()*0.7,r:0.34+Math.random()*0.3,vr:0,a:d.a*(0.75+Math.random()*0.5),va:0,hi:i%4,par:0.4+Math.random()*0.6,pick:600+Math.floor(Math.random()*1500),wob:Math.random()*6.28});
    }
  }
  function size(){ W=window.innerWidth; H=window.innerHeight; var RS=DPR*0.8; c.width=Math.round(W*RS); c.height=Math.round(H*RS); c.style.width=W+'px'; c.style.height=H+'px'; ctx.setTransform(RS,0,0,RS,0,0);
    var n=Math.min(_pp==='/home'?380:190, Math.floor(W*H/(_pp==='/home'?5000:10000))); stars=[];
    for(var i=0;i<n;i++) stars.push({x:Math.random()*W,y:Math.random()*H,r:Math.random()*(_pp==='/home'?2.2:1.4)+(_pp==='/home'?0.9:0.3),p:Math.random()*6.283,s:0.4+Math.random()*1.1,d:Math.random()*0.008+0.002,dx:0.002+Math.random()*0.009,am:Math.random()<0.16});
    if(!clouds.length) seedClouds();
    if(window.__skyStatic){ window.__skyDrew=false; draw(); }
  }
  var lastDraw=0, skipTick=0;
  var spriteCache={};
  function spriteFor(hue){ var s=spriteCache[hue]; if(s) return s; var cv=document.createElement('canvas'); cv.width=cv.height=256; var g2=cv.getContext('2d'); var rg=g2.createRadialGradient(128,128,0,128,128,128); rg.addColorStop(0,'rgba('+hue+',1)'); rg.addColorStop(1,'rgba('+hue+',0)'); g2.fillStyle=rg; g2.fillRect(0,0,256,256); spriteCache[hue]=cv; return cv; }
  var glowCv=null;
  function glowSprite(){ if(glowCv) return glowCv; var cv=document.createElement('canvas'); cv.width=cv.height=512; var g2=cv.getContext('2d'); var rg=g2.createRadialGradient(256,256,0,256,256,256); rg.addColorStop(0,'rgba(150,110,255,0.22)'); rg.addColorStop(0.4,'rgba(90,80,230,0.11)'); rg.addColorStop(1,'rgba(60,60,200,0)'); g2.fillStyle=rg; g2.fillRect(0,0,512,512); glowCv=cv; return cv; }
  function draw(now){
    if(now && now-lastDraw<33){ requestAnimationFrame(draw); return; }
    lastDraw=now||0;
    if(document.hidden){ requestAnimationFrame(draw); return; }
    skipTick++; if(skipTick%24===0){ try{ if(getComputedStyle(c).display==='none'){ requestAnimationFrame(draw); return; } }catch(e){} }
    if(!window.__skyStatic){ var nwP=performance.now(); if(!window.__skyT0) window.__skyT0=nwP; window.__skyN=(window.__skyN||0)+1; var elP=nwP-window.__skyT0; if(elP>2600){ if(window.__skyN/(elP/1000)<19 && _pp!=='/home'){ window.__skyStatic=true; } else { window.__skyN=0; window.__skyT0=nwP; } } } else { if(window.__skyDrew) return; window.__skyDrew=true; }
    var t=(Date.now()-t0)/1000, fx=clockFx(), M=MOODS[mood];
    px += (tx-px)*0.03; py += (ty-py)*0.03;
    ctx.clearRect(0,0,W,H);
    ctx.globalCompositeOperation='lighter';
    var SUB = W < 700 ? 3 : 4;
    for(var ci=0;ci<clouds.length;ci++){ var cl=clouds[ci], hue=M.clouds[cl.hi];
      cl.pick--;
      if(cl.pick<=0){ cl.tx=0.08+Math.random()*0.84; cl.ty=0.06+Math.random()*0.8; cl.pick=800+Math.floor(Math.random()*1800); }
      cl.vx += (cl.tx-cl.x)*0.0000035 + (Math.random()-0.5)*0.000004;
      cl.vy += (cl.ty-cl.y)*0.0000035 + (Math.random()-0.5)*0.000004;
      cl.vx *= 0.996; cl.vy *= 0.996;
      var spd=Math.sqrt(cl.vx*cl.vx+cl.vy*cl.vy);
      if(spd>0.00045){ cl.vx=cl.vx/spd*0.00045; cl.vy=cl.vy/spd*0.00045; }
      cl.x+=cl.vx; cl.y+=cl.vy;
      cl.vr += (Math.random()-0.5)*0.00012; cl.vr*=0.99; cl.r+=cl.vr; if(cl.r<0.24){ cl.r=0.24; cl.vr=0; } if(cl.r>0.72){ cl.r=0.72; cl.vr=0; }
      cl.va += (Math.random()-0.5)*0.00006; cl.va*=0.99; cl.a+=cl.va; if(cl.a<0.024){ cl.a=0.024; cl.va=0; } if(cl.a>0.105){ cl.a=0.105; cl.va=0; }
      cl.wob += 0.0035;
      var ccx=cl.x*W+px*12*cl.par, ccy=cl.y*H+py*8*cl.par, ccr=cl.r*Math.max(W,H), ca=cl.a*fx.cloud;
      for(var sb=0;sb<SUB;sb++){
        var off=sb===0?0:ccr*(sb===2?0.1:0.2), ang=cl.wob*(sb%2?1:-1)+sb*2.1;
        var gx2=ccx+Math.cos(ang)*off, gy2=ccy+Math.sin(ang)*off*0.7, gr2=ccr*(sb===0?1:(sb===2?0.5:0.72));
        var bhue=sb===0?hue:(sb===2?M.clouds[3]:M.clouds[(cl.hi+sb)%3]);
        var balf=ca*(sb===0?1:(sb===2?0.6:0.78));
        ctx.globalAlpha=Math.max(0,Math.min(1,balf));
        ctx.drawImage(spriteFor(bhue),gx2-gr2,gy2-gr2,gr2*2,gr2*2);
        ctx.globalAlpha=1;
      }
    }
    var scx=W/2+px*6, scy=H*0.44+py*4, sBase=Math.min(W,H);
    ctx.drawImage(glowSprite(),scx-sBase*0.48,scy-sBase*0.48,sBase*0.96,sBase*0.96);
    ctx.globalCompositeOperation='source-over';
    var pts=[];
    for(var i=0;i<stars.length;i++){ var st=stars[i]; if(!reduced){ st.p+=st.s*0.016; st.y-=st.d; st.x-=st.dx; } if(st.y<-2){ st.y=H+2; st.x=Math.random()*W; } if(st.x<-2){ st.x=W+2; }
      var a=((_pp==='/home'?0.6:0.35)+(_pp==='/home'?0.4:0.65)*Math.abs(Math.sin(st.p)))*fx.star; if(a>1) a=1;
      var sx=st.x+px*st.r*5, sy=st.y+py*st.r*3.5;
      ctx.beginPath(); ctx.arc(sx,sy,st.r,0,6.2832); ctx.fillStyle=st.am?('rgba('+M.star+','+(a*0.95).toFixed(3)+')'):('rgba(235,230,255,'+(a*0.9).toFixed(3)+')'); ctx.fill();
      if(st.r>1.15){ ctx.beginPath(); ctx.arc(sx,sy,st.r*3.2,0,6.2832); ctx.fillStyle='rgba('+M.clouds[0]+','+(a*0.10).toFixed(3)+')'; ctx.fill(); }
      if(st.r>0.62) pts.push({x:sx,y:sy,a:a});
    }
    var lines=0;
    ctx.lineWidth=0.7;
    for(var a1=0;a1<pts.length && lines<40;a1++){ for(var a2=a1+1;a2<pts.length && lines<40;a2++){
      var dx=pts[a1].x-pts[a2].x; if(dx>135||dx<-135) continue;
      var dy=pts[a1].y-pts[a2].y; if(dy>135||dy<-135) continue;
      var dist=Math.sqrt(dx*dx+dy*dy); if(dist>135) continue;
      var la=(1-dist/135)*0.17*Math.min(pts[a1].a,pts[a2].a);
      if(la<0.012) continue;
      ctx.strokeStyle='rgba('+M.line+','+la.toFixed(3)+')';
      ctx.beginPath(); ctx.moveTo(pts[a1].x,pts[a1].y); ctx.lineTo(pts[a2].x,pts[a2].y); ctx.stroke();
      lines++;
    } }
    var ORBITS=[{r:0.14,s:5,sp:0.11,a0:1.2,c0:'196,165,255',c1:'124,77,255'},{r:0.225,s:7,sp:0.074,a0:4.2,c0:'147,197,253',c1:'37,99,235'},{r:0.315,s:10,sp:0.05,a0:2.6,c0:'240,171,252',c1:'168,85,247',ring:1},{r:0.42,s:13,sp:0.033,a0:5.5,c0:'165,243,252',c1:'8,145,178'}];
    ctx.lineWidth=1;
    for(var oi=0;oi<ORBITS.length;oi++){ var ob=ORBITS[oi]; ctx.beginPath(); ctx.ellipse(scx,scy,ob.r*sBase,ob.r*sBase*0.8,0,0,6.2832); ctx.strokeStyle='rgba(167,139,250,'+(0.13+oi*0.025).toFixed(3)+')'; ctx.stroke(); }
    var coreR=sBase*0.05*(1+Math.sin(t*0.7)*0.04), tt=reduced?40:t;
    var cg=ctx.createRadialGradient(scx-coreR*0.4,scy-coreR*0.4,coreR*0.1,scx,scy,coreR);
    cg.addColorStop(0,'rgba(243,240,255,0.95)'); cg.addColorStop(0.35,'rgba(196,165,255,0.92)'); cg.addColorStop(0.78,'rgba(124,77,255,0.6)'); cg.addColorStop(1,'rgba(80,70,229,0.12)');
    ctx.beginPath(); ctx.arc(scx,scy,coreR,0,6.2832); ctx.fillStyle=cg; ctx.fill();
    for(var pi=0;pi<ORBITS.length;pi++){ var po=ORBITS[pi], ang=po.a0+tt*po.sp;
      var ox=scx+Math.cos(ang)*po.r*sBase, oy=scy+Math.sin(ang)*po.r*sBase*0.8, pr=Math.max(2.2,po.s*(0.6+sBase/1100));
      ctx.beginPath(); ctx.arc(ox,oy,pr*2.3,0,6.2832); ctx.fillStyle='rgba('+po.c1+',0.10)'; ctx.fill();
      var pg=ctx.createRadialGradient(ox-pr*0.4,oy-pr*0.4,pr*0.15,ox,oy,pr);
      pg.addColorStop(0,'rgba('+po.c0+',0.95)'); pg.addColorStop(1,'rgba('+po.c1+',0.88)');
      ctx.beginPath(); ctx.arc(ox,oy,pr,0,6.2832); ctx.fillStyle=pg; ctx.fill();
      if(po.ring){ ctx.save(); ctx.translate(ox,oy); ctx.rotate(-0.32); ctx.beginPath(); ctx.ellipse(0,0,pr*2.15,pr*0.6,0,0,6.2832); ctx.strokeStyle='rgba(216,180,254,0.55)'; ctx.lineWidth=1.4; ctx.stroke(); ctx.restore(); }
    }
    if(!meteor && !reduced && Math.random()<0.0038){ meteor={x:Math.random()*W*0.7+W*0.2,y:Math.random()*H*0.25,vx:-7-Math.random()*3,vy:4+Math.random()*2,l:1}; }
    if(meteor){ meteor.x+=meteor.vx; meteor.y+=meteor.vy; meteor.l-=0.016;
      var mg=ctx.createLinearGradient(meteor.x,meteor.y,meteor.x-meteor.vx*9,meteor.y-meteor.vy*9);
      mg.addColorStop(0,'rgba(237,233,255,'+(0.9*Math.max(meteor.l,0)).toFixed(3)+')'); mg.addColorStop(1,'rgba(150,110,255,0)');
      ctx.strokeStyle=mg; ctx.lineWidth=1.7; ctx.beginPath(); ctx.moveTo(meteor.x,meteor.y); ctx.lineTo(meteor.x-meteor.vx*9,meteor.y-meteor.vy*9); ctx.stroke();
      if(meteor.l<=0||meteor.x<-80||meteor.y>H+80) meteor=null;
    }
    requestAnimationFrame(draw);
  }
  size(); window.addEventListener('resize',size); requestAnimationFrame(draw);
})();
`;


// ---------- YouTube network ----------
// youtube.com's own player refuses every cloud/datacenter IP at the
// playability check, and the surviving public Invidious instances bot-wall
// their /watch pages when fetched from a server — but Invidious SEARCH works
// through the proxy, and the Piped network (a whole federated YouTube
// frontend) still plays. So: search here, mirror playback to Piped.
const INVIDIOUS_INSTANCES = [
  'https://invidious.tiekoetter.com',
  'https://inv.nadeko.net',
  'https://yt.chocolatemoo53.com',
];
const INVIDIOUS_API_ORDER = [
  'https://yt.chocolatemoo53.com',
  'https://invidious.tiekoetter.com',
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
];
const INVIDIOUS_HOSTS = INVIDIOUS_INSTANCES.map(u => new URL(u).hostname).concat(['invidious.nerdvpn.de']);
// every video/search link resolves to a 6ixNetworks route — nothing is
// ever handed off to youtube, piped, or an instance's own pages
function internalMirror(target) {
  const h = target.hostname.toLowerCase();
  const vid = target.searchParams.get('v');
  // v222 (his call): youtube searched/clicked from search stays on the real
  // site through the engine/proxy — no more bounce to the internal /yt pages.
  if (h === 'www.google.com' || h === 'google.com') {
    // google serves datacenter IPs its "unusual traffic" sorry page, and
    // the captcha on it can never work through a proxy (reCAPTCHA is
    // domain-locked — it errors "invalid domain for site key" anywhere
    // but google.com). So google searches just become network searches.
    if (target.pathname === '/search') {
      const q = target.searchParams.get('q');
      return q ? '/go?q=' + encodeURIComponent(q) : '/';
    }
    if (target.pathname === '/' || target.pathname.startsWith('/sorry')) return '/home';
    return null;
  }
  if (INVIDIOUS_HOSTS.includes(h) && target.pathname === '/watch' && vid) {
    return '/yt/watch?v=' + encodeURIComponent(vid);
  }
  return null;
}
const YT_HOME = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#0a0a0b"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="6ixNetworks"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><script>if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}</script><title>Google</title><link rel="icon" href="https://www.google.com/favicon.ico">
${FONT_LINKS}<style>${GALAXY_CSS}
body{display:block;padding:0}
.ytwrap{width:100%;box-sizing:border-box;max-width:1240px;margin:0 auto;padding:66px 16px 120px}
.ythead{text-align:center;margin:10px 0 18px}
.ytlogo{font-size:40px;font-weight:800;letter-spacing:-.02em;background:linear-gradient(94deg,#f0abfc,#a78bfa 25%,#38bdf8 48%,#34d399 68%,#facc15 85%,#fb7185);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent}
.ythead p{color:#a49dc4;margin:6px 0 0;font-size:14.5px}
.ytsearch{display:flex;gap:8px;align-items:center;background:rgba(12,10,24,.85);-webkit-backdrop-filter:blur(20px) saturate(1.4);backdrop-filter:blur(20px) saturate(1.4);border:1px solid rgba(var(--star),.16);border-radius:999px;padding:6px 6px 6px 18px;max-width:680px;margin:18px auto 0;box-shadow:0 14px 34px rgba(0,0,0,.35)}
.ytsearch input{flex:1;min-width:0;background:transparent;border:0;outline:none;color:#fff;font-size:16px;font-family:inherit}
.ytsearch button[type=submit]{background:linear-gradient(120deg,rgb(var(--acc)),rgb(var(--acc2)));color:#fff;border:0;border-radius:999px;padding:10px 22px;font-weight:700;cursor:pointer;font-family:inherit}
.ytpaste{display:flex;gap:8px;align-items:center;max-width:680px;margin:10px auto 0;background:rgba(255,255,255,.04);border:1px dashed rgba(255,255,255,.18);border-radius:999px;padding:5px 5px 5px 16px}
.ytpaste input{flex:1;min-width:0;background:transparent;border:0;outline:none;color:#d8d4ea;font-size:14px;font-family:inherit}
.ytpaste button{background:rgba(255,255,255,.07);color:#e9e6f5;border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:8px 16px;font-weight:700;cursor:pointer;font-family:inherit;box-shadow:none}
.ytpaste button:hover{background:rgba(167,139,250,.16);color:#fff}
.ytpaste.bad{border-color:rgba(248,113,113,.6)}
.yth{font-size:19px;font-weight:800;margin:30px 2px 12px;color:#f4f2ff}
.yth span{color:rgb(var(--star))}
.yrail{display:flex;gap:12px;overflow-x:auto;padding:4px 2px 12px;scrollbar-width:none}
.yrail::-webkit-scrollbar{display:none}
.yrail .ytcard{flex:0 0 250px}
.ygrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(235px,1fr));gap:14px}
@media(max-width:560px){.ygrid{grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}.ytlogo{font-size:32px}}
.ytcard{display:block;background:rgba(14,12,26,.66);border:1px solid rgba(255,255,255,.07);border-radius:16px;overflow:hidden;text-decoration:none;transition:transform .15s ease,border-color .15s ease;box-shadow:none}
.ytcard:hover{transform:translateY(-2px);border-color:rgba(var(--star),.35)}
.ytthumb{position:relative;display:block;aspect-ratio:16/9;background:#000}
.ytthumb img{width:100%;height:100%;object-fit:cover;display:block}
.ytdur{position:absolute;right:7px;bottom:7px;background:rgba(0,0,0,.8);color:#fff;font-size:11.5px;font-weight:700;border-radius:7px;padding:2px 6px}
.ytt{display:block;padding:10px 12px 0;font-size:14.5px;font-weight:600;color:#f1eefc;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.yta{display:block;padding:3px 12px 12px;font-size:12.5px;color:#9d97b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ytsk{border-radius:16px;background:rgba(255,255,255,.05);aspect-ratio:16/10.4;animation:ytpulse 1.2s ease-in-out infinite}
@keyframes ytpulse{0%,100%{opacity:.45}50%{opacity:.9}}
.ytempty{color:#9d97b8;font-size:14.5px;padding:16px 2px}
.ytmore{text-align:center;color:#9d97b8;font-size:13.5px;padding:20px 0 4px;min-height:22px}
.ytbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.ytbar .yth{margin:30px 2px 12px}
/* category dropdown — same glass menus as 6ixflix */
.dd{position:relative;display:inline-block}
.ddbtn{display:inline-flex;align-items:center;gap:9px;background:linear-gradient(180deg,rgba(255,255,255,.09),rgba(255,255,255,.045));-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);border:1px solid rgba(var(--star),.22);color:#f4f2ff;border-radius:999px;padding:10px 16px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;box-shadow:0 8px 22px rgba(0,0,0,.35)}
.ddbtn svg{color:rgb(var(--star));transition:transform .18s ease;flex:none}
.dd.open .ddbtn svg{transform:rotate(180deg)}
.ddbtn:hover{background:linear-gradient(180deg,rgba(167,139,250,.18),rgba(255,255,255,.05));color:#fff}
.ddmenu{position:fixed;z-index:300;min-width:190px;max-height:300px;overflow-y:auto;overscroll-behavior:contain;touch-action:pan-y;-webkit-overflow-scrolling:touch;background:rgba(13,11,24,.96);-webkit-backdrop-filter:blur(22px);backdrop-filter:blur(22px);border:1px solid rgba(var(--star),.2);border-radius:16px;padding:6px;box-shadow:0 24px 60px rgba(0,0,0,.6)}
.ddopt{display:flex;width:100%;align-items:center;gap:9px;background:transparent;border:0;color:#d8d4ea;font-size:14px;font-weight:600;padding:10px 12px;border-radius:11px;cursor:pointer;font-family:inherit;text-align:left;box-shadow:none}
.ddopt:hover{background:rgba(167,139,250,.16);color:#fff}
.ddopt.on{color:#fff;background:rgba(var(--acc),.16)}
.ddopt .dddot{width:7px;height:7px;border-radius:50%;background:rgb(var(--star));flex:none;visibility:hidden}
.ddopt.on .dddot{visibility:visible}
</style></head><body>${STAR_CANVAS}
<div class="ytwrap">
<div class="ythead">
<div class="ytlogo">6ixtube</div>
<p>youtube thru ur own network — click a video n it streams right here</p>
<form class="ytsearch" action="/yt/search" method="get"><input name="q" type="text" placeholder="search youtube" autocomplete="off"><button type="submit">search</button></form>
<div class="ytpaste" id="pasteBox"><input id="pasteIn" type="text" placeholder="or paste a youtube link — we'll stream it" autocomplete="off"><button id="pasteGo" type="button">stream it</button></div>
</div>
<h2 class="yth"><span>✦</span> trending rn</h2>
<div class="yrail" id="trail"></div>
<div class="ytbar"><h2 class="yth" id="gridTitle">browse — trending</h2><span class="ddslot" id="catSlot"></span></div>
<select id="catSel" hidden>
<option value="trending">trending</option>
<option value="music">music</option>
<option value="gaming">gaming</option>
<option value="news">news</option>
<option value="sports">sports</option>
<option value="live">live</option>
<option value="comedy">comedy</option>
<option value="tech">tech</option>
</select>
<div class="ygrid" id="ygrid"></div>
<div id="ytsent"></div><div class="ytmore" id="ytmore"></div>
</div>
${SIDEBAR_HTML}<script src="/ui.js"></script>
<script>
(function(){
var rail = document.getElementById('trail'), grid = document.getElementById('ygrid'), title = document.getElementById('gridTitle');
var TITLES = { trending: 'trending', music: 'music', gaming: 'gaming', news: 'news', sports: 'sports', live: 'live now', comedy: 'comedy', tech: 'tech' };
var cache = {};
var moreC = {};
function esc(s){ return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function fmtLen(s){ if (!s) return ''; var m = Math.floor(s / 60), h = Math.floor(m / 60), ss = ('0' + (s % 60)).slice(-2); return h ? (h + ':' + ('0' + (m % 60)).slice(-2) + ':' + ss) : (m + ':' + ss); }
function card(v){ return '<a class="ytcard" href="/yt/watch?v=' + v.id + '"><span class="ytthumb"><img loading="lazy" src="' + v.img + '" alt="">' + (v.len ? '<span class="ytdur">' + fmtLen(v.len) + '</span>' : '') + '</span><span class="ytt">' + esc(v.t) + '</span><span class="yta">' + esc(v.a) + '</span></a>'; }
function skel(el, n){ var h = ''; for (var i = 0; i < n; i++) h += '<div class="ytsk"></div>'; el.innerHTML = h; }
function fill(el, vids){ el.innerHTML = vids.length ? vids.map(card).join('') : '<div class="ytempty">nothing came back — try again in a sec</div>'; }
function load(f, el, n, cb){ if (cache[f]) { fill(el, cache[f]); if (cb) cb(cache[f]); return; } skel(el, n); fetch('/api/ytfeed?f=' + f).then(function(r){ return r.json(); }).then(function(j){ cache[f] = (j && j.vids) || []; moreC[f] = (j && j.cont) || ''; fill(el, cache[f]); if (cb) cb(cache[f]); pokeMore(); }).catch(function(){ el.innerHTML = '<div class="ytempty">feed hiccup — tap the category again</div>'; }); }
var curCat = 'trending';
window.ytSetCat = function(f){ curCat = f; var me = document.getElementById('ytmore'); if (me) me.textContent = ''; title.textContent = 'browse — ' + (TITLES[f] || f); if (f === 'trending' && cache.trending) { fill(grid, cache.trending); setTimeout(pokeMore, 80); return; } load(f, grid, 8); };
load('trending', rail, 6, function(vids){ if (curCat === 'trending') fill(grid, vids); rail.innerHTML = vids.slice(0, 12).map(card).join('') || '<div class="ytempty">nothing came back — try again in a sec</div>'; });
/* infinite videos — keep trading tokens for more, games style */
var moreEl = document.getElementById('ytmore'), moreBusy = false;
function loadMore(){
  var f0 = curCat, tok = moreC[curCat];
  if (moreBusy || !tok) return;
  moreBusy = true; moreEl.textContent = 'loading more…';
  fetch('/api/ytmore?f=' + encodeURIComponent(f0) + '&c=' + encodeURIComponent(tok)).then(function(r){ return r.json(); }).then(function(j){
    moreBusy = false;
    if (f0 !== curCat) return;
    var vids = (j && j.vids) || [];
    moreC[f0] = (j && j.cont) || '';
    vids.forEach(function(v){
      if (!v || !v.id) return;
      if (grid.querySelector('a[href="/yt/watch?v=' + v.id + '"]')) return;
      var d = document.createElement('div'); d.innerHTML = card(v);
      if (d.firstChild) grid.appendChild(d.firstChild);
    });
    moreEl.textContent = moreC[f0] ? '' : "that's everything youtube is giving us here — try another category";
  }).catch(function(){ moreBusy = false; moreEl.textContent = 'more videos hiccuped — keep scrolling to retry'; });
}
function pokeMore(){ var s = document.getElementById('ytsent'); if (!s) return; var r = s.getBoundingClientRect(); if (r.top < window.innerHeight + 800) loadMore(); }
if ('IntersectionObserver' in window) { var io = new IntersectionObserver(function(es){ if (es[0].isIntersecting) loadMore(); }, { rootMargin: '800px' }); io.observe(document.getElementById('ytsent')); }
/* paste a link, stream it */
var pIn = document.getElementById('pasteIn'), pBox = document.getElementById('pasteBox');
function pasteGo(){
  var s = (pIn.value || '').trim(); if (!s) return;
  var id = '';
  var m = s.match(/(?:v=|youtu\\.be\\/|shorts\\/|live\\/|embed\\/|v\\/)([A-Za-z0-9_-]{11})/);
  if (m) id = m[1]; else if (/^[A-Za-z0-9_-]{11}$/.test(s)) id = s;
  if (!id) { pBox.classList.add('bad'); setTimeout(function(){ pBox.classList.remove('bad'); }, 1600); return; }
  location.href = '/yt/watch?v=' + id;
}
document.getElementById('pasteGo').addEventListener('click', pasteGo);
pIn.addEventListener('keydown', function(e){ if (e.key === 'Enter') { e.preventDefault(); pasteGo(); } });
pIn.addEventListener('paste', function(){ setTimeout(pasteGo, 60); });
/* category dropdown — custom glass menu, same build as 6ixflix */
var sel = document.getElementById('catSel'), slot = document.getElementById('catSlot'), openMenu = null;
function closeDD(){ if (openMenu) { openMenu.remove(); openMenu = null; var d = slot.querySelector('.dd'); if (d) d.classList.remove('open'); document.removeEventListener('click', onDoc, true); window.removeEventListener('resize', closeDD); } }
function onDoc(e){ if (openMenu && !openMenu.contains(e.target)) closeDD(); }
function buildDD(){
  var wrap = document.createElement('span'); wrap.className = 'dd';
  var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'ddbtn';
  btn.innerHTML = '<span class="ddl"></span><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
  wrap.appendChild(btn); slot.appendChild(wrap);
  function sync(){ btn.querySelector('.ddl').textContent = 'category — ' + sel.options[sel.selectedIndex].text; }
  sync();
  btn.addEventListener('click', function(){
    if (openMenu) { closeDD(); return; }
    var menu = document.createElement('div'); menu.className = 'ddmenu';
    Array.prototype.forEach.call(sel.options, function(o){
      var it = document.createElement('button'); it.type = 'button'; it.className = 'ddopt' + (o.value === sel.value ? ' on' : '');
      it.innerHTML = '<span class="dddot"></span>' + o.text;
      it.addEventListener('click', function(){ sel.value = o.value; sync(); closeDD(); window.ytSetCat(o.value); });
      menu.appendChild(it);
    });
    document.body.appendChild(menu);
    var r = btn.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    var mH = menu.offsetHeight, mTop = r.bottom + 8, mRoom = window.innerHeight - (window.innerWidth <= 820 ? 104 : 12);
    if (mTop + mH > mRoom) mTop = Math.max(8, mRoom - mH);
    if (mTop + mH > mRoom) { menu.style.maxHeight = (mRoom - 8) + 'px'; mTop = 8; }
    menu.style.top = mTop + 'px';
    openMenu = menu; wrap.classList.add('open');
    document.addEventListener('click', onDoc, true);
    window.addEventListener('resize', closeDD);
  });
}
buildDD();
})();
</script>
</body></html>`;
function isStaticAsset(target, ct) {
  if (ct) {
    if (/^(image|font)\//i.test(ct)) return true;
    if (/text\/css|javascript|ecmascript/i.test(ct)) return true;
  }
  return /\.(?:png|jpe?g|gif|webp|svg|ico|avif|css|mjs|js|woff2?|ttf|otf)$/i.test(target.pathname);
}


// ---------- games network (/gs) ----------
// The catalog is pulled live from the GameMonetize publisher feed
// (1,000+ embeddable HTML5 games, built for iframing) and cached for an
// hour. Games launch in /play inside an iframe — through the proxy by
// default, with a one-tap direct mode for games whose code fights it.
const GM_FEED = 'https://rss.gamemonetize.com/rssfeed.php?format=json&category=All&type=html5&amount=9000';
const FAMOBI_FEED = 'https://api.famobi.com/feed';
const FALLBACK_GAMES = [
  { t: 'Nutty Rush Kart', u: 'https://html5.gamemonetize.co/jo8widlpg0usj47eix91m74q1jzvon00/', img: 'https://img.gamemonetize.com/jo8widlpg0usj47eix91m74q1jzvon00/512x384.jpg', c: 'Racing', w: 800, h: 600 },
  { t: '2048', u: 'https://play2048.co/', img: '', c: 'Puzzles', w: 800, h: 600 },
  { t: 'Hextris', u: 'https://hextris.io/', img: '', c: 'Arcade', w: 800, h: 600 },
  { t: 'Little Alchemy 2', u: 'https://littlealchemy2.com/', img: '', c: 'Puzzles', w: 800, h: 600 },
  { t: 'Slow Roads', u: 'https://slowroads.io/', img: '', c: 'Racing', w: 800, h: 600 },
];
let gamesCache = { at: 0, list: null };
const POP_KEYS = ['slope','moto x3m','basketball superstars','8 ball billiards classic','8 ball pool 2d','defly.io','drift dudes','gun spin','chess classic','solitaire legend','mahjong world','smarty bubbles 2','garden match 3d','fireboy and watergirl online','cookie clicker : clicker games','wordle 2.0','geometry dash 3d','snake vs ai','doodle jump 4','western sniper','sniper hero: urban strike','dead city: zombie survival','fps block strike dust2','modern strike shooting game','drag racing club','drift cup racing','endless truck','words of wonders','word search classic','jigsaw puzzle deluxe','thief puzzle','om nom bubbles','bubble tower 3d','temple blocks','train 2048','giant 2048','3d basketball','euro penalty cup 2021','penalty superstar','zombie barrage','racing cars','truck trials','element blocks','snowball champions','3d chess','sniper shooter 3d','slam dunk basketball','penalty shootout: multi league'];
function normT(t) { return String(t || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function pinPopular(list) {
  const used = new Set(); const head = [];
  for (const key of POP_KEYS) {
    let pick = -1;
    for (let i = 0; i < list.length; i++) { if (!used.has(i) && normT(list[i].t) === key) { pick = i; break; } }
    if (pick < 0) for (let i = 0; i < list.length; i++) { if (!used.has(i) && normT(list[i].t).indexOf(key) === 0) { pick = i; break; } }
    if (pick >= 0) { used.add(pick); head.push(list[pick]); }
  }
  if (!head.length) return list;
  return head.concat(list.filter((g, i) => !used.has(i)));
}
async function loadGames() {
  if (gamesCache.list && Date.now() - gamesCache.at < 3600e3) return gamesCache.list;
  let list = [];
  const seen = new Set();
  const seenT = new Set();
  function push(t, u, img, c, w, h) {
    if (!t || !u || !/^https:\/\//.test(u)) return;
    if (seen.has(u)) return;
    seen.add(u);
    const tk = String(t).toLowerCase().replace(/\s+/g, ' ').trim();
    if (seenT.has(tk)) return;
    seenT.add(tk);
    list.push({ t: String(t).replace(/&amp;/g, '&').replace(/&#0?39;/g, '\'').replace(/&quot;/g, '"').slice(0, 80), u, img: img || '', c: c || 'Arcade', w: w || 800, h: h || 600 });
  }
  // famobi first: the small curated catalog — every game, quality up front
  try {
    const r = await fetch(FAMOBI_FEED, { headers: { 'user-agent': BROWSER_UA, 'accept': 'application/json' } });
    if (r.ok) {
      const j = await r.json();
      for (const g of ((j && j.games) || [])) {
        if (!g || !g.name || !g.link) continue;
        const raw = (g.categories && g.categories[0]) ? String(g.categories[0]) : 'Arcade';
        push(g.name, g.link, g.thumb || '', raw.charAt(0).toUpperCase() + raw.slice(1), 800, 600);
      }
    }
  } catch {}
  // gamemonetize: the bulk catalog behind it
  try {
    const r = await fetch(GM_FEED, { headers: { 'user-agent': BROWSER_UA, 'accept': 'application/json' } });
    if (r.ok) {
      const j = await r.json();
      for (const g of (Array.isArray(j) ? j : [])) {
        if (!g || !g.title || !g.url) continue;
        push(g.title, g.url, g.thumb || '', g.category || 'Arcade', +g.width || 800, +g.height || 600);
        if (list.length >= 8000) break;
      }
    }
  } catch {}
  if (list.length) {
    list = pinPopular(list);
    if (gamesCache.list && gamesCache.list.length > 400 && list.length < gamesCache.list.length * 0.5) { gamesCache.at = Date.now() - 3300e3; return gamesCache.list; }
    gamesCache = { at: Date.now(), list };
    return list;
  }
  if (gamesCache.list) { gamesCache.at = Date.now() - 3300e3; return gamesCache.list; }
  return FALLBACK_GAMES;
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const APPS = [
  { t: 'Discord', u: 'https://discord.com/app', c: 'Social', lg: 'discord' },
  { t: 'TikTok', u: 'https://www.tiktok.com', c: 'Social', lg: 'tiktok' },
  { t: 'Instagram', u: 'https://www.instagram.com', c: 'Social', lg: 'instagram' },
  { t: 'Snapchat', u: 'https://web.snapchat.com', c: 'Social', lg: 'snapchat' },
  { t: '6ixTube', u: 'https://www.youtube.com', c: 'Video', lg: 'youtube' },
  { t: 'Roblox Cloud', u: 'https://now.gg/apps/a/19900/b.html', c: 'Games', lg: 'roblox' },
  { t: 'Twitch', u: 'https://www.twitch.tv', c: 'Video', lg: 'twitch' },
  { t: 'Spotify', u: 'https://open.spotify.com', c: 'Music', lg: 'spotify' },
  
  { t: 'X', u: 'https://x.com', c: 'Social', lg: 'x' },
  { t: 'WhatsApp', u: 'https://web.whatsapp.com', c: 'Social', lg: 'whatsapp' },
  { t: 'Reddit', u: 'https://www.reddit.com', c: 'Social', lg: 'reddit' },
  { t: 'Kick', u: 'https://kick.com', c: 'Video', lg: 'kick' },
  { t: 'CapCut', u: 'https://www.capcut.com', c: 'Tools', fi: 'capcut.com' },
  { t: 'Gmail', u: 'https://mail.google.com', c: 'Google', lg: 'gmail' },
  { t: 'Classroom', u: 'https://classroom.google.com', c: 'Google', lg: 'googleclassroom' },
  { t: 'Drive', u: 'https://drive.google.com', c: 'Google', lg: 'googledrive' },
  { t: 'Docs', u: 'https://docs.google.com', c: 'Google', lg: 'googledocs' },
  { t: 'Telegram', u: 'https://web.telegram.org', c: 'Social', lg: 'telegram' },
  { t: 'Facebook', u: 'https://www.facebook.com', c: 'Social', lg: 'facebook' },
  { t: 'Pinterest', u: 'https://www.pinterest.com', c: 'Social', lg: 'pinterest' },
  { t: 'SoundCloud', u: 'https://soundcloud.com', c: 'Music', lg: 'soundcloud' },
  { t: 'YouTube Music', u: 'https://music.youtube.com', c: 'Music', lg: 'youtubemusic' },
  { t: 'Tubi', u: 'https://tubitv.com', c: 'Video', lg: 'tubi' },
  { t: 'Hulu', u: 'https://www.hulu.com', c: 'Video' },
  { t: 'Pluto TV', u: 'https://pluto.tv', c: 'Video', fi: 'pluto.tv' },
  
  
  
  
  { t: 'Canva', u: 'https://www.canva.com', c: 'Tools', fi: 'canva.com' },
  { t: 'Photopea', u: 'https://www.photopea.com', c: 'Tools', lg: 'photopea' },
  { t: 'VS Code', u: 'https://vscode.dev', c: 'Tools', fi: 'vscode.dev' },
  { t: 'GitHub', u: 'https://github.com', c: 'Tools', lg: 'github' },
  { t: 'Maps', u: 'https://www.google.com/maps', c: 'Google', lg: 'googlemaps' },
  { t: 'Photos', u: 'https://photos.google.com', c: 'Google', lg: 'googlephotos' },
  { t: 'Apple Music', u: 'https://music.apple.com', c: 'Music', lg: 'applemusic' },
  { t: 'Audiomack', u: 'https://audiomack.com', c: 'Music', lg: 'audiomack' },
  { t: 'Rumble', u: 'https://rumble.com', c: 'Video', lg: 'rumble' },
  { t: 'Dailymotion', u: 'https://www.dailymotion.com', c: 'Video', lg: 'dailymotion' },
  { t: 'Wikipedia', u: 'https://www.wikipedia.org', c: 'Tools', lg: 'wikipedia' },
  { t: 'Internet Archive', u: 'https://archive.org', c: 'Tools', lg: 'internetarchive' }
];
function appHue(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return (h >= 18 && h <= 58) ? h + 205 : h; }
function appsPage() {
  const cats = [...new Set(APPS.map(a => a.c))].sort();
  const APK_CARD = '';
  const cards = APK_CARD + APPS.map((a, ai) => {
    const dom = (() => { try { return new URL(a.u).hostname.replace(/^www\./, ''); } catch (err) { return a.u; } })();
    const iconDom = a.t === 'WhatsApp' ? 'whatsapp.com' : a.t === 'VS Code' ? 'code.visualstudio.com' : dom;
    const fav = proxied('https://www.google.com/s2/favicons?domain=' + iconDom + '&sz=128');
    const brand = a.lg ? proxied('https://cdn.simpleicons.org/' + a.lg) : '';
    const letter = '<span class="appLetter" style="background:hsl(' + appHue(a.t) + ',42%,32%)">' + escHtml(a.t.slice(0, 1).toUpperCase()) + '</span>';
    return `<a class="card appRow" href="/appplay?u=${encodeURIComponent(a.u)}&t=${encodeURIComponent(a.t)}" data-s="${escHtml((a.t + ' ' + a.c).toLowerCase())}" data-c="${escHtml(a.c)}" data-u="${escHtml(a.u)}" data-i="${ai}">
      <span class="appIcon">${letter}<img class="appLogo" loading="lazy" alt="" src="${fav}" data-brand="${brand}"></span>
      <span class="appMeta"><b>${escHtml(a.t)}</b><i>${escHtml(a.c)} · ${escHtml(dom)}</i></span>
      <span class="fav" data-f="${escHtml(a.u)}">☆</span></a>`;
  }).join('');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#0a0a0b"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="6ixNetworks"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><script>if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}</script><title>Google</title><link rel="icon" href="https://www.google.com/favicon.ico">
${FONT_LINKS}<style>${GALAXY_CSS}</style><style>.card{position:relative}.fav{position:absolute;top:6px;right:8px;z-index:2;font-size:19px;line-height:1;color:rgba(255,255,255,.85);text-shadow:0 1px 6px rgba(0,0,0,.85);cursor:pointer;padding:3px 5px}.fav.on{color:#fbbf24}.chip{background:rgba(13,11,26,.55);color:#f4f4f5;border:1px solid rgba(var(--star),.25);border-radius:999px;padding:9px 15px;cursor:pointer;font-weight:700;font-family:inherit}.chip.on{background:rgba(var(--acc),.32)}#grid{display:flex;flex-direction:column;gap:10px;max-width:880px;margin:16px auto}
.card.appRow{display:flex;align-items:center;gap:14px;background:#101012;border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:12px 14px;text-decoration:none;aspect-ratio:auto;height:auto;min-height:0}
.card.appRow:hover{border-color:rgba(255,255,255,.32)}
.appIcon{position:relative;width:52px;height:52px;flex:none;border-radius:14px;overflow:hidden;background:#f4f4f5;display:flex;align-items:center;justify-content:center}
.appLetter{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:800;color:#fff}
.card img.appLogo{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;padding:7px;box-sizing:border-box;background:#f4f4f5}
.appMeta{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;text-align:left}
.appMeta b{font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.appMeta i{font-style:normal;opacity:.6;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card.appRow .fav{position:static;flex:none;width:38px;height:38px;display:flex;align-items:center;justify-content:center;font-size:19px;padding:0}
</style></head><body>${STAR_CANVAS}<div class="wrap">
<a class="back" href="/home">← 6ixNetworks</a>
<h1>6ix<span>Networks</span> apps</h1>

<div class="bar"><input id="gq" type="text" placeholder="search apps..." autocomplete="off">
<select id="gc"><option value="">all categories</option>${cats.map(c => `<option>${escHtml(c)}</option>`).join('')}</select><button class="chip" id="gfav" type="button">★ favorites</button><button class="chip" id="grec" type="button">recent</button><button class="chip" id="grand" type="button">random</button><a class="chip" href="/gs" style="text-decoration:none">games</a></div>
<div class="grid" id="grid">${cards}</div>
${SIDEBAR_HTML}

</div>
<script src="/ui.js"></script>
<script>
var gq=document.getElementById('gq'), gc=document.getElementById('gc'), grid=document.getElementById('grid');
var favOnly=false, recOnly=false;
function ls(k, d){ try{ return JSON.parse(localStorage.getItem(k)) || d; }catch(e){ return d; } }
function favs(){ return ls('gx_afavs', []); }
function recents(){ return ls('gx_arecent', []); }
function paintFavs(){ var f=favs(); document.querySelectorAll('.fav').forEach(function(el){ var on=f.indexOf(el.dataset.f)>=0; el.classList.toggle('on', on); el.textContent = on ? '★' : '☆'; }); }
function filt(){ var q=gq.value.toLowerCase(), c=gc.value, f=favs(), r=recents();
  document.querySelectorAll('.card').forEach(function(el){
    var ok = (!q || el.dataset.s.includes(q)) && (!c || el.dataset.c===c);
    if(favOnly) ok = ok && f.indexOf(el.dataset.u)>=0;
    if(recOnly) ok = ok && r.indexOf(el.dataset.u)>=0;
    el.style.display = ok ? '' : 'none';
  });
}
function orderRecent(on){ var cards=[].slice.call(grid.querySelectorAll('.card')); if(on){ var r=recents(); cards.sort(function(a,b){ var ia=r.indexOf(a.dataset.u), ib=r.indexOf(b.dataset.u); ia = ia<0 ? 999 : ia; ib = ib<0 ? 999 : ib; return ia-ib; }); } else { cards.sort(function(a,b){ return (+a.dataset.i)-(+b.dataset.i); }); } cards.forEach(function(el){ grid.appendChild(el); }); }
gq.addEventListener('input', filt); gc.addEventListener('change', filt);
document.getElementById('gfav').addEventListener('click', function(){ favOnly=!favOnly; this.classList.toggle('on', favOnly); filt(); });
document.getElementById('grec').addEventListener('click', function(){ recOnly=!recOnly; this.classList.toggle('on', recOnly); orderRecent(recOnly); filt(); });
document.getElementById('grand').addEventListener('click', function(){ var vis=[].slice.call(grid.querySelectorAll('.card')).filter(function(el){ return el.style.display!=='none'; }); if(vis.length) location.href = vis[Math.floor(Math.random()*vis.length)].href; });
grid.addEventListener('click', function(e){
  var f=e.target.closest ? e.target.closest('.fav') : null;
  if(f){ e.preventDefault(); e.stopPropagation(); var u=f.dataset.f, a=favs(), i=a.indexOf(u); if(i>=0) a.splice(i,1); else a.push(u); try{ localStorage.setItem('gx_afavs', JSON.stringify(a)); }catch(err){} paintFavs(); if(favOnly) filt(); return; }
  var card=e.target.closest ? e.target.closest('.card') : null;
  if(card && card.dataset.u){ var r=recents().filter(function(x){ return x!==card.dataset.u; }); r.unshift(card.dataset.u); try{ localStorage.setItem('gx_arecent', JSON.stringify(r.slice(0,12))); }catch(err){} }
});
paintFavs();
document.querySelectorAll('.appLogo').forEach(function(img){
  function bad(){ var b=img.getAttribute('data-brand'); if(b && !img.dataset.fb){ img.dataset.fb='1'; img.src=b; } else { img.remove(); } }
  img.addEventListener('error', bad);
  if(img.complete && img.naturalWidth===0) bad();
});
</script>
<script>${NOTIF_JS}</script>
</body>
</html>`;
}

function gamesPage() {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#0a0a0b"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="6ixNetworks"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><script>if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}</script><title>Google</title><link rel="icon" href="https://www.google.com/favicon.ico">
${FONT_LINKS}<style>${GALAXY_CSS}</style><style>.card{position:relative}.fav{position:absolute;top:6px;right:8px;z-index:2;font-size:19px;line-height:1;color:rgba(255,255,255,.85);text-shadow:0 1px 6px rgba(0,0,0,.85);cursor:pointer;padding:3px 5px}.fav.on{color:#fbbf24}.chip{background:#0d0b1a;color:#f4f4f5;border:1px solid rgba(var(--star),.22);border-radius:999px;padding:9px 15px;cursor:pointer;font-weight:700;font-family:inherit}.chip.on{background:rgba(var(--acc),.3);border-color:rgba(var(--star),.55)}
#feat{position:relative;display:block;border-radius:20px;overflow:hidden;margin:4px 0 18px;border:1px solid rgba(var(--star),.16);text-decoration:none;color:#fff;background:#0d0b08;width:100%;max-width:1120px}
#feat img{width:100%;height:230px;object-fit:cover;display:block;opacity:1}
#feat .feat-cap{position:absolute;left:0;right:0;bottom:0;padding:38px 18px 14px;background:linear-gradient(180deg,transparent,rgba(0,0,0,.82));display:flex;align-items:flex-end;gap:10px}
#feat .feat-tag{font-size:10.5px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#0a0a0b;background:#e4e4e7;border-radius:999px;padding:4px 9px;flex:none;margin-bottom:3px}
#feat .feat-t{font-size:21px;font-weight:800;letter-spacing:-.01em}
#feat .feat-c{font-size:12.5px;color:#c9c2b4}
#feat .feat-b{font-size:13.5px;color:#e9e2ff;margin-top:5px;font-style:italic;max-width:540px}
#feat .feat-dots{position:absolute;top:12px;right:14px;display:flex;gap:6px}
#feat .feat-dots i{width:7px;height:7px;border-radius:99px;background:rgba(255,255,255,.35);display:block}
#feat .feat-dots i.on{background:#e4e4e7}
#feat.fade{animation:featfade .5s ease}
@keyframes featfade{from{opacity:.35}to{opacity:1}}
.gbar{position:relative;z-index:40;background:rgba(9,9,13,.88);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);margin:0 -8px;padding:10px 8px 9px;border-bottom:1px solid rgba(255,255,255,.07)}#gbar{position:static;margin:0}
#gq{background:#0d0b1a;border-color:rgba(var(--star),.18);font-size:16px}
#gchips{display:flex;gap:8px;overflow-x:auto;overscroll-behavior-x:contain;padding:10px 2px 1px;scrollbar-width:none}
#gchips::-webkit-scrollbar{display:none}
#gchips .chip{flex:none;padding:7px 13px;font-size:13.5px}\n.gtop{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:1px 2px 10px}\n.gname{font-size:19px;font-weight:800;letter-spacing:-.01em;color:#f4f4f5}\n.gname #gcount{font-size:13px;font-weight:500;color:#9c9ca5;margin-left:9px}\n.gutils{margin-left:auto;display:flex;gap:7px;flex-wrap:wrap}\n.gutils .chip{padding:6px 11px;font-size:12.5px}
.sec-h{font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#8a7a5c;margin:0 2px 9px}
#popWrap{width:100%;max-width:1120px;margin:0 0 18px}
#popRow{display:flex;gap:12px;overflow-x:auto;padding:2px 2px 10px;scroll-snap-type:x mandatory;scrollbar-width:none}
#popRow::-webkit-scrollbar{display:none}
.pop{flex:0 0 252px;aspect-ratio:16/10;scroll-snap-align:start;border-radius:16px}
.pop img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;aspect-ratio:auto}
.pop .gicon,.pop .ltile,.pop .lgwrap{position:absolute;inset:0;width:100%;height:100%;aspect-ratio:auto}
.pop .rank{position:absolute;left:9px;bottom:0;font-size:52px;font-weight:900;line-height:.95;color:rgba(10,10,11,.25);-webkit-text-stroke:2px rgba(255,255,255,.9);z-index:2;font-style:italic}
.pop .popcap{position:absolute;left:0;right:0;bottom:0;padding:26px 12px 9px 58px;background:linear-gradient(180deg,transparent,rgba(0,0,0,.85));z-index:1}
.pop .popcap .gt{padding:0;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pop .popcap .popc{font-size:11.5px;color:#a1a1aa}
#jumpWrap{width:100%;max-width:1120px;margin:2px 0 16px}
#jumpRow{display:flex;gap:12px;overflow-x:auto;padding-bottom:6px;scrollbar-width:none}
#jumpRow::-webkit-scrollbar{display:none}
#jumpRow .card{flex:0 0 168px}
.lgwrap{width:100%;aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;background:radial-gradient(120% 120% at 30% 18%,#1e1e28,#0b0b0f);overflow:hidden}.lgwrap img{width:74%;height:74%;object-fit:contain;aspect-ratio:auto;background:transparent;border-radius:14%;filter:drop-shadow(0 8px 16px rgba(0,0,0,.5))}.ltile{font-size:46px;font-weight:900;color:rgba(255,255,255,.94);letter-spacing:-.02em;text-shadow:0 2px 14px rgba(0,0,0,.4)}
#grid{gap:16px}
#pager{display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:center;margin:22px 0 8px;width:100%;max-width:1120px}
.pgbtn{flex:none;min-width:42px}
.pgbtn[disabled]{opacity:.35;cursor:default}
.pgdots{color:#8a7a5c;padding:0 2px}

#grid .card{border-radius:16px}
@media(hover:hover){ #grid .card{transition:transform .16s ease,border-color .16s ease,box-shadow .16s ease} #grid .card:hover{transform:translateY(-3px);box-shadow:0 10px 26px rgba(0,0,0,.45)} }
@media(max-width:640px){ #feat img{height:160px} #feat .feat-t{font-size:18px} .pop{flex-basis:206px} .pop .rank{font-size:42px} #grid{grid-template-columns:repeat(2,1fr);gap:10px} #grid .gt{font-size:13px;padding:8px 10px 1px} #grid .gc{padding:0 10px 9px;font-size:11px} .gbar{padding:8px 6px 7px} .gbar .bar{gap:7px} #gq{padding:11px 14px} .gbar .chip{padding:8px 13px;font-size:13.5px} .pop .rank{font-size:36px} .pop .popcap{padding:24px 12px 9px 50px} #gq{flex:1 1 100%;width:100%} #gchips{padding-top:8px} #feat img{height:168px} #feat .feat-b{display:none} #feat .feat-t{font-size:17px} }
</style></head><body>${STAR_CANVAS}<div class="wrap">
<div id="gbarWrap"><div class="gbar" id="gbar"><div class="gtop"><div class="gname">games<span id="gcount">loading games…</span></div><div class="gutils"><a class="chip" href="/emu" style="text-decoration:none"><svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' style='vertical-align:-2px;margin-right:5px'><line x1="6" y1="12" x2="10" y2="12"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="15" y1="13" x2="15.01" y2="13"/><line x1="18" y1="11" x2="18.01" y2="11"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59C2.62 9.42 2 14.46 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.62-6.584-.685-7.258A4 4 0 0 0 17.32 5z"/></svg> emulator</a></div></div>\n<div class="bar" style="margin:0"><input id="gq" type="text" placeholder="search 8,000+ games..." autocomplete="off">
<button class="chip" id="gfav" type="button">★ favorites</button><button class="chip" id="grec" type="button">recent</button><button class="chip" id="grand" type="button"><svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' style='vertical-align:-2px;margin-right:5px'><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg> random</button></div>
<div id="gchips"></div></div></div>


<a id="feat" hidden></a>
<div id="popWrap" hidden><div class="sec-h">popular rn</div><div id="popRow"></div></div>
<div id="jumpWrap" hidden><div class="sec-h">jump back in</div><div id="jumpRow"></div></div>
<div class="sec-h" style="margin-top:4px">all games</div>
<div class="grid" id="grid"></div><div id="pager"></div>
${SIDEBAR_HTML}

</div>
<script src="/ui.js"></script>
<script>
var gq=document.getElementById('gq'); try { var _q = new URLSearchParams(location.search).get('q'); if (_q) gq.value = _q; } catch(e){}
var _gq2=document.getElementById('gq'), grid=document.getElementById('grid'), gcount=document.getElementById('gcount'), gchips=document.getElementById('gchips');
var GAMES=[], view=[], page=0, favOnly=false, recOnly=false, PS=96, CAT='';
function ls(k, d){ try{ return JSON.parse(localStorage.getItem(k)) || d; }catch(e){ return d; } }
function favs(){ return ls('gx_favs', []); }
function recents(){ return ls('gx_recent', []); }
function escA(s){ return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;'); }
function playHref(g){ return '/play?u='+encodeURIComponent(g.u)+'&t='+encodeURIComponent(g.t); }
function hueFor(t){ var h=0; for(var i=0;i<t.length;i++){ h=(h*31 + t.charCodeAt(i))%360; } return h; }
function tileFor(g){ if(g.img && g.lg) return '<div class="lgwrap"><img loading="lazy" src="'+escA(g.img)+'" alt=""></div>'; if(g.img) return '<img loading="lazy" src="'+escA(g.img)+'" alt="">'; if(g.icon) return '<div class="noimg gicon">'+g.icon+'</div>'; var h=hueFor(g.t); var L=(g.t.replace(/[^a-z0-9]/gi,'').charAt(0) || '?').toUpperCase(); return '<div class="noimg ltile" style="background:linear-gradient(135deg,hsl('+h+',48%,30%),hsl('+((h+50)%360)+',55%,15%))">'+L+'</div>'; }
function mkCard(g, i){ var a=document.createElement('a'); a.className='card'; a.href=playHref(g); a.dataset.s=(g.t+' '+g.c).toLowerCase(); a.dataset.c=g.c; a.dataset.u=g.u; a.dataset.i=i;
  a.innerHTML=tileFor(g)+'<span class="fav" data-f="'+escA(g.u)+'">☆</span><div class="gt"></div><div class="gc"></div>';
  a.querySelector('.gt').textContent=g.t; a.querySelector('.gc').textContent=g.c||''; return a; }
function mkPop(g, rank){ var a=document.createElement('a'); a.className='card pop'; a.href=playHref(g); a.dataset.u=g.u;
  a.innerHTML=tileFor(g)+'<span class="rank">'+rank+'</span><div class="popcap"><div class="gt"></div><div class="popc"></div></div>';
  a.querySelector('.gt').textContent=g.t; a.querySelector('.popc').textContent=g.c||''; return a; }
function paintFavs(){ var f=favs(); document.querySelectorAll('.fav').forEach(function(el){ var on=f.indexOf(el.dataset.f)>=0; el.classList.toggle('on', on); el.textContent = on ? '★' : '☆'; }); }
function renderPage(){
  var pages = Math.max(1, Math.ceil(view.length / PS));
  if (page >= pages) page = pages - 1;
  if (page < 0) page = 0;
  grid.innerHTML = '';
  var start = page * PS, end = Math.min(start + PS, view.length);
  var frag = document.createDocumentFragment();
  for (var i = start; i < end; i++) frag.appendChild(mkCard(view[i], i));
  grid.appendChild(frag);
  paintFavs();
  if (gcount) gcount.textContent = GAMES.length.toLocaleString() + ' games' + (view.length !== GAMES.length ? ' \u2014 ' + view.length.toLocaleString() + ' match' : '') + (pages > 1 ? ' \u2014 page ' + (page + 1) + ' of ' + pages.toLocaleString() : '');
  buildPager(pages);
}
function buildPager(pages){
  var pg = document.getElementById('pager');
  if (!pg) return;
  pg.innerHTML = '';
  if (pages <= 1) return;
  function btn(label, target){
    var b = document.createElement('button'); b.type = 'button'; b.className = 'chip pgbtn'; b.textContent = label;
    if (target === page) b.classList.add('on');
    if (target < 0 || target >= pages) b.disabled = true;
    b.addEventListener('click', function(){ if (target !== page && target >= 0 && target < pages) { page = target; renderPage(); grid.scrollIntoView({ behavior: 'smooth', block: 'start' }); } });
    pg.appendChild(b);
  }
  function dots(){ var s = document.createElement('span'); s.className = 'pgdots'; s.textContent = '\u2026'; pg.appendChild(s); }
  btn('\u2190 prev', page - 1);
  var win = [0, page - 1, page, page + 1, pages - 1].filter(function(v, ix, a){ return v >= 0 && v < pages && a.indexOf(v) === ix; }).sort(function(a, b){ return a - b; });
  var last = -1;
  win.forEach(function(n){ if (last >= 0 && n - last > 1) dots(); btn(String(n + 1), n); last = n; });
  btn('next \u2192', page + 1);
}
function applyView(){ var q=gq.value.toLowerCase(), f=favs(), r=recents();
  view = GAMES.filter(function(g){ var ok = (!q || (g.t+' '+g.c).toLowerCase().indexOf(q)>=0) && (!CAT || g.c===CAT); if(favOnly) ok = ok && f.indexOf(g.u)>=0; if(recOnly) ok = ok && r.indexOf(g.u)>=0; return ok; });
  if(recOnly){ view.sort(function(a,b){ var ia=r.indexOf(a.u), ib=r.indexOf(b.u); ia=ia<0?999:ia; ib=ib<0?999:ib; return ia-ib; }); }
  grid.innerHTML=''; page=0; renderPage(); }
gq.addEventListener('input', applyView);
document.getElementById('gfav').addEventListener('click', function(){ favOnly=!favOnly; this.classList.toggle('on', favOnly); applyView(); });
document.getElementById('grec').addEventListener('click', function(){ recOnly=!recOnly; this.classList.toggle('on', recOnly); applyView(); });
document.getElementById('grand').addEventListener('click', function(){ var pool = view.length ? view : GAMES; if(pool.length){ var g = pool[Math.floor(Math.random()*pool.length)]; location.href = playHref(g); } });
function cardTap(e){
  var f=e.target.closest ? e.target.closest('.fav') : null;
  if(f){ e.preventDefault(); e.stopPropagation(); var u=f.dataset.f, a=favs(), i=a.indexOf(u); if(i>=0) a.splice(i,1); else a.push(u); try{ localStorage.setItem('gx_favs', JSON.stringify(a)); }catch(err){} paintFavs(); if(favOnly) applyView(); return; }
  var card=e.target.closest ? e.target.closest('.card') : null;
  if(card && card.dataset.u){ var r=recents().filter(function(x){ return x!==card.dataset.u; }); r.unshift(card.dataset.u); try{ localStorage.setItem('gx_recent', JSON.stringify(r.slice(0,12))); }catch(err){} }
}
grid.addEventListener('click', cardTap);
document.getElementById('popRow').addEventListener('click', cardTap);
document.getElementById('jumpRow').addEventListener('click', cardTap);

function buildChips(){
  var counts={}; GAMES.forEach(function(g){ counts[g.c]=(counts[g.c]||0)+1; });
  var cats=Object.keys(counts).sort(function(a,b){ return counts[b]-counts[a]; }).slice(0,10);
  gchips.innerHTML='';
  function chip(label, val){ var b=document.createElement('button'); b.type='button'; b.className='chip'+(CAT===val?' on':''); b.textContent=label; b.addEventListener('click', function(){ CAT = (CAT===val) ? '' : val; buildChips(); applyView(); }); gchips.appendChild(b); }
  chip('all', '');
  if(counts['Featured']) chip('featured', 'Featured');
  cats.forEach(function(c){ if(c!=='Featured') chip(c.toLowerCase(), c); });
}
function buildPop(){
  var pw=document.getElementById('popWrap'), pr=document.getElementById('popRow');
  var n=0; pr.innerHTML='';
  for(var i=0;i<GAMES.length && n<14;i++){ var g=GAMES[i]; if(!g) continue; n++; pr.appendChild(mkPop(g, n)); }
  if(n) pw.hidden=false;
}
function heroStart(){
  var feat = document.getElementById('feat');
  var pool = GAMES.filter(function(g){ return g.img && !g.lg; }).slice(0, 6).map(function(g){ return { t: g.t, c: g.c, img: g.img, href: playHref(g) }; });
  var rotationOn = true;
  function showSixPick(p){
    rotationOn = false;
    feat.hidden = false;
    feat.href = p.href;
    feat.innerHTML = '';
    var im = document.createElement('img'); im.src = p.img; im.alt = '';
    var cap = document.createElement('div'); cap.className = 'feat-cap';
    var tag = document.createElement('span'); tag.className = 'feat-tag'; tag.textContent = "✦ six's pick of the day";
    var tw = document.createElement('div');
    var tt = document.createElement('div'); tt.className = 'feat-t'; tt.textContent = p.t;
    var tc = document.createElement('div'); tc.className = 'feat-c'; tc.textContent = p.c || '';
    tw.appendChild(tt); tw.appendChild(tc);
    if (p.blurb) { var tb = document.createElement('div'); tb.className = 'feat-b'; tb.textContent = p.blurb; tw.appendChild(tb); }
    cap.appendChild(tag); cap.appendChild(tw);
    feat.appendChild(im); feat.appendChild(cap);
    feat.classList.remove('fade'); void feat.offsetWidth; feat.classList.add('fade');
  }
  if (feat) { fetch('/api/six-pick').then(function(r){ return r.json(); }).then(function(p){ if (p && p.ok && p.t) showSixPick(p); }).catch(function(){}); }
  if (feat && pool.length > 1) {
    var fi = 0, ftimer = null;
    feat.hidden = false;
    function showFeat(n) {
      if (!rotationOn) return;
      var it = pool[n];
      feat.href = it.href;
      feat.innerHTML = '';
      var im = document.createElement('img'); im.src = it.img; im.alt = '';
      var cap = document.createElement('div'); cap.className = 'feat-cap';
      var tag = document.createElement('span'); tag.className = 'feat-tag'; tag.textContent = 'featured';
      var tw = document.createElement('div');
      var tt = document.createElement('div'); tt.className = 'feat-t'; tt.textContent = it.t;
      var tc = document.createElement('div'); tc.className = 'feat-c'; tc.textContent = it.c || '';
      tw.appendChild(tt); tw.appendChild(tc); cap.appendChild(tag); cap.appendChild(tw);
      var dots = document.createElement('div'); dots.className = 'feat-dots';
      pool.forEach(function(_, di){ var d = document.createElement('i'); if (di === n) d.className = 'on'; dots.appendChild(d); });
      feat.appendChild(im); feat.appendChild(cap); feat.appendChild(dots);
      feat.classList.remove('fade'); void feat.offsetWidth; feat.classList.add('fade');
    }
    function cycle(){ fi = (fi + 1) % pool.length; showFeat(fi); }
    showFeat(0);
    ftimer = setInterval(cycle, 6000);
    feat.addEventListener('mouseenter', function(){ clearInterval(ftimer); });
    feat.addEventListener('mouseleave', function(){ ftimer = setInterval(cycle, 6000); });
  }
  try {
    var rec = recents();
    var jw = document.getElementById('jumpWrap'), jr = document.getElementById('jumpRow');
    if (rec.length && jw && jr) {
      var byU = {};
      GAMES.forEach(function(g){ byU[g.u] = g; });
      var added = 0;
      rec.forEach(function(u){ var g = byU[u]; if (g && added < 10) { jr.appendChild(mkCard(g, added)); added++; } });
      if (added) jw.hidden = false;
    }
  } catch (e) {}
}
function loadCatalog(){
fetch('/api/games').then(function(r){ return r.json(); }).then(function(list){
  GAMES = Array.isArray(list) ? list : [];
  buildChips(); buildPop(); applyView(); heroStart();
}).catch(function(){ if(gcount){ gcount.innerHTML='couldnt load the games \u2014 '; var rb=document.createElement('button'); rb.className='chip'; rb.textContent='retry'; rb.addEventListener('click', loadCatalog); gcount.appendChild(rb); } });
}

/* v180: bar is fixed from first paint — zero scroll-dependent state, nothing to lag or snap on any browser */
loadCatalog();
</script>
<script>${NOTIF_JS}</script>
</body>
</html>`;
}

// ---------- invisible engine: pages stay identical to the cloudflare build; only the fetching changes ----------
function uvEncodeUrl(str) { let out = ''; for (let i = 0; i < str.length; i++) out += i % 2 ? String.fromCharCode(str.charCodeAt(i) ^ 2) : str[i]; return encodeURIComponent(out); }
function uvDecodeUrl(str) { let s = str || ''; try { s = decodeURIComponent(s); } catch (e) {} let out = ''; for (let i = 0; i < s.length; i++) out += i % 2 ? String.fromCharCode(s.charCodeAt(i) ^ 2) : s[i]; return out; }
const UV_BOOT = '<script src="/uv-assets/baremux/index.js?e=68"></' + 'script><script>(function(){ if (window.__gxUv) return; window.__gxUv = 1; (async function(){ try { var conn = new BareMux.BareMuxConnection(\'/uv-assets/baremux/worker.js?e=68\'); if ((await conn.getTransport()) !== \'/uv-assets/epoxy/index.mjs?e=68\') await conn.setTransport(\'/uv-assets/epoxy/index.mjs?e=68\', [{ wisp: (location.protocol === \'https:\' ? \'wss:\' : \'ws:\') + \'//\' + location.host + \'/wisp/\' }]); } catch (e) {} })(); })();</' + 'script>';
function uvWarmPage(target) {
  let classic = '/home';
  try { if (/^https:\/\//i.test(target || '')) classic = proxied(target); } catch (e) {}
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#0a0a0b"><title>Google</title><link rel="icon" href="https://www.google.com/favicon.ico">
${FONT_LINKS}<style>${GALAXY_CSS}</style></head><body><div class="wrap" style="text-align:center;padding-top:16vh">
<div class="brand6">6net<span>lite</span></div>
<p class="sub">loading…</p>
<p id="slow" class="sub" style="display:none">taking long — <a href="${escHtml(classic)}">open it the classic way</a></p>
</div>
<script src="/uv-assets/baremux/index.js?e=68"></script>
<script>
(async function(){
  try { var bk = 'gx_warm_' + location.pathname; var bn = +(sessionStorage.getItem(bk) || 0); if (bn >= 3) { location.replace(document.querySelector('#slow a').href); return; } sessionStorage.setItem(bk, String(bn + 1)); } catch (e) {}
  var slow = document.getElementById('slow');
  setTimeout(function(){ slow.style.display = 'block'; }, 8000);
  try {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(function(res){ var to=setTimeout(res, 7000); navigator.serviceWorker.addEventListener('controllerchange', function(){ clearTimeout(to); res(); }); });
    var conn = new BareMux.BareMuxConnection('/uv-assets/baremux/worker.js?e=68');
    if ((await conn.getTransport()) !== '/uv-assets/epoxy/index.mjs?e=68') await conn.setTransport('/uv-assets/epoxy/index.mjs?e=68', [{ wisp: (window.GX_WISP || (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/wisp/') }]);
    if (sessionStorage.getItem('gxWarm') === '1') { slow.style.display = 'block'; return; }
    sessionStorage.setItem('gxWarm', '1');
    location.replace(location.href);
  } catch (e) { slow.style.display = 'block'; }
})();
</script>
</body>
</html>`;
}

function playPageUv(u, t) {
  if (!/^https:\/\//i.test(u || '')) {
    return '<!DOCTYPE html><body style="background:#0a0a0b;color:#f2f2f2;font-family:system-ui;padding:40px">bad game link — <a style="color:#e4e4e7" href="/gs">back to games</a></body>';
  }
  const prox = '/uv/service/' + uvEncodeUrl(u);
  const alt = proxied(u);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#0a0a0b"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="6ixNetworks"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><script>if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}</script><title>Google</title><link rel="icon" href="https://www.google.com/favicon.ico">
${FONT_LINKS}<style>${GALAXY_CSS}</style></head><body class="playbody">${STAR_CANVAS}
<div class="top"><a href="/gs">← games</a><span class="title">${escHtml(t || 'Game')}</span><span id="st" style="opacity:.7;font-size:13px"></span>
<button class="on" onclick="useNet()">network</button>
<button onclick="retry()">retry</button>
<button onclick="document.getElementById('gf').requestFullscreen()">fullscreen</button>
<button onclick="cloakTab('google')">cloak: google</button>
<button onclick="cloakTab('drive')" style="background:rgba(255,255,255,.07);color:#f4f4f5;border:1px solid rgba(255,255,255,.35);border-radius:999px;padding:7px 13px;cursor:pointer">drive</button><button onclick="cloakOpen()">cloaked tab</button></div>
<iframe class="gameframe" id="gf" src="about:blank" allowfullscreen allow="autoplay; fullscreen; gamepad; keyboard-lock; camera; microphone"></iframe>
<div id="dead" onclick="retry()" style="display:none;position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:5;background:rgba(18,18,20,.92);border:1px solid rgba(255,255,255,.45);color:#f4f4f5;border-radius:999px;padding:10px 20px;cursor:pointer;font-weight:700">✦ retry</div>
<script src="/ui.js"></script>
<script src="/stars.js?e=96"></script>
<script src="/uv-assets/baremux/index.js?e=68"></script>
<script>
var BOOTING=true;
var PROX=${JSON.stringify(prox)};
var gf=document.getElementById('gf'), stEl=document.getElementById('st');
try{ var gu=new URLSearchParams(location.search).get('u'); if(gu){ var R=[]; try{ R=JSON.parse(localStorage.getItem('gx_recent'))||[]; }catch(e){} R=[gu].concat(R.filter(function(x){ return x!==gu; })).slice(0,12); localStorage.setItem('gx_recent', JSON.stringify(R)); } }catch(e){}
var tries=0, alive=false;
function errPage(){
  try{
    var d=gf.contentDocument;
    if(!d || !d.body) return false;
    var t=d.body.innerText||'';
    return /error processing your request|failed to load|proxy could not reach|that host is blocked|bad proxy path/i.test(t);
  }catch(e){ return false; }
}
function hasLife(){
  try{
    var d=gf.contentDocument;
    if(!d || !d.body) return false;
    if(d.querySelector('canvas,iframe,video,embed,object')) return true;
    return d.body.innerHTML.length > 5000 && (d.body.innerText||'').trim().length > 40;
  }catch(e){ return false; }
}
function check(){
  if(BOOTING || alive) return;
  if(hasLife()){ alive=true; if(stEl) stEl.textContent=''; return; }
  if(errPage()){
    if(tries<2){ tries++; if(stEl) stEl.textContent='reconnecting\u2026'; gf.src=PROX; arm(); }
    else { if(stEl) stEl.textContent=''; document.getElementById('dead').style.display='block'; }
  }
}
function arm(){ [6000, 14000, 26000, 45000].forEach(function(ms){ setTimeout(check, ms); }); }
function useNet(){ tries=0; alive=false; document.getElementById('dead').style.display='none'; if(stEl) stEl.textContent=''; gf.src=PROX; arm(); }
function retry(){ useNet(); }
gf.addEventListener('load', function(){ setTimeout(check, 4000); });
(async function(){
  try {
    if ('serviceWorker' in navigator) {
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise(function(res){ var to=setTimeout(res, 7000); navigator.serviceWorker.addEventListener('controllerchange', function(){ clearTimeout(to); res(); }); });
    }
    var conn = new BareMux.BareMuxConnection('/uv-assets/baremux/worker.js?e=68');
    if ((await conn.getTransport()) !== '/uv-assets/epoxy/index.mjs?e=68') await conn.setTransport('/uv-assets/epoxy/index.mjs?e=68', [{ wisp: (window.GX_WISP || (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/wisp/') }]);
  } catch (e) {}
  BOOTING=false;
  gf.src=PROX;
  arm();
})();
</script>
</body>
</html>`;
}

function appPlayPageUv(u, t) {
  if (!/^https:\/\//i.test(u || '')) {
    return '<!DOCTYPE html><body style="background:#0a0a0b;color:#f2f2f2;font-family:system-ui;padding:40px">bad app link — <a style="color:#e4e4e7" href="/apps">back to apps</a></body>';
  }
  const prox = '/uv/service/' + uvEncodeUrl(u);
  const alt = proxied(u);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#0a0a0b"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="6ixNetworks"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><script>if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}</script><title>Google</title><link rel="icon" href="https://www.google.com/favicon.ico">
${FONT_LINKS}<style>${GALAXY_CSS}</style></head><body class="playbody">${STAR_CANVAS}
<div class="top"><a href="/apps">← apps</a><span class="title">${escHtml(t || 'App')}</span><span id="st" style="opacity:.7;font-size:13px"></span>
<button class="on" onclick="useNet()">network</button>
<button onclick="retry()">retry</button>
<button onclick="document.getElementById('gf').requestFullscreen()">fullscreen</button>
<button onclick="cloakTab('google')">cloak: google</button>
<button onclick="cloakTab('drive')" style="background:rgba(255,255,255,.07);color:#f4f4f5;border:1px solid rgba(255,255,255,.35);border-radius:999px;padding:7px 13px;cursor:pointer">drive</button><button onclick="cloakOpen()">cloaked tab</button></div>
<iframe class="gameframe" id="gf" src="about:blank" allowfullscreen allow="autoplay; fullscreen; gamepad; keyboard-lock; camera; microphone"></iframe>
<div id="dead" onclick="retry()" style="display:none;position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:5;background:rgba(18,18,20,.92);border:1px solid rgba(255,255,255,.45);color:#f4f4f5;border-radius:999px;padding:10px 20px;cursor:pointer;font-weight:700">✦ retry</div>
<script src="/ui.js"></script>
<script src="/stars.js?e=96"></script>
<script src="/uv-assets/baremux/index.js?e=68"></script>
<script>
var BOOTING=true;
var PROX=${JSON.stringify(prox)};
var gf=document.getElementById('gf'), stEl=document.getElementById('st');
try{ var gu=new URLSearchParams(location.search).get('u'); if(gu){ var R=[]; try{ R=JSON.parse(localStorage.getItem('gx_arecent'))||[]; }catch(e){} R=[gu].concat(R.filter(function(x){ return x!==gu; })).slice(0,12); localStorage.setItem('gx_arecent', JSON.stringify(R)); } }catch(e){}
var tries=0, alive=false;
function errPage(){
  try{
    var d=gf.contentDocument;
    if(!d || !d.body) return false;
    var t=d.body.innerText||'';
    return /error processing your request|failed to load|proxy could not reach|that host is blocked|bad proxy path/i.test(t);
  }catch(e){ return false; }
}
function hasLife(){
  try{
    var d=gf.contentDocument;
    if(!d || !d.body) return false;
    if(d.querySelector('canvas,iframe,video,embed,object')) return true;
    return d.body.innerHTML.length > 5000 && (d.body.innerText||'').trim().length > 40;
  }catch(e){ return false; }
}
function check(){
  if(BOOTING || alive) return;
  if(hasLife()){ alive=true; if(stEl) stEl.textContent=''; return; }
  if(errPage()){
    if(tries<2){ tries++; if(stEl) stEl.textContent='reconnecting\u2026'; gf.src=PROX; arm(); }
    else { if(stEl) stEl.textContent=''; document.getElementById('dead').style.display='block'; }
  }
}
function arm(){ [6000, 14000, 26000, 45000].forEach(function(ms){ setTimeout(check, ms); }); }
function useNet(){ tries=0; alive=false; document.getElementById('dead').style.display='none'; if(stEl) stEl.textContent=''; gf.src=PROX; arm(); }
function retry(){ useNet(); }
gf.addEventListener('load', function(){ setTimeout(check, 4000); });
(async function(){
  try {
    if ('serviceWorker' in navigator) {
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise(function(res){ var to=setTimeout(res, 7000); navigator.serviceWorker.addEventListener('controllerchange', function(){ clearTimeout(to); res(); }); });
    }
    var conn = new BareMux.BareMuxConnection('/uv-assets/baremux/worker.js?e=68');
    if ((await conn.getTransport()) !== '/uv-assets/epoxy/index.mjs?e=68') await conn.setTransport('/uv-assets/epoxy/index.mjs?e=68', [{ wisp: (window.GX_WISP || (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/wisp/') }]);
  } catch (e) {}
  BOOTING=false;
  gf.src=PROX;
  arm();
})();
</script>
</body>
</html>`;
}
function playPage(u, t) {
  if (!/^https:\/\//i.test(u || '')) {
    return '<!DOCTYPE html><body style="background:#0a0a0b;color:#f2f2f2;font-family:system-ui;padding:40px">bad game link — <a style="color:#e4e4e7" href="/gs">back to games</a></body>';
  }
  const prox = UV_OK() ? '/uv/service/' + uvEncodeUrl(u) : gproxied(u);
  const alt = proxied(u);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#0a0a0b"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="6ixNetworks"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><script>if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}</script><title>Google</title><link rel="icon" href="https://www.google.com/favicon.ico">
${FONT_LINKS}<style>${GALAXY_CSS}</style></head><body class="playbody">${STAR_CANVAS}
<div class="top"><a href="/gs">← games</a><span class="title">${escHtml(t || 'Game')}</span><span id="st" style="opacity:.7;font-size:13px"></span>
<button class="on" onclick="useNet()">network</button>
<button onclick="retry()">retry</button>
<button onclick="document.getElementById('gf').requestFullscreen()">fullscreen</button>
<button onclick="cloakTab('google')">cloak: google</button>
<button onclick="cloakTab('drive')" style="background:rgba(255,255,255,.07);color:#f4f4f5;border:1px solid rgba(255,255,255,.35);border-radius:999px;padding:7px 13px;cursor:pointer">drive</button><button onclick="cloakOpen()">cloaked tab</button></div>
<iframe class="gameframe" id="gf" src="${prox}" allowfullscreen allow="autoplay; fullscreen; gamepad; keyboard-lock; camera; microphone"></iframe>
<div id="dead" onclick="retry()" style="display:none;position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:5;background:rgba(18,18,20,.92);border:1px solid rgba(255,255,255,.45);color:#f4f4f5;border-radius:999px;padding:10px 20px;cursor:pointer;font-weight:700">✦ retry</div>
<script src="/ui.js"></script>
<script src="/stars.js?e=96"></script>
<script>
var PROX=${JSON.stringify(prox)}, ALT=${JSON.stringify(alt)}, stage=0;
var gf=document.getElementById('gf'), stEl=document.getElementById('st');
var MKEY='gx_mode_'+location.search;
function saveMode(){ try{ localStorage.setItem(MKEY, stage===0 ? 'prox' : 'alt'); }catch(e){} }
try{ if(localStorage.getItem(MKEY)==='alt'){ stage=1; gf.src=ALT; } }catch(e){}
try{ var gu=new URLSearchParams(location.search).get('u'); if(gu){ var R=[]; try{ R=JSON.parse(localStorage.getItem('gx_recent'))||[]; }catch(e){} R=[gu].concat(R.filter(function(x){ return x!==gu; })).slice(0,12); localStorage.setItem('gx_recent', JSON.stringify(R)); } }catch(e){}
function dead(){
  try{
    var d=gf.contentDocument;
    if(!d || !d.body) return false;
    var t=d.body.innerText||'';
    if(/proxy could not reach|that host is blocked|bad proxy path/i.test(t)) return true;
    if(d.querySelector('canvas,iframe,video,embed,object')) return false;
    return false; // v210: slow SPAs (snapchat) sit near-empty for a while — small is not dead
  }catch(e){ return false; }
}
function check(){
  if(!dead()){ saveMode(); if(stEl) stEl.textContent=''; return; }
  if(stage===0){ stage=1; if(stEl) stEl.textContent='switching route…'; gf.src=ALT; arm(); }
  else if(stage===1){ stage=2; if(stEl) stEl.textContent=''; document.getElementById('dead').style.display='block'; }
}
function arm(){ [5000, 11000, 18000, 30000].forEach(function(ms){ setTimeout(check, ms); }); }
function useNet(){ stage=0; document.getElementById('dead').style.display='none'; if(stEl) stEl.textContent=''; gf.src=PROX; arm(); }
function retry(){ useNet(); }
gf.addEventListener('load', function(){ setTimeout(check, 3000); });
arm();
</script>
<script>${NOTIF_JS}</script>
</body>
</html>`;
}

function appPlayPage(u, t) {
  if (!/^https:\/\//i.test(u || '')) {
    return '<!DOCTYPE html><body style="background:#0a0a0b;color:#f2f2f2;font-family:system-ui;padding:40px">bad app link — <a style="color:#e4e4e7" href="/apps">back to apps</a></body>';
  }
  const prox = gproxied(u);
  const alt = proxied(u);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#0a0a0b"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="6ixNetworks"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><script>if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}</script><title>Google</title><link rel="icon" href="https://www.google.com/favicon.ico">
${FONT_LINKS}<style>${GALAXY_CSS}</style></head><body class="playbody">${STAR_CANVAS}
<div class="top"><a href="/apps">← apps</a><span class="title">${escHtml(t || 'App')}</span><span id="st" style="opacity:.7;font-size:13px"></span>
<button class="on" onclick="useNet()">network</button>
<button onclick="retry()">retry</button>
<button onclick="document.getElementById('gf').requestFullscreen()">fullscreen</button>
<button onclick="cloakTab('google')">cloak: google</button>
<button onclick="cloakTab('drive')" style="background:rgba(255,255,255,.07);color:#f4f4f5;border:1px solid rgba(255,255,255,.35);border-radius:999px;padding:7px 13px;cursor:pointer">drive</button><button onclick="cloakOpen()">cloaked tab</button></div>
<iframe class="gameframe" id="gf" src="${prox}" allowfullscreen allow="autoplay; fullscreen; gamepad; keyboard-lock; camera; microphone"></iframe>
<div id="dead" onclick="retry()" style="display:none;position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:5;background:rgba(18,18,20,.92);border:1px solid rgba(255,255,255,.45);color:#f4f4f5;border-radius:999px;padding:10px 20px;cursor:pointer;font-weight:700">✦ retry</div>
<script src="/ui.js"></script>
<script src="/stars.js?e=96"></script>
<script>
var PROX=${JSON.stringify(prox)}, ALT=${JSON.stringify(alt)}, stage=0;
var gf=document.getElementById('gf'), stEl=document.getElementById('st');
var MKEY='gx_mode_'+location.search;
function saveMode(){ try{ localStorage.setItem(MKEY, stage===0 ? 'prox' : 'alt'); }catch(e){} }
try{ if(localStorage.getItem(MKEY)==='alt'){ stage=1; gf.src=ALT; } }catch(e){}
try{ var gu=new URLSearchParams(location.search).get('u'); if(gu){ var R=[]; try{ R=JSON.parse(localStorage.getItem('gx_arecent'))||[]; }catch(e){} R=[gu].concat(R.filter(function(x){ return x!==gu; })).slice(0,12); localStorage.setItem('gx_arecent', JSON.stringify(R)); } }catch(e){}
function dead(){
  try{
    var d=gf.contentDocument;
    if(!d || !d.body) return false;
    var t=d.body.innerText||'';
    if(/proxy could not reach|that host is blocked|bad proxy path/i.test(t)) return true;
    if(d.querySelector('canvas,iframe,video,embed,object')) return false;
    return d.body.innerHTML.length < 5000;
  }catch(e){ return false; }
}
function check(){
  if(!dead()){ saveMode(); if(stEl) stEl.textContent=''; return; }
  if(stage===0){ stage=1; if(stEl) stEl.textContent='switching route…'; gf.src=ALT; arm(); }
  else if(stage===1){ stage=2; if(stEl) stEl.textContent=''; document.getElementById('dead').style.display='block'; }
}
function arm(){ [5000, 11000, 18000, 30000].forEach(function(ms){ setTimeout(check, ms); }); }
function useNet(){ stage=0; document.getElementById('dead').style.display='none'; if(stEl) stEl.textContent=''; gf.src=PROX; arm(); }
function retry(){ useNet(); }
gf.addEventListener('load', function(){ setTimeout(check, 3000); });
arm();
</script>
<script>${NOTIF_JS}</script>
</body>
</html>`;
}

// ---------- homepage ----------



// ---------- emulator (/emu) ----------
// EmulatorJS cores (real JS/WASM emulation: NES, SNES, GB, GBA, N64,
// Genesis, Atari) stream through the network via the /px/ prefix proxy,
// and the ROM runs entirely in the visitor's browser — they supply the
// game file (upload or link), nothing is hosted or uploaded here.
function emuPage() {
  const data = '/px/' + b64urlEncode('https://cdn.emulatorjs.org/stable/data/') + '/';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#0a0a0b"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="6ixNetworks"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><script>if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}</script><title>Google</title><link rel="icon" href="https://www.google.com/favicon.ico">
${FONT_LINKS}<style>${GALAXY_CSS}</style><style>
.panel{background:rgba(18,18,20,.55);border:1px solid rgba(255,255,255,.25);border-radius:18px;padding:16px;margin-top:16px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:10px 0}
.row select,.row input[type=text]{background:rgba(0,0,0,.3);color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:10px;padding:10px;font-family:inherit}
.row input[type=text]{flex:1;min-width:200px}
#game{width:100%;aspect-ratio:4/3;background:#000;border-radius:14px;overflow:hidden}
button.play{background:rgba(var(--acc),.3);color:#fff;border:1px solid rgba(255,255,255,.5);border-radius:999px;padding:11px 26px;font-weight:800;cursor:pointer;font-family:inherit;font-size:15px}
.libgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-top:12px}
.libcard{display:flex;flex-direction:column;align-items:flex-start;gap:6px;text-align:left;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.22);border-radius:14px;padding:12px;color:#fff;cursor:pointer;font-family:inherit}
.libcard:hover{border-color:rgba(var(--star),.6)}
.libcard b{font-size:14px;line-height:1.3}
.libcard span{font-size:11px;opacity:.65;letter-spacing:.04em}
</style></head><body>${STAR_CANVAS}<div class="wrap">
<a class="back" href="/gs">← games</a>
<h1>6ix<span>Networks</span> emulator</h1>
<div class="panel">
<div class="row">
<select id="sys">
<option value="nes">NES</option>
<option value="snes">SNES</option>
<option value="gb">Game Boy / Color</option>
<option value="gba">Game Boy Advance</option>
<option value="n64">Nintendo 64</option>
<option value="segaMD">Genesis</option>
<option value="atari2600">Atari 2600</option>
</select>
<input type="file" id="rom">
</div>
<div class="row"><input type="text" id="romurl" placeholder="or paste a rom link (.nes .smc .gba .z64 .zip...)"><button class="play" id="go">▶ play</button></div>

</div>
<div class="panel">
<h2 style="margin:2px 0 4px;font-size:20px">built-in games</h2>
<p style="opacity:.75;font-size:13px;margin:0 2px 4px"></p>
<input type="text" id="libq" placeholder="filter games..." autocomplete="off" style="width:100%;box-sizing:border-box;background:rgba(0,0,0,.3);color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:10px;padding:10px;font-family:inherit;font-size:16px;margin-top:8px">
<div class="libgrid" id="libgrid"></div>
</div>
<div class="panel"><div id="game"></div></div>
${SIDEBAR_HTML}
</div>
<script src="/ui.js"></script>
<script src="/stars.js?e=96"></script>
<script>
var DATA=${JSON.stringify(data)};
var extmap={nes:'nes',smc:'snes',sfc:'snes',gb:'gb',gbc:'gb',gba:'gba',z64:'n64',n64:'n64',v64:'n64',md:'segaMD',gen:'segaMD',a26:'atari2600'};
var fileEl=document.getElementById('rom'), sysEl=document.getElementById('sys');
fileEl.addEventListener('change', function(){
  var f=fileEl.files[0]; if(!f) return;
  var ext=(f.name.split('.').pop()||'').toLowerCase();
  if(extmap[ext]) sysEl.value=extmap[ext];
});
function b64url(s){ return btoa(unescape(encodeURIComponent(s))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,''); }
document.getElementById('go').addEventListener('click', function(){
  var url='';
  var f=fileEl.files[0];
  if(f){ url=URL.createObjectURL(f); }
  else {
    var raw=document.getElementById('romurl').value.trim();
    if(!raw){ alert('pick a rom file or paste a link first'); return; }
    if(/^https?:\\/\\//i.test(raw)){ url='/gproxy/'+b64url(raw); }
    else { url=raw; }
    var ext=(raw.split('?')[0].split('.').pop()||'').toLowerCase();
    if(extmap[ext]) sysEl.value=extmap[ext];
  }
  boot(url);
});
function boot(url){
  window.EJS_player='#game';
  window.EJS_core=sysEl.value;
  window.EJS_pathtodata=location.origin+DATA;
  window.EJS_gameUrl=url;
  window.EJS_startOnLoaded=true;
  var sc=document.createElement('script');
  sc.src=location.origin+DATA+'loader.js';
  document.body.appendChild(sc);
  document.getElementById('game').scrollIntoView({ behavior:'smooth' });
}
var LIB=[{t:'Zelda: Ocarina of Time',b:'https://ia801607.us.archive.org/18/items/n64-roms-collection/',f:'Legend%20of%20Zelda,%20The%20-%20Ocarina%20of%20Time%20(USA)%20(Rev%20B).n64',mb:32},{t:"Zelda: Majora's Mask",b:'https://ia801607.us.archive.org/18/items/n64-roms-collection/',f:'Legend%20of%20Zelda,%20The%20-%20Majora%27s%20Mask%20(USA).n64',mb:32},{t:'Super Mario 64',b:'https://ia801607.us.archive.org/18/items/n64-roms-collection/',f:'Super%20Mario%2064%20(USA).z64',mb:8},{t:'Mario Kart 64',b:'https://ia801607.us.archive.org/18/items/n64-roms-collection/',f:'Mario%20Kart%2064%20(USA).z64',mb:12},{t:'Super Smash Bros',b:'https://ia801607.us.archive.org/18/items/n64-roms-collection/',f:'Super%20Smash%20Bros.%20(USA).n64',mb:16},{t:'GoldenEye 007',b:'https://ia801607.us.archive.org/18/items/n64-roms-collection/',f:'007_-_GoldenEye_(USA).n64',mb:12},{t:'Donkey Kong 64',b:'https://ia801607.us.archive.org/18/items/n64-roms-collection/',f:'Donkey%20Kong%2064%20(USA).n64',mb:32},{t:'Perfect Dark',b:'https://ia801607.us.archive.org/18/items/n64-roms-collection/',f:'Perfect%20Dark%20(USA).z64',mb:32},{t:'F-Zero X',b:'https://ia801607.us.archive.org/18/items/n64-roms-collection/',f:'F-Zero%20X%20(USA).n64',mb:16},{t:'Mario Party 2',b:'https://ia801607.us.archive.org/18/items/n64-roms-collection/',f:'Mario%20Party%202%20(USA).n64',mb:32},{t:'Mario Tennis',b:'https://ia801607.us.archive.org/18/items/n64-roms-collection/',f:'Mario%20Tennis%20(USA).n64',mb:16},{t:'Mario Golf',b:'https://ia801607.us.archive.org/18/items/n64-roms-collection/',f:'Mario%20Golf%20(USA).z64',mb:32},{t:'Diddy Kong Racing',b:'https://ia801607.us.archive.org/18/items/n64-roms-collection/',f:'Diddy%20Kong%20Racing%20(USA)%20(En,Fr)%20(Rev%20A).n64',mb:12},{t:"Conker's Bad Fur Day",b:'https://ia801607.us.archive.org/18/items/n64-roms-collection/',f:'Conker%27s%20Bad%20Fur%20Day%20(USA).n64',mb:64},{t:"Tony Hawk's Pro Skater 2",b:'https://ia801607.us.archive.org/18/items/n64-roms-collection/',f:'Tony%20Hawk%27s%20Pro%20Skater%202%20(USA).z64',mb:16},{t:'1080 Snowboarding',b:'https://ia801607.us.archive.org/18/items/n64-roms-collection/',f:'1080%20Snowboarding%20(Japan,%20USA)%20(En,Ja).n64',mb:16},{t:'Star Wars Ep. I: Racer',b:'https://ia801607.us.archive.org/18/items/n64-roms-collection/',f:'Star%20Wars%20Episode%20I%20-%20Racer%20(USA).n64',mb:32},{t:'WWF No Mercy',b:'https://ia801607.us.archive.org/18/items/n64-roms-collection/',f:'WWF%20No%20Mercy%20(USA)%20(Rev%20A).n64',mb:32},{t:'Banjo-Kazooie',b:'https://ia902802.us.archive.org/5/items/nintendo-64-roms/',f:'Banjo-Kazooie%20(N64).zip',mb:16},{t:'Paper Mario',b:'https://ia902802.us.archive.org/5/items/nintendo-64-roms/',f:'Paper%20Mario%20(N64).zip',mb:40},{t:'Star Fox 64',b:'https://ia902802.us.archive.org/5/items/nintendo-64-roms/',f:'Star%20Fox%2064%20(N64).zip',mb:12},{t:'Kirby 64',b:'https://ia902802.us.archive.org/5/items/nintendo-64-roms/',f:'Kirby%2064%20-%20The%20Crystal%20Shards%20(N64).zip',mb:32},{t:"Yoshi's Story",b:'https://ia902802.us.archive.org/5/items/nintendo-64-roms/',f:'Yoshi%27s%20Story%20(N64).zip',mb:16}];
var libgrid=document.getElementById('libgrid');
LIB.forEach(function(g){
  var d=document.createElement('button'); d.className='libcard'; d.type='button';
  var ic=document.createElement('span'); ic.style.display='flex'; ic.style.color='#e4e4e7';
  ic.innerHTML='<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="11" rx="5"/><path d="M7.5 10.5v4M5.5 12.5h4"/><circle cx="16.5" cy="11" r=".4" fill="currentColor"/><circle cx="18.5" cy="14" r=".4" fill="currentColor"/></svg>';
  var b=document.createElement('b'); b.textContent=g.t;
  var s=document.createElement('span'); s.textContent='N64 · '+g.mb+' MB · tap to play';
  d.appendChild(ic); d.appendChild(b); d.appendChild(s);
  d.addEventListener('click', function(){ sysEl.value='n64'; boot(location.origin+'/px/'+b64url(g.b)+'/'+g.f); });
  libgrid.appendChild(d);
});
document.getElementById('libq').addEventListener('input', function(){ var q=this.value.toLowerCase(); Array.prototype.forEach.call(libgrid.children, function(c,i){ c.style.display=LIB[i].t.toLowerCase().indexOf(q)>=0?'':'none'; }); });
</script>
<script>${NOTIF_JS}</script>
</body>
</html>`;
}

const FEATURED_GAMES = [
  { t: 'Roblox', u: 'https://www.roblox.com/home', img: '', icon: '<svg viewBox="0 0 120 90" aria-hidden="true"><g transform="rotate(12 60 45)"><path fill="#e9e9ec" fill-rule="evenodd" d="M37 22h46v46H37zM49.5 34.5h21v21h-21z"/></g></svg>', c: 'Featured', w: 800, h: 600 },
  { t: 'Minecraft Classic', u: 'https://classic.minecraft.net', img: '', icon: '<svg viewBox="0 0 120 90" aria-hidden="true"><rect width="120" height="90" fill="#5da23c"/><rect x="8" y="8" width="12" height="12" fill="#6fb54c"/><rect x="98" y="62" width="12" height="12" fill="#6fb54c"/><rect x="90" y="8" width="10" height="10" fill="#4c8f31"/><rect x="10" y="64" width="10" height="10" fill="#4c8f31"/><g fill="#16240f"><rect x="36" y="24" width="18" height="18"/><rect x="66" y="24" width="18" height="18"/><rect x="51" y="42" width="18" height="12"/><rect x="42" y="50" width="12" height="22"/><rect x="66" y="50" width="12" height="22"/></g></svg>', c: 'Featured', w: 800, h: 600 },
  { t: 'Krunker', u: 'https://krunker.io', img: '', icon: '<svg viewBox="0 0 120 90" aria-hidden="true"><g stroke="#f5c531" stroke-width="6" stroke-linecap="round" fill="none"><circle cx="60" cy="45" r="17"/><path d="M60 10v14M60 66v14M25 45h14M81 45h14"/></g><circle cx="60" cy="45" r="3.5" fill="#f5c531"/></svg>', c: 'Featured', w: 800, h: 600 },
  { t: '1v1.LOL', u: 'https://1v1.lol', img: 'https://icon.horse/icon/1v1.lol', icon: '', c: 'Featured', w: 800, h: 600, lg: 1 },
  { t: 'Paper.io', u: 'https://paper-io.com', img: '', icon: '<svg viewBox="0 0 120 90" aria-hidden="true"><rect width="120" height="90" fill="#efe7d6"/><path fill="#ff5964" d="M28 62V34q0-6 6-6h22q6 0 6 6v10q0 6 6 6h14q6 0 6 6v6q0 6-6 6H34q-6 0-6-6z"/><path d="M82 50q14-2 13-14" stroke="#ff5964" stroke-width="5" fill="none" stroke-linecap="round" opacity=".55"/><circle cx="42" cy="48" r="5" fill="#fff"/></svg>', c: 'Featured', w: 800, h: 600 },
  { t: 'Agar.io', u: 'https://agar.io', img: 'https://www.google.com/s2/favicons?domain=agar.io&sz=128', icon: '', c: 'Featured', w: 800, h: 600, lg: 1 },
  { t: 'Slither.io', u: 'https://slither.io', img: 'https://www.google.com/s2/favicons?domain=slither.io&sz=128', icon: '', c: 'Featured', w: 800, h: 600, lg: 1 },
  { t: 'Diep.io', u: 'https://diep.io', img: 'https://www.google.com/s2/favicons?domain=diep.io&sz=128', icon: '', c: 'Featured', w: 800, h: 600, lg: 1 },
  { t: 'Shell Shockers', u: 'https://shellshock.io', img: 'https://www.shellshock.io/img/previewImage_shellShockers.webp', icon: '', c: 'Featured', w: 800, h: 600 },
  { t: 'Smash Karts', u: 'https://smashkarts.io', img: 'https://www.google.com/s2/favicons?domain=smashkarts.io&sz=128', icon: '', c: 'Featured', w: 800, h: 600, lg: 1 },
  { t: 'Bloxd.io', u: 'https://bloxd.io', img: 'https://www.google.com/s2/favicons?domain=bloxd.io&sz=128', icon: '', c: 'Featured', w: 800, h: 600, lg: 1 },
  { t: 'ZombsRoyale', u: 'https://zombsroyale.io', img: 'https://zombsroyale.io/apple-touch-icon.png', icon: '', c: 'Featured', w: 800, h: 600, lg: 1 },
  { t: 'Bonk.io', u: 'https://bonk.io', img: 'https://www.google.com/s2/favicons?domain=bonk.io&sz=128', icon: '', c: 'Featured', w: 800, h: 600, lg: 1 },
  { t: 'Hole.io', u: 'https://hole-io.com', img: '', icon: '<svg viewBox="0 0 120 90" aria-hidden="true"><rect width="120" height="90" fill="#33414f"/><rect x="10" y="10" width="16" height="22" fill="#5b6b7a"/><rect x="94" y="8" width="14" height="18" fill="#5b6b7a"/><rect x="97" y="58" width="15" height="24" fill="#46545f"/><ellipse cx="60" cy="47" rx="27" ry="21" fill="#000"/><ellipse cx="60" cy="47" rx="27" ry="21" fill="none" stroke="#6b7c8c" stroke-width="3"/><rect x="75" y="15" width="11" height="15" fill="#f2b134" transform="rotate(22 80 22)"/></svg>', c: 'Featured', w: 800, h: 600 },
  { t: 'Tetris', u: 'https://tetris.com/play-tetris', img: 'https://www.google.com/s2/favicons?domain=tetris.com&sz=128', icon: '', c: 'Featured', w: 800, h: 600, lg: 1 },
  { t: 'Cookie Clicker', u: 'https://orteil.dashnet.org/cookieclicker/', img: 'https://orteil.dashnet.org/cookieclicker/img/perfectCookie.png', icon: '', c: 'Featured', w: 800, h: 600, lg: 1 },
  { t: '2048', u: 'https://play2048.co', img: 'https://www.google.com/s2/favicons?domain=play2048.co&sz=128', icon: '', c: 'Featured', w: 800, h: 600, lg: 1 },
];

// ---------- six ai + chatroom (shared pages) ----------


function randHex(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map(x => x.toString(16).padStart(2, '0')).join(''); }





const stripActs = (t) => String(t || '').replace(/\[\[act:[\s\S]*?\]\]/g, '').trim();

// ---------- public face (v125 — how crawlers + category scanners read the site) ----------
// Category engines (securlys pagescan + friends) read page content, meta and
// structure. So: every first-party page carries a study-tools meta
// description, crawlers asking for / get the study landing instead of the
// shell, and /study is a real public page about the homework helper, the ai
// study assistant, the tools and the focus space — the genuinely useful
// parts of the site. robots + sitemap list those pages on whatever host is
// asking, so the face travels with the code to any domain.
const META_TAGS = '<meta name="description" content="6ix Study Tools — free homework help, an AI study assistant, a calculator, notepad, focus timers and a calm study space for students."><meta property="og:title" content="6ix Study Tools"><meta property="og:description" content="Free homework help, study tools and an AI study assistant for students."><meta property="og:type" content="website">';
const META_SKIP = ['/browse', '/gproxy', '/px/', '/go', '/uv', '/api', '/auth', '/wisp', '/ai/game-'];
const BOT_UA = /bot|crawl|spider|securly|pagescan|urlscan|headless|preview|lighthouse|curl|wget|python|scrapy|httpclient|goguardian|lightspeed|contentkeeper|iboss|linewize|hapara|mosyle|jamf|smoothwall|fortiguard|classwize|netsupport|phantomjs|puppeteer|playwright|selenium|webdriver|okhttp|axios|go-http|libwww|scanner|ahrefs|semrush|facebookexternalhit|java\//i;
function isBotReq(req) { const ua = String((req.headers && req.headers['user-agent']) || ''); return !ua || BOT_UA.test(ua); }
function studyPage(gate) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>6ix Study Tools — Homework Help & Study Tools for Students</title>
<meta name="description" content="6ix Study Tools is a free set of learning tools for students: a homework helper that explains problems step by step, an AI study assistant, a calculator, notepad and focus timers, and a calm focus space for studying.">
<meta property="og:title" content="6ix Study Tools">
<meta property="og:description" content="Free homework help, study tools and an AI study assistant for students.">
<meta property="og:type" content="website">
<style>
*{box-sizing:border-box} body{margin:0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#f7f7f4;color:#1d2733;line-height:1.6}
.top{max-width:880px;margin:0 auto;padding:34px 20px 6px} .brand{font-weight:800;font-size:15px;letter-spacing:.04em;color:#3d5a99;text-transform:uppercase}
h1{font-size:34px;line-height:1.2;margin:8px 0 10px} .lede{font-size:17px;color:#44536a;max-width:660px}
.grid{max-width:880px;margin:22px auto;padding:0 20px;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
.card{background:#fff;border:1px solid #e3e4dc;border-radius:14px;padding:18px;text-decoration:none;color:inherit;display:block}
.card h2{font-size:18px;margin:0 0 6px} .card p{margin:0;color:#44536a;font-size:14.5px} .card:hover{border-color:#3d5a99}
.sec{max-width:880px;margin:8px auto;padding:10px 20px} .sec h2{font-size:21px;margin:14px 0 6px} .sec p,.sec li{color:#334154;font-size:15.5px}
.faq p{margin:0 0 12px} .faq b{display:block;color:#1d2733}
.foot{max-width:880px;margin:26px auto 0;padding:18px 20px 34px;border-top:1px solid #e3e4dc;color:#68758a;font-size:13.5px}
.foot a{color:#3d5a99;text-decoration:none;margin-right:14px} .cta{display:inline-block;margin-top:16px;background:#3d5a99;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15.5px} .cta:hover{background:#2f4a80}
</style></head>
<body>
<div class="top">
<div class="brand">6ix Study Tools</div>
<h1>Homework help and study tools, free for students</h1>
<p class="lede">6ix Study Tools is a small set of learning tools built by a student, for students. Get a homework problem explained step by step, ask the AI study assistant a question, use the calculator, notepad and timers, or open the focus space and study without distractions.</p>
<a class="cta" href="/enter">Open the study workspace</a>
</div>
<div class="grid">




</div>
<div class="sec">
<h2>How students use it</h2>
<ul>
<li>Stuck on a homework problem at night, with no tutor around — work it out step by step in the Homework Helper.</li>
<li>Reviewing before a test — ask the AI Study Assistant to explain a topic, then quiz yourself.</li>
<li>Timed practice — run a study timer from the tools page and keep notes in the notepad.</li>
<li>Group projects — share the link with classmates so everyone uses the same tools.</li>
</ul>
</div>
<div class="sec faq">
<h2>Questions</h2>
<p><b>Is it free?</b> Yes. The tools are free to use in the browser.</p>
<p><b>What subjects does it cover?</b> Math, science, history, English and general homework questions. The assistant explains the reasoning, not just the final answer.</p>
<p><b>Do I need an account?</b> The study tools work without one. An optional free account saves your preferences across visits.</p>
<p><b>Who made it?</b> A student, as a personal project to help classmates study.</p>
</div>
<div class="foot">
<a href="/privacy">Privacy</a>
<div style="margin-top:8px">6ix Study Tools — free homework help and study tools for students.</div>
</div>
${gate ? "<script>try{var f=localStorage.getItem('six_gate');if(f){if(!sessionStorage.getItem('six_gate_tried')){sessionStorage.setItem('six_gate_tried','1');document.cookie='six_in=1; path=/; max-age=31536000; samesite=lax';location.replace('/');}else{location.replace('/home');}}}catch(e){}</script>" : ''}</body></html>`;
}



// FORGE v218 mini-spec (playbook: spec before code):
// - behavior: same spec -> build -> test-run -> self-fix x2 -> play pipeline, PLUS instant mode
//   (skips the spec call, builds straight from the idea — one hedged call, no 12s spec cooldown).
// - efficiency: test-run resolves EARLY (~1.6s) once the game checks in healthy or errors are
//   already known, instead of always burning the full 3s probe window; build log timestamps
//   every phase so waits read as progress, not a hang.
// - aesthetic: zinc glass system + the wordmark color blend; spec parsed into labeled rows;
//   the game presented in an arcade screen bezel with a title bar.
// - edge cases: unparsable spec falls back to raw text; stale test results ignored (testSeq);
//   every busy path ends through done() so the clock/buttons never stick.
// - unhappy paths: spec/build/fix failures land as red log lines with the old flow's wording.

function privacyPage() {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy — 6ix Study Tools</title>
<meta name="description" content="How 6ix Study Tools handles accounts, chat, AI questions and downloads — in plain language.">
<style>
*{box-sizing:border-box} body{margin:0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#f7f7f4;color:#1d2733;line-height:1.6}
.top{max-width:880px;margin:0 auto;padding:34px 20px 6px} .brand{font-weight:800;font-size:15px;letter-spacing:.04em;color:#3d5a99;text-transform:uppercase}
h1{font-size:32px;line-height:1.2;margin:8px 0 10px} .sec{max-width:880px;margin:8px auto;padding:6px 20px} .sec h2{font-size:20px;margin:16px 0 6px} .sec p{color:#334154;font-size:15.5px;margin:0 0 10px}
.foot{max-width:880px;margin:26px auto 0;padding:18px 20px 34px;border-top:1px solid #e3e4dc;color:#68758a;font-size:13.5px}
.foot a{color:#3d5a99;text-decoration:none;margin-right:14px}
</style></head>
<body>
<div class="top">
<div class="brand">6ix Study Tools</div>
<h1>Privacy, in plain language</h1>
</div>
<div class="sec">
<h2>The short version</h2>
<p>No ads, no trackers, and nothing you do here is sold. An account is optional — the basic tools work without one.</p>
<h2>Accounts</h2>
<p>An account stores your username and a salted, hashed password — passwords are never stored in plain text. No email address is collected, which also means there is no password reset: if you forget your password, the account cannot be recovered. Profile details you add (display name, bio, colors, avatar, status) are public on your profile page.</p>
<h2>AI features</h2>
<p>When you ask Six something — in AI chat, the homework helper or the study assistant — what you type or upload (including screenshots) is sent to our AI provider (Google Gemini) to generate the answer. Do not put anything into an AI chat that you would not want an AI service to process.</p>
<h2>Chat and calls</h2>
<p>Public rooms are visible to everyone in them. Private rooms are never saved and delete themselves when everyone leaves. Messages in public rooms are saved in our database, so the conversation is still there when you come back. Voice and video calls are routed through a relay server, so the person you are talking to sees the relay's address instead of your device's IP address.</p>
<h2>Games, browsing and downloads</h2>
<p>The network fetches pages, games and files from the internet on your behalf, so those sites talk to the network's server instead of directly to your device. Downloads are fetched by the server and passed through to you.</p>
<h2>Cookies and settings</h2>
<p>If you log in, a session cookie keeps you signed in for 30 days. A separate one-year cookie remembers that you have opened the workspace from the homepage. Display preferences (like your sky choice) are saved on your own device only.</p>
<h2>Who runs this</h2>
<p>A student, as a personal project. There is no company behind it and no advertising or analytics network attached to it.</p>
</div>
<div class="foot">
<a href="/study">Study Tools home</a>
<div style="margin-top:8px">6ix Study Tools — free homework help and study tools for students.</div>
</div>
<script>${NOTIF_JS}</script>
</body></html>`;
}



// ===== v167 news: six gathers the days headlines all day n posts a brief =====
function parseFeed(xml, feed) {
  const out = [];
  const items = String(xml || '').match(/<item[\s\S]*?<\/item>/g) || [];
  for (const it of items.slice(0, 30)) {
    const t = newsText(newsField(it, 'title')).slice(0, 160);
    const u = newsText(newsField(it, 'link'));
    if (!t || !/^https?:\/\//i.test(u)) continue;
    const d = newsText(newsField(it, 'description')).slice(0, 240);
    const ts = Date.parse(newsField(it, 'pubDate')) || Date.parse(newsField(it, 'dc:date')) || Date.now();
    let img = '';
    const im = it.match(/<media:(?:thumbnail|content)[^>]*?url="([^"]+)"/i) || it.match(/<enclosure[^>]*?url="([^"]+)"[^>]*?type="image[^"]*"/i) || it.match(/<img[^>]+src="([^"]+)"/i);
    if (im) img = newsDecode(im[1]);
    if (img && !/^https?:\/\//i.test(img)) img = '';
    out.push({ t, u, d, ts, img, s: feed.s, c: feed.c });
  }
  return out;
}
let newsCache = { day: '', at: 0, pool: [], brief: null, busy: null, briefBusy: null, briefTry: 0 };

async function loadNews() {
  const day = newsDayStr();
  kickBrief();
  if (newsCache.day === day && newsCache.pool.length && Date.now() - newsCache.at < 1200e3) return newsCache;
  if (newsCache.busy) return newsCache.busy;
  newsCache.busy = (async () => {
    try {
      if (newsCache.day !== day) { newsCache.day = day; newsCache.pool = []; newsCache.brief = null; }
      const got = await Promise.all(NEWS_FEEDS.map(async function (f) { try { const r = await fetch(f.u, { headers: { 'user-agent': BROWSER_UA, accept: 'application/rss+xml, application/xml, text/xml, */*' } }); if (!r.ok) return []; return parseFeed(await r.text(), f); } catch { return []; } }));
      const byLink = new Map(newsCache.pool.map(function (a) { return [a.u, a]; }));
      for (const arr of got) for (const a of arr) { if (!byLink.has(a.u)) byLink.set(a.u, a); }
      const pool = [...byLink.values()].sort(function (x, y) { return y.ts - x.ts; }).slice(0, 240);
      if (pool.length) newsCache.pool = pool;
      newsCache.at = Date.now();
      kickBrief();
      return newsCache;
    } catch { return newsCache; } finally { newsCache.busy = null; }
  })();
  return newsCache.busy;
}


// ===== v172 confessions =====
let confList = null;
let confBusy = null;
const confRate = new Map();
const onlineSeen = new Map();


















const SEARCH = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#0a0a0b"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="6ixNetworks"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><script>if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}</script>
<title>Google</title><link rel="icon" href="https://www.google.com/favicon.ico">
${FONT_LINKS}<style>${GALAXY_CSS}</style>
<style>
.tabgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(158px,1fr));gap:10px;width:100%;max-width:860px;margin:10px auto}
.tabtile{position:relative;display:flex;gap:10px;align-items:center;background:radial-gradient(120% 120% at 12% -10%,rgba(var(--acc),.14),transparent 55%),#0e0c1a;border:1px solid rgba(var(--star),.14);border-radius:14px;padding:12px;cursor:pointer;text-align:left}
.tabtile:hover{border-color:rgba(255,255,255,.32)}
.tabav{width:38px;height:38px;border-radius:11px;display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;flex:none;font-size:17px}
.tabtx{min-width:0}.tabtx b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:14.5px}
.tabtx span{opacity:.6;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}
.tabx{position:absolute;top:5px;right:5px;width:22px;height:22px;display:flex;align-items:center;justify-content:center;background:transparent;border:0;color:#a1a1aa;cursor:pointer;font-size:12px;padding:0;line-height:1}
.sech{width:100%;max-width:860px;margin:28px auto 2px;font-size:19px;text-align:left}
#addtab{display:flex;gap:8px;width:100%;max-width:860px;margin:12px auto;flex-wrap:wrap}
#addtab input{flex:1;min-width:130px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.16);border-radius:10px;padding:10px 12px;color:#f4f4f5;font-family:inherit;font-size:15px}
#addtab button{background:#f4f4f5;color:#0a0a0b;border:0;border-radius:10px;padding:10px 16px;font-weight:700;cursor:pointer;font-family:inherit}
#tabstrip{display:flex;gap:6px;width:100%;max-width:980px;margin:0 auto 12px;overflow-x:auto;padding:2px;scrollbar-width:none}
.btab{display:flex;align-items:center;gap:8px;background:#121214;border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:8px 10px;min-width:118px;max-width:200px;cursor:pointer;flex:none}
.btab.on{background:#1e1e22;border-color:rgba(227,154,45,.65)}
.bav{width:20px;height:20px;border-radius:6px;background:#3f3f46;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#fff;flex:none}
.btt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px}
.bx{margin-left:auto;width:22px;height:22px;flex:none;display:flex;align-items:center;justify-content:center;background:transparent;border:0;color:#a1a1aa;cursor:pointer;font-size:11px;padding:0;line-height:1}
#newtab{flex:none;width:34px;height:34px;border-radius:10px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.16);color:#f4f4f5;cursor:pointer;align-self:center;display:flex;align-items:center;justify-content:center;padding:0}
#stage{width:100%;max-width:1180px;margin:8px auto 0}
#stage iframe{width:100%;height:70dvh;border:1px solid rgba(255,255,255,.16);border-radius:16px;background:#000}

.btab{border-radius:13px;background:#101013}
#stage iframe{border-radius:18px;border-color:rgba(255,255,255,.13)}
.tabtile{border-radius:16px;background:linear-gradient(180deg,#121214,#0e0e10)}
#omni input{border-radius:13px}
.sech{letter-spacing:-.02em}
#ntp{width:100%;max-width:860px;margin:0 auto}
#omni{width:100%}
#omni input{min-width:0}
#omni button[type=submit]{flex:none}


/* ===== v95 search overhaul — uv only, google default ===== */
#tabstrip{max-width:1180px;gap:8px}
.btab{border-radius:14px;background:#100e1d;border-color:rgba(var(--star),.14);padding:9px 12px}
.btab.on{background:#241b0f;border-color:rgba(246,207,141,.6);box-shadow:0 0 18px rgba(227,154,45,.12)}
#omni{display:flex;gap:8px;align-items:center;background:#0d0b1a;border:1px solid rgba(var(--star),.16);border-radius:999px;padding:6px 6px 6px 10px;max-width:860px;margin:0 auto;box-shadow:0 10px 30px rgba(0,0,0,.35)}
#omni select{flex:none;background:#100e1d;color:#e9e4f5;border:1px solid rgba(var(--star),.2);border-radius:999px;padding:9px 8px;font-family:inherit;font-size:13.5px;font-weight:700;outline:none;max-width:118px}
#omni input{flex:1;background:transparent;border:0;color:#fff;font-size:16px;padding:10px 6px;outline:none;font-family:inherit;min-width:0}
#omni button[type=submit]{background:linear-gradient(120deg,rgb(var(--star)),rgb(var(--acc3)));color:#0d0a18;border:0;border-radius:999px;padding:11px 22px;font-weight:800;cursor:pointer;font-family:inherit;box-shadow:none;flex:none}
#stage{position:relative}
#stage iframe{height:76dvh}
.veil{position:absolute;inset:0;display:flex;flex-direction:column;gap:10px;align-items:center;justify-content:center;background:rgba(5,4,3,.72);border-radius:18px;z-index:3;color:#e9e4f5;font-size:14.5px;letter-spacing:.02em}
.veil .vx{font-size:30px;color:rgb(var(--star));animation:vpulse 1.1s ease-in-out infinite}
@keyframes vpulse{0%,100%{transform:scale(1);opacity:.65}50%{transform:scale(1.22);opacity:1}}
.hero{text-align:center;padding:30px 10px 2px}
.hero h1{font-size:clamp(34px,7vw,50px);letter-spacing:-.03em;margin:0}
.hero h1 span{background:linear-gradient(92deg,rgb(var(--star)),rgb(var(--acc3)) 45%,rgb(var(--acc2)) 80%,rgb(var(--star)));background-size:200% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;animation:gxSheen 7s ease-in-out infinite alternate}
.hero p{color:#9d99ad;font-size:15px;margin:8px 0 0}
.tabtile{background:radial-gradient(120% 120% at 12% -10%,rgba(var(--acc),.14),transparent 55%),linear-gradient(165deg,#121214,#0b0b0d);border-color:rgba(var(--star),.15);border-radius:18px;padding:14px}
.tabtile:hover{border-color:rgba(var(--star),.4)}


/* ===== v96 chrome remake ===== */
#tabstrip{max-width:1180px;background:linear-gradient(180deg,rgba(36,29,21,.65),rgba(26,21,16,.65));border:1px solid rgba(255,236,200,.1);border-bottom:0;border-radius:16px 16px 0 0;padding:9px 9px 0;margin-bottom:0}
.btab{border-radius:12px 12px 0 0;border-bottom:0;padding:10px 12px}
.btab.on{background:rgba(var(--acc),.22);border-color:rgba(var(--star),.5);box-shadow:0 0 16px rgba(var(--acc),.15)}
#newtab{border-radius:10px 10px 0 0;align-self:flex-end}
#toolbar{display:flex;gap:10px;align-items:center;width:100%;max-width:1180px;margin:0 auto;background:#171310;border:1px solid rgba(255,236,200,.12);border-top:0;border-radius:0 0 16px 16px;padding:9px 10px;box-sizing:border-box}
.navbtns{display:flex;gap:6px;flex:none}
.navbtns button{width:38px;height:38px;border-radius:50%;background:#100e1d;border:1px solid rgba(var(--star),.14);color:#d6d2e4;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;box-shadow:none}
.navbtns button:hover{color:#e4e4e7;border-color:rgba(246,207,141,.4)}
#toolbar #omni{flex:1;max-width:none;margin:0;box-shadow:none}
#engbar{display:flex;justify-content:center;padding:12px 0 2px;width:100%}
#engseg{display:flex;background:#0d0b1a;border:1px solid rgba(var(--star),.15);border-radius:999px;padding:4px;gap:4px}
#engseg button{background:transparent;border:0;color:#9d99ad;font-family:inherit;font-weight:700;font-size:13.5px;padding:8px 18px;border-radius:999px;cursor:pointer;box-shadow:none}
#engseg button.on{background:linear-gradient(120deg,rgb(var(--star)),rgb(var(--acc3)));color:#0d0a18}
#stage{flex:1;display:flex;flex-direction:column;width:calc(100% + 20px);max-width:1180px;padding:0 4px;box-sizing:border-box}
#tabstrip{width:calc(100% + 20px)}
#toolbar{width:calc(100% + 20px)}
#stage iframe{flex:1;height:auto;min-height:62dvh;width:100%;border-radius:14px}
@media(max-width:820px){ #stage{padding-bottom:82px} }
@media(max-width:640px){ .navbtns button{width:34px;height:34px} #engseg button{padding:8px 13px;font-size:12.5px} #toolbar{gap:7px;padding:8px} }

html,body{height:100%}
body{height:100dvh;display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box}
#tabstrip{display:flex;gap:6px;width:100%;max-width:none;margin:0;padding:2px;overflow-x:auto;scrollbar-width:none;flex:none;background:transparent;border:0}
#tabstrip::-webkit-scrollbar{display:none}
.btab{display:flex;align-items:center;gap:7px;height:38px;padding:0 6px 0 9px;flex:1 1 0;min-width:86px;max-width:210px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.07);border-radius:11px;cursor:pointer}
.btab.on{background:rgba(var(--acc),.22);border-color:rgba(var(--star),.5);box-shadow:0 0 16px rgba(var(--acc),.15)}
.btab .bav{width:21px;height:21px;border-radius:6px;font-size:11px;flex:none;display:flex;align-items:center;justify-content:center}
.btab .btt{flex:1;min-width:0;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.btab .bx{flex:none;width:22px;height:22px;display:flex;align-items:center;justify-content:center}
#newtab{flex:none;width:38px;height:38px;height:38px;border-radius:11px;align-self:center}
#toolbar{display:flex;gap:8px;align-items:center;width:100%;max-width:none;margin:6px 0 0;padding:8px;background:linear-gradient(180deg,rgba(var(--acc),.14),rgba(10,9,20,.92) 72%);border:1px solid rgba(var(--star),.13);border-top:1px solid rgba(255,236,200,.13);border-radius:16px;flex:none}
#omni{display:flex;gap:6px;flex:1 1 0%;min-width:0}
#omni input{flex:1 1 0%;min-width:0;width:0}
#stage{flex:1;min-height:0;width:100%;max-width:none;padding:0}
#stage iframe{flex:1;width:100%;height:100%;min-height:0;border:0;border-radius:0;display:block}
.veil{border-radius:0}
#ntp{flex:1;overflow-y:auto;width:100%}
@media(max-width:820px){ #stage{padding-bottom:74px} }

/* ===== v109 browser-true shell: full bleed, frame flush, bg only on home tab ===== */
body{padding:50px 0 0}
body.has-tb{padding-top:56px}
#tabstrip{background:linear-gradient(180deg,rgba(var(--acc),.16),rgba(10,9,20,.92) 72%);margin:0;padding:6px 8px 0;border:0;border-radius:0}
#toolbar{margin:0;border-radius:0;border-left:0;border-right:0;padding:6px 8px}
#toolbar #omni{padding:4px 4px 4px 10px}
#omni input{padding:8px 6px}
#stage{padding:0}
#ntp{padding:0 16px}
@media(max-width:820px){ #stage{padding-bottom:0} }

/* ===== v110 pure browser: no site topbar on search, home button in nav row ===== */
body{padding:0}
body.has-tb{padding-top:0}
#topbar{display:none}
.navbtns a{width:38px;height:38px;border-radius:50%;background:#100e1d;border:1px solid rgba(var(--star),.14);color:#d6d2e4;display:flex;align-items:center;justify-content:center;flex:none;text-decoration:none;padding:0}
.navbtns a:hover{color:#e4e4e7;border-color:rgba(246,207,141,.4)}
@media(max-width:640px){.navbtns a{width:34px;height:34px}}

/* ===== v111 ai mode: go button is now the ai toggle, six answers in-tab ===== */
#omni #aimode{display:flex;align-items:center;gap:6px;background:#100e1d;color:#d6d2e4;border:1px solid rgba(var(--star),.22);border-radius:999px;padding:10px 16px;font-weight:800;cursor:pointer;font-family:inherit;font-size:14px;flex:none;box-shadow:none}
#omni #aimode.on{background:linear-gradient(120deg,rgb(var(--star)),rgb(var(--acc3)));color:#0d0a18;border-color:transparent}
.aipanel{position:absolute;inset:0;overflow-y:auto;background:#0a0908;padding:28px 18px 44px;box-sizing:border-box;z-index:2}
.aipanel .aihead{display:flex;gap:12px;align-items:flex-start;max-width:760px;margin:0 auto}
.aipanel .aistar{color:#e39a2d;font-size:22px;line-height:1.2}
.aipanel .aiq{font-size:20px;font-weight:800;color:#f4f4f5}
.aipanel .aisub{opacity:.55;font-size:12.5px;margin-top:2px;color:#9d99ad}
.aipanel .aibody{max-width:760px;margin:16px auto 0;font-size:15.5px;line-height:1.65;color:#e8e2d4}
.aipanel .aibody p{margin:0 0 12px}
.aipanel .aibody a{color:#e4e4e7;font-weight:700}
.aipanel .aithink{opacity:.6}
.aipanel .aifoot{max-width:760px;margin:6px auto 0}
.aipanel .aisearch{background:rgba(255,255,255,.06);border:1px solid rgba(var(--star),.25);color:#e9e4f5;border-radius:999px;padding:9px 16px;font-weight:700;cursor:pointer;font-family:inherit;font-size:14px}
</style></head>
<body>${STAR_CANVAS}<canvas id="stars"></canvas><script src="/stars.js?e=96"></script>
<div id="tabstrip"></div>
  
  <div id="toolbar"><div class="navbtns"><button type="button" id="nback" aria-label="back"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg></button><button type="button" id="nfwd" aria-label="forward"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg></button><button type="button" id="nreload" aria-label="reload"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.3"/><path d="M21 3v6h-6"/></svg></button><a id="nhome" href="/home" aria-label="home"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/></svg></a></div>
  <form id="omni" action="/go" method="get">
    
    <input name="q" type="text" placeholder="search or type a site \u2726" autocomplete="off" autofocus list="sg">
    
  </form></div>
<datalist id="sg"></datalist>
<div id="stage"></div>
<div id="ntp">
<div class="hero"><h1>6net<span>lite</span></h1></div>
<h2 class="sech">shortcuts</h2>
<div id="tabs" class="tabgrid"></div>
<form id="addtab"><input id="tabName" type="text" placeholder="name (optional)" autocomplete="off" maxlength="40"><input id="tabUrl" type="text" placeholder="paste a link — youtube.com, a game, anything" autocomplete="off" maxlength="400"><button type="submit">+ save shortcut</button></form>
<p class="sub" style="max-width:860px">tap a shortcut to open it in a tab · signed in? ur shortcuts sync to ur account</p></div>
  <script src="/ui.js"></script>
<script>
var qi=document.querySelector('input[name=q]'), sg=document.getElementById('sg'), sgt=null;
if(qi && sg){ qi.addEventListener('input', function(){ clearTimeout(sgt); var v=qi.value.trim(); if(v.length<2){ sg.innerHTML=''; return; } sgt=setTimeout(function(){ fetch('/suggest?q='+encodeURIComponent(v)).then(function(r){ return r.json(); }).then(function(list){ sg.innerHTML=''; (list||[]).forEach(function(s){ var o=document.createElement('option'); o.value=s; sg.appendChild(o); }); }).catch(function(){}); }, 160); }); }
</script>
<script>
var TKEY='gx_tabs_v1';
var DEF=[];
function loadTabs(){ try{ var v=JSON.parse(localStorage.getItem(TKEY)); if(Array.isArray(v)) return v; }catch(e){} return DEF.slice(); }
function saveTabs(v){ try{ localStorage.setItem(TKEY, JSON.stringify(v)); }catch(e){} schedulePush(); }
function hue(s){ var h=0; for(var i=0;i<s.length;i++) h=(h*31 + s.charCodeAt(i)) % 360; return h; }
function hostOf(u){ var a=document.createElement('a'); a.href=u; return a.hostname || u; }
function renderTabs(){
  var box=document.getElementById('tabs'); box.innerHTML='';
  var tabs=loadTabs();
  if(!tabs.length){ box.innerHTML='<p class="sub">no shortcuts yet — add one below</p>'; return; }
  tabs.forEach(function(tb, ix){
    var d=document.createElement('div'); d.className='tabtile';
    var av=document.createElement('div'); av.className='tabav'; av.textContent=(tb.t||'?').slice(0,1).toUpperCase(); av.style.background='hsl('+hue(tb.t||tb.u)+',45%,36%)';
    var tx=document.createElement('div'); tx.className='tabtx';
    var b=document.createElement('b'); b.textContent=tb.t||tb.u;
    var sp=document.createElement('span'); sp.textContent=hostOf(tb.u);
    tx.appendChild(b); tx.appendChild(sp);
    var x=document.createElement('button'); x.className='tabx'; x.type='button'; x.textContent='\u2715'; x.setAttribute('aria-label','remove tab');
    x.addEventListener('click', function(ev){ ev.stopPropagation(); var v=loadTabs(); v.splice(ix,1); saveTabs(v); renderTabs(); });
    d.appendChild(av); d.appendChild(tx); d.appendChild(x);
    d.addEventListener('click', function(){ openTab(tb.u, tb.t); });
    box.appendChild(d);
  });
}
document.getElementById('addtab').addEventListener('submit', function(ev){
  ev.preventDefault();
  var name=document.getElementById('tabName').value.trim();
  var url=document.getElementById('tabUrl').value.trim();
  if(!url) return;
  if(url.indexOf('://')<0) url='https://'+url;
  var v=loadTabs(); v.unshift({ t: name || hostOf(url), u: url }); saveTabs(v.slice(0,24)); renderTabs();
  document.getElementById('tabName').value=''; document.getElementById('tabUrl').value='';
});
renderTabs();
var cutsSync=false, pushT=null;
function schedulePush(){ if(!cutsSync) return; clearTimeout(pushT); pushT=setTimeout(pushCuts, 900); }
function pushCuts(){ if(!cutsSync) return; try{ fetch('/api/shortcuts', { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ cuts: loadTabs() }) }); }catch(e){} }
try{ fetch('/api/shortcuts').then(function(r){ return r.json(); }).then(function(j){
  if(!j || !j.ok) return; cutsSync=true;
  if(Array.isArray(j.cuts) && j.cuts.length){ try{ localStorage.setItem(TKEY, JSON.stringify(j.cuts.slice(0,24))); }catch(e){} renderTabs(); }
  else if(loadTabs().length) pushCuts();
}).catch(function(){}); }catch(e){}
</script>
<script>
var BTKEY='gx_btabs_v2';
var btabs=[], bactive=0, bid=0;
function bEl(id){ return document.getElementById(id); }
function bsave(){ try{ localStorage.setItem(BTKEY, JSON.stringify({ tabs: btabs, active: bactive })); }catch(e){} }
function bload(){
  try{ var v=JSON.parse(localStorage.getItem(BTKEY)); if(v && Array.isArray(v.tabs) && v.tabs.length){ btabs=v.tabs; bactive=Math.min(v.active||0, btabs.length-1); btabs.forEach(function(t){ bid=Math.max(bid, t.id||0); }); return; } }catch(e){}
  btabs=[{ id:++bid, raw:'', url:null, title:'new tab' }]; bactive=0;
}
function renderBtabs(){
  var strip=bEl('tabstrip'); strip.innerHTML='';
  btabs.forEach(function(tb, ix){
    var d=document.createElement('div'); d.className='btab'+(ix===bactive?' on':'');
    var av=document.createElement('span'); av.className='bav'; av.textContent=(tb.title||'n').slice(0,1).toUpperCase();
    if(tb.url) av.style.background='hsl('+hue(tb.title||tb.raw||'x')+',45%,36%)';
    if(tb.ai){ av.textContent='✦'; av.style.background='#e39a2d'; av.style.color='#171106'; }
    var tt=document.createElement('span'); tt.className='btt'; tt.textContent=tb.title||'new tab';
    var x=document.createElement('button'); x.className='bx'; x.type='button'; x.textContent='\u2715'; x.setAttribute('aria-label','close tab');
    x.addEventListener('click', function(ev){ ev.stopPropagation(); closeBtab(ix); });
    d.appendChild(av); d.appendChild(tt); d.appendChild(x);
    d.addEventListener('click', function(){ switchBtab(ix); });
    strip.appendChild(d);
  });
  var add=document.createElement('button'); add.id='newtab'; add.type='button'; add.innerHTML='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>'; add.setAttribute('aria-label','new tab');
  add.addEventListener('click', function(){ newBtab(); });
  strip.appendChild(add);
  var stage=bEl('stage'); var act=btabs[bactive];
  btabs.forEach(function(tb){
    if(!tb.url) return;
    var f=stage.querySelector('iframe[data-bid="'+tb.id+'"]');
    if(!f){
      f=document.createElement('iframe'); f.setAttribute('data-bid', tb.id);
      f.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen; gamepad; pointer-lock');
      f.setAttribute('allowfullscreen', '');
      f.src=tb.url;
      f.addEventListener('load', function(){ var vv=stage.querySelector('[data-veil="'+tb.id+'"]'); if(vv) vv.remove(); try{ var t=f.contentWindow.document.title; if(t && t!=='Google' && t!=='Error'){ tb.title=t.slice(0,60); bsave(); renderBtabs(); } }catch(e){} });
      var vl=document.createElement('div'); vl.className='veil'; vl.setAttribute('data-veil', tb.id); vl.innerHTML='<div class="vx">✦</div><div>tunneling thru the network…</div>'; stage.appendChild(vl);
      setTimeout(function(){ var vv3=stage.querySelector('[data-veil="'+tb.id+'"]'); if(vv3) vv3.remove(); }, 6000);
      stage.appendChild(f);
      (function(tb2, fr){
        if(!tb2.raw) return;
        var tries = 0;
        var swap = function(){
          tb2.rescued = true; clearInterval(iv);
          var isU = tb2.raw.indexOf('://') > 0 || (tb2.raw.indexOf(' ') < 0 && tb2.raw.indexOf('.') > 0);
          var dest = isU ? tb2.raw : ('https://www.bing.com/search?q=' + encodeURIComponent(tb2.raw));
          fr.src = '/go?q=' + encodeURIComponent(dest) + '&classic=1';
          var vv2 = stage.querySelector('[data-veil="' + tb2.id + '"]'); if(vv2) vv2.remove();
        };
        var iv = setInterval(function(){
          tries++;
          if(tb2.rescued) { clearInterval(iv); return; }
          var doc = null;
          try { doc = fr.contentWindow.document; } catch(e) {}
          if(doc && doc.body) {
            var txt = (doc.body.textContent || '').slice(0, 1500);
            if(txt.trim().length > 40) { var vv4=stage.querySelector('[data-veil="' + tb2.id + '"]'); if(vv4) vv4.remove(); }
            if(/error processing your request|failed to load/i.test(txt)) { swap(); }
            else if(txt.trim().length > 60) { clearInterval(iv); }
            else if(tries >= 25) { swap(); }
          } else if(tries >= 25) { swap(); }
        }, 1200);
      })(tb, f);
    }
    f.style.display = (tb===act) ? 'block' : 'none';
    var vx=stage.querySelector('[data-veil="'+tb.id+'"]'); if(vx) vx.style.display = (tb===act) ? 'flex' : 'none';
  });
  Array.prototype.forEach.call(stage.querySelectorAll('iframe'), function(f){
    var id=+f.getAttribute('data-bid');
    if(!btabs.some(function(tb){ return tb.id===id && tb.url; })) f.remove();
  });
  btabs.forEach(function(tb){
    if(!tb.ai) return;
    var p=stage.querySelector('[data-aipanel="'+tb.id+'"]');
    if(!p){ p=buildAiPanel(tb); stage.appendChild(p); }
    p.style.display = (tb===act) ? 'block' : 'none';
  });
  Array.prototype.forEach.call(stage.querySelectorAll('[data-aipanel]'), function(p){
    var pid=+p.getAttribute('data-aipanel');
    if(!btabs.some(function(tb){ return tb.id===pid && tb.ai; })) p.remove();
  });
  var showStage = !!(act && (act.url || act.ai));
  bEl('ntp').style.display = showStage ? 'none' : 'block';
  stage.style.display = showStage ? 'flex' : 'none';
  var onEl=strip.querySelector('.btab.on'); if(onEl){ var sl=onEl.offsetLeft-8; if(strip.scrollLeft>sl || sl>strip.scrollLeft+strip.clientWidth-onEl.offsetWidth) strip.scrollLeft=sl; }
  var qi=document.querySelector('#omni input[name=q]');
  if(qi && act && document.activeElement!==qi) qi.value = act.raw || '';
}
function switchBtab(ix){ bactive=ix; bsave(); renderBtabs(); }
function newBtab(){ btabs.push({ id:++bid, raw:'', url:null, title:'new tab' }); bactive=btabs.length-1; bsave(); renderBtabs(); var qi=document.querySelector('#omni input[name=q]'); if(qi) qi.focus(); }
function closeBtab(ix){
  btabs.splice(ix,1);
  if(!btabs.length){ btabs.push({ id:++bid, raw:'', url:null, title:'new tab' }); bactive=0; }
  else if(ix<=bactive) bactive=Math.max(0, bactive-1);
  bsave(); renderBtabs();
}
function engUrl(q){ return 'https://duckduckgo.com/?q='+encodeURIComponent(q); }
function actFrame(){ var act=btabs[bactive]; if(!act) return null; return document.querySelector('#stage iframe[data-bid="'+act.id+'"]'); }
var nb=document.getElementById('nback'), nf=document.getElementById('nfwd'), nr=document.getElementById('nreload');
if(nb) nb.addEventListener('click', function(){ var f=actFrame(); if(f){ try{ f.contentWindow.history.back(); }catch(e){} } });
if(nf) nf.addEventListener('click', function(){ var f=actFrame(); if(f){ try{ f.contentWindow.history.forward(); }catch(e){} } });
if(nr) nr.addEventListener('click', function(){ var f=actFrame(); if(f){ f.src=f.src; } });
function openTab(raw, title){
  var q=(raw||'').trim(); if(!q) return;
  var isUrl = q.indexOf('://')>0 || (q.indexOf(' ')<0 && q.indexOf('.')>0);
  var disp = title || (isUrl ? q.replace('https://','').replace('http://','') : q); if(disp.charAt(disp.length-1)==='/') disp=disp.slice(0,-1);
  var target='/go?q='+encodeURIComponent(isUrl ? q : engUrl(q));
  var act=btabs[bactive];
  if(act && !act.url && !act.raw){ act.raw=q; act.url=target; act.title=disp; }
  else { btabs.push({ id:++bid, raw:q, url:target, title:disp }); bactive=btabs.length-1; }
  bsave(); renderBtabs();
}
function aiEsc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function aiRender(text){
  return aiEsc(text).split(/\\n{2,}/).map(function(par){
    par = par.replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g, '<a href="$2" data-aiurl="$2">$1</a>');
    par = par.replace(/(^|[\\s(])((https?:\\/\\/)[^\\s<]+)/g, '$1<a href="$2" data-aiurl="$2">$2</a>');
    return '<p>' + par.replace(/\\n/g, '<br>') + '</p>';
  }).join('');
}
function buildAiPanel(tb){
  var p=document.createElement('div'); p.className='aipanel'; p.setAttribute('data-aipanel', tb.id);
  var head=document.createElement('div'); head.className='aihead';
  var star=document.createElement('span'); star.className='aistar'; star.textContent='✦';
  var hw=document.createElement('div');
  var q=document.createElement('div'); q.className='aiq'; q.textContent=tb.ai;
  var sub=document.createElement('div'); sub.className='aisub'; sub.textContent='six · web mode';
  hw.appendChild(q); hw.appendChild(sub); head.appendChild(star); head.appendChild(hw); p.appendChild(head);
  var body=document.createElement('div'); body.className='aibody'; p.appendChild(body);
  var foot=document.createElement('div'); foot.className='aifoot';
  var sb=document.createElement('button'); sb.type='button'; sb.className='aisearch'; sb.textContent='search it instead';
  sb.addEventListener('click', function(){ openTab(tb.ai, null); });
  foot.appendChild(sb); p.appendChild(foot);
  if(tb.answer){ body.innerHTML=aiRender(tb.answer); }
  else {
    body.innerHTML='<p class="aithink">six is thinkin…</p>';
    fetch('/ai/ask', { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ messages:[{ role:'user', content: tb.ai }], mode:'web' }) })
      .then(function(r){ return r.json(); })
      .then(function(o){ tb.answer=(o && o.text) || 'six had nothin for that one'; bsave(); body.innerHTML=aiRender(tb.answer); })
      .catch(function(){ body.innerHTML='<p>six is unreachable rn — hit search it instead n run it the normal way</p>'; });
  }
  return p;
}
function openAiTab(raw){
  var q=(raw||'').trim(); if(!q) return;
  var act=btabs[bactive];
  if(act && !act.url && !act.raw && !act.ai){ act.ai=q; act.raw=q; act.title=q.slice(0,60); }
  else { btabs.push({ id:++bid, raw:q, url:null, ai:q, title:q.slice(0,60) }); bactive=btabs.length-1; }
  bsave(); renderBtabs();
}
var aimBtn=document.getElementById('aimode');
function aimOn(){ try{ return false; }catch(e){ return false; } }
function aimPaint(){ if(aimBtn){ aimBtn.classList.toggle('on', aimOn()); aimBtn.setAttribute('aria-pressed', aimOn() ? 'true' : 'false'); } }
if(aimBtn) aimBtn.addEventListener('click', function(){ try{ localStorage.setItem('gx_aimode', aimOn() ? '0' : '1'); }catch(e){} aimPaint(); var qi=document.querySelector('#omni input[name=q]'); if(qi) qi.focus(); });
aimPaint();
document.getElementById('stage').addEventListener('click', function(ev){ var a=(ev.target && ev.target.closest) ? ev.target.closest('a[data-aiurl]') : null; if(a){ ev.preventDefault(); openTab(a.getAttribute('data-aiurl'), null); } });
document.getElementById('omni').addEventListener('submit', function(ev){ ev.preventDefault(); var qi=document.querySelector('#omni input[name=q]'); if(aimOn()) openAiTab(qi.value); else openTab(qi.value, null); });
bload(); renderBtabs();
try { var hq = new URLSearchParams(location.search).get('q'); if (hq && hq.trim()) { var hv = hq.trim(); var ex2 = -1; for (var ii = 0; ii < btabs.length; ii++) { if (btabs[ii].raw === hv) { ex2 = ii; break; } } if (ex2 >= 0) { if (ex2 !== bactive) { bactive = ex2; bsave(); renderBtabs(); } } else if (aimOn()) { openAiTab(hv); } else { openTab(hv, null); } var qi2 = document.querySelector('#omni input[name=q]'); if (qi2) qi2.value = hv; } } catch (e) {}

setTimeout(function(){ try{ var w=document.createElement('iframe'); w.style.display='none'; w.src='/go?q='+encodeURIComponent('https://example.com'); w.addEventListener('load', function(){ setTimeout(function(){ w.remove(); }, 4000); }); document.body.appendChild(w); }catch(e){} }, 2600);

</script>
</body>
</html>`;

// spare-key job (v231, his call): the leftover keys earn their keep writing
// the lil splash line under the home title. six invents a fresh one in the
// background every ~20 min and it joins the built-in rotation — the page
// itself never waits on it, built-ins show until a fresh one lands.
const SPLASH_BUILTINS = ["six's house — wipe ur feet", "still up. obviously", "ur teacher thinks this is a study site", "the bell cant save u", "homework? never met her", "six picked today's games. blame him", "100% more six than yesterday", "built in a bedroom. runs like a company", "ur principal cant stand us", "welcome back twin"];
let splashAi = '', splashAiAt = 0, splashBusy = false;
// v236: the splash is alive now — it rotates every few seconds, and
// the longer a visitor camps the homepage the more six criticizes
// them. tiers fed by builtins + the spare-key lane (see /api/splash).
const ROAST_MILD = ["still scrolling huh", "u good? u been here a sec", "the games are right there btw", "take ur time. or dont", "this page aint that deep twin", "u window shopping or what"];
const ROAST_MEAN = ["bro u live here now?", "ur screentime report is crying", "go touch a game. any game", "this is ur home now ig. pay rent", "even six took a break before u", "u been here so long the splash gave up"];
const ROAST_FERAL = ["day 47 of u staring at the homepage", "ur teacher thinks ur studying. ur not", "the bell rang twice. u stayed", "congrats. u beat the homepage. no prize", "six is charging u rent after this", "pick one: a game, or logging off"];
let splashPool = [], roastAi = { mild: [], mean: [], feral: [] }, roastBusy = false, roastAt = 0;
function cleanLine(s) { return String(s || '').replace(/["<>]/g, '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim().slice(0, 70); }
function splashPick() {
  if (splashPool.length) return splashPool[Math.floor(Math.random() * splashPool.length)];
  const pool = splashAi ? SPLASH_BUILTINS.concat([splashAi]) : SPLASH_BUILTINS;
  return pool[Math.floor(Math.random() * pool.length)];
}
// v238: FULLY ai-operated rotation — no pools, no repeats. every line
// shown is generated fresh by the spare-key lane, per dwell tier,
// with a rolling history the generator is told not to repeat. a tiny
// per-tier buffer (2 deep) keeps swaps instant; history is global,
// so no visitor ever sees a line another visitor just got either.
const SPLASH_TIERS = ['fresh', 'mild', 'mean', 'feral'];
const splashBuf = { fresh: [], mild: [], mean: [], feral: [] };
const splashSeen = { fresh: [], mild: [], mean: [], feral: [] };
const splashGenBusy = {};
async function topUpSplash(tier) {
  if (splashGenBusy[tier]) return; splashGenBusy[tier] = true;
  try { while (splashBuf[tier].length < 2) { const l = await genSplashLine(tier); if (!l) break; splashBuf[tier].push(l); } }
  catch { /* lane down — buffer stays short, client just holds the current line */ }
  splashGenBusy[tier] = false;
}
function homeServed() { return HOME.replace(/<p class="splash">[^<]*<\/p>/, '<p class="splash">' + splashPick() + '</p>'); }
const HOME = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#0a0a0b"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="6ixNetworks"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><script>if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}</script>
<title>Google</title><link rel="icon" href="https://www.google.com/favicon.ico">
${FONT_LINKS}<style>${GALAXY_CSS}</style>
</head>
<body>${STAR_CANVAS}
  <div id="heroClock" style="font-size:12.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:rgba(var(--star),.55);margin-bottom:6px"></div>
  <h1 class="wm">6ix<span>Networks</span></h1>
  <p class="splash">${["six's house — wipe ur feet","still up. obviously","ur teacher thinks this is a study site","the bell cant save u","homework? never met her","six picked today's games. blame him","100% more six than yesterday","built in a bedroom. runs like a company","ur principal cant stand us","welcome back twin"][Math.floor(Math.random()*10)]}</p>
  
    <form class="heroSearch" action="/search" method="get" autocomplete="off">
    <div class="xlights" aria-hidden="true"></div>
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
    <input id="heroQ" name="q" type="text" placeholder="search the web or paste a link..." autocomplete="off">
    <button type="submit">go</button>
    <div id="heroSug" hidden></div>
  </form>
  <div class="hchips"><a href="/yt">6ixtube</a><a href="/gs">games</a></div>
  <div class="statCard"><div class="scTime" id="scTime">--:--</div><div class="scDate" id="scDate"></div><div class="scRow scBatt"><svg width="23" height="13" viewBox="0 0 25 13" fill="none" aria-hidden="true"><rect x="0.7" y="0.7" width="20" height="11.6" rx="3.2" stroke="currentColor" stroke-opacity=".55"/><rect id="scBatFill" x="2.7" y="2.7" width="0" height="7.6" rx="1.6" fill="currentColor"/><path d="M23.2 4.4v4.2a2.3 2.3 0 0 0 0-4.2z" fill="currentColor" fill-opacity=".55"/></svg><span id="scBat">battery unavailable</span></div></div>
  <script>
  (function(){
    var c=document.getElementById('heroClock');
    function tick(){ if(!c) return; var d=new Date(); var days=['sunday','monday','tuesday','wednesday','thursday','friday','saturday']; var h=d.getHours(); var g= h<5?'up late': h<12?'good morning': h<17?'good afternoon': h<21?'good evening':'good night'; var ap=h>=12?'pm':'am'; var hh=h%12||12; var mm=('0'+d.getMinutes()).slice(-2); c.textContent=days[d.getDay()]+' \u00b7 '+hh+':'+mm+' '+ap+' \u2014 '+g; }
    tick(); setInterval(tick, 20000);
    var sct=document.getElementById('scTime'), scd=document.getElementById('scDate');
    function scTick(){ var d=new Date(); if(sct){ var h=d.getHours(), m=d.getMinutes(); var ap=h>=12?'PM':'AM'; var h12=h%12; if(h12===0) h12=12; sct.textContent=h12+':'+(m<10?'0':'')+m+' '+ap; } if(scd){ var dys=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']; var mos=['January','February','March','April','May','June','July','August','September','October','November','December']; scd.textContent=dys[d.getDay()]+', '+mos[d.getMonth()]+' '+d.getDate(); } }
    scTick(); setInterval(scTick, 1000);
    var scb=document.getElementById('scBat'), scf=document.getElementById('scBatFill');
    if(navigator.getBattery){ navigator.getBattery().then(function(b){ function bu(){ var pc=Math.round(b.level*100); if(scb) scb.textContent=pc+'%'+(b.charging?' - charging':''); if(scf) scf.setAttribute('width', String(Math.round(16*b.level))); } bu(); b.addEventListener('levelchange', bu); b.addEventListener('chargingchange', bu); }).catch(function(){}); }
  // line six generated fresh (buffered one ahead); if the lane is
  // dry the current line just holds — old lines never repeat.
  (function(){
    var el = document.querySelector('.splash'); if (!el) return;
    el.style.transition = 'opacity .18s';
    var t0 = Date.now(), buf = '', bufTier = '', fetching = false, last = el.textContent;
    function tier(){ var s = (Date.now() - t0) / 1000; return s < 25 ? 'fresh' : s < 65 ? 'mild' : s < 150 ? 'mean' : 'feral'; }
    function refill(){
      if (fetching || buf) return;
      fetching = true;
      var rt = tier();
      fetch('/api/splash/next?tier=' + rt).then(function(r){ return r.json(); }).then(function(j){
        fetching = false;
        if (j && j.line && j.line !== last) { buf = j.line; bufTier = rt; }
      }).catch(function(){ fetching = false; });
    }
    function swap(){
      var t = tier();
      if (buf && bufTier === t) {
        el.style.opacity = '0';
        var nxt = buf; buf = '';
        setTimeout(function(){ el.textContent = nxt; last = nxt; el.style.opacity = '1'; }, 180);
        refill();
        setTimeout(swap, 2000 + Math.random() * 6000);
      } else {
        if (buf && bufTier !== t) buf = '';
        refill();
        setTimeout(swap, 1400);
      }
    }
    refill();
    setTimeout(swap, 2000 + Math.random() * 6000);
  })();
    function buildLights(){
      var box=document.querySelector('.xlights'); if(!box) return;
      var form=box.parentElement; var w=box.offsetWidth||form.offsetWidth-2, h=box.offsetHeight||form.offsetHeight-2; if(w<50||h<20) return;
      var inset=1, W=w-inset*2, H=h-inset*2, r=H/2;
      var straight=Math.max(0, W-2*r), arc=Math.PI*r, P=2*straight+2*arc;
      var count=Math.max(10, Math.round(P/34));
      var cols=['#ff4646','#ffd23e','#3e8bff','#3ee06a'], dark=['#c81e1e','#d99a06','#1e56c8','#12963a'];
      var defs='';
      for(var ci=0; ci<4; ci++){
        defs+='<radialGradient id="xglow'+ci+'"><stop offset="0%" stop-color="'+cols[ci]+'" stop-opacity=".5"/><stop offset="100%" stop-color="'+cols[ci]+'" stop-opacity="0"/></radialGradient>';
        defs+='<radialGradient id="xbulb'+ci+'" cx="38%" cy="28%" r="85%"><stop offset="0%" stop-color="#ffffff" stop-opacity=".95"/><stop offset="35%" stop-color="'+cols[ci]+'"/><stop offset="100%" stop-color="'+dark[ci]+'"/></radialGradient>';
      }
      defs+='<linearGradient id="xsock" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#3a3f45"/><stop offset="100%" stop-color="#14161a"/></linearGradient>';
      function pt(d){
        if(d<straight) return [inset+r+d, inset, 0, -1];
        d-=straight;
        if(d<arc){ var phi=-Math.PI/2+d/r; return [inset+(W-r)+r*Math.cos(phi), inset+r+r*Math.sin(phi), Math.cos(phi), Math.sin(phi)]; }
        d-=arc;
        if(d<straight) return [inset+(W-r)-d, inset+H, 0, 1];
        d-=straight;
        var phi2=Math.PI/2+d/r; return [inset+r+r*Math.cos(phi2), inset+r+r*Math.sin(phi2), Math.cos(phi2), Math.sin(phi2)];
      }
      var wire='M'+(inset+r)+' '+inset+' H'+(inset+W-r)+' A'+r+' '+r+' 0 0 1 '+(inset+W-r)+' '+(inset+H)+' H'+(inset+r)+' A'+r+' '+r+' 0 0 1 '+(inset+r)+' '+inset+' Z';
      var s='<svg width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none" focusable="false" aria-hidden="true"><defs>'+defs+'</defs>';
      s+='<path d="'+wire+'" fill="none" stroke="rgba(70,140,70,.35)" stroke-width="6"/>';
      s+='<path d="'+wire+'" fill="none" stroke="#22331f" stroke-width="2.6"/>';
      for(var i=0; i<count; i++){
        var p=pt((i+0.5)*P/count), outB=(i%2===0), cyc=i%4;
        var ang=Math.atan2(p[3], p[2])*180/Math.PI+(outB?90:270);
        s+='<g class="xb" style="animation-delay:'+((i%4)*-0.45)+'s" transform="translate('+p[0].toFixed(1)+' '+p[1].toFixed(1)+') rotate('+ang.toFixed(1)+')">';
        s+='<circle cx="0" cy="-8" r="13" fill="url(#xglow'+cyc+')"/>';
        s+='<path d="M0 -19 C 5.5 -12.5 7.5 -8.5 7.5 -4.8 A 7.5 7.5 0 1 1 -7.5 -4.8 C -7.5 -8.5 -5.5 -12.5 0 -19 Z" fill="url(#xbulb'+cyc+')"/>';
        s+='<ellipse cx="0" cy="-5.5" rx="3.4" ry="4.2" fill="#ffffff" opacity=".30"/>';
        s+='<ellipse cx="-2.6" cy="-9.5" rx="1.9" ry="3.4" fill="#ffffff" opacity=".55" transform="rotate(-12)"/>';
        s+='<rect x="-3" y="-3.6" width="6" height="6" rx="1.5" fill="url(#xsock)"/>';
        s+='</g>';
      }
      s+='</svg>';
      box.innerHTML=s;
    }
    buildLights();
    var xlT=null;
    window.addEventListener('resize', function(){ clearTimeout(xlT); xlT=setTimeout(buildLights, 160); });
    setTimeout(buildLights, 400);
    var q=document.getElementById('heroQ'), box=document.getElementById('heroSug'), form=q ? q.form : null, t=null, seq=0;
    if(!q||!box||!form) return;
    function hide(){ box.hidden=true; }
    q.addEventListener('input', function(){
      var v=q.value.trim(); clearTimeout(t);
      if(v.length<2){ hide(); return; }
      t=setTimeout(function(){
        var my=++seq;
        fetch('/suggest?q='+encodeURIComponent(v)).then(function(r){ return r.json(); }).then(function(list){
          if(my!==seq || !Array.isArray(list) || !list.length){ if(my===seq) hide(); return; }
          box.innerHTML='';
          list.slice(0,7).forEach(function(s){
            var b=document.createElement('button'); b.type='button'; b.className='hsug'; b.textContent=s;
            b.addEventListener('click', function(){ q.value=s; form.requestSubmit(); });
            box.appendChild(b);
          });
          box.hidden=false;
        }).catch(function(){});
      }, 160);
    });
    q.addEventListener('blur', function(){ setTimeout(hide, 150); });
    q.addEventListener('focus', function(){ if(box.children.length) box.hidden=false; });
  })();
  </script>

  <div class="mq"><span class="mq-tag">trending rn</span><div class="mq-view"><div class="mq-track" id="mqTrack"></div></div><details class="mqdrop"><summary>trending rn<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></summary><div class="mqmenu" id="mqMenu"></div></details></div>
<style>
.mq{display:flex;align-items:center;gap:12px;max-width:860px;margin:22px auto 0;width:100%;text-align:left;position:relative;z-index:5}
.mq-tag{flex:none;font-size:11.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:rgb(var(--star));background:rgba(var(--acc),.16);border:1px solid rgba(var(--star),.3);padding:6px 11px;border-radius:999px}
.mq-view{overflow:hidden;flex:1;min-width:0;touch-action:pan-y}@media(min-width:701px){.mq-view{-webkit-mask-image:linear-gradient(90deg,transparent,#000 6%,#000 94%,transparent);mask-image:linear-gradient(90deg,transparent,#000 6%,#000 94%,transparent)}}
.mq-track{display:flex;gap:9px;width:max-content;animation:mqMove 40s linear infinite;padding:2px 0;will-change:transform;transform:translate3d(0,0,0)}
@media(hover:hover) and (pointer:fine){.mq:hover .mq-track{animation-play-state:paused}}
@keyframes mqMove{to{transform:translateX(-50%)}}
.mq-track a{flex:none;font-size:13.5px;font-weight:600;color:#e9e4f5;text-decoration:none;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.11);padding:7px 14px;border-radius:999px}
.mq-track a:hover{background:rgba(255,255,255,.11);color:#fff}.mqdrop{display:none;position:relative;flex:1;min-width:0}.mqdrop summary{list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13.5px;font-weight:700;color:#f4f4f5;background:#12111f;border:1px solid rgba(255,255,255,.2);padding:9px 15px;border-radius:999px;box-shadow:0 8px 22px rgba(0,0,0,.45)}.mqdrop summary::-webkit-details-marker{display:none}.mqmenu{position:absolute;top:calc(100% + 8px);left:0;right:0;z-index:80;background:#0c0b17;opacity:1 !important;border:1px solid rgba(255,255,255,.2);border-radius:16px;padding:6px;box-shadow:0 22px 50px rgba(0,0,0,.75);max-height:320px;overflow-y:auto}.mqmenu a{display:block;padding:10px 13px;border-radius:10px;color:#e9e4f5;text-decoration:none;font-size:14px;font-weight:600}.mqmenu a:hover{background:rgba(255,255,255,.08);color:#fff}body[data-motion="off"] .mq-view,body[data-motion="off"] .mq-tag{display:none}body[data-motion="off"] .mqdrop{display:block}
</style>
<script>
(function(){
  var T = ['Roblox','Minecraft Classic','Slope','1v1.LOL','Krunker','Moto X3M','Shell Shockers','Tetris','Cookie Clicker','Paper.io','Smash Karts','2048','Agar.io','Diep.io','Hole.io','Bloxd.io'];
  var tr = document.getElementById('mqTrack');
  if (!tr) return;
  for (var k = 0; k < 2; k++) T.forEach(function(t){
    var a = document.createElement('a');
    a.href = '/gs?q=' + encodeURIComponent(t);
    a.textContent = t;
    tr.appendChild(a);
  });
  var mn = document.getElementById('mqMenu');
  if (mn) T.forEach(function(t){
    var a = document.createElement('a');
    a.href = '/gs?q=' + encodeURIComponent(t);
    a.textContent = t;
    mn.appendChild(a);
  });
})();
</script>
<div class="starfield" aria-hidden="true"><i class="tw tv" style="left:82%;top:15%;width:2px;height:2px;animation-duration:3.4s;animation-delay:1.0s"></i><i class="tw" style="left:18%;top:14%;width:3px;height:3px;animation-duration:3.4s;animation-delay:2.2s"></i><i class="tw" style="left:76%;top:55%;width:2px;height:2px;animation-duration:2.0s;animation-delay:0.9s"></i><i class="tw" style="left:65%;top:78%;width:2px;height:2px;animation-duration:3.0s;animation-delay:2.9s"></i><i class="tw tv" style="left:90%;top:70%;width:2px;height:2px;animation-duration:2.3s;animation-delay:2.4s"></i><i class="tw" style="left:1%;top:21%;width:3px;height:3px;animation-duration:2.7s;animation-delay:1.1s"></i><i class="tw" style="left:28%;top:44%;width:2px;height:2px;animation-duration:2.1s;animation-delay:0.4s"></i><i class="tw" style="left:45%;top:78%;width:2px;height:2px;animation-duration:3.5s;animation-delay:2.9s"></i><i class="tw tv" style="left:69%;top:16%;width:2px;height:2px;animation-duration:2.1s;animation-delay:1.2s"></i><i class="tw" style="left:81%;top:80%;width:2px;height:2px;animation-duration:3.1s;animation-delay:2.8s"></i><i class="tw" style="left:6%;top:85%;width:2px;height:2px;animation-duration:3.4s;animation-delay:3.9s"></i><i class="tw" style="left:30%;top:13%;width:2px;height:2px;animation-duration:2.5s;animation-delay:2.5s"></i><i class="tw tv" style="left:47%;top:21%;width:2px;height:2px;animation-duration:2.6s;animation-delay:2.7s"></i><i class="tw" style="left:90%;top:88%;width:3px;height:3px;animation-duration:2.0s;animation-delay:2.5s"></i><i class="tw" style="left:69%;top:32%;width:2px;height:2px;animation-duration:2.8s;animation-delay:1.1s"></i><i class="tw" style="left:82%;top:89%;width:3px;height:3px;animation-duration:2.3s;animation-delay:1.3s"></i></div><div class="launch">
<a class="lcard" href="/search"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg><b>search</b></a>
<a class="lcard" href="/gs"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg><b>games</b></a>
<a class="lcard" href="/apps"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M12 18h.01"/></svg><b>apps</b></a>
<a class="lcard" href="/yt"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="4"/><path d="m10 9 5 3-5 3z" fill="currentColor" stroke="none"/></svg><b>6ixtube</b></a>




<a class="lcard" href="/emu"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="11" rx="5"/><path d="M7.5 10.5v4M5.5 12.5h4"/><circle cx="16.5" cy="11" r=".4" fill="currentColor"/><circle cx="18.5" cy="14" r=".4" fill="currentColor"/></svg><b>emulator</b></a>
</div>
<style>.wm{background:linear-gradient(94deg,#f0abfc,#a78bfa 25%,#38bdf8 48%,#34d399 68%,#facc15 85%,#fb7185);background-size:220% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;animation:wmBlend 9s ease-in-out infinite alternate}@keyframes wmBlend{from{background-position:0% 0}to{background-position:100% 0}}body[data-motion="off"] .wm{animation:none}@keyframes wmSlide{0%,100%{background-position:0% 0}50%{background-position:110% 0}}
.heroSearch{position:relative;z-index:40;display:flex;align-items:center;gap:8px;max-width:640px;margin:16px auto 10px;background:rgba(13,11,26,.72);-webkit-backdrop-filter:blur(18px) saturate(1.4);backdrop-filter:blur(18px) saturate(1.4);border:1px solid rgba(var(--star),.25);border-radius:999px;padding:7px 7px 7px 18px;box-shadow:0 18px 44px rgba(0,0,0,.5),0 0 32px rgba(var(--acc),.12);animation:gxUp .55s .1s cubic-bezier(.2,.8,.3,1) both}
.heroSearch:focus-within{border-color:rgba(var(--star),.55);box-shadow:0 18px 44px rgba(0,0,0,.5),0 0 0 3px rgba(var(--acc),.18),0 0 40px rgba(var(--acc),.2)}
.xlights{display:none;position:absolute;inset:0;z-index:5;pointer-events:none}
body[data-lights="on"] .xlights{display:block}
.xlights svg{width:100%;height:100%;display:block;overflow:visible}
.xlights .xb{animation:xblink 1.8s linear infinite}
@keyframes xblink{0%,52%{opacity:1}62%,100%{opacity:.15}}
body[data-motion="off"] .xlights .xb{animation:none}
@media (prefers-reduced-motion: reduce){.xlights .xb{animation:none}}
.splash{text-align:center;color:rgba(var(--star),.62);font-size:13.5px;font-weight:600;letter-spacing:.03em;margin:0 0 2px;animation:gxUp .55s .06s cubic-bezier(.2,.8,.3,1) both}
.statCard{position:fixed;left:16px;bottom:16px;z-index:35;min-width:214px;padding:14px 16px 12px;border-radius:18px;background:rgba(13,11,26,.66);-webkit-backdrop-filter:blur(18px) saturate(1.5);backdrop-filter:blur(18px) saturate(1.5);border:1px solid rgba(var(--star),.18);box-shadow:0 16px 40px rgba(0,0,0,.45);color:#e9e9f2;animation:gxUp .55s .3s cubic-bezier(.2,.8,.3,1) both}
.scTime{font-size:31px;font-weight:800;line-height:1.05;letter-spacing:.01em}
.scDate{font-size:12.5px;color:#a5a5bb;margin-top:2px}
.scRow{display:flex;align-items:center;gap:8px;font-size:12.5px;color:#c9c9da;margin-top:9px}
.scRow svg{flex:none;color:rgba(var(--star),.78)}
.scRow b{color:#fff}
.scDiv{height:1px;background:rgba(var(--star),.14);margin-top:10px}
@media(max-width:820px){.statCard{left:10px;bottom:86px;min-width:0;padding:10px 13px 9px;border-radius:15px}.scTime{font-size:21px}.scDate{display:none}.scBatt{display:none}.scRow{margin-top:6px}}
.heroSearch svg{flex:none;color:rgba(var(--star),.7)}
.heroSearch input{flex:1;min-width:0;background:transparent;border:0;outline:none;color:#fff;font-size:16px;font-family:inherit;padding:10px 2px;box-shadow:none}
.heroSearch input::placeholder{color:#8e8ea3}
.heroSearch button[type=submit]{flex:none;background:linear-gradient(120deg,rgb(var(--star)),rgb(var(--acc3)));color:#0d0a18;border:0;border-radius:999px;padding:12px 24px;font-weight:800;font-size:15px;cursor:pointer;font-family:inherit}
#heroSug{position:absolute;left:10px;right:10px;top:calc(100% + 8px);background:rgba(10,9,20,.97);border:1px solid rgba(var(--star),.22);border-radius:16px;padding:6px;z-index:70;text-align:left;box-shadow:0 22px 50px rgba(0,0,0,.6)}
#heroSug[hidden]{display:none}
.hsug{display:block;width:100%;text-align:left;background:none;border:0;color:#e9e9ee;font-size:14.5px;font-family:inherit;padding:9px 12px;border-radius:10px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hsug:hover{background:rgba(255,255,255,.08)}
.hchips{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin:2px auto 6px;animation:gxUp .55s .18s cubic-bezier(.2,.8,.3,1) both}
.hchips a{color:#dcdce2;text-decoration:none;font-size:13px;font-weight:600;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.13);border-radius:999px;padding:7px 14px}
.hchips a:hover{background:rgba(var(--acc),.2);color:#fff;border-color:rgba(var(--star),.4)}
@media (prefers-reduced-motion: reduce){ .heroSearch,.hchips{animation:none} }
.dcord{display:flex;align-items:center;gap:14px;max-width:560px;margin:22px auto 6px;padding:15px 20px;border-radius:18px;background:#5865F2;color:#fff;text-decoration:none;box-shadow:0 10px 30px rgba(88,101,242,.35)}.dcord svg{flex:none}.dcord span{display:flex;flex-direction:column;gap:1px;text-align:left}.dcord b{font-size:16.5px;letter-spacing:-.01em}.dcord i{font-style:normal;font-size:12.5px;opacity:.85}@media (max-width:760px){.dcord{margin-bottom:112px}}.wm span{background:linear-gradient(92deg,rgb(var(--star)),rgb(var(--acc3)) 45%,rgb(var(--acc2)) 80%,rgb(var(--star)));background-size:200% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;animation:gxSheen 7s ease-in-out infinite alternate}
.launch .lcard svg{width:40px;height:40px;padding:9px;background:rgba(var(--acc),.13);border:1px solid rgba(var(--star),.16);border-radius:12px;color:rgb(var(--acc3))}
.heroSearch{box-shadow:0 18px 44px rgba(0,0,0,.5),0 0 44px rgba(var(--acc),.18)}
</style>
<div id="actDeck" hidden><div class="ppl-h">happening on 6ix <span id="actMeta" style="letter-spacing:0;text-transform:none;font-weight:600"></span></div><div id="actList"></div><div class="act-top" id="actTop"></div></div>
<style>#actDeck{max-width:640px;margin:26px auto 0;width:100%;text-align:left}.act-item{display:flex;align-items:center;gap:11px;padding:9px 2px;border-bottom:1px solid rgba(255,255,255,.05);font-size:14.5px;color:#d6d2e4}.act-item .aav{position:relative;width:32px;height:32px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;color:#fff;overflow:hidden}.act-item .aav img{width:100%;height:100%;object-fit:cover}.act-item a.who{color:#fff;font-weight:700;text-decoration:none}.act-item .when{margin-left:auto;font-size:12.5px;color:#8b8699;flex:none}.act-item .vchip{flex:none;font-size:12px;font-weight:700;color:rgb(var(--star));background:rgba(var(--acc),.16);border:1px solid rgba(var(--star),.3);padding:3px 9px;border-radius:999px}#actList{max-height:262px;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.18) transparent}#actList::-webkit-scrollbar{width:8px}#actList::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:8px}.act-top{margin-top:12px;font-size:13.5px;color:#9d99ad}.act-top a{color:#e9e4f5;font-weight:600;text-decoration:none}.act-top a:hover{text-decoration:underline}</style>
<script>
fetch('/api/activity').then(function(r){ return r.json(); }).then(function(o){
  if (!o || !o.ok) return;
  var items = o.items || [];
  if (!items.length && !(o.top && o.top.length)) return;
  function ago(t){ var s = Math.max(0, (Date.now() - t) / 1000); if (s < 90) return 'now'; if (s < 3600) return Math.floor(s / 60) + 'm'; if (s < 86400) return Math.floor(s / 3600) + 'h'; return Math.floor(s / 86400) + 'd'; }
  var meta = [];
  if (o.online) meta.push(o.online + ' online rn');
  if (o.confessionToday) meta.push(o.confessionToday + ' confessions today');
  if (o.members) meta.push(o.members + ' members');
  document.getElementById('actMeta').textContent = meta.length ? '\u2014 ' + meta.join(' \u00b7 ') : '';
  var list = document.getElementById('actList');
  items.slice(0, 9).forEach(function(it){
    var row = document.createElement('div'); row.className = 'act-item';
    var av = document.createElement('span'); av.className = 'aav'; av.style.background = (it.hue !== null && it.hue !== undefined) ? 'hsl(' + it.hue + ',45%,38%)' : '#3f3f46';
    if (it.av) { var im = document.createElement('img'); im.src = it.av; im.alt = ''; av.appendChild(im); } else av.textContent = (it.disp || it.name || '?').slice(0, 1).toUpperCase();
    row.appendChild(av);
    var tx = document.createElement('span');
    var who = document.createElement('a'); who.className = 'who'; who.href = '/u/' + encodeURIComponent(it.name); who.textContent = it.disp || it.name;
    tx.appendChild(who);
    if (it.type === 'request') { tx.appendChild(document.createTextNode(' requested ')); var g = document.createElement('b'); g.textContent = it.title; tx.appendChild(g); }
    else tx.appendChild(document.createTextNode(' joined 6ixnetworks'));
    row.appendChild(tx);
    if (it.type === 'request' && it.votes) { var vc = document.createElement('span'); vc.className = 'vchip'; vc.textContent = it.votes + ' votes'; row.appendChild(vc); }
    var when = document.createElement('span'); when.className = 'when'; when.textContent = ago(it.ts); row.appendChild(when);
    list.appendChild(row);
  });
  if (o.top && o.top.length) {
    var tp = document.getElementById('actTop');
    tp.appendChild(document.createTextNode('top requesters: '));
    o.top.forEach(function(p, ix){
      if (ix) tp.appendChild(document.createTextNode(' \u00b7 '));
      var a = document.createElement('a'); a.href = '/u/' + encodeURIComponent(p.name); a.textContent = (p.disp || p.name) + ' (' + p.votes + ')';
      tp.appendChild(a);
    });
  }
  document.getElementById('actDeck').hidden = false;
}).catch(function(){});
</script>
<a class="dcord" href="https://discord.gg/bY5Dhk6dQZ" target="_blank" rel="noopener"><svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.32 4.37a19.8 19.8 0 0 0-4.93-1.51 13.8 13.8 0 0 0-.64 1.28 18.3 18.3 0 0 0-5.5 0 12.6 12.6 0 0 0-.64-1.28h-.05A19.7 19.7 0 0 0 3.64 4.37C.53 9.05-.32 13.58.1 18.06a19.9 19.9 0 0 0 6.04 3.03c.24-.33.47-.68.66-1.03a12.9 12.9 0 0 1-1.04-.5c.09-.07.18-.14.26-.21a14.2 14.2 0 0 0 12.06 0c.08.07.17.14.26.21-.33.2-.68.37-1.04.5.19.35.42.7.66 1.03a19.8 19.8 0 0 0 6.05-3.03c.5-5.18-.84-9.68-3.69-13.69ZM8.02 15.33c-1.18 0-2.16-1.08-2.16-2.42s.95-2.42 2.16-2.42 2.18 1.09 2.16 2.42c0 1.34-.95 2.42-2.16 2.42Zm7.97 0c-1.18 0-2.15-1.08-2.15-2.42s.95-2.42 2.15-2.42 2.18 1.09 2.16 2.42c0 1.34-.95 2.42-2.16 2.42Z"/></svg><span><b>join the discord</b></span></a>
  ${SIDEBAR_HTML}<script src="/ui.js"></script>

<script>
  // turn bare domains into https:// before submitting is handled server-side too
</script>
<script>${NOTIF_JS}</script>
</body>
</html>`;

function isSearchDest(dest) {
  try {
    const u = new URL(dest);
    const h = u.hostname.replace(/^www\./, '').toLowerCase();
    if (h === 'bing.com' && u.pathname.includes('/search')) return true;
    if (h.startsWith('google.') && u.pathname === '/search') return true;
    if (h === 'duckduckgo.com' && u.searchParams.has('q')) return true;
    if (h === 'search.brave.com' || h === 'search.yahoo.com') return true;
    return false;
  } catch (e) { return false; }
}
function normalizeInput(q) {
  const s = (q || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[^\s]+\.[a-z]{2,}(\/\S*)?$/i.test(s)) return 'https://' + s;
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(s);
}

const MEM_CACHE = new Map();
let MEM_CACHE_BYTES = 0;

// ---------- proxy core ----------

function blockPage(targetStr) {
  const arch = proxied('https://web.archive.org/web/2id_/' + targetStr);
  const again = proxied(targetStr);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#0a0a0b"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="6ixNetworks"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><script>if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}</script><title>Google</title><link rel="icon" href="https://www.google.com/favicon.ico">
${FONT_LINKS}<style>${GALAXY_CSS}</style></head><body>${STAR_CANVAS}<div class="wrap">
<a class="back" href="/home">← 6ixNetworks</a>
<h1>6ix<span>Networks</span></h1>
<p style="font-weight:700;font-size:19px">that site blocked the network ✦</p>
<p style="opacity:.8;max-width:52ch">its firewall refused the connection — happens with datacenter traffic. the archive copy usually still loads:</p>
<div class="links"><a href="${arch}">archive.org copy</a><a href="${again}">retry</a><a href="/home">home</a></div>
${CLOAK_BAR}
</div>
<script src="/ui.js"></script>
<script src="/stars.js?e=96"></script>
</body></html>`;
}
const BLOCK_SIG = /attention required|are you a robot|access denied|request blocked|unusual traffic|verify you are human|checking your browser|ddos-guard|incapsula|just a moment|rate limit|too many requests/i;
const CHAL_SIG = /just a moment|checking your browser|verify you are human|are you a robot|attention required/i;
// alternate egress, worker-style: public relay services fetch the page
// from THEIR network and hand us the HTML. Wired as an automatic
// fallback for sites that firewall the direct route — allorigins and
// cors.lol were the two that demonstrably answered during testing
// (codetabs timed out, corsproxy.io wants a key, thingproxy is dead).
const RELAYS = [
  (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
  (u) => 'https://api.cors.lol/?url=' + encodeURIComponent(u),
];
async function fetchViaRelay(targetStr) {
  for (const build of RELAYS) {
    try {
      const r = await fetch(build(targetStr), { headers: { 'user-agent': BROWSER_UA, 'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
      if (!r.ok) continue;
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('text/html')) continue;
      const text = await r.text();
      if (text.length < 800 || BLOCK_SIG.test(text.slice(0, 4000))) continue;
      return text;
    } catch { /* next relay */ }
  }
  return null;
}
async function fetchRescue(targetStr) {
  // v233: same relay bench as fetchViaRelay but for ANY small GET resource —
  // player .js/.json/config calls, not just whole pages.
  for (const build of RELAYS) {
    try {
      const r = await fetch(build(targetStr), { headers: { 'user-agent': BROWSER_UA, 'accept': '*/*' }, signal: AbortSignal.timeout(7000) });
      if (!r.ok) continue;
      const cl = +(r.headers.get('content-length') || 0);
      if (cl > 3 * 1024 * 1024) continue;
      return r;
    } catch { /* next relay */ }
  }
  return null;
}
function sendCompressed(req, res, status, headers, buf) {
  const h = Object.assign({}, headers);
  const ae = req.headers['accept-encoding'] || '';
  if (buf.length > 1024 && ae.includes('gzip') && !h['content-encoding']) {
    const gz = zlib.gzipSync(buf, { level: 5 });
    h['content-encoding'] = 'gzip';
    h['content-length'] = gz.length;
    h['vary'] = 'accept-encoding';
    res.writeHead(status, h);
    return res.end(gz);
  }
  h['content-length'] = buf.length;
  res.writeHead(status, h);
  return res.end(buf);
}
async function handleProxy(req, res, targetUrlStr, gameMode) {
  let target;
  try { target = new URL(targetUrlStr); } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    return res.end('bad url');
  }
  if (!/^https?:$/.test(target.protocol) || isPrivateHost(target.hostname)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('that host is blocked');
  }
  // six refuses to serve two toolkits embed pages bundle. (1) disable-devtool:
  // its size check walks every ancestor frame — under VD all ancestors are
  // same-origin (served by us), so the walk completes, it decides devtools
  // are open, and it suicides the player frame to about:blank ~2s in
  // (proven by full network capture 2026-11-04: VS_DEVTOOLS + FRAMENAV).
  // the pages' own inline configs all guard on window.DisableDevtool
  // existing, so a blank library disarms the whole trap. (2) the /__ads/
  // loader: the rotating popunder feed behind the fake vpn-install prompts.
  const lowPath = (target.pathname || '').toLowerCase();
  if (lowPath.includes('disable-devtool') || lowPath.includes('/__ads/')) {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=86400' });
    return res.end('/* six blocked this toolkit */');
  }

  if (res.socket) { try { res.socket.setNoDelay(true); } catch { } }
  // collect request body (for proxied form posts)
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  const accept = req.headers['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
  const isNav = accept.includes('text/html');
    // forward the browser's own fetch metadata when it sent any: an image
    // request has to look like an image request, a script like a script.
    // Forging one fixed shape for everything (the old way) is what made
    // image and captcha servers refuse to serve pictures.
    const fDest = req.headers['sec-fetch-dest'];
    const fMode = req.headers['sec-fetch-mode'];
    const fSite = req.headers['sec-fetch-site'];
  const headers = {
    'user-agent': BROWSER_UA,
    'accept': accept,
    'accept-language': req.headers['accept-language'] || 'en-US,en;q=0.9',
    'sec-ch-ua': '"Chromium";v="131", "Google Chrome";v="131", "Not-A.Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': fDest || (isNav ? 'document' : 'empty'),
    'sec-fetch-mode': fMode || (isNav ? 'navigate' : 'cors'),
    'sec-fetch-site': fSite || 'none',
    'referer': proxyReferer(req.headers['referer'], target),
  };
  if (req.headers['sec-fetch-user']) headers['sec-fetch-user'] = req.headers['sec-fetch-user'];
  else if (isNav && !fDest) {
    headers['sec-fetch-user'] = '?1';
    headers['upgrade-insecure-requests'] = '1';
  }
  if (req.headers['range']) headers['range'] = req.headers['range'];
  if (req.headers['if-range']) headers['if-range'] = req.headers['if-range'];
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  // bing degrades search results when a request carries an established
  // cookie jar (it collapses the ranking to a single term while still
  // echoing the full query) — a fresh jar always gets the real results.
  // so bing search requests go out cookieless, always.
  const isBingSearch = /(^|\.)bing\.com$/i.test(target.hostname) && target.pathname.includes('/search');
  const upstreamCookies = isBingSearch ? '' : buildUpstreamCookies(req.headers['cookie'] || '', target.hostname);
  if (upstreamCookies) headers['cookie'] = upstreamCookies;

  // v209: mirror/debing rules are NAVIGATION-only. Fired on a
  // subresource they 302 a player .js file to an HTML page and the
  // embed dies ("Unexpected token '<'" — youtube virtual direct did).
  // vd hosts asked for the REAL site (6ixtube = full youtube thru his ip) — the mirror must not hijack them back to the internal pages.
  const mirror = (isNav && !isVdHost(target)) ? internalMirror(target) : null;
  if (mirror) {
    res.writeHead(302, { location: mirror });
    return res.end();
  }
  const debinged = isNav ? debingUrl(target) : null;
  if (debinged) {
    res.writeHead(302, { location: proxied(debinged) });
    return res.end();
  }
  // memory cache (Node deploys): static assets only, GET without Range
  const cacheableReq = req.method === 'GET' && !req.headers['range'] && isStaticAsset(target, '');
  if (cacheableReq) {
    const hit = MEM_CACHE.get(target.toString());
    if (hit && Date.now() - hit.time < 3600e3) {
      const h = Object.assign({}, hit.headers, { 'x-6ixnetworks-cache': 'HIT' });
      return sendCompressed(req, res, 200, h, hit.buf);
    }
  }

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
      redirect: 'manual',
    });
  } catch (e) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    return res.end('proxy could not reach that site: ' + e.message);
  }

  // v233: walled SUBRESOURCES get the relay rescue too. before, only the
  // embed page itself was rescued — if the host walled the player's own
  // .js/config/stream-resolver calls (the usual movie death), six served
  // the 403 straight to the player and the movie just spun forever.
  if ((upstream.status === 403 || upstream.status === 429) && req.method === 'GET' && !req.headers['range'] && !isNav && !/\.(m3u8|ts|m4s|mp4|mkv|aac|mp3|key)$/i.test(target.pathname)) {
    const rescued = await fetchRescue(target.toString());
    if (rescued) upstream = rescued;
  }

  const status = upstream.status;
  const outHeaders = {};
  const ct = upstream.headers.get('content-type');
  if (ct) outHeaders['content-type'] = ct;
  const cache = upstream.headers.get('cache-control');
  if (cache) outHeaders['cache-control'] = cache;
  else if (isStaticAsset(target, ct || '')) outHeaders['cache-control'] = 'public, max-age=604800, immutable';
  // translate the site's cookies onto the proxy domain so sessions persist
  const translatedCookies = getSetCookies(upstream.headers)
    .map(sc => translateSetCookie(sc, target.hostname)).filter(Boolean);
  if (translatedCookies.length) outHeaders['set-cookie'] = translatedCookies;

  // redirects: send the browser to the proxied version of the new location
  if (status >= 300 && status < 400 && upstream.headers.get('location')) {
    const loc = new URL(upstream.headers.get('location'), target).toString();
    outHeaders['location'] = proxied(loc);
    res.writeHead(302, outHeaders);
    return res.end();
  }

  const isHtml = ct && ct.includes('text/html');
  const isCss = ct && ct.includes('text/css');

  if (isHtml || isCss) {
    const text = await upstream.text();
    if (isHtml && isNav && (status === 403 || status === 429 || CHAL_SIG.test(text.slice(0, 4000)))) {
      const relayed = await fetchViaRelay(target.toString());
      if (relayed) {
        let rw = rewriteHtml(relayed, target.toString());
        rw = injectProxyShim(rw, target.toString(), gameMode ? '/gproxy/' : '/browse/');
        const rb = Buffer.from(rw, 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': rb.length, 'x-6ixnetworks-route': 'relay' });
        return res.end(rb);
      }
      if (status !== 200) {
        const bp = Buffer.from(blockPage(target.toString()), 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': bp.length });
        return res.end(bp);
      }
    }
    let rewritten = isHtml ? rewriteHtml(text, target.toString()) : rewriteCss(text, target.toString());
  if (isHtml) rewritten = injectProxyShim(rewritten, target.toString(), gameMode ? '/gproxy/' : '/browse/');
    const buf = Buffer.from(rewritten, 'utf8');
    return sendCompressed(req, res, status, outHeaders, buf);
  }

  // v209: HLS playlists get their URIs rewritten through the proxy —
  // streamed raw, players resolved segments against the proxy URL and
  // buffered forever (virtual-direct movies "never finishing").
  const isHls = (ct && /mpegurl/i.test(ct)) || /\.m3u8$/i.test(target.pathname);
  if (isHls && req.method === 'GET' && status === 200) {
    const plText = await upstream.text();
    const plBuf = Buffer.from(rewritePlaylist(plText, target.toString(), gameMode), 'utf8');
    outHeaders['content-type'] = 'application/vnd.apple.mpegurl';
    return sendCompressed(req, res, 200, outHeaders, plBuf);
  }

  // stream everything else raw, passing through the headers media
  // players need (range/seeking) — this is what makes video files play
  // v209: never forward content-length for a compressed upstream —
  // fetch() hands us decompressed bytes, so that length is the
  // compressed size and browsers cut the body off there (every big
  // player .js died mid-file: virtual direct loaded nothing).
  const upEnc = upstream.headers.get('content-encoding');
  for (const h of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    if (h === 'content-length' && upEnc) continue;
    const v = upstream.headers.get(h);
    if (v) outHeaders[h] = v;
  }
  const cacheableRes = cacheableReq && status === 200 && isStaticAsset(target, ct || '');
  if (cacheableRes) {
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length <= 8e6) {
      const ck2 = target.toString();
      const old = MEM_CACHE.get(ck2);
      if (old) MEM_CACHE_BYTES -= old.buf.length;
      MEM_CACHE.set(ck2, { buf, headers: Object.assign({}, outHeaders), time: Date.now() });
      MEM_CACHE_BYTES += buf.length;
      while (MEM_CACHE_BYTES > 128e6 && MEM_CACHE.size > 1) { const k0 = MEM_CACHE.keys().next().value; MEM_CACHE_BYTES -= MEM_CACHE.get(k0).buf.length; MEM_CACHE.delete(k0); }
    }
    outHeaders['x-6ixnetworks-cache'] = 'MISS';
    return sendCompressed(req, res, status, outHeaders, buf);
  }
  // v263 SPEED: fetch() hands us decoded bytes and the raw tail used
  // to forward them UNCOMPRESSED across the tunnel - the slowest leg
  // carried 3-5x the bytes it needed to for every player bundle, json
  // and script. compressible streams now gzip on our side; media and
  // range/seek traffic never compress. everything streams through
  // pipeline() (real backpressure) instead of the manual read loop.
  const ae2 = req.headers['accept-encoding'] || '';
  const compressible = /^(text\/|application\/(javascript|json|xml|x-javascript|manifest)|image\/svg)/i.test(ct || '');
  if (upstream.body && status === 200 && !req.headers['range'] && ae2.includes('gzip') && compressible) {
    const h2 = Object.assign({}, outHeaders);
    delete h2['content-length'];
    h2['content-encoding'] = 'gzip';
    h2['vary'] = 'accept-encoding';
    res.writeHead(status, h2);
    pipeline(Readable.fromWeb(upstream.body), zlib.createGzip({ level: 5 }), res, () => {});
    return;
  }
  res.writeHead(status, outHeaders);
  if (upstream.body) pipeline(Readable.fromWeb(upstream.body), res, () => {});
  else res.end();
}


function ytSearchPage(query, hit) {
  const abs = (u) => { try { return new URL(u, hit.inst).href; } catch { return u; } };
  const fmtLen = (s) => { s = Math.floor(+s || 0); if (!s) return ''; const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, '0'); return h ? h + ':' + String(m).padStart(2, '0') + ':' + ss : m + ':' + ss; };
  const cards = hit.vids.map(r => {
    const id = r.videoId || (String(r.url || '').split('v=')[1] || '').split('&')[0];
    if (!id) return '';
    const t0 = (r.videoThumbnails || []).slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0];
    const img = t0 ? proxied(abs(t0.url)) : (r.thumbnail ? proxied(abs(r.thumbnail)) : proxied('https://i.ytimg.com/vi/' + id + '/hqdefault.jpg'));
    const len = fmtLen(r.lengthSeconds || r.duration);
    return `<a class="ytcard" href="/yt/watch?v=${encodeURIComponent(id)}"><span class="ytthumb"><img loading="lazy" src="${img}" alt="">${len ? `<span class="ytdur">${len}</span>` : ''}</span><span class="ytt">${escHtml(r.title || '')}</span><span class="yta">${escHtml(r.author || r.uploaderName || '')}</span></a>`;
  }).join('');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#0a0a0b"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="6ixNetworks"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><script>if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}</script><title>Google</title><link rel="icon" href="https://www.google.com/favicon.ico">
${FONT_LINKS}<style>${GALAXY_CSS}
body{display:block;padding:0}
.ytwrap{width:100%;box-sizing:border-box;max-width:1240px;margin:0 auto;padding:66px 16px 120px}
.ythead{text-align:center;margin:10px 0 18px}
.ytlogo{display:inline-block;font-size:40px;font-weight:800;letter-spacing:-.02em;background:linear-gradient(94deg,#f0abfc,#a78bfa 25%,#38bdf8 48%,#34d399 68%,#facc15 85%,#fb7185);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent}
.ytsearch{display:flex;gap:8px;align-items:center;background:rgba(12,10,24,.85);-webkit-backdrop-filter:blur(20px) saturate(1.4);backdrop-filter:blur(20px) saturate(1.4);border:1px solid rgba(var(--star),.16);border-radius:999px;padding:6px 6px 6px 18px;max-width:680px;margin:18px auto 0;box-shadow:0 14px 34px rgba(0,0,0,.35)}
.ytsearch input{flex:1;min-width:0;background:transparent;border:0;outline:none;color:#fff;font-size:16px;font-family:inherit}
.ytsearch button[type=submit]{background:linear-gradient(120deg,rgb(var(--acc)),rgb(var(--acc2)));color:#fff;border:0;border-radius:999px;padding:10px 22px;font-weight:700;cursor:pointer;font-family:inherit}
.ytpaste{display:flex;gap:8px;align-items:center;max-width:680px;margin:10px auto 0;background:rgba(255,255,255,.04);border:1px dashed rgba(255,255,255,.18);border-radius:999px;padding:5px 5px 5px 16px}
.ytpaste input{flex:1;min-width:0;background:transparent;border:0;outline:none;color:#d8d4ea;font-size:14px;font-family:inherit}
.ytpaste button{background:rgba(255,255,255,.07);color:#e9e6f5;border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:8px 16px;font-weight:700;cursor:pointer;font-family:inherit;box-shadow:none}
.ytpaste button:hover{background:rgba(167,139,250,.16);color:#fff}
.ytpaste.bad{border-color:rgba(248,113,113,.6)}
.yth{font-size:19px;font-weight:800;margin:26px 2px 12px;color:#f4f2ff}
.yth span{color:rgb(var(--star))}
.ytgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(235px,1fr));gap:14px}
@media(max-width:560px){.ytgrid{grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}.ytlogo{font-size:32px}}
.ytcard{display:block;background:rgba(14,12,26,.66);border:1px solid rgba(255,255,255,.07);border-radius:16px;overflow:hidden;text-decoration:none;transition:transform .15s ease,border-color .15s ease;box-shadow:none}
.ytcard:hover{transform:translateY(-2px);border-color:rgba(var(--star),.35)}
.ytthumb{position:relative;display:block;aspect-ratio:16/9;background:#000}
.ytthumb img{width:100%;height:100%;object-fit:cover;display:block}
.ytdur{position:absolute;right:7px;bottom:7px;background:rgba(0,0,0,.8);color:#fff;font-size:11.5px;font-weight:700;border-radius:7px;padding:2px 6px}
.ytt{display:block;padding:10px 12px 0;font-size:14.5px;font-weight:600;color:#f1eefc;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.yta{display:block;padding:3px 12px 12px;font-size:12.5px;color:#9d97b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ytempty{color:#9d97b8;font-size:14.5px;padding:16px 2px}
.ytmore{text-align:center;color:#9d97b8;font-size:13.5px;padding:20px 0 4px;min-height:22px}
</style></head><body>${STAR_CANVAS}
<div class="ytwrap">
<div class="ythead">
<a class="ytlogo" href="/yt">6ixtube</a>
<form class="ytsearch" action="/yt/search" method="get"><input name="q" type="text" value="${escHtml(query)}" placeholder="search youtube" autocomplete="off"><button type="submit">search</button></form>
<div class="ytpaste" id="pasteBox"><input id="pasteIn" type="text" placeholder="or paste a youtube link — we'll stream it" autocomplete="off"><button id="pasteGo" type="button">stream it</button></div>
</div>
<h2 class="yth">results for <span>&ldquo;${escHtml(query)}&rdquo;</span></h2>
<div class="ytgrid" id="ygrid">${cards || '<div class="ytempty">nothing came up for that one — try another search</div>'}</div>
<div id="ytsent"></div><div class="ytmore" id="ytmore"></div>
</div>
${SIDEBAR_HTML}
<script src="/ui.js"></script>
<script>
(function(){
var pIn = document.getElementById('pasteIn'), pBox = document.getElementById('pasteBox');
function pasteGo(){
  var s = (pIn.value || '').trim(); if (!s) return;
  var id = '';
  var m = s.match(/(?:v=|youtu\\.be\\/|shorts\\/|live\\/|embed\\/|v\\/)([A-Za-z0-9_-]{11})/);
  if (m) id = m[1]; else if (/^[A-Za-z0-9_-]{11}$/.test(s)) id = s;
  if (!id) { pBox.classList.add('bad'); setTimeout(function(){ pBox.classList.remove('bad'); }, 1600); return; }
  location.href = '/yt/watch?v=' + id;
}
document.getElementById('pasteGo').addEventListener('click', pasteGo);
pIn.addEventListener('keydown', function(e){ if (e.key === 'Enter') { e.preventDefault(); pasteGo(); } });
pIn.addEventListener('paste', function(){ setTimeout(pasteGo, 60); });
/* infinite results — same endless paging as the games catalog */
var MOREQ = ${JSON.stringify(query)}, MOREC = ${JSON.stringify(hit.cont || '')};
var grid2 = document.getElementById('ygrid'), moreEl2 = document.getElementById('ytmore'), moreBusy2 = false;
function esc2(s){ return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function fmtLen2(s){ if (!s) return ''; var m = Math.floor(s / 60), h = Math.floor(m / 60), ss = ('0' + (s % 60)).slice(-2); return h ? (h + ':' + ('0' + (m % 60)).slice(-2) + ':' + ss) : (m + ':' + ss); }
function card2(v){ return '<a class="ytcard" href="/yt/watch?v=' + v.id + '"><span class="ytthumb"><img loading="lazy" src="' + v.img + '" alt="">' + (v.len ? '<span class="ytdur">' + fmtLen2(v.len) + '</span>' : '') + '</span><span class="ytt">' + esc2(v.t) + '</span><span class="yta">' + esc2(v.a) + '</span></a>'; }
function loadMore2(){
  if (moreBusy2 || !MOREC) return;
  moreBusy2 = true; moreEl2.textContent = 'loading more…';
  fetch('/api/ytmore?q=' + encodeURIComponent(MOREQ) + '&c=' + encodeURIComponent(MOREC)).then(function(r){ return r.json(); }).then(function(j){
    moreBusy2 = false;
    var vids = (j && j.vids) || [];
    MOREC = (j && j.cont) || '';
    vids.forEach(function(v){
      if (!v || !v.id) return;
      if (grid2.querySelector('a[href="/yt/watch?v=' + v.id + '"]')) return;
      var d = document.createElement('div'); d.innerHTML = card2(v);
      if (d.firstChild) grid2.appendChild(d.firstChild);
    });
    moreEl2.textContent = MOREC ? '' : "that's everything youtube is giving us for this search";
  }).catch(function(){ moreBusy2 = false; moreEl2.textContent = 'more videos hiccuped — keep scrolling to retry'; });
}
if ('IntersectionObserver' in window) { var io2 = new IntersectionObserver(function(es){ if (es[0].isIntersecting) loadMore2(); }, { rootMargin: '800px' }); io2.observe(document.getElementById('ytsent')); }
})();
</script>
<script>${NOTIF_JS}</script>
</body></html>`;
}
async function fetchYtSearchApi(query) {
  for (let round = 0; round < 2; round++) {
    for (const inst of INVIDIOUS_API_ORDER) {
      try {
        const r = await fetchT(inst + '/api/v1/search?q=' + encodeURIComponent(query) + '&type=video', { headers: { 'user-agent': BROWSER_UA, 'accept': 'application/json' } }, 6000);
        if (!r.ok) continue;
        const j = await r.json();
        if (Array.isArray(j)) { const vids = j.filter(x => x && x.videoId && x.title); if (vids.length) return { inst, vids }; }
      } catch { /* next instance */ }
    }
    if (round === 0) await sleep(1200);
  }
  return null;
}
async function handleYtSearch(req, res, q) {
  const query = (q || '').trim();
  if (!query) { res.writeHead(302, { location: '/yt' }); return res.end(); }
  const itHit = await fetchYtSearchIt(query);
  if (itHit) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(ytSearchPage(query, itHit)); }
  const pipedHit = await fetchPipedSearch(query);
  if (pipedHit) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(ytSearchPage(query, pipedHit)); }
  const apiHit = await fetchYtSearchApi(query);
  if (apiHit) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(ytSearchPage(query, apiHit)); }
  res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
  res.end('<!DOCTYPE html><body style="background:#0a0a0b;color:#f2f2f2;font-family:system-ui;padding:40px">6ixtube search is down rn — <a style="color:#e4e4e7" href="/yt/search?q=' + encodeURIComponent(query) + '">retry</a></body>');
}


// ---------- in-network youtube player (/yt/watch) ----------
// Data comes from an instance's API (fetched by this server), playback is
// an MSE player in our own page streaming both tracks through /gproxy —
// the browser never talks to youtube, an instance, or googlevideo.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fetchT = (url, opts, ms) => fetch(url, { ...(opts || {}), signal: AbortSignal.timeout(ms || 6000) });
// piped backend: its proxy serves muxed mp4 files whose bytes actually
// flow from datacenter IPs (for videos its extractor can still reach).
// invidious stays as the metadata/search fallback — its companion
// rejects datacenter playback requests outright ("URL has expired").
const PIPED_APIS = ['https://api.piped.private.coffee'];
const PIPED_INFO_CACHE = new Map();
async function fetchPipedStreams(id, bust) {
  if (!bust) { const c = PIPED_INFO_CACHE.get(id); if (c && Date.now() - c.at < 300e3) return c.hit; }
  for (const api of PIPED_APIS) {
    try {
      const r = await fetchT(api + '/streams/' + encodeURIComponent(id), { headers: { 'user-agent': BROWSER_UA, 'accept': 'application/json' } }, 7000);
      if (!r.ok) continue;
      const j = await r.json();
      if (j && (j.title || (j.videoStreams || []).length)) { const hit = { api, data: j }; PIPED_INFO_CACHE.set(id, { at: Date.now(), hit }); if (PIPED_INFO_CACHE.size > 60) PIPED_INFO_CACHE.delete(PIPED_INFO_CACHE.keys().next().value); return hit; }
    } catch { /* next backend */ }
  }
  return null;
}
// v199: resolve a playable file straight from youtube's innertube API,
// from THIS server. the googlevideo url is minted for this server's ip
// and fetched by this server too, so the bytes exit the host's own ip
// instead of a piped/invidious datacenter. any refusal (po-token walls,
// unplayable status, no muxed mp4) returns null and the instance chain
// below catches it, exactly like before.
const IT_CLIENTS = [
  { name: 'ios', key: 'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc', ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_1 like Mac OS X)', ctx: { client: { clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2', userAgent: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_1 like Mac OS X)', osName: 'iPhone', osVersion: '18.3.1.22D72', hl: 'en', gl: 'US' } } },
  { name: 'vr', key: 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w', ua: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1)', ctx: { client: { clientName: 'ANDROID_VR', clientVersion: '1.65.10', deviceMake: 'Oculus', deviceModel: 'Quest 3', androidSdkVersion: 32, userAgent: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1)', hl: 'en', gl: 'US' } } },
  { name: 'android', key: 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w', ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14; en_US)', ctx: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 34, userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14; en_US)', hl: 'en', gl: 'US', clientScreen: 'WATCH' } } },
  { name: 'tv', key: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8', ua: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/2.1 Chrome/63.0.3239.84 TV Safari/537.36', ctx: { client: { clientName: 'TVHTML5', clientVersion: '7.20250923.13.00', userAgent: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/2.1 Chrome/63.0.3239.84 TV Safari/537.36', hl: 'en', gl: 'US' } } },
];
const itFileCache = new Map();
function itPick(sd) {
  if (!sd) return {};
  const fmts = (sd.formats || []).filter(f => f && f.url && /video\/mp4/.test(f.mimeType || ''));
  fmts.sort((a, b) => (b.height || 0) - (a.height || 0));
  const muxed = fmts.find(f => (f.height || 0) <= 720) || fmts[fmts.length - 1] || null;
  const ad = (sd.adaptiveFormats || []).filter(f => f && f.url);
  const vids = ad.filter(f => /video\/mp4/.test(f.mimeType || '') && (f.mimeType || '').includes('avc1')).sort((a, b) => (b.height || 0) - (a.height || 0));
  const v = vids.find(f => (f.height || 0) <= 720) || vids[0] || null;
  const a = ad.filter(f => /audio\/mp4/.test(f.mimeType || '')).sort((x, y) => (y.bitrate || 0) - (x.bitrate || 0))[0] || null;
  return { muxed: muxed ? { url: muxed.url, h: muxed.height || 0 } : null, pair: (v && a) ? { v: { url: v.url, h: v.height || 0 }, a: { url: a.url } } : null };
}
async function itClientFile(cl, vidId) {
  const r = await fetch('https://www.youtube.com/youtubei/v1/player?key=' + cl.key + '&prettyPrint=false', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': cl.ua },
    body: JSON.stringify({ context: cl.ctx, videoId: vidId, contentCheckOk: true, racyCheckOk: true }),
    signal: AbortSignal.timeout(7000),
  });
  if (!r.ok) return null;
  const j = await r.json();
  if (!j || !j.streamingData || (j.playabilityStatus && j.playabilityStatus.status !== 'OK')) return null;
  const pick = itPick(j.streamingData);
  if (!pick.muxed && !pick.pair) return null;
  return { client: cl.name, ua: cl.ua, title: (j.videoDetails && j.videoDetails.title) || '', ...pick };
}
async function ytProbe(url, ua) {
  try {
    const r = await fetch(url, { headers: { 'user-agent': ua, range: 'bytes=0-1023' }, signal: AbortSignal.timeout(4500) });
    if (r.status !== 200 && r.status !== 206) return false;
    if (r.body) { const rd = r.body.getReader(); const first = await rd.read(); try { rd.cancel(); } catch { } return !first.done && first.value && first.value.length > 0; }
    return true;
  } catch { return false; }
}
// v270: the downloader-site resolver. race every client shape in
// parallel (the old list had two clients youtube rejects outright —
// 400 precondition failed — which is why videos never loaded), then
// PROVE the winning lane with a 1kb ranged probe before the browser
// ever sees it. lanes: 'remux' (separate 720p video + audio tracks,
// merged by ffmpeg while streaming — what cobalt-style sites do) or
// 'file' (one muxed mp4, relayed with full range/seek).
async function ytResolve(vidId, fresh, exclude) {
  if (!fresh) { const c = itFileCache.get(vidId); if (c && Date.now() - c.at < 5 * 60 * 1000 && !(exclude && exclude.has(c.hit.lane + ':' + c.hit.client))) return c.hit; }
  const got = await Promise.allSettled(IT_CLIENTS.map(cl => itClientFile(cl, vidId)));
  const cands = [];
  got.forEach(g => { if (g.status === 'fulfilled' && g.value) cands.push(g.value); });
  const byName = {};
  cands.forEach(c => { byName[c.client] = c; });
  const order = [];
  const pushLane = (c, lane) => { if (c && ((lane === 'remux' && c.pair) || (lane === 'file' && c.muxed))) order.push({ lane, client: c.client, ua: c.ua, title: c.title, muxed: c.muxed, pair: c.pair }); };
  pushLane(byName.ios, 'remux'); pushLane(byName.vr, 'file'); pushLane(byName.android, 'remux'); pushLane(byName.tv, 'remux');
  pushLane(byName.vr, 'remux'); pushLane(byName.android, 'file'); pushLane(byName.tv, 'file'); pushLane(byName.ios, 'file');
  for (const cand of order) {
    if (exclude && exclude.has(cand.lane + ':' + cand.client)) continue;
    if (cand.lane === 'remux') {
      if (!await ffmpegBin()) continue;
      if (await ytProbe(cand.pair.v.url, cand.ua) && await ytProbe(cand.pair.a.url, cand.ua)) { const hit = { ...cand }; itFileCache.set(vidId, { at: Date.now(), hit }); if (itFileCache.size > 60) itFileCache.delete(itFileCache.keys().next().value); return hit; }
    } else if (await ytProbe(cand.muxed.url, cand.ua)) {
      const hit = { ...cand }; itFileCache.set(vidId, { at: Date.now(), hit }); if (itFileCache.size > 60) itFileCache.delete(itFileCache.keys().next().value); return hit;
    }
  }
  return null;
}
async function fetchInnertubeFile(vidId, fresh) {
  const hit = await ytResolve(vidId, fresh);
  if (hit && hit.lane === 'file') return { url: hit.muxed.url, title: hit.title, ua: hit.ua };
  return null;
}
// ffmpeg powers the remux lane. on the windows host it is fetched
// once, on first need, into bin/ next to server.js (static essentials
// build); anywhere it already exists in PATH it is used as-is. any
// failure just disables the lane — the file lane still works.
let _ffBin = undefined, _ffGetting = null;
async function ffmpegBin() {
  if (_ffBin !== undefined) return _ffBin;
  const { spawn } = require('child_process');
  const fs = require('fs');
  const path = require('path');
  const local = path.join(__dirname, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const test = (bin) => new Promise(res => { try { const p = spawn(bin, ['-version'], { stdio: 'ignore' }); p.on('error', () => res(false)); p.on('close', c => res(c === 0)); } catch { res(false); } });
  if (fs.existsSync(local) && await test(local)) { _ffBin = local; return _ffBin; }
  if (await test('ffmpeg')) { _ffBin = 'ffmpeg'; return _ffBin; }
  if (process.platform === 'win32') {
    if (!_ffGetting) {
      // fire and forget: this call returns null (remux skipped) while
      // the download runs; the downloader flips _ffBin when ready
      _ffGetting = (async () => {
        try {
          const os = require('os');
          const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-'));
          const zip = path.join(tmp, 'ff.zip');
          const r = await fetch('https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip', { signal: AbortSignal.timeout(240000) });
          if (!r.ok) return;
          fs.writeFileSync(zip, Buffer.from(await r.arrayBuffer()));
          await new Promise((res, rej) => { const p = spawn('powershell', ['-NoProfile', '-Command', "Expand-Archive -LiteralPath '" + zip + "' -DestinationPath '" + tmp + "/x' -Force"], { stdio: 'ignore' }); p.on('error', rej); p.on('close', () => res()); });
          const dirs = fs.readdirSync(path.join(tmp, 'x'));
          const exe = path.join(tmp, 'x', dirs[0], 'bin', 'ffmpeg.exe');
          if (fs.existsSync(exe)) { fs.mkdirSync(path.join(__dirname, 'bin'), { recursive: true }); fs.copyFileSync(exe, local); _ffBin = local; }
        } catch { /* lane stays off */ }
      })();
    }
  }
  _ffBin = null;
  return null;
}

// v205: youtube metadata + search straight from youtube's innertube
// API on this server — no invidious/piped instance in the loop.
// instances stay as fallbacks only. thumbs come off i.ytimg directly.
const IT_WEB = { key: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', ctx: { client: { clientName: 'WEB', clientVersion: '2.20241126.01.00', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', hl: 'en', gl: 'US' } } };
async function itCall(path, body, clients) {
  for (const cl of clients) {
    try {
      const r = await fetchT('https://www.youtube.com/youtubei/v1/' + path + '?key=' + cl.key + '&prettyPrint=false', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': cl.ua }, body: JSON.stringify({ context: cl.ctx, ...body }) }, 8000);
      if (!r.ok) continue;
      const j = await r.json();
      if (j) return j;
    } catch { /* next client */ }
  }
  return null;
}
function itText(t) {
  if (!t) return '';
  if (typeof t.simpleText === 'string') return t.simpleText;
  if (Array.isArray(t.runs)) return t.runs.map(r => r.text || '').join('');
  return '';
}
function itLen(t, fallback) {
  if (typeof fallback === 'number' && fallback > 0) return fallback;
  const s = itText(t);
  if (!s) return 0;
  return s.split(':').map(x => parseInt(x, 10) || 0).reduce((a, b) => a * 60 + b, 0);
}
function collectItVideos(node, out, seen) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.videoId === 'string' && node.videoId.length >= 6 && (node.title || node.headline)) {
    if (!seen.has(node.videoId)) {
      seen.add(node.videoId);
      let thumb = '';
      const th = (node.thumbnail && node.thumbnail.thumbnails) || node.thumbnails || [];
      if (Array.isArray(th) && th.length) thumb = th[th.length - 1].url || '';
      out.push({ videoId: node.videoId, title: itText(node.title || node.headline), author: itText(node.shortBylineText || node.bylineText || node.longBylineText), lengthSeconds: itLen(node.lengthText, node.lengthSeconds), thumb });
    }
  }
  for (const k in node) collectItVideos(node[k], out, seen);
}
const ytMetaCache = new Map();
async function fetchYtMetaIt(id) {
  const c = ytMetaCache.get(id);
  if (c && Date.now() - c.at < 600e3) return c.meta;
  const clients = [IT_WEB, IT_CLIENTS[1], IT_CLIENTS[2]];
  let meta = null;
  for (const cl of clients) {
    const pj = await itCall('player', { videoId: id, contentCheckOk: true, racyCheckOk: true }, [cl]);
    if (pj && pj.videoDetails) {
      const vd = pj.videoDetails;
      const th = (vd.thumbnail && vd.thumbnail.thumbnails) || [];
      meta = { title: vd.title || '', author: vd.author || '', poster: th.length ? th[th.length - 1].url : ('https://i.ytimg.com/vi/' + id + '/hqdefault.jpg'), recs: [] };
      break;
    }
  }
  const nj = await itCall('next', { videoId: id }, clients);
  if (nj) {
    const out = [], seen = new Set([id]);
    collectItVideos(nj, out, seen);
    const recs = out.slice(0, 12);
    if (meta) meta.recs = recs;
    else if (recs.length) meta = { title: '', author: '', poster: 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg', recs };
  }
  if (meta && (meta.title || meta.recs.length)) {
    ytMetaCache.set(id, { at: Date.now(), meta });
    if (ytMetaCache.size > 80) ytMetaCache.delete(ytMetaCache.keys().next().value);
    return meta;
  }
  return null;
}
const YT_FEEDS = { trending: 'viral videos', music: 'music videos', gaming: 'gaming', news: 'news today', sports: 'sports highlights', live: 'live streams', comedy: 'stand up comedy', tech: 'tech reviews' };
const ytFeedCache = new Map();
// pull the 'next page' token out of an innertube response — it
// lives on the continuationItemRenderer at the end of the list.
// with it, search results never have to stop at one batch: the
// client keeps trading tokens for more videos, games-catalog style.
function findItCont(node, depth) {
  if (!node || typeof node !== 'object' || (depth || 0) > 20) return '';
  const cir = node.continuationItemRenderer;
  if (cir && cir.continuationEndpoint && cir.continuationEndpoint.continuationCommand && cir.continuationEndpoint.continuationCommand.token) return String(cir.continuationEndpoint.continuationCommand.token);
  for (const k in node) { const r = findItCont(node[k], (depth || 0) + 1); if (r) return r; }
  return '';
}
async function fetchYtFeed(f) {
  const q = YT_FEEDS[f]; if (!q) return null;
  const c = ytFeedCache.get(f); if (c && Date.now() - c.at < 600e3) return { vids: c.vids, cont: c.cont || '' };
  const j = await itCall('search', { query: q }, [IT_WEB, IT_CLIENTS[0], IT_CLIENTS[1]]);
  if (!j) return null;
  const out = [], seen = new Set(); collectItVideos(j, out, seen);
  if (!out.length) return null;
  const vids = out.slice(0, 24).map(v => ({ id: v.videoId, t: v.title, a: v.author, len: v.lengthSeconds, img: proxied('https://i.ytimg.com/vi/' + v.videoId + '/hqdefault.jpg') }));
  const cont = findItCont(j);
  ytFeedCache.set(f, { at: Date.now(), vids, cont });
  return { vids, cont };
}
async function fetchYtSearchIt(query, cont) {
  const body = cont ? { query, continuation: String(cont) } : { query };
  const j = await itCall('search', body, [IT_WEB, IT_CLIENTS[1], IT_CLIENTS[2]]);
  if (!j) return null;
  const out = [], seen = new Set();
  collectItVideos(j, out, seen);
  if (!out.length) return null;
  const vids = out.slice(0, 24).map(v => ({ videoId: v.videoId, title: v.title, author: v.author, lengthSeconds: v.lengthSeconds, videoThumbnails: [{ url: v.thumb || ('https://i.ytimg.com/vi/' + v.videoId + '/hqdefault.jpg'), width: 480 }] }));
  return { inst: 'https://www.youtube.com', vids, cont: findItCont(j) };
}
function pickPipedFile(d) {
  const vs = (d.videoStreams || []).filter(s => s && s.url && !s.videoOnly && /video\/mp4/.test(s.mimeType || ''));
  const q = (s) => parseInt(s.quality, 10) || 0;
  vs.sort((a, b) => q(b) - q(a));
  return vs.find(s => q(s) > 0 && q(s) <= 720) || vs.find(s => q(s) > 0) || vs[0] || null;
}
async function fetchPipedSearch(query) {
  for (const api of PIPED_APIS) {
    try {
      const r = await fetchT(api + '/search?q=' + encodeURIComponent(query) + '&filter=videos', { headers: { 'user-agent': BROWSER_UA, 'accept': 'application/json' } }, 7000);
      if (!r.ok) continue;
      const j = await r.json();
      const items = ((j && j.items) || []).filter(x => x && x.url && x.title);
      if (items.length) {
        const vids = items.map(x => ({ videoId: (String(x.url).split('v=')[1] || '').split('&')[0], title: x.title, author: x.uploaderName || '', lengthSeconds: x.duration || 0, videoThumbnails: [{ url: x.thumbnail || '', width: 480 }] })).filter(v => v.videoId);
        if (vids.length) return { inst: api, vids };
      }
    } catch { /* next backend */ }
  }
  return null;
}
const YT_INFO_CACHE = new Map();
async function fetchVideoInfo(id, bust) {
  if (!bust) { const c = YT_INFO_CACHE.get(id); if (c && Date.now() - c.at < 300e3) return c.hit; }
  // instances flap (their youtube-bypass backends restart and 500 for a
  // few seconds), so sweep the list twice with a breath between rounds
  for (let round = 0; round < 2; round++) {
    for (const inst of INVIDIOUS_API_ORDER) {
      try {
        const r = await fetchT(inst + '/api/v1/videos/' + encodeURIComponent(id) + '?local=true', {
          headers: { 'user-agent': BROWSER_UA, 'accept': 'application/json' },
        }, 6000);
        if (!r.ok) continue;
        const j = await r.json();
        if (j && ((j.adaptiveFormats || []).length || (j.formatStreams || []).length)) { const hit = { inst, data: j }; YT_INFO_CACHE.set(id, { at: Date.now(), hit }); if (YT_INFO_CACHE.size > 60) YT_INFO_CACHE.delete(YT_INFO_CACHE.keys().next().value); return hit; }
      } catch { /* next instance */ }
    }
    if (round === 0) await sleep(1500);
  }
  return null;
}
function pickStreams(d) {
  const hOf = (f) => parseInt(f.resolution) || f.height || 0;
  const vids = (d.adaptiveFormats || []).filter(f => /^video\//.test(f.type || '') && /video\/mp4/.test(f.type || ''));
  const auds = (d.adaptiveFormats || []).filter(f => /^audio\//.test(f.type || ''));
  const avc = vids.filter(f => (f.type || '').includes('avc1')).sort((a, b) => hOf(b) - hOf(a));
  const v = avc.find(f => hOf(f) <= 720) || avc[0] || vids.sort((a, b) => hOf(b) - hOf(a))[0] || null;
  const audsMp4 = auds.filter(f => /audio\/mp4/.test(f.type || '')).sort((x, y) => (y.bitrate || 0) - (x.bitrate || 0));
  const a = audsMp4[0] || auds.sort((x, y) => (y.bitrate || 0) - (x.bitrate || 0))[0] || null;
  const p = (d.formatStreams || [])[0] || null;
  return { v, a, p };
}
// ---------- yt descriptions + six's debrief (/api/ytdesc) ----------
// the watch pages were missing the whole description half of
// youtube. this pulls the real video details off innertube and has
// six write his funny debrief on it — cached a day per video.
const ytDescCache = new Map();
async function fetchYtDesc(vidId) {
  const c = ytDescCache.get(vidId);
  if (c && Date.now() - c.at < 86400e3) return c.out;
  let out = null;
  const j = await itCall('player', { videoId: vidId, contentCheckOk: true, racyCheckOk: true }, [IT_WEB, IT_CLIENTS[2], IT_CLIENTS[0]]);
  const vd = j && j.videoDetails;
  if (vd && vd.title) {
    out = { ok: true, t: String(vd.title || '').slice(0, 200), a: String(vd.author || '').slice(0, 80), views: parseInt(vd.viewCount, 10) || 0, desc: String(vd.shortDescription || '').slice(0, 6000) };
    
  }
  if (out) { ytDescCache.set(vidId, { at: Date.now(), out }); if (ytDescCache.size > 200) ytDescCache.delete(ytDescCache.keys().next().value); }
  return out;
}
function ytWatchPage(id, hit, phit) {
  // stream mode is the primary player: a muxed mp4 file relayed through
  // /yt/stream (piped proxy first) — verified actually playing in a real
  // browser. youtube's embed is the manual backup: through the proxy it
  // renders black (and bare embed urls error 153 without a referer), so
  // it only loads when the user taps for it.
  const embedSrc = gproxied('https://www.youtube-nocookie.com/embed/' + encodeURIComponent(id) + '?autoplay=1&rel=0&playsinline=1');
  const progUrl = '/yt/stream?v=' + encodeURIComponent(id) + '&kind=p';
  let title = '', poster = '', recs = '';
  if (hit) {
    const d = hit.data;
    const abs = (u) => { try { return new URL(u, hit.inst).href; } catch { return u; } };
    const thumbs = (d.videoThumbnails || []).slice().sort((a, b) => (b.width || 0) - (a.width || 0));
    title = d.title || '';
    poster = thumbs.length ? proxied(abs(thumbs[0].url)) : '';
    recs = (d.recommendedVideos || []).slice(0, 12).map(rv => {
      const t0 = (rv.videoThumbnails || [])[0];
      const img = t0 ? proxied(abs(t0.url)) : '';
      return `<a class="card" href="/yt/watch?v=${encodeURIComponent(rv.videoId)}">${img ? `<img loading="lazy" src="${img}" alt="">` : '<div class="noimg">✦</div>'}<div class="gt">${escHtml(rv.title || '')}</div></a>`;
    }).join('');
  } else if (phit) {
    const d = phit.data;
    title = d.title || '';
    poster = d.thumbnailUrl ? proxied(d.thumbnailUrl) : '';
    recs = (d.relatedStreams || []).slice(0, 12).map(rv => {
      const rid = (String(rv.url || '').split('v=')[1] || '').split('&')[0];
      if (!rid) return '';
      return `<a class="card" href="/yt/watch?v=${encodeURIComponent(rid)}">${rv.thumbnail ? `<img loading="lazy" src="${proxied(rv.thumbnail)}" alt="">` : '<div class="noimg">✦</div>'}<div class="gt">${escHtml(rv.title || '')}</div></a>`;
    }).join('');
  }
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#0a0a0b"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="6ixNetworks"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><script>if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}</script><title>Google</title><link rel="icon" href="https://www.google.com/favicon.ico">
${FONT_LINKS}<style>${GALAXY_CSS}</style></head><body>${STAR_CANVAS}
<div class="wrap">
<a class="back" href="/yt">← 6ixtube</a>
<video id="vid" controls playsinline preload="auto" ${poster ? `poster="${poster}"` : ''} style="width:100%;border-radius:18px;background:#000;aspect-ratio:16/9;margin-top:12px"></video>
<iframe id="ytembed" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen style="width:100%;aspect-ratio:16/9;border:0;border-radius:18px;background:#000;margin-top:12px;display:none"></iframe>
<div style="display:flex;gap:8px;margin:12px 2px 4px;flex-wrap:wrap;align-items:center">
<button id="modeStream" style="background:rgba(227,154,45,.25);border:1px solid rgba(255,255,255,.45);color:#f4f4f5;border-radius:999px;padding:8px 16px;cursor:pointer;font-weight:700">✦ stream mode</button>
<button id="modeEmbed" style="background:rgba(18,18,20,.92);border:1px solid rgba(255,255,255,.45);color:#f4f4f5;border-radius:999px;padding:8px 16px;cursor:pointer;font-weight:700;opacity:.65">embed player</button>
<a id="ytdl" href="${progUrl}&amp;dl=1" style="background:rgba(18,18,20,.92);border:1px solid rgba(255,255,255,.45);color:#f4f4f5;border-radius:999px;padding:8px 16px;cursor:pointer;font-weight:700;text-decoration:none;display:inline-flex;align-items:center;gap:6px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m6 11 6 6 6-6"/><path d="M4 21h16"/></svg>download</a>
<span id="ytstat" style="opacity:.75;font-size:13px">stream mode — the file itself, straight through the network</span>
</div>
<p style="margin:10px 2px 20px;font-weight:700">${escHtml(title || '')}</p>
<div id="ydesc" style="display:none;margin:2px 2px 18px;background:rgba(14,12,26,.66);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:14px 16px">
<div id="ymeta" style="color:#9d97b8;font-size:13px"></div>
<p id="ysix" style="display:none;color:#c9b8ff;font-size:14.5px;line-height:1.5;margin:10px 0 0"></p>
<p id="ydtext" style="color:#d8d4e6;font-size:14px;line-height:1.55;margin:10px 0 0;white-space:pre-wrap;word-break:break-word"></p>
<button id="ymore" type="button" style="display:none;margin-top:10px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);color:#e9e6f5;border-radius:999px;padding:7px 14px;font-weight:700;cursor:pointer;font-family:inherit;box-shadow:none">full description</button>
</div>
<div id="ytretry" style="display:none;margin:0 2px 14px;background:rgba(18,18,20,.92);border:1px solid rgba(255,255,255,.45);color:#f4f4f5;border-radius:999px;padding:10px 20px;cursor:pointer;font-weight:700;width:fit-content">✦ tap for a fresh route</div>
<div class="grid">${recs}</div>
${CLOAK_BAR}
</div>
<script src="/ui.js"></script>
<script>
var EMBED=document.getElementById('ytembed'), VID=document.getElementById('vid'), STAT=document.getElementById('ytstat'), PILL=document.getElementById('ytretry');
var PROG=${JSON.stringify(progUrl)}, EMBEDSRC=${JSON.stringify(embedSrc)};
var VIDID=${JSON.stringify(id)};
var mode='stream', retries=0, embedWatch=null, eChecks=0;
var walked = {}, stallTimer = null;
function setStat(t){ if(STAT) STAT.textContent=t; }
function tryPlay(){
  var p=VID.play();
  if(p && p.catch) p.catch(function(){ try{ VID.muted=true; var q=VID.play(); if(q && q.catch) q.catch(function(){}); }catch(e){} });
}
VID.src=PROG; tryPlay();
function toStream(){
  if(embedWatch){ clearInterval(embedWatch); embedWatch=null; }
  mode='stream';
  EMBED.style.display='none'; VID.style.display='block';
  if(!VID.getAttribute('src')){ VID.src=PROG; }
  tryPlay();
  setStat('stream mode — the file itself, straight through the network');
  document.getElementById('modeEmbed').style.opacity='.65';
  document.getElementById('modeStream').style.opacity='1';
}
function toEmbed(){
  mode='embed'; eChecks=0;
  try{ VID.pause(); }catch(e){}
  VID.style.display='none'; EMBED.style.display='block';
  if(!EMBED.getAttribute('src')) EMBED.src=EMBEDSRC;
  setStat('embed player — the normal youtube player, inside the network');
  document.getElementById('modeStream').style.opacity='.65';
  document.getElementById('modeEmbed').style.opacity='1';
  if(embedWatch) clearInterval(embedWatch);
  embedWatch=setInterval(function(){
    eChecks++;
    if(mode!=='embed'){ clearInterval(embedWatch); embedWatch=null; return; }
    if(eChecks>8){ clearInterval(embedWatch); embedWatch=null; setStat(walked.embed ? 'embed came up black too — youtube has this one locked on every route. try another video' : 'embed still black… stream mode is the one that works — tap it'); return; }
    var doc=null;
    try{ doc=EMBED.contentWindow && EMBED.contentWindow.document; }catch(e){}
    if(!doc || !doc.body) return;
    var v=doc.querySelector('video');
    if(v && (v.readyState>=2 || v.currentTime>0)){ setStat('playing ✦'); clearInterval(embedWatch); embedWatch=null; return; }
    var t=(doc.body.innerText || '').toLowerCase();
    if(t.indexOf('video is unavailable')>=0 || t.indexOf('video unavailable')>=0 || t.indexOf('sign in')>=0 || t.indexOf('configuration error')>=0 || (t.indexOf('error')>=0 && t.indexOf('occurred')>=0)){
      clearInterval(embedWatch); embedWatch=null;
      if(walked.embed) setStat('embed refused it too — youtube has this one locked on every route. try another video');
      else setStat('the embed got refused — tap stream mode, that is the one that works');
    }
  }, 2500);
}
document.getElementById('modeStream').addEventListener('click', function(){ walked={}; toStream(); });
document.getElementById('modeEmbed').addEventListener('click', function(){ walked={}; toEmbed(); });
function streamFail(){
  if(mode!=='stream') return;
  PILL.style.display='none';
  if(!walked.fresh){
    walked.fresh=1;
    setStat('stream got walled on this one — grabbing a fresh route…');
    VID.src=PROG + '&fresh=1&n=walk';
    tryPlay();
    armStall();
    return;
  }
  if(!walked.embed){
    walked.embed=1;
    setStat('youtube walled the file itself — flipping to the embed player');
    toEmbed();
    return;
  }
  setStat('youtube has this one locked on every route we tried — some videos are just walled (age/login locks). try another one');
  PILL.style.display='block';
}
function armStall(){
  if(stallTimer) clearTimeout(stallTimer);
  stallTimer=setTimeout(function(){
    if(mode==='stream' && VID.readyState<2 && !VID.error) streamFail();
  }, 14000);
}
VID.addEventListener('error', function(){
  if(mode==='stream') streamFail();
}, true);
PILL.addEventListener('click', function(){
  retries++;
  walked={};
  PILL.style.display='none';
  if(retries>2){ location.reload(); return; }
  setStat('getting a fresh route…');
  VID.src=PROG + '&fresh=1&n=' + retries;
  tryPlay();
  armStall();
});
armStall();
(function(){
  var box = document.getElementById('ydesc');
  if (!box || typeof VIDID === 'undefined') return;
  fetch('/api/ytdesc?v=' + encodeURIComponent(VIDID)).then(function(r){ return r.json(); }).then(function(o){
    if (!o || !o.ok) return;
    var meta = [];
    if (o.a) meta.push(o.a);
    if (o.views) meta.push(o.views.toLocaleString('en-US') + ' views');
    document.getElementById('ymeta').textContent = meta.join(' · ');
    if (o.six) { var sx = document.getElementById('ysix'); sx.textContent = '✦ six: ' + o.six; sx.style.display = 'block'; }
    var d = document.getElementById('ydtext'), more = document.getElementById('ymore'), full = o.desc || '';
    if (full.length > 320) {
      d.textContent = full.slice(0, 320) + '…';
      more.style.display = 'inline-block';
      more.addEventListener('click', function(){
        var open = more.textContent === 'less';
        d.textContent = open ? full.slice(0, 320) + '…' : full;
        more.textContent = open ? 'full description' : 'less';
      });
    } else d.textContent = full;
    box.style.display = 'block';
  }).catch(function(){});
})();
</script>
<script>${NOTIF_JS}</script>
</body>
</html>`;
}

function ytWatchPage2(id, hit, phit, uvUrl, meta) {
  // stream mode is the primary player: a muxed mp4 file relayed through
  // /yt/stream (piped proxy first) — verified actually playing in a real
  // browser. youtube's embed is the manual backup: through the proxy it
  // renders black (and bare embed urls error 153 without a referer), so
  // it only loads when the user taps for it.
  const embedSrc = gproxied('https://www.youtube-nocookie.com/embed/' + encodeURIComponent(id) + '?autoplay=1&rel=0&playsinline=1');
  const progUrl = '/yt/stream?v=' + encodeURIComponent(id) + '&kind=p';
  let title = '', poster = '', recs = '';
  if (hit) {
    const d = hit.data;
    const abs = (u) => { try { return new URL(u, hit.inst).href; } catch { return u; } };
    const thumbs = (d.videoThumbnails || []).slice().sort((a, b) => (b.width || 0) - (a.width || 0));
    title = d.title || '';
    poster = thumbs.length ? proxied(abs(thumbs[0].url)) : '';
    recs = (d.recommendedVideos || []).slice(0, 12).map(rv => {
      const t0 = (rv.videoThumbnails || [])[0];
      const img = t0 ? proxied(abs(t0.url)) : '';
      return `<a class="card" href="/yt/watch?v=${encodeURIComponent(rv.videoId)}">${img ? `<img loading="lazy" src="${img}" alt="">` : '<div class="noimg">✦</div>'}<div class="gt">${escHtml(rv.title || '')}</div></a>`;
    }).join('');
  } else if (phit) {
    const d = phit.data;
    title = d.title || '';
    poster = d.thumbnailUrl ? proxied(d.thumbnailUrl) : '';
    recs = (d.relatedStreams || []).slice(0, 12).map(rv => {
      const rid = (String(rv.url || '').split('v=')[1] || '').split('&')[0];
      if (!rid) return '';
      return `<a class="card" href="/yt/watch?v=${encodeURIComponent(rid)}">${rv.thumbnail ? `<img loading="lazy" src="${proxied(rv.thumbnail)}" alt="">` : '<div class="noimg">✦</div>'}<div class="gt">${escHtml(rv.title || '')}</div></a>`;
    }).join('');
  }
  if (meta) {
    title = meta.title || title;
    if (meta.poster) poster = proxied(meta.poster);
    if (meta.recs && meta.recs.length) recs = meta.recs.map(rv => `<a class="card" href="/yt/watch?v=${encodeURIComponent(rv.videoId)}"><img loading="lazy" src="${proxied('https://i.ytimg.com/vi/' + rv.videoId + '/hqdefault.jpg')}" alt=""><div class="gt">${escHtml(rv.title || '')}</div></a>`).join('');
  }
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#0a0a0b"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="6ixNetworks"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><script>if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}</script><title>Google</title><link rel="icon" href="https://www.google.com/favicon.ico">
${FONT_LINKS}<style>${GALAXY_CSS}</style></head><body>${STAR_CANVAS}
<div class="wrap">
<a class="back" href="/yt">← 6ixtube</a>
<iframe id="ytuv" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen style="width:100%;aspect-ratio:16/9;border:0;border-radius:18px;background:#000;margin-top:12px;display:none"></iframe>
<video id="vid" controls playsinline preload="auto" ${poster ? `poster="${poster}"` : ''} style="width:100%;border-radius:18px;background:#000;aspect-ratio:16/9;margin-top:12px"></video>
<iframe id="ytembed" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen style="width:100%;aspect-ratio:16/9;border:0;border-radius:18px;background:#000;margin-top:12px;display:none"></iframe>
<div style="display:flex;gap:8px;margin:12px 2px 4px;flex-wrap:wrap;align-items:center">
<button id="modeUv" style="background:rgba(18,18,20,.92);border:1px solid rgba(255,255,255,.45);color:#f4f4f5;border-radius:999px;padding:8px 16px;cursor:pointer;font-weight:700;opacity:.65">6ixtube mode</button>
<button id="modeStream" style="background:rgba(227,154,45,.25);border:1px solid rgba(255,255,255,.45);color:#f4f4f5;border-radius:999px;padding:8px 16px;cursor:pointer;font-weight:700">✦ stream mode</button>
<button id="modeEmbed" style="background:rgba(18,18,20,.92);border:1px solid rgba(255,255,255,.45);color:#f4f4f5;border-radius:999px;padding:8px 16px;cursor:pointer;font-weight:700;opacity:.65">embed player</button>
<a id="ytdl" href="${progUrl}&amp;dl=1" style="background:rgba(18,18,20,.92);border:1px solid rgba(255,255,255,.45);color:#f4f4f5;border-radius:999px;padding:8px 16px;cursor:pointer;font-weight:700;text-decoration:none;display:inline-flex;align-items:center;gap:6px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m6 11 6 6 6-6"/><path d="M4 21h16"/></svg>download</a>
<span id="ytstat" style="opacity:.75;font-size:13px">stream mode — the file itself, straight through the network</span>
</div>
<p style="margin:10px 2px 20px;font-weight:700">${escHtml(title || '')}</p>
<div id="ydesc" style="display:none;margin:2px 2px 18px;background:rgba(14,12,26,.66);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:14px 16px">
<div id="ymeta" style="color:#9d97b8;font-size:13px"></div>
<p id="ysix" style="display:none;color:#c9b8ff;font-size:14.5px;line-height:1.5;margin:10px 0 0"></p>
<p id="ydtext" style="color:#d8d4e6;font-size:14px;line-height:1.55;margin:10px 0 0;white-space:pre-wrap;word-break:break-word"></p>
<button id="ymore" type="button" style="display:none;margin-top:10px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);color:#e9e6f5;border-radius:999px;padding:7px 14px;font-weight:700;cursor:pointer;font-family:inherit;box-shadow:none">full description</button>
</div>
<div id="ytretry" style="display:none;margin:0 2px 14px;background:rgba(18,18,20,.92);border:1px solid rgba(255,255,255,.45);color:#f4f4f5;border-radius:999px;padding:10px 20px;cursor:pointer;font-weight:700;width:fit-content">✦ tap for a fresh route</div>
<div class="grid">${recs}</div>
${CLOAK_BAR}
</div>
<script src="/ui.js"></script>
<script>
var EMBED=document.getElementById('ytembed'), VID=document.getElementById('vid'), STAT=document.getElementById('ytstat'), PILL=document.getElementById('ytretry');
var PROG=${JSON.stringify(progUrl)}, EMBEDSRC=${JSON.stringify(embedSrc)};
var VIDID=${JSON.stringify(id)};
var mode='stream', retries=0, embedWatch=null, eChecks=0;
var walked = {}, stallTimer = null;
function setStat(t){ if(STAT) STAT.textContent=t; }
function tryPlay(){
  var p=VID.play();
  if(p && p.catch) p.catch(function(){ try{ VID.muted=true; var q=VID.play(); if(q && q.catch) q.catch(function(){}); }catch(e){} });
}

function toStream(){
  if(embedWatch){ clearInterval(embedWatch); embedWatch=null; }
  mode='stream';
  UVF.style.display='none'; stopWatch();
  EMBED.style.display='none'; VID.style.display='block';
  if(!VID.getAttribute('src')){ VID.src=PROG; }
  tryPlay();
  setStat('stream mode — the file itself, straight through the network');
  document.getElementById('modeEmbed').style.opacity='.65';
  document.getElementById('modeStream').style.opacity='1';
  document.getElementById('modeUv').style.opacity='.65';
}
function toEmbed(){
  mode='embed'; eChecks=0;
  UVF.style.display='none'; stopWatch();
  try{ VID.pause(); }catch(e){}
  VID.style.display='none'; EMBED.style.display='block';
  if(!EMBED.getAttribute('src')) EMBED.src=EMBEDSRC;
  setStat('embed player — the normal youtube player, inside the network');
  document.getElementById('modeStream').style.opacity='.65';
  document.getElementById('modeEmbed').style.opacity='1';
  document.getElementById('modeUv').style.opacity='.65';
  if(embedWatch) clearInterval(embedWatch);
  embedWatch=setInterval(function(){
    eChecks++;
    if(mode!=='embed'){ clearInterval(embedWatch); embedWatch=null; return; }
    if(eChecks>8){ clearInterval(embedWatch); embedWatch=null; if(walked.embed && !walked.uv){ walked.uv=1; setStat('embed came up black too — trying the full site through ur ip'); toUv(); } else if(walked.embed){ setStat('embed came up black too — youtube has this one locked on every route. try another video'); } else setStat('embed still black… stream mode is the one that works — tap it'); return; }
    var doc=null;
    try{ doc=EMBED.contentWindow && EMBED.contentWindow.document; }catch(e){}
    if(!doc || !doc.body) return;
    var v=doc.querySelector('video');
    if(v && (v.readyState>=2 || v.currentTime>0)){ setStat('playing ✦'); clearInterval(embedWatch); embedWatch=null; return; }
    var t=(doc.body.innerText || '').toLowerCase();
    if(t.indexOf('video is unavailable')>=0 || t.indexOf('video unavailable')>=0 || t.indexOf('error processing your request')>=0 || t.indexOf('sign in')>=0 || t.indexOf('configuration error')>=0 || (t.indexOf('error')>=0 && t.indexOf('occurred')>=0)){
      clearInterval(embedWatch); embedWatch=null;
      if(!walked.uv){ walked.uv=1; setStat('embed refused too — trying the full site through ur ip'); toUv(); }
      else if(walked.embed) setStat('embed refused it too — youtube has this one locked on every route. try another video');
      else setStat('the embed got refused — tap stream mode, that is the one that works');
    }
  }, 2500);
}
document.getElementById('modeStream').addEventListener('click', function(){ walked={}; toStream(); });
document.getElementById('modeEmbed').addEventListener('click', function(){ walked={}; toEmbed(); });
function streamFail(){
  if(mode!=='stream') return;
  PILL.style.display='none';
  if(!walked.fresh){
    walked.fresh=1;
    setStat('stream got walled on this one — grabbing a fresh route…');
    VID.src=PROG + '&fresh=1&n=walk';
    tryPlay();
    armStall();
    return;
  }
  if(!walked.embed){
    walked.embed=1;
    setStat('youtube walled the file itself — flipping to the embed player');
    toEmbed();
    return;
  }
  setStat('youtube has this one locked on every route we tried — some videos are just walled (age/login locks). try another one');
  PILL.style.display='block';
}
function armStall(){
  if(stallTimer) clearTimeout(stallTimer);
  stallTimer=setTimeout(function(){
    if(mode==='stream' && VID.readyState<2 && !VID.error) streamFail();
  }, 14000);
}
VID.addEventListener('error', function(){
  if(mode==='stream') streamFail();
}, true);
PILL.addEventListener('click', function(){
  retries++;
  walked={};
  PILL.style.display='none';
  if(retries>2){ location.reload(); return; }
  setStat('getting a fresh route…');
  VID.src=PROG + '&fresh=1&n=' + retries;
  tryPlay();
  armStall();
});
armStall();
VID.src=PROG; tryPlay();
(function(){
  var box = document.getElementById('ydesc');
  if (!box || typeof VIDID === 'undefined') return;
  fetch('/api/ytdesc?v=' + encodeURIComponent(VIDID)).then(function(r){ return r.json(); }).then(function(o){
    if (!o || !o.ok) return;
    var meta = [];
    if (o.a) meta.push(o.a);
    if (o.views) meta.push(o.views.toLocaleString('en-US') + ' views');
    document.getElementById('ymeta').textContent = meta.join(' · ');
    if (o.six) { var sx = document.getElementById('ysix'); sx.textContent = '✦ six: ' + o.six; sx.style.display = 'block'; }
    var d = document.getElementById('ydtext'), more = document.getElementById('ymore'), full = o.desc || '';
    if (full.length > 320) {
      d.textContent = full.slice(0, 320) + '…';
      more.style.display = 'inline-block';
      more.addEventListener('click', function(){
        var open = more.textContent === 'less';
        d.textContent = open ? full.slice(0, 320) + '…' : full;
        more.textContent = open ? 'full description' : 'less';
      });
    } else d.textContent = full;
    box.style.display = 'block';
  }).catch(function(){});
})();
</script>
<script src="/uv-assets/baremux/index.js?e=68"></script>
<script>
var UVF=document.getElementById('ytuv'), UVURL=${JSON.stringify(uvUrl)}, uvWatch=null, uvChecks=0, uvBooted=false;
function stopWatch(){ if(uvWatch){ clearInterval(uvWatch); uvWatch=null; } }
function startWatch(){
  stopWatch(); uvChecks=0;
  uvWatch=setInterval(function(){
    uvChecks++;
    if(mode!=='uv'){ stopWatch(); return; }
    if(uvChecks>14){ stopWatch(); if(walked.fresh){ setStat('youtube walled this one on every route — some videos are just locked (age/login walls). try another one'); } else { setStat('6ixtube through the engine is taking long \u2014 stream mode instead'); toStream(); } return; }
    var doc=null;
    try{ doc=UVF.contentWindow && UVF.contentWindow.document; }catch(e){}
    if(!doc || !doc.body) return;
    var v=doc.querySelector('video');
    if(v && (v.readyState>=2 || v.currentTime>0)){ setStat('playing on 6ixtube \u2726'); stopWatch(); return; }
    var t=(doc.body.innerText || '').toLowerCase();
    if(t.indexOf('sign in to confirm')>=0 || t.indexOf('video is unavailable')>=0 || t.indexOf('video unavailable')>=0 || t.indexOf('error processing your request')>=0 || t.indexOf('error processing your request')>=0){
      stopWatch(); if(walked.fresh){ setStat('youtube walled this one on every route — some videos are just locked (age/login walls). try another one'); } else { setStat('youtube walled that one through the engine \u2014 stream mode instead'); toStream(); }
    }
  }, 2500);
}
function toUv(){
  mode='uv';
  try{ VID.pause(); }catch(e){}
  VID.style.display='none'; EMBED.style.display='none'; UVF.style.display='block';
  if(embedWatch){ clearInterval(embedWatch); embedWatch=null; }
  setStat('6ixtube mode \u2014 the full site, through your ip');
  document.getElementById('modeStream').style.opacity='.65';
  document.getElementById('modeEmbed').style.opacity='.65';
  document.getElementById('modeUv').style.opacity='1';
  if(uvBooted && !UVF.getAttribute('src')) UVF.src=UVURL;
  startWatch();
}
document.getElementById('modeUv').addEventListener('click', function(){ walked={}; toUv(); });
(async function(){
  try {
    if ('serviceWorker' in navigator) {
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise(function(res){ var to=setTimeout(res, 7000); navigator.serviceWorker.addEventListener('controllerchange', function(){ clearTimeout(to); res(); }); });
    }
    var conn = new BareMux.BareMuxConnection('/uv-assets/baremux/worker.js?e=68');
    if ((await conn.getTransport()) !== '/uv-assets/epoxy/index.mjs?e=68') await conn.setTransport('/uv-assets/epoxy/index.mjs?e=68', [{ wisp: (window.GX_WISP || (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/wisp/') }]);
  } catch (e) {}
  uvBooted=true;
  if (mode==='uv' && !UVF.getAttribute('src')) { UVF.src=UVURL; startWatch(); }
})();
</script>
</body>
</html>`;
}

// ---------- the shell (/shell) ----------
// A single HTML page that IS the cloak: the whole network runs inside a
// fullscreen iframe, so the outer tab's title + favicon stay disguised
// (Google by default) on EVERY page — not just the homepage. Served at
// /shell, and exportable as a standalone file (?ext=1 bakes in the
// public server list) that can be opened from a download with the
// server running entirely in the background.
function shellPage(servers) {
  const list = servers ? JSON.stringify(servers) : 'null';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#0a0a0b"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="6ixNetworks"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><script>if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}</script>
<title>Google</title><link rel="icon" href="https://www.google.com/favicon.ico">
<style>html,body{margin:0;height:100%;height:100dvh;background:#0a0a0b;overflow:hidden}iframe{position:fixed;inset:0;width:100%;height:100%;height:100dvh;border:0}
#dot{position:fixed;right:14px;bottom:14px;z-index:9;width:30px;height:30px;border-radius:50%;border:1px solid rgba(255,255,255,.35);background:rgba(14,14,16,.55);color:#e4e4e7;opacity:.35;cursor:pointer;font-size:14px;line-height:1}
#dot:hover{opacity:1}
body.tabup #dot{bottom:120px}body.tabup #menu{bottom:160px}
#menu{position:fixed;right:14px;bottom:52px;z-index:9;display:none;flex-direction:column;gap:6px;background:rgba(11,10,20,.92);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);border:1px solid rgba(167,139,250,.35);border-radius:18px;padding:10px;box-shadow:0 18px 44px rgba(0,0,0,.55)}
#menu button{background:rgba(167,139,250,.16);color:#fff;border:1px solid rgba(255,255,255,.22);border-radius:999px;padding:8px 14px;cursor:pointer;font-size:12.5px;font-weight:700;text-align:left;font-family:system-ui}
#menu button:hover{background:rgba(167,139,250,.32)}

/* MINIMAL v146 */
.tb-logo span{background:none!important;-webkit-background-clip:initial;background-clip:initial;-webkit-text-fill-color:#e7e7ea;color:#e7e7ea;animation:none!important}
.lcard svg{color:#d9d9de!important}
.lcard:hover{border-color:rgba(255,255,255,.22)!important;box-shadow:none!important}
.card,.appRow{box-shadow:none!important}
</style></head><body>
<iframe id="f" allow="autoplay; fullscreen; gamepad; keyboard-lock; camera; microphone" allowfullscreen></iframe>
<button id="dot">✦</button>
<div id="menu">
<button onclick="disguise('google')">google</button>
<button onclick="disguise('classroom')">classroom</button>
<button onclick="disguise('docs')">docs</button>
<button onclick="disguise('drive')">drive</button>
<button onclick="panic()">panic</button>
<button onclick="blank()">about:blank</button>
</div>
<script>
var SERVERS=${list} || [location.origin + '/'];
var f=document.getElementById('f'); function fitFrame(){ if(window.visualViewport){ f.style.height = window.visualViewport.height + 'px'; } } if(window.visualViewport){ window.visualViewport.addEventListener('resize', fitFrame); window.addEventListener('orientationchange', fitFrame); fitFrame(); setTimeout(fitFrame, 350); setTimeout(fitFrame, 1200); window.addEventListener('scroll', fitFrame, { passive: true }); } 
var presets={ google:{t:'Google',i:'https://www.google.com/favicon.ico'}, classroom:{t:'Google Classroom',i:'https://ssl.gstatic.com/classroom/favicon.png'}, docs:{t:'Google Docs',i:'https://ssl.gstatic.com/docs/documents/images/kix-favicon7.ico'}, drive:{t:'My Drive - Google Drive',i:'https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_32dp.png'} };
function disguise(k){ try{ localStorage.setItem('six_disguise', k); }catch(e){} var p=presets[k]||presets.google; document.title=p.t; var l=document.querySelector("link[rel~='icon']")||document.createElement('link'); l.rel='icon'; l.href=p.i; document.head.appendChild(l); }
window.addEventListener('message', function(e){ if (e && e.data && e.data.sixCloak) disguise(e.data.sixCloak); if (e && e.data && e.data.sixChrome) document.body.classList.toggle('tabup', e.data.sixChrome === 'tabbar'); });
function panic(){ location.href='https://classroom.google.com/'; } // real classroom, top-level: google sends X-Frame-Options SAMEORIGIN so it can never load inside the frame
document.addEventListener('keydown', function(e){ if(e.keyCode===192) panic(); });
document.getElementById('dot').addEventListener('click', function(){ var m=document.getElementById('menu'); m.style.display = m.style.display==='flex' ? 'none' : 'flex'; });
function blank(){
  var src=f.src;
  var w=null;
  try{ w=window.open('about:blank','_blank'); }catch(e){}
  if(!w){ alert('ur browser blocked the popup - allow popups for this site (lock icon by the address bar, site settings, popups, allow) then hit it again'); return; }
  var tries=0;
  (function build(){
    var ok=false;
    try{
      var d=w.document;
      if(d && d.body){
        d.title='Google';
        var l=d.createElement('link'); l.rel='icon'; l.href='https://www.google.com/favicon.ico'; if(d.head) d.head.appendChild(l);
        d.body.style.margin='0';
        var fr=d.createElement('iframe');
        fr.src=src;
        fr.setAttribute('style','border:0;width:100vw;height:100vh;display:block');
        fr.setAttribute('allow','camera; microphone; autoplay; fullscreen');
        fr.setAttribute('allowfullscreen','');
        d.body.appendChild(fr);
        ok=true;
      }
    }catch(e){}
    if(ok){ location.replace('https://www.google.com/'); }
    else if(++tries<50){ setTimeout(build,60); }
    else { try{ w.close(); }catch(e){} alert('that tab wouldnt take the page - try hitting it again'); }
  })();
}
try{ var sd=localStorage.getItem('six_disguise'); if(sd && presets[sd]){ document.title=presets[sd].t; var li=document.querySelector("link[rel~='icon']"); if(li) li.href=presets[sd].i; } }catch(e){}
(function start(){
  var saved=null;
  try{ saved=localStorage.getItem('six_server'); }catch(e){}
  var cands = saved ? [saved].concat(SERVERS) : SERVERS.slice();
  var i=0;
  function next(){
    if(i>=cands.length){ f.src=cands[0]+'home'; return; }
    var base=cands[i++];
    fetch(base, { mode:'no-cors', cache:'no-store' }).then(function(){ f.src=base+'home'; }, next);
  }
  if(cands.length===1) f.src=cands[0]+'home'; else next();
})();
</script>
<script>${NOTIF_JS}</script>
</body></html>`;
}

// ---------- server ----------

// ---------- chatroom (node) + six ai ----------

// key pool: up to 4 ai studio keys (GEMINI_API_KEY + GEMINI_API_KEY2/3/4,
// or a comma list in GEMINI_API_KEYS). each key carries its OWN free
// quota, so the pool multiplies six's daily budget — when one key hits
// its limit (429/403) the next key steps in mid-request.
// key lanes (v228, his balancing call): each six surface stays on its OWN
// keys instead of the whole pool rotating thru everything — /ai page six
// lives on keys 1-2, 6ixchat six lives on key 1 (one of those same two),
// forge gets its own key (key 3 when the pool has one). small pools degrade
// gracefully: 2 keys -> forge shares key 2, 1 key -> everything shares it.

// endpoint does text only). model names verified oct 2026: 3.1 flash image
// is the current nano banana, 3 pro image is nano banana pro, 2.5 flash
// image is the original nano banana with the big free tier. first model
// that returns image bytes wins and gets remembered; workers ai (flux)
 // only these three exist (live-verified 2026-10-30); all three 429 on free keys — google gives free projects zero image quota rn


// ===== v140 game forge: six specs it, builds it, the page tests + self-fixes it =====
const GAME_SHIM = '<script>window.__gxT=0;(function(){var r=window.requestAnimationFrame;if(r){window.requestAnimationFrame=function(cb){return r.call(window,function(t){window.__gxT++;try{return cb(t)}catch(e){try{parent.postMessage({gxGameErr:String((e&&e.message)||e)},"*")}catch(_){}}})};}})();window.addEventListener("error",function(e){try{parent.postMessage({gxGameErr:String((e&&e.message)||"error")},"*")}catch(_){}});window.addEventListener("load",function(){setTimeout(function(){var painted=false;try{var c=document.querySelector("canvas");if(c){var x=c.getContext("2d");var w=c.width,h=c.height;if(x&&w&&h){var pts=[[w>>1,h>>1],[w>>2,h>>2],[3*w>>2,3*h>>2],[w>>2,3*h>>2],[3*w>>2,h>>2]];var seen={};for(var i=0;i<pts.length;i++){var d=x.getImageData(pts[i][0],pts[i][1],1,1).data;seen[d[0]+","+d[1]+","+d[2]+","+d[3]]=1;}painted=Object.keys(seen).length>1;}}}catch(e){painted=true;}try{parent.postMessage({gxGameProbe:{ticks:window.__gxT,painted:painted}},"*")}catch(_){}},1300);});</scr' + 'ipt>';


const crypto = require('crypto');
let greqSeq = 0;
// ---------- movies (cinemeta metadata — free, no key) ----------
let mvCache = {};
const BANGERS = [{"id": "tt15239678", "t": "Dune: Part Two", "y": "2024", "img": "https://images.metahub.space/poster/small/tt15239678/img"}, {"id": "tt15398776", "t": "Oppenheimer", "y": "2023", "img": "https://images.metahub.space/poster/small/tt15398776/img"}, {"id": "tt6263850", "t": "Deadpool & Wolverine", "y": "2024", "img": "https://images.metahub.space/poster/small/tt6263850/img"}, {"id": "tt1877830", "t": "The Batman", "y": "2022", "img": "https://images.metahub.space/poster/small/tt1877830/img"}, {"id": "tt1517268", "t": "Barbie", "y": "2023", "img": "https://images.metahub.space/poster/small/tt1517268/img"}, {"id": "tt6718170", "t": "The Super Mario Bros. Movie", "y": "2023", "img": "https://images.metahub.space/poster/small/tt6718170/img"}, {"id": "tt6791350", "t": "Guardians of the Galaxy Vol. 3", "y": "2023", "img": "https://images.metahub.space/poster/small/tt6791350/img"}, {"id": "tt23289160", "t": "Godzilla Minus One", "y": "2023", "img": "https://images.metahub.space/poster/small/tt23289160/img"}, {"id": "tt14230458", "t": "Poor Things", "y": "2023", "img": "https://images.metahub.space/poster/small/tt14230458/img"}, {"id": "tt6166392", "t": "Wonka", "y": "2023", "img": "https://images.metahub.space/poster/small/tt6166392/img"}, {"id": "tt14849194", "t": "The Holdovers", "y": "2023", "img": "https://images.metahub.space/poster/small/tt14849194/img"}, {"id": "tt0111161", "t": "The Shawshank Redemption", "y": "1994", "img": "https://images.metahub.space/poster/small/tt0111161/img"}, {"id": "tt0068646", "t": "The Godfather", "y": "1972", "img": "https://images.metahub.space/poster/small/tt0068646/img"}, {"id": "tt0110912", "t": "Pulp Fiction", "y": "1994", "img": "https://images.metahub.space/poster/small/tt0110912/img"}, {"id": "tt0137523", "t": "Fight Club", "y": "1999", "img": "https://images.metahub.space/poster/small/tt0137523/img"}, {"id": "tt0109830", "t": "Forrest Gump", "y": "1994", "img": "https://images.metahub.space/poster/small/tt0109830/img"}, {"id": "tt1375666", "t": "Inception", "y": "2010", "img": "https://images.metahub.space/poster/small/tt1375666/img"}, {"id": "tt0133093", "t": "The Matrix", "y": "1999", "img": "https://images.metahub.space/poster/small/tt0133093/img"}, {"id": "tt0816692", "t": "Interstellar", "y": "2014", "img": "https://images.metahub.space/poster/small/tt0816692/img"}, {"id": "tt0099685", "t": "GoodFellas", "y": "1990", "img": "https://images.metahub.space/poster/small/tt0099685/img"}, {"id": "tt0172495", "t": "Gladiator", "y": "2000", "img": "https://images.metahub.space/poster/small/tt0172495/img"}, {"id": "tt4154796", "t": "Avengers: Endgame", "y": "2019", "img": "https://images.metahub.space/poster/small/tt4154796/img"}, {"id": "tt7286456", "t": "Joker", "y": "2019", "img": "https://images.metahub.space/poster/small/tt7286456/img"}, {"id": "tt6751668", "t": "Parasite", "y": "2019", "img": "https://images.metahub.space/poster/small/tt6751668/img"}, {"id": "tt2582802", "t": "Whiplash", "y": "2014", "img": "https://images.metahub.space/poster/small/tt2582802/img"}, {"id": "tt1392190", "t": "Mad Max: Fury Road", "y": "2015", "img": "https://images.metahub.space/poster/small/tt1392190/img"}, {"id": "tt5052448", "t": "Get Out", "y": "2017", "img": "https://images.metahub.space/poster/small/tt5052448/img"}, {"id": "tt1160419", "t": "Dune", "y": "2021", "img": "https://images.metahub.space/poster/small/tt1160419/img"}, {"id": "tt9362722", "t": "Spider-Man: Across the Spider-Verse", "y": "2023", "img": "https://images.metahub.space/poster/small/tt9362722/img"}, {"id": "tt0126029", "t": "Shrek", "y": "2001", "img": "https://images.metahub.space/poster/small/tt0126029/img"}, {"id": "tt0114709", "t": "Toy Story", "y": "1995", "img": "https://images.metahub.space/poster/small/tt0114709/img"}, {"id": "tt0993846", "t": "The Wolf of Wall Street", "y": "2013", "img": "https://images.metahub.space/poster/small/tt0993846/img"}, {"id": "tt4154756", "t": "Avengers: Infinity War", "y": "2018", "img": "https://images.metahub.space/poster/small/tt4154756/img"}, {"id": "tt2380307", "t": "Coco", "y": "2017", "img": "https://images.metahub.space/poster/small/tt2380307/img"}, {"id": "tt0468569", "t": "The Dark Knight", "y": "2008", "img": "https://images.metahub.space/poster/small/tt0468569/img"}, {"id": "tt1745960", "t": "Top Gun: Maverick", "y": "2022", "img": "https://images.metahub.space/poster/small/tt1745960/img"}, {"id": "tt10366206", "t": "John Wick: Chapter 4", "y": "2023", "img": "https://images.metahub.space/poster/small/tt10366206/img"}];
// ---------- six source ranking (server-side liveness probes) ----------
// SRCS_PROBE mirrors watchPage's client SRCS array — same 11 sources,
// same order, same URL shapes. Keep the two in sync: index i here is
// index i on the watch page. {id} = imdb tt, {s}/{e} = season/episode.
const DEAD_MARKS = ['404 not found', 'video not found', 'no video', 'file not found'];
const resolveCache = new Map();
// ---------- the provider registry ----------
// Every way 6ixflix can play something is ONE module in this list.
// Adding an authorized provider = adding ONE entry here (plus its
// availability hook in streamResolve below) — the resolve API, the
// watch page and the provider badges all read from this registry,
// so nothing else has to move. mode: 'file' = a real media file
// plays in our own <video> element (the provider authorizes direct
// file access); 'api' = the provider's official player API;
// 'iframe' = the provider's own embed page in a frame.
// ---------- watch-page metadata (TMDB when keyed, cinemeta otherwise) ----------
const metaCache = new Map();
// ---------- free on youtube (official free-with-ads movies, no api key) ----------
// Discovery: YouTube search/storefront pages embed gridMovieRenderer
// objects; the free catalog titles carry a 'Free with ads' badge. Every
// candidate is verified through oEmbed (200 = exists + embeddable metadata;
// 401/404 = dropped). Seed below is oEmbed-verified the same way and only
// used if live discovery comes back thin.
const YTFREE_SEED = ['Fv1go3QpsZA', 'qvNsNOIE4CQ', 'IwVFvEaqH7E', 'r87BQKWpYZI', 't2dchDnp07c', 'lQg6T4odBcg', 'mT8c86tJj7M'];
const YTFREE_QUERIES = ['lego movie', 'scooby-doo movie', 'tom and jerry movie', 'barbie movie', 'my little pony movie', 'hot wheels movie', 'care bears movie', 'the land before time movie', 'balto movie', 'all dogs go to heaven movie'];
let ytfreeCache = { at: 0, list: [] };
let ytfreeBusy = null;
// ---------- my library (jellyfin, env-gated + dormant until configured) ----------
// Dormant by design: with JELLYFIN_URL / JELLYFIN_KEY unset this returns
// [] with NO outbound call and the movies-page row stays hidden. img is
// deliberately '' (cards render the noimg fallback) — embedding the API
// key in a proxied image URL would leak the key into page HTML.
let jellyCache = { at: 0, list: [] };
async function jellyList() {
  const base = String(process.env.JELLYFIN_URL || '').replace(/\/+$/, '');
  const key = process.env.JELLYFIN_KEY || '';
  if (!base || !key) return [];
  if (Date.now() - jellyCache.at < 300e3 && jellyCache.list.length) return jellyCache.list;
  try {
    const r = await fetch(base + '/Items?Recursive=true&IncludeItemTypes=Movie,Series&Fields=PrimaryImageAspectRatio&Limit=48', { headers: { 'X-Emby-Token': key, 'user-agent': BROWSER_UA, 'accept': 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('jelly ' + r.status);
    const j = await r.json();
    const list = (j.Items || []).map(function (it) { return { id: String(it.Id || ''), t: String(it.Name || '').slice(0, 90), y: it.ProductionYear || '', img: '', kind: 'jelly', u: base + '/web/index.html#!/details?id=' + encodeURIComponent(it.Id || '') }; }).filter(function (x) { return x.id && x.t; });
    jellyCache = { at: Date.now(), list: list };
    return list;
  } catch { return jellyCache.list; }
}
// ---------- the vault: archive.org public-domain library ----------
// six wires every vault title to its real file: browse/search run on
// the archive advancedsearch index, and /api/arc resolves an item id
// to the best streamable mp4 in its metadata. playback rides the
// same /px/ file pipe as the built-in shelf — the path that works.
let arcCache = {};
const arcFileCache = {};
async function arcFetchJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'accept': 'application/json' } });
  if (!r.ok) throw new Error('archive ' + r.status);
  return r.json();
}
// ---------- apk vault (f-droid open-source repo) ----------
const FDROID_CURATED = ['org.schabi.newpipe', 'org.videolan.vlc', 'org.mozilla.fennec_fdroid', 'com.aurora.store', 'org.xbmc.kodi', 'com.retroarch', 'com.termux', 'de.danoeh.antennapod', 'app.organicmaps', 'com.fsck.k9', 'com.beemdevelopment.aegis', 'org.fdroid.fdroid'];
let fdCache = null, fdAt = 0, fdLoading = null, fdErrAt = 0;
const FD_FS = require('fs'), FD_PATH = require('path');
const FD_DISK = FD_PATH.join(__dirname, '.fdroid-cache.json');
try { const j = JSON.parse(FD_FS.readFileSync(FD_DISK, 'utf8')); if (j && Array.isArray(j.list) && j.list.length) { fdCache = j.list; fdAt = j.at || 0; } } catch (e) {}
function fdLoc(d) { if (!d || typeof d !== 'object') return ''; return d['en-US'] || d['en'] || Object.values(d)[0] || ''; }
async function fdroidIndex() {
  if (fdCache && Date.now() - fdAt < 12 * 3600 * 1000) return fdCache;
  if (fdLoading) return fdLoading;
  fdLoading = (async () => {
    try {
      const r = await fetch('https://f-droid.org/repo/index-v2.json', { headers: { 'user-agent': BROWSER_UA }, signal: AbortSignal.timeout(90000) });
      if (!r.ok) throw new Error('fdroid ' + r.status);
      const j = await r.json();
      const out = [];
      for (const pkg of Object.keys(j.packages || {})) {
        const p = j.packages[pkg]; const md = p.metadata || {};
        const vers = Object.values(p.versions || {});
        if (!vers.length) continue;
        vers.sort((a, b) => (((b.manifest || {}).versionCode) || 0) - (((a.manifest || {}).versionCode) || 0));
        const v = vers[0]; const f = v.file || {}; const mani = v.manifest || {};
        if (!f.name) continue;
        const ic = md.icon ? fdLoc(md.icon) : null;
        out.push({
          pkg,
          name: String(fdLoc(md.name) || pkg).slice(0, 60),
          sum: String(fdLoc(md.summary) || '').slice(0, 140),
          icon: (ic && ic.name) ? proxied('https://f-droid.org/repo' + ic.name) : '',
          ver: String(mani.versionName || '').slice(0, 24),
          mb: f.size ? Math.round(f.size / 104857.6) / 10 : 0,
          dl: '/dl?u=' + b64urlEncode('https://f-droid.org/repo' + f.name)
        });
      }
      out.sort((a, b) => a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1);
      fdCache = out; fdAt = Date.now();
      try { FD_FS.writeFileSync(FD_DISK, JSON.stringify({ at: fdAt, list: fdCache })); } catch (e) {}
      return out;
    } catch (e) { fdErrAt = Date.now(); return fdCache || []; }
    finally { fdLoading = null; }
  })();
  return fdLoading;
}

async function findTt(q) {
  const raw = String(q || '').slice(0, 160);
  const m = raw.toLowerCase().match(/tt\d{6,10}/);
  if (m) {
    const id = m[0];
    for (const kind of ['movie', 'series']) {
      try {
        const r = await fetch('https://v3-cinemeta.strem.io/meta/' + kind + '/' + id + '.json', { headers: { 'user-agent': BROWSER_UA, accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
        if (r.ok) { const j = await r.json(); const meta = j && j.meta;
          if (meta && meta.name) return [{ id: id, t: String(meta.name).slice(0, 90), y: meta.year || '', img: meta.poster ? proxied(meta.poster) : '', kind: kind }]; }
      } catch { }
    }
    return [{ id: id, t: id, y: '', img: '', kind: 'movie' }];
  }
  const clean = raw.replace(/[^A-Za-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!clean) return [];
  const out = []; const seen = new Set();
  try {
    const url = 'https://v3.sg.media-imdb.com/suggestion/' + encodeURIComponent(clean.charAt(0).toLowerCase()) + '/' + encodeURIComponent(clean) + '.json';
    const r = await fetch(url, { headers: { 'user-agent': BROWSER_UA, accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
    if (r.ok) { const j = await r.json();
      for (const d of (j.d || [])) { if (!d || !String(d.id || '').startsWith('tt') || seen.has(d.id)) continue; seen.add(d.id);
        out.push({ id: d.id, t: String(d.l || '').slice(0, 90), y: d.y || '', img: d.i && d.i.imageUrl ? proxied(d.i.imageUrl) : '', kind: d.qid === 'tvSeries' ? 'series' : 'movie' }); } }
  } catch { }
  try { const cm = await cinemetaList('movie', clean, '', ''); for (const it of cm) if (!seen.has(it.id)) { seen.add(it.id); out.push(it); } } catch { }
  try { const cs = await cinemetaList('series', clean, '', ''); for (const it of cs) if (!seen.has(it.id)) { seen.add(it.id); out.push(it); } } catch { }
  return out.slice(0, 8);
}
// ---------- six runs the featured pick ----------
let sixPickMem = null;
let sixPickBusy = null;

function validAv(v) { if (v === '' || v === null || v === undefined) return ''; const s = String(v); return (/^data:image\/(png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=]+$/.test(s) && s.length <= 140000) ? s : null; }
function validHue(v) { if (v === null || v === undefined || v === '') return null; const n = parseInt(v, 10); return (isFinite(n) && n >= 0 && n <= 359) ? n : null; }
function frLists(rec) { if (!rec) return null; if (!Array.isArray(rec.friends)) rec.friends = []; if (!Array.isArray(rec.fin)) rec.fin = []; if (!Array.isArray(rec.fout)) rec.fout = []; return rec; }
function dmAccess(req, room, peerName) { if (!room || room.indexOf('dm-') !== 0) return true; const me = voterUser(req); if (!me) return false; const peer = String(peerName || '').trim().toLowerCase(); if (!peer || peer === me.toLowerCase()) return false; if (!areFriends(me.toLowerCase(), peer)) return false; return room === dmRoomFor(me, peer); }

const SEEN = new Map();
function isOnline(name) { const t = SEEN.get(String(name || '').toLowerCase()); return !!t && Date.now() - t < 120e3; }
const reqMileSeen = new Map();
function notifState(meName) {
  const lower = String(meName).toLowerCase(); const rec = ACCOUNTS.get(lower);
  const notifs = rec && Array.isArray(rec.notifs) ? rec.notifs : [];
  let call = null; const c = CALLS.get(lower);
  if (c) {
    if (Date.now() - c.ts > 45000 && c.state === 'ringing') { pushNotif(lower, { type: 'call_missed', from: c.from, fromName: c.fromName }); CALLS.delete(lower); }
    else if (c.state === 'ringing') call = { from: c.from, fromName: c.fromName, mode: c.mode, room: c.room, age: Date.now() - c.ts };
    else if (Date.now() - c.ts > 90000) CALLS.delete(lower);
  }
  let outcall = null;
  for (const [callee, cc] of CALLS) { if (cc.from === lower) { outcall = { to: callee, state: cc.state, mode: cc.mode, age: Date.now() - cc.ts }; break; } }
  const fr = frLists(rec);
  /* v182: ambient notifs (missed calls, friend accepts, request milestones) have no inbox of their own — once a poll delivers them they count as seen, otherwise the chat badge stays lit forever with nothing to open. The snapshot keeps this delivery's read flags so the one-time toast still fires; stored rows flip to read and the badge math runs after the flip. */
  const snap = notifs.map((n) => Object.assign({}, n));
  let ambDirty = false;
  for (const n of notifs) { if (!n.read && (n.type === 'call_missed' || n.type === 'friend_acc' || n.type === 'req_milestone')) { n.read = true; ambDirty = true; } }
  if (ambDirty) persistAcct(lower);
  const dmFrom = {}; let unread = 0;
  for (const n of notifs) { if (!n.read) { unread++; if (n.type === 'dm') dmFrom[n.from] = true; } }
  return { notifs: snap, unread, reqs: fr ? fr.fin.length : 0, reqFrom: fr ? fr.fin.slice() : [], dmFrom: Object.keys(dmFrom), call, outcall };
}
// ===== v113 durable store: Upstash Redis REST (env-gated, write-through) =====
function storeSet(key, val) { storeCmd([['SET', key, val]]); }
function storeDel(key) { storeCmd([['DEL', key]]); }

// ===== v139 chat history store: second Upstash DB just for chat (env-gated, write-through) =====
function wsEncode(str) {
  const p = Buffer.from(str, 'utf8'); const len = p.length; let h;
  if (len < 126) { h = Buffer.from([0x81, len]); }
  else if (len < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(len, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([h, p]);
}
const REACT_SET = ['heart', 'fire', 'laugh', 'up', 'skull'];
function chatVoiceList(roomName) { const room = chatRoomOf(roomName); const members = []; for (const p of room.peers.values()) if (p.voice) members.push({ pid: p.pid, name: p.disp || p.name }); chatBroadcast(room, { type: 'voice', members }); }
function readJsonBody(req, limit) {
  return new Promise((resolve) => {
    let b = '';
    const cap = limit || 32768;
    req.on('data', (c) => { b += c; if (b.length > cap) { try { req.destroy(); } catch {} } });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}


// ---------- proxy tunnel (wisp) + shared engine assets (node build) ----------
const UV_GZ = new Map();
let SJ_WISP = null, SJ_BAREMUX_DIR = null, SJ_EPOXY_DIR = null, SJ_WISP_IMPL = 'none';
try {
  const fs2 = require('fs'); const path2 = require('path');
  const wmod = require('@mercuryworkshop/wisp-js/server');
  SJ_WISP = wmod.server;
  try { if (wmod.logging) wmod.logging.set_level(process.env.WISP_LOG ? (wmod.logging[process.env.WISP_LOG] ?? wmod.logging.NONE) : wmod.logging.NONE); } catch (e) {}
  try { Object.assign(SJ_WISP.options, { allow_private_ips: true, allow_udp_streams: false, hostname_blacklist: [/^localhost$/, /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2[0-9]|3[01])\./, /^::1$/, /\.local$/] }); } catch (e) {}
  try { if (!SJ_WISP || typeof SJ_WISP.routeRequest !== 'function') { const wsn = require('wisp-server-node'); if (wsn && typeof wsn.routeRequest === 'function') { SJ_WISP = wsn; SJ_WISP_IMPL = 'wisp-server-node'; } } else SJ_WISP_IMPL = 'wisp-js'; } catch (e) { SJ_WISP_IMPL = 'wisp-js'; }
  try { SJ_BAREMUX_DIR = require('@mercuryworkshop/bare-mux/node').baremuxPath; } catch (e) { SJ_BAREMUX_DIR = path2.join(path2.dirname(require.resolve('@mercuryworkshop/bare-mux')), 'dist'); }
  SJ_EPOXY_DIR = (() => { const cands = []; const sep = path2.sep;
    try { const here = path2.join(__dirname, 'node_modules', '@mercuryworkshop', 'epoxy-transport'); cands.push(here + sep + 'dist', here + sep + 'lib', here); } catch (e) {}
    try { const rp = require.resolve('@mercuryworkshop/epoxy-transport'); const marker = 'node_modules/@mercuryworkshop/epoxy-transport'; const norm = rp.replace(/\\/g, '/'); const ix = norm.indexOf(marker); if (ix >= 0) { const root = norm.slice(0, ix + marker.length); cands.push(root + '/dist', root, path2.dirname(rp)); } else cands.push(path2.dirname(rp)); } catch (e) {}
    for (const c of cands) { try { if (c && fs2.existsSync(path2.join(c, 'index.mjs'))) return c; } catch (e) {} }
    return cands[0] || null; })();
  console.log('epoxy dir:', SJ_EPOXY_DIR, SJ_EPOXY_DIR ? ('index.mjs: ' + fs2.existsSync(path2.join(SJ_EPOXY_DIR, 'index.mjs'))) : 'MISSING');
  console.log('proxy tunnel ready (wisp on /wisp/, impl: ' + SJ_WISP_IMPL + ')');
} catch (e) { console.log('proxy tunnel unavailable:', e.message); }




// ---------- ultraviolet engine (node build — replaces scramjet as the rider in v57) ----------
let UV_DIR = null;
try {
  const fs3 = require('fs'); const path3 = require('path');
  UV_DIR = path3.join(path3.dirname(require.resolve('@titaniumnetwork-dev/ultraviolet/package.json')), 'dist');
  if (!fs3.existsSync(path3.join(UV_DIR, 'uv.bundle.js'))) throw new Error('uv dist missing');
  console.log('ultraviolet engine ready');
} catch (e) { console.log('ultraviolet unavailable:', e.message); }
const UV_OK = () => !!UV_DIR;
const UV_CONFIG = `self.__uv$config = {
  prefix: '/uv/service/',
  encodeUrl: Ultraviolet.codec.xor.encode,
  decodeUrl: Ultraviolet.codec.xor.decode,
  handler: '/uv-assets/uv.handler.js',
  client: '/uv-assets/uv.client.js',
  bundle: '/uv-assets/uv.bundle.js',
  config: '/uv-assets/uv.config.js',
  sw: '/uv-assets/uv.sw.js'
};
`;
const UV_SW = `importScripts("/uv-assets/uv.bundle.js");
importScripts("/uv-assets/uv.config.js");
importScripts("/uv-assets/uv.sw.js");
const __uvSw = new UVServiceWorker();
self.addEventListener("fetch", (event) => {
  if (event.request.url.startsWith(location.origin + self.__uv$config.prefix)) event.respondWith(__uvSw.fetch(event));
});
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
`;
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname.length > 1 && u.pathname.endsWith('/') && !/^\/(uv|sj|px|browse|gproxy|wisp)/.test(u.pathname)) u.pathname = u.pathname.slice(0, -1);
  const _end0 = res.end.bind(res);
  const _wh0 = res.writeHead.bind(res);
  const _wr0 = res.write.bind(res);
  let _stHead = null;
  res.writeHead = (code, ...rest) => {
    let msg = null, hdrs = {};
    for (const r of rest) { if (typeof r === 'string') msg = r; else if (r && typeof r === 'object') hdrs = r; }
    _stHead = [code, msg, hdrs];
    try { res.statusCode = code; } catch (e) {}
    return res;
  };
  const flushHead = (extra) => {
    if (!_stHead) return;
    const st = _stHead; _stHead = null;
    const merged = Object.assign({}, st[2], extra || {});
    try { if (st[1]) _wh0(st[0], st[1], merged); else _wh0(st[0], merged); } catch (e) {}
  };
  res.write = (...args) => { flushHead(); return _wr0(...args); };
  res.end = (body, ...rest) => {
    try {
      if (typeof body === 'string' && body.includes('<head>') && !body.includes('name="description"') && !META_SKIP.some((p) => u.pathname.startsWith(p))) { const hx = body.indexOf('<head>') + 6; body = body.slice(0, hx) + META_TAGS + body.slice(hx); }
      if (UV_OK() && typeof body === 'string' && body.includes('</body>') && (body.includes('action="/go"') || body.includes('href="/play?u=') || body.includes('id="askbar"'))) {
        const ix = body.lastIndexOf('</body>'); body = body.slice(0, ix) + UV_BOOT + body.slice(ix);
      }
    } catch (e) {}
    try {
      const ae = req.headers['accept-encoding'] || '';
      if (typeof body === 'string' && body.length > 2048 && res.statusCode >= 200 && res.statusCode < 300 && /\bgzip\b/.test(ae) && !res.getHeader('content-encoding') && !res.getHeader('content-length')) {
        const gz = require('zlib').gzipSync(body);
        if (gz.length < body.length) {
          if (_stHead) flushHead({ 'content-encoding': 'gzip', 'vary': 'accept-encoding' });
          else { try { res.setHeader('content-encoding', 'gzip'); res.setHeader('vary', 'accept-encoding'); } catch (e) {} }
          return _end0(gz, ...rest);
        }
      }
    } catch (e) {}
    flushHead();
    return _end0(body, ...rest);
  };
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    if (isBotReq(req)) return res.end(studyPage());
    if (/(?:^|;\s*)six_in=1(?:;|$)/.test(String(req.headers.cookie || ''))) return res.end(shellPage(null));
    return res.end(studyPage(true));
  }
  if (u.pathname === '/study') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(studyPage());
  }
  if (u.pathname === '/enter') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'set-cookie': 'six_in=1; Path=/' + cookieDomain(req) + '; Max-Age=31536000; SameSite=Lax' });
    return res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>6ix Study Tools</title></head><body><script>try{localStorage.setItem("six_gate","1")}catch(e){} location.replace("/");</script></body></html>');
  }
  if (u.pathname === '/privacy') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(privacyPage());
  }
  // scanner fork: automated visitors (filter scanners, crawlers, preview bots)
  // get the public study face on EVERY page route, not just the front door.
  // the app's machinery — apis, auth, proxy pipes, downloads, assets — is
  // exempt and answers normally; real browsers never match the bot filter.
  if (req.method === 'GET' && u.pathname !== '/' && isBotReq(req)) {
    const p = u.pathname;
    const skip = p === '/study' || p === '/privacy' || p === '/robots.txt' || p === '/sitemap.xml' || p === '/enter' || p === '/healthz' || p === '/ui.js' || p === '/cloak.js' || p === '/sw.js' || p === '/favicon.ico' || p.startsWith('/api') || p.startsWith('/auth') || p.startsWith('/go') || p.startsWith('/gproxy') || p.startsWith('/px/') || p.startsWith('/uv') || p.startsWith('/wisp') || p.startsWith('/baremux') || p.startsWith('/epoxy') || p.startsWith('/dl') || p.startsWith('/yt/stream') || p.startsWith('/icons/') || p === '/fonts.css' || p.startsWith('/font/');
    if (!skip) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(studyPage());
    }
  }
  if (u.pathname === '/robots.txt') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end('User-agent: *\nAllow: /\nAllow: /study\nAllow: /hw\nAllow: /tools\nAllow: /ai\nAllow: /space\nAllow: /privacy\nDisallow: /gs\nDisallow: /chat\nDisallow: /movies\nDisallow: /watch\nDisallow: /emu\nDisallow: /search\nDisallow: /apps\nDisallow: /requests\nDisallow: /download\nDisallow: /account\nDisallow: /u/\nDisallow: /home\nDisallow: /shell\nDisallow: /yt\nSitemap: https://' + (req.headers.host || 'localhost') + '/sitemap.xml\n');
  }
  if (u.pathname === '/sitemap.xml') {
    const host = 'https://' + (req.headers.host || 'localhost');
    const paths = ['/', '/study', '/hw', '/tools', '/ai', '/space', '/privacy'];
    res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + paths.map((p) => '<url><loc>' + host + p + '</loc></url>').join('') + '</urlset>');
  }
  if (u.pathname === '/home') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(isBotReq(req) ? studyPage() : homeServed());
  }
  if (u.pathname === '/search') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(SEARCH);
  }  if (u.pathname === '/stars.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(STARS_JS);
  }
  if (u.pathname === '/shell') {
    const servers = u.searchParams.has('ext') ? ['https://s.usareme.site/', 'https://sixsearch.deionmont1.workers.dev/'] : null;
    if (isBotReq(req)) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(studyPage()); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(shellPage(servers));
  }
    
  if (u.pathname === '/suggest') {
    const q = (u.searchParams.get('q') || '').trim();
    let out = [];
    if (q) {
      try {
        const r = await fetch('https://ac.duckduckgo.com/ac/?q=' + encodeURIComponent(q) + '&type=list', { headers: { 'user-agent': BROWSER_UA, 'accept': 'application/json' } });
        const j = await r.json();
        if (Array.isArray(j) && Array.isArray(j[1])) out = j[1].slice(0, 8).map(String);
      } catch {}
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' });
    return res.end(JSON.stringify(out));
  }
  if (u.pathname === '/manifest.webmanifest') {
    res.writeHead(200, { 'content-type': 'application/manifest+json', 'cache-control': 'public, max-age=86400' });
    return res.end(PWA_MANIFEST);
  }
  if (u.pathname === '/sw.js') {
    if (UV_OK()) { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(UV_SW); }
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(SW_JS);
  }
  if (u.pathname === '/icon-512.png' || u.pathname === '/icon-192.png' || u.pathname === '/apple-touch-icon.png') {
    const b64 = u.pathname === '/icon-512.png' ? ICON_512 : u.pathname === '/icon-192.png' ? ICON_192 : ICON_180;
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=604800' });
    return res.end(Buffer.from(b64, 'base64'));
  }
  if (u.pathname === '/ui.js' || u.pathname === '/cloak.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    return res.end(CLOAK_JS);
  }
  const ACCT_PAGES = { '/ai': 'six ai', '/chat': '6ixchat', '/chat/call': '6ixchat calls', '/forge': 'the game forge', '/hw': 'hw helper' };
  
  
  
  
  
  
  
  
  
  
  
  

  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  if (u.pathname === '/api/shortcuts') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false })); }
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  if (u.pathname === '/emu') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(emuPage());
  }
  
  
  if (u.pathname === '/api/games') {
    const games = FEATURED_GAMES.concat(await loadGames());
    const out = games.map(g => ({ t: g.t, u: g.u, img: g.img ? proxied(g.img) : '', icon: g.icon || '', lg: g.lg ? 1 : 0, c: g.c || 'Arcade' }));
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=600' });
    return res.end(JSON.stringify(out));
  }
  if (u.pathname === '/gs') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(gamesPage());
  }
  if (u.pathname === '/apps') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(appsPage());
  }
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  if (u.pathname === '/play') {
    if (UV_OK() && u.searchParams.get('u')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(playPageUv(u.searchParams.get('u') || '', u.searchParams.get('t') || 'Game')); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(playPage(u.searchParams.get('u') || '', u.searchParams.get('t') || 'Game'));
  }
  if (u.pathname === '/appplay') {
    if (u.searchParams.get('u') && isVdHost(u.searchParams.get('u'))) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(appPlayPage(u.searchParams.get('u') || '', u.searchParams.get('t') || 'App')); }
    if (UV_OK() && u.searchParams.get('u')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(appPlayPageUv(u.searchParams.get('u') || '', u.searchParams.get('t') || 'App')); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(appPlayPage(u.searchParams.get('u') || '', u.searchParams.get('t') || 'App'));
  }
  if (u.pathname === '/api/ytfeed') {
    const feed = await fetchYtFeed(u.searchParams.get('f') || 'trending');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(JSON.stringify({ ok: !!feed, vids: feed ? feed.vids : [], cont: feed ? feed.cont : '' }));
  }
  if (u.pathname === '/api/ytmore') {
    const mf = String(u.searchParams.get('f') || '');
    const mq = mf ? (YT_FEEDS[mf] || '') : String(u.searchParams.get('q') || '').slice(0, 100);
    const mc = String(u.searchParams.get('c') || '').slice(0, 2400);
    let mout = { ok: false, vids: [], cont: '' };
    if (mq && mc) {
      const hit = await fetchYtSearchIt(mq, mc);
      if (hit) mout = { ok: true, vids: hit.vids.map(v => ({ id: v.videoId, t: v.title, a: v.author, len: v.lengthSeconds, img: proxied('https://i.ytimg.com/vi/' + v.videoId + '/hqdefault.jpg') })), cont: hit.cont || '' };
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(JSON.stringify(mout));
  }
  if (u.pathname === '/api/ytdesc') {
    const dv = String(u.searchParams.get('v') || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16);
    const dout = dv ? await fetchYtDesc(dv) : null;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(JSON.stringify(dout || { ok: false }));
  }
  if (u.pathname === '/yt') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(YT_HOME);
  }
  if (u.pathname === '/yt/watch') {
    const vidId = (u.searchParams.get('v') || '').trim();
    if (!vidId) { res.writeHead(302, { location: '/yt' }); return res.end(); }
    // metadata is decoration now (title, poster, up next) — the embed
    // player does not need it, so a dead metadata backend no longer
    // kills the watch page; it renders with whatever resolved
    const meta = await fetchYtMetaIt(vidId);
    const hit = meta ? null : await fetchVideoInfo(vidId);
    const phit = (meta || hit) ? null : await fetchPipedStreams(vidId);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    const uvUrl = UV_OK() ? '/uv/service/' + uvEncodeUrl('https://www.youtube.com/watch?v=' + vidId) : null;
    return res.end(uvUrl ? ytWatchPage2(vidId, hit, phit, uvUrl, meta) : ytWatchPage(vidId, hit, phit));
  }
  if (u.pathname === '/yt/stream') {
    const vidId = (u.searchParams.get('v') || '').trim();
    const kind = u.searchParams.get('kind') || 'v'; const wantDl = u.searchParams.get('dl') === '1';
    if (!vidId) { res.writeHead(502); return res.end('stream unavailable'); }
    const range = req.headers['range'];
    if (kind === 'p') {
      // v270 downloader lanes: remux (ffmpeg merges the 720p video +
      // audio tracks into ONE mp4 while it streams — nothing saved)
      // or file (a single muxed mp4 relayed with full range/seek).
      // both were probe-validated by ytResolve before we commit.
      const wantFresh = u.searchParams.get('fresh') === '1';
      const tried = new Set();
      for (let round = 0; round < 5; round++) {
        const hit2 = await ytResolve(vidId, wantFresh || round > 0, tried);
        if (!hit2) break;
        if (hit2.lane === 'file') {
          try {
            const up = await fetch(hit2.muxed.url, { headers: { 'user-agent': hit2.ua, ...(range ? { range } : {}) }, signal: AbortSignal.timeout(20000) });
            if (up.status === 200 || up.status === 206) {
              const hh = { 'cache-control': 'no-store' };
              for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) { const v = up.headers.get(h); if (v && !(h === 'content-length' && up.headers.get('content-encoding'))) hh[h] = v; }
              if (wantDl && up.status === 200) { const nm = String(hit2.title || '').replace(/[^\w \-\.]/g, '').trim().slice(0, 80); hh['content-disposition'] = 'attachment; filename="' + (nm || ('video-' + vidId)) + '.mp4"'; }
              res.writeHead(up.status, hh);
              if (up.body) await new Promise(done => pipeline(Readable.fromWeb(up.body), res, () => done()));
              return;
            }
            tried.add('file:' + hit2.client);
          } catch { tried.add('file:' + hit2.client); /* next lane / round / legacy chain */ }
        } else if (hit2.lane === 'remux') {
          const bin = await ffmpegBin();
          if (bin) {
            const { spawn } = require('child_process');
            const hh = { 'content-type': 'video/mp4', 'cache-control': 'no-store' };
            if (wantDl) { const nm = String(hit2.title || '').replace(/[^\w \-\.]/g, '').trim().slice(0, 80); hh['content-disposition'] = 'attachment; filename="' + (nm || ('video-' + vidId)) + '.mp4"'; }
            const ff = spawn(bin, ['-loglevel', 'error', '-rw_timeout', '20000000', '-user_agent', hit2.ua, '-i', hit2.pair.v.url, '-user_agent', hit2.ua, '-i', hit2.pair.a.url, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
            res.on('close', () => { try { ff.kill('SIGKILL'); } catch { } });
            // v273: the probe fetches with plain http — ffmpeg is a
            // different animal and some pairs die in its hands. never
            // commit the response until ffmpeg itself produces bytes;
            // a dead lane gets excluded and the walk tries the next.
            const firstChunk = await new Promise(done => {
              let settled = false;
              const to = setTimeout(() => { if (!settled) { settled = true; done(null); } }, 12000);
              ff.stdout.once('data', (chunk) => { if (!settled) { settled = true; clearTimeout(to); try { ff.stdout.pause(); } catch { } done(chunk); } });
              ff.on('error', () => { if (!settled) { settled = true; clearTimeout(to); done(null); } });
              ff.on('close', () => { if (!settled) { settled = true; clearTimeout(to); done(null); } });
            });
            if (firstChunk && firstChunk.length) {
              res.writeHead(200, hh);
              res.write(firstChunk);
              await new Promise(done => pipeline(ff.stdout, res, () => done()));
              try { ff.kill('SIGKILL'); } catch { }
              return;
            }
            try { ff.kill('SIGKILL'); } catch { }
            tried.add('remux:' + hit2.client);
            itFileCache.delete(vidId);
          }
        }
      }
      // legacy instance chain (piped file, then invidious below)
      for (let round = 0; round < 2; round++) {
        const ph = await fetchPipedStreams(vidId, wantFresh || round === 1);
        const pf = ph ? pickPipedFile(ph.data) : null;
        if (!pf) break;
        try {
          const up = await fetch(pf.url, { headers: { 'user-agent': BROWSER_UA, ...(range ? { range } : {}) } });
          if (up.status === 200 || up.status === 206) {
            const hh = {};
            for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) { const v = up.headers.get(h); if (v && !(h === 'content-length' && up.headers.get('content-encoding'))) hh[h] = v; }
            if (wantDl && up.status === 200) { const nm = String((ph && ph.data && ph.data.title) || '').replace(/[^\w \-\.]/g, '').trim().slice(0, 80); hh['content-disposition'] = 'attachment; filename="' + (nm || ('video-' + vidId)) + '.mp4"'; }
            res.writeHead(up.status, hh);
            if (up.body) { const reader = up.body.getReader(); while (true) { const { done, value } = await reader.read(); if (done) break; res.write(Buffer.from(value)); } }
            return res.end();
          }
        } catch { /* retry fresh once, then fall through */ }
      }
    }
    let hit = await fetchVideoInfo(vidId);
    for (let attempt = 0; attempt < 2; attempt++) {
      const fmt = hit ? pickStreams(hit.data)[kind] : null;
      if (!fmt) break;
      let absUrl; try { absUrl = new URL(fmt.url, hit.inst).href; } catch { absUrl = fmt.url; }
      try {
        const up = await fetch(absUrl, { headers: { 'user-agent': BROWSER_UA, ...(range ? { range } : {}) } });
        if ((up.status === 403 || up.status === 500 || up.status === 502) && attempt === 0) { hit = await fetchVideoInfo(vidId, true); continue; }
        const hh = {};
        for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) { const v = up.headers.get(h); if (v && !(h === 'content-length' && up.headers.get('content-encoding'))) hh[h] = v; }
        res.writeHead(up.status, hh);
        if (up.body) { const reader = up.body.getReader(); while (true) { const { done, value } = await reader.read(); if (done) break; res.write(Buffer.from(value)); } }
        return res.end();
      } catch { if (attempt === 0) { hit = await fetchVideoInfo(vidId, true); continue; } }
    }
    res.writeHead(502); return res.end('stream unavailable');
  }
  if (u.pathname === '/yt/search') {
    return handleYtSearch(req, res, u.searchParams.get('q') || '');
  }
  if (u.pathname === '/go') {
    const dest = normalizeInput(u.searchParams.get('q') || '');
    if (!dest) { res.writeHead(302, { location: '/home' }); return res.end(); }
    if (u.searchParams.get('classic') === '1') { res.writeHead(302, { location: proxied(dest) }); return res.end(); }
    if (isVdHost(dest)) { res.writeHead(302, { location: '/appplay?u=' + encodeURIComponent(dest) + '&t=' + encodeURIComponent(new URL(dest).hostname.replace(/^www\./, '')) }); return res.end(); }
    if (UV_OK()) { res.writeHead(302, { location: '/uv/service/' + uvEncodeUrl(dest) }); return res.end(); }
    res.writeHead(302, { location: proxied(dest) });
    return res.end();
  }
  if (u.pathname === '/fonts.css') {
    try {
      if (!fontCssCache.css || Date.now() - fontCssCache.at > 86400e3) {
        const r = await fetchT('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap', { headers: { 'user-agent': BROWSER_UA, 'accept': 'text/css,*/*' } }, 8000);
        if (!r.ok) throw new Error('fonts ' + r.status);
        let css = await r.text();
        css = css.replace(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g, (m, u2) => 'url(/font/' + b64urlEncode(u2) + ')');
        fontCssCache = { css, at: Date.now() };
      }
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=86400' });
      return res.end(fontCssCache.css);
    } catch { res.writeHead(200, { 'content-type': 'text/css' }); return res.end(''); }
  }
  if (u.pathname.startsWith('/font/')) {
    let target = '';
    try { target = b64urlDecode(u.pathname.slice(6)); } catch { }
    let tu = null;
    try { tu = new URL(target); } catch { }
    if (!tu || tu.hostname !== 'fonts.gstatic.com' || tu.protocol !== 'https:') { res.writeHead(404); return res.end('nf'); }
    const hitF = fontFileCache.get(target);
    if (hitF) { res.writeHead(200, { 'content-type': hitF.ct, 'cache-control': 'public, max-age=31536000, immutable' }); return res.end(hitF.buf); }
    try {
      const r = await fetchT(target, { headers: { 'user-agent': BROWSER_UA } }, 8000);
      if (!r.ok) { res.writeHead(502); return res.end('font upstream'); }
      const buf = Buffer.from(await r.arrayBuffer());
      const ct = r.headers.get('content-type') || 'font/woff2';
      fontFileCache.set(target, { buf, ct });
      if (fontFileCache.size > 40) fontFileCache.delete(fontFileCache.keys().next().value);
      res.writeHead(200, { 'content-type': ct, 'cache-control': 'public, max-age=31536000, immutable' });
      return res.end(buf);
    } catch { res.writeHead(502); return res.end('font upstream'); }
  }
  if (u.pathname.startsWith('/px/')) {
    const rest = u.pathname.slice('/px/'.length);
    const slash = rest.indexOf('/');
    let base = null;
    if (slash > 0) { try { base = b64urlDecode(rest.slice(0, slash)); } catch {} }
    if (!base || !/^https:\/\//i.test(base)) { res.writeHead(400, { 'content-type': 'text/plain' }); return res.end('bad prefix path'); }
    if (!base.endsWith('/')) base += '/';
    let targetStr = base + rest.slice(slash + 1);
    if (u.search) targetStr += u.search;
    return handleProxy(req, res, targetStr, false);
  }
  if (u.pathname.startsWith('/gproxy/')) {
    const encoded = u.pathname.slice('/gproxy/'.length);
    let targetStr;
    try { targetStr = b64urlDecode(encoded); } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      return res.end('bad proxy path');
    }
    if (u.search) targetStr += (targetStr.includes('?') ? '&' : '?') + u.search.slice(1);
    return handleProxy(req, res, targetStr, true);
  }
  if (u.pathname.startsWith('/browse/')) {
    const encoded = u.pathname.slice('/browse/'.length);
    let targetStr;
    try { targetStr = b64urlDecode(encoded); } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      return res.end('bad proxy path');
    }
    // keep any query string the browser appended
    if (u.search) targetStr += (targetStr.includes('?') ? '&' : '?') + u.search.slice(1);
    return handleProxy(req, res, targetStr);
  }
  if (u.pathname === '/uv-test') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end('<!doctype html><meta charset="utf-8"><title>uv test</title><div id="out">running</div>' +
    '<script src="/uv-assets/baremux/index.js?e=68"></' + 'script>' +
    '<script>' +
    'var out = document.getElementById("out");' +
    'function log(t) { var d = document.createElement("div"); d.textContent = t; out.appendChild(d); }' +
    '(async function() {' +
    '  try {' +
    '    var conn = new BareMux.BareMuxConnection("/uv-assets/baremux/worker.js?e=68");' +
    '    await conn.setTransport("/uv-assets/epoxy/index.mjs?e=68", [{ wisp: (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + "/wisp/" }]);' +
    '    log("transport set ok");' +
    '    var client = new BareMux.BareClient();' +
    '    var r = await client.fetch("https://example.com/");' +
    '    log("bareclient fetch status: " + r.status);' +
    '    var t = await r.text();' +
    '    log("body head: " + t.slice(0, 120));' +
    '  } catch (e) { log("BARECLIENT ERROR: " + (e && e.stack || e)); }' +
    '})();' +
    '</' + 'script>');
  }
  if (u.pathname.startsWith('/uv/service/')) {
    const target = uvDecodeUrl(u.pathname.slice('/uv/service/'.length));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(uvWarmPage(target));
  }
  if (u.pathname === '/uv' || u.pathname === '/sj') {
    const dest = normalizeInput(u.searchParams.get('url') || '');
    if (UV_OK() && dest) { res.writeHead(302, { location: '/uv/service/' + uvEncodeUrl(dest) }); return res.end(); }
    res.writeHead(302, { location: '/home' });
    return res.end();
  }
  if (u.pathname.startsWith('/uv-assets/')) {
    const rel = u.pathname.slice('/uv-assets/'.length);
    const seg = rel.split('/')[0];
    let kind, file;
    if (seg === 'baremux' || seg === 'epoxy') { kind = seg; file = rel.slice(seg.length + 1); }
    else { kind = 'uv'; file = rel; }
    if (kind === 'uv' && file === 'uv.config.js' && UV_OK()) { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(UV_CONFIG); }
    const base = kind === 'baremux' ? SJ_BAREMUX_DIR : kind === 'epoxy' ? SJ_EPOXY_DIR : UV_DIR;
    if (!base || !file || file.includes('..')) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    const fsx = require('fs'); const pathx = require('path');
    const fp = pathx.join(base, file);
    if (!fp.startsWith(base) || !fsx.existsSync(fp)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    const ext = pathx.extname(fp).toLowerCase();
    const mime = ext === '.wasm' ? 'application/wasm' : ext === '.json' ? 'application/json' : ext === '.map' ? 'application/json' : 'text/javascript; charset=utf-8';
    const extra = (kind === 'uv' && file === 'uv.sw.js') ? { 'service-worker-allowed': '/' } : {};
    const hdrs = { 'content-type': mime, 'cache-control': (file === 'uv.sw.js' ? 'no-cache' : 'public, max-age=31536000, immutable'), 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-resource-policy': 'same-origin', ...extra };
    // v232 uv speed: these files rode the tunnel RAW (epoxy is 1.7MB) — now
    // gzipped from a small in-memory cache (same bytes, ~60-75% less wire).
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '') && /\.(js|mjs|json|wasm|map)$/.test(fp)) {
      try {
        const zlibx = require('zlib');
        const st = fsx.statSync(fp);
        let c = UV_GZ.get(fp);
        if (!c || c.m !== st.mtimeMs) { c = { m: st.mtimeMs, buf: zlibx.gzipSync(fsx.readFileSync(fp), { level: 6 }) }; UV_GZ.set(fp, c); if (UV_GZ.size > 40) UV_GZ.clear(); }
        res.writeHead(200, { ...hdrs, 'content-encoding': 'gzip', 'content-length': c.buf.length, 'vary': 'accept-encoding' });
        return res.end(c.buf);
      } catch (e) { /* fall through to the raw stream */ }
    }
    res.writeHead(200, hdrs);
    return fsx.createReadStream(fp).pipe(res);
  }
  if (u.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }
  if (u.pathname === '/wisp-test') {
    if (!/\bsix_in=/.test(req.headers.cookie || '')) { res.writeHead(403, { 'content-type': 'text/plain' }); return res.end('nope'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    const stage = { impl: SJ_WISP_IMPL, step: 'start' };
    let done = false;
    const finish = (obj) => { if (done) return; done = true; try { res.end(JSON.stringify(Object.assign(stage, obj))); } catch (e) {} };
    setTimeout(() => finish({ ok: false, timeout: true }), 12000);
    try {
      const wc = require('@mercuryworkshop/wisp-js/client');
      const CC = wc.ClientConnection || (wc.client && wc.client.ClientConnection);
      if (!CC) { stage.keys = Object.keys(wc || {}); return finish({ ok: false, step: 'no-client-export' }); }
      const conn = new CC('ws://127.0.0.1:' + PORT + '/wisp/');
      conn.onopen = () => {
        stage.step = 'wisp-open';
        let st;
        try { st = conn.create_stream('example.com', 80, 1); } catch (e) { return finish({ ok: false, err: 'create_stream: ' + e.message }); }
        let got = '';
        st.onmessage = (d) => { try { got += Buffer.from(d).toString('latin1'); } catch (e) {} if (got.length > 80) finish({ ok: got.indexOf('Example Domain') >= 0 || got.indexOf('HTTP/') === 0, step: 'stream-data', bytes: got.length, head: got.slice(0, 90) }); };
        st.onclose = (r) => finish({ ok: false, step: 'stream-close', reason: r, bytes: got.length });
        st.send(new TextEncoder().encode('GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n'));
        stage.step = 'get-sent';
      };
    } catch (e) { stage.err = String((e && e.message) || e); return finish({ ok: false, step: 'threw' }); }
    return;
  }
  res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>404 — 6net lite</title><style>' + GALAXY_CSS + '</style></head><body><div style="text-align:center;max-width:440px;margin:auto;padding:32px 20px"><svg width="46" height="46" viewBox="0 0 24 24" fill="rgb(var(--star))" aria-hidden="true"><path d="M12 2l2.3 7.7L22 12l-7.7 2.3L12 22l-2.3-7.7L2 12l7.7-2.3z"/></svg><h1 style="font-size:68px;margin:10px 0 2px">404</h1><p class="sub" style="margin-bottom:26px">this page is not on the network.<br>six checked everywhere. everywhere.</p><div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap"><a href="/home" style="background:#fafafa;color:#0a0a0b;padding:12px 22px;border-radius:12px;font-weight:700;text-decoration:none;font-size:15px">go home</a><a href="/gs" style="background:#17171a;color:#f4f4f5;border:1px solid rgba(255,255,255,.16);padding:12px 22px;border-radius:12px;font-weight:700;text-decoration:none;font-size:15px">play games</a></div></div></body></html>');
});

// v208: generic websocket proxy for proxied pages — the shim rewrites
// ws/wss urls on classic-proxy pages to /wsx?u=<b64 target>, and the
// upstream socket is opened HERE so the traffic exits this server's ip
// like everything else. private/loopback targets refused (ssrf guard).
const { WebSocketServer: WsxServer, WebSocket: WsxClient } = require('ws');
const wsxServer = new WsxServer({ noServer: true, handleProtocols: (protos) => (protos && protos.length ? protos[0] : false) });
function handleWsx(req, socket, head) {
  let target = '';
  try { target = b64urlDecode(new URL(req.url, 'http://x').searchParams.get('u') || ''); } catch { socket.destroy(); return; }
  let tu = null;
  try { tu = new URL(target); } catch { }
  if (!tu || !/^wss?:$/.test(tu.protocol) || isPrivateHost(tu.hostname)) { socket.destroy(); return; }
  const wsUrl = tu.href;
  const protoHdr = req.headers['sec-websocket-protocol'];
  const protos = protoHdr ? protoHdr.split(',').map(s => s.trim()).filter(Boolean) : [];
  wsxServer.handleUpgrade(req, socket, head, (down) => {
    const up = new WsxClient(wsUrl, protos.length ? protos : undefined, { headers: { 'user-agent': BROWSER_UA, origin: (tu.protocol === 'wss:' ? 'https://' : 'http://') + tu.host } });
    const queued = [];
    let open = false;
    down.on('message', (data, isBinary) => { if (open) { try { up.send(data, { binary: isBinary }); } catch { } } else queued.push([data, isBinary]); });
    up.on('open', () => { open = true; for (const [d, b] of queued) { try { up.send(d, { binary: b }); } catch { } } });
    up.on('message', (data, isBinary) => { try { down.send(data, { binary: isBinary }); } catch { } });
    const kill = () => { try { down.close(); } catch { } try { up.close(); } catch { } };
    up.on('close', kill); down.on('close', kill);
    up.on('error', kill); down.on('error', kill);
  });
}
server.on('upgrade', (req, socket, head) => {
  try { const p = new URL(req.url, 'http://x').pathname; if (SJ_WISP && p.startsWith('/wisp')) return SJ_WISP.routeRequest(req, socket, head); if (p === '/wsx') return handleWsx(req, socket, head); } catch (e) {}
  socket.destroy(); return;
});
server.keepAliveTimeout = 75000; server.headersTimeout = 80000;
server.listen(PORT, () => console.log('6net lite listening on ' + PORT));
loadGames().catch(() => {});
