const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());

// Keep-alive
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  setInterval(() => fetch(RENDER_URL + '/ping').catch(() => {}), 14 * 60 * 1000);
}
app.get('/ping', (_, res) => res.send('pong'));

// ── Helpers ───────────────────────────────────────────────────
function toProxyUrl(val, base) {
  if (!val) return val;
  const t = val.trim();
  if (t.startsWith('data:') || t.startsWith('javascript:') || t.startsWith('#') ||
      t.startsWith('mailto:') || t.startsWith('tel:') || t.startsWith('blob:') ||
      t.startsWith('/proxy?') || t.startsWith('/search?')) return t;
  try {
    const abs = new URL(t, base).href;
    if (!abs.startsWith('http')) return t;
    return `/proxy?url=${encodeURIComponent(abs)}`;
  } catch { return t; }
}

function rewriteCSS(css, base) {
  if (!css) return css;
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, q, url) => {
    const p = toProxyUrl(url.trim(), base);
    return `url(${q}${p}${q})`;
  });
}

// ── DuckDuckGo Search ─────────────────────────────────────────
app.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json({ results: [] });
  try {
    const r = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=es-es`,
      { headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'Referer': 'https://duckduckgo.com/',
      }}
    );
    const html = await r.text();
    const $ = cheerio.load(html);
    const results = [];
    $('.result:not(.result--ad)').each((i, el) => {
      if (i >= 12) return false;
      const titleEl = $(el).find('.result__title a');
      const snippet = $(el).find('.result__snippet').text().trim();
      const displayUrl = $(el).find('.result__url').text().trim();
      const title = titleEl.text().trim();
      const rawHref = titleEl.attr('href') || '';
      let url = '';
      try {
        const u = new URL('https://duckduckgo.com' + rawHref);
        url = u.searchParams.get('uddg') || u.searchParams.get('u') || rawHref;
        if (url.startsWith('//')) url = 'https:' + url;
      } catch { url = rawHref; }
      if (title && url && url.startsWith('http') && !url.includes('duckduckgo.com'))
        results.push({ title, snippet, url, display: displayUrl });
    });
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message, results: [] });
  }
});

// ── Web Proxy GET ─────────────────────────────────────────────
app.get('/proxy', async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).send('Missing url');

  let targetUrl;
  try {
    targetUrl = decodeURIComponent(rawUrl);
    if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;
    new URL(targetUrl);
  } catch { return res.status(400).send('Invalid URL'); }

  const BLOCKED = ['spotify.com','instagram.com','tiktok.com','facebook.com','twitter.com','x.com'];
  const parsed = new URL(targetUrl);
  if (BLOCKED.some(d => parsed.hostname.includes(d)))
    return res.send(blockedPage(targetUrl, parsed.hostname));

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
        'Referer': parsed.origin,
        'Origin': parsed.origin,
      },
      redirect: 'follow',
    });

    const ct = upstream.headers.get('content-type') || '';
    const finalUrl = upstream.url || targetUrl;
    const finalOrigin = new URL(finalUrl).origin;

    const strip = () => {
      ['x-frame-options','content-security-policy','x-content-type-options',
       'strict-transport-security','permissions-policy'].forEach(h => res.removeHeader(h));
      res.set('Access-Control-Allow-Origin', '*');
    };

    // CSS
    if (ct.includes('text/css')) {
      strip();
      res.set('Content-Type', 'text/css; charset=utf-8');
      res.send(rewriteCSS(await upstream.text(), finalUrl));
      return;
    }

    // JS — rewrite hardcoded absolute URLs inside scripts
    if (ct.includes('javascript') || ct.includes('ecmascript')) {
      strip();
      res.set('Content-Type', 'application/javascript; charset=utf-8');
      let js = await upstream.text();
      // Rewrite absolute URLs in string literals inside JS
      js = js.replace(/(["'`])(https?:\/\/[^"'`\s]{4,})\1/g, (match, q, url) => {
        try {
          new URL(url);
          // Skip data URLs and already-proxied
          if (url.includes('/proxy?url=')) return match;
          return `${q}/proxy?url=${encodeURIComponent(url)}${q}`;
        } catch { return match; }
      });
      res.send(js);
      return;
    }

    // Binary / images / fonts / media
    if (!ct.includes('text/html') && !ct.includes('application/xhtml')) {
      strip();
      res.set('Content-Type', ct);
      upstream.body.pipe(res);
      return;
    }

    // ── HTML ──────────────────────────────────────────────────
    const html = await upstream.text();
    const $ = cheerio.load(html);

    // Kill security meta tags
    $('meta[http-equiv]').each((_, el) => {
      const v = ($(el).attr('http-equiv') || '').toLowerCase();
      if (v === 'x-frame-options' || v === 'content-security-policy') $(el).remove();
    });

    // Remove frame-busting inline scripts
    $('script:not([src])').each((_, el) => {
      const code = $(el).html() || '';
      if (/top\s*[!=]=\s*(self|window)|top\.location|self\.location|parent\.location|window\.top\s*!==\s*window/i.test(code))
        $(el).remove();
    });

    // Rewrite <a href>
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (/^(mailto:|tel:|#|javascript:)/.test(href)) return;
      try {
        const abs = new URL(href, finalUrl).href;
        if (abs.startsWith('http')) $(el).attr('href', `/proxy?url=${encodeURIComponent(abs)}`);
      } catch {}
    });

    // Rewrite all src attributes (img, script, iframe, audio, video, source, track)
    $('[src]').each((_, el) => {
      const src = $(el).attr('src');
      if (!src) return;
      const p = toProxyUrl(src, finalUrl);
      if (p !== src) $(el).attr('src', p);
    });

    // Rewrite <video poster>
    $('video[poster]').each((_, el) => {
      const v = $(el).attr('poster');
      const p = toProxyUrl(v, finalUrl);
      if (p !== v) $(el).attr('poster', p);
    });

    // Rewrite <source src> and <source srcset> (video/audio/picture)
    $('source').each((_, el) => {
      const src = $(el).attr('src');
      if (src) { const p = toProxyUrl(src, finalUrl); if (p !== src) $(el).attr('src', p); }
      const srcset = $(el).attr('srcset');
      if (srcset) {
        const rw = srcset.replace(/([^\s,]+)(\s+[^\s,]+)?/g, (m, u, d) => {
          if (!u || u.startsWith('data:')) return m;
          try { return `/proxy?url=${encodeURIComponent(new URL(u, finalUrl).href)}${d||''}`; }
          catch { return m; }
        });
        $(el).attr('srcset', rw);
      }
    });

    // Rewrite <track src> (subtitles/captions)
    $('track[src]').each((_, el) => {
      const v = $(el).attr('src');
      const p = toProxyUrl(v, finalUrl);
      if (p !== v) $(el).attr('src', p);
    });

    // Rewrite <link href>
    $('link[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const p = toProxyUrl(href, finalUrl);
      if (p !== href) $(el).attr('href', p);
    });

    // Rewrite srcset
    $('[srcset]').each((_, el) => {
      const rewritten = ($(el).attr('srcset') || '').replace(/([^\s,]+)(\s+[^\s,]+)?/g, (m, u, d) => {
        if (!u || u.startsWith('data:')) return m;
        try { return `/proxy?url=${encodeURIComponent(new URL(u, finalUrl).href)}${d||''}`; }
        catch { return m; }
      });
      $(el).attr('srcset', rewritten);
    });

    // Rewrite <form action>
    $('form').each((_, el) => {
      const action = $(el).attr('action');
      if (action) {
        try {
          const abs = new URL(action, finalUrl).href;
          $(el).attr('action', `/proxy?url=${encodeURIComponent(abs)}`);
        } catch {}
      }
    });

    // Rewrite inline style url()
    $('[style]').each((_, el) => {
      const s = $(el).attr('style') || '';
      const r = rewriteCSS(s, finalUrl);
      if (r !== s) $(el).attr('style', r);
    });

    // Rewrite <style> blocks
    $('style').each((_, el) => {
      const css = $(el).html() || '';
      const r = rewriteCSS(css, finalUrl);
      if (r !== css) $(el).html(r);
    });

    // Rewrite lazy-load attributes
    ['data-src','data-href','data-lazy','data-original','data-url'].forEach(attr => {
      $(`[${attr}]`).each((_, el) => {
        const v = $(el).attr(attr);
        if (!v) return;
        const p = toProxyUrl(v, finalUrl);
        if (p !== v) $(el).attr(attr, p);
      });
    });

    // Rewrite <meta> refresh
    $('meta[http-equiv="refresh"]').each((_, el) => {
      const content = $(el).attr('content') || '';
      const m = content.match(/^(\d+;\s*url=)(.+)$/i);
      if (m) {
        try {
          const abs = new URL(m[2].trim(), finalUrl).href;
          $(el).attr('content', `${m[1]}/proxy?url=${encodeURIComponent(abs)}`);
        } catch {}
      }
    });

    // Rewrite background= attribute
    $('[background]').each((_, el) => {
      const v = $(el).attr('background');
      const p = toProxyUrl(v, finalUrl);
      if (p !== v) $(el).attr('background', p);
    });

    // ── Inject interceptor script (first in <head>) ──────────
    const interceptor = buildInterceptor(finalUrl, finalOrigin);
    if ($('head').length) $('head').prepend(interceptor);
    else $.root().prepend(interceptor);

    strip();
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send($.html());

  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(500).send(errorPage(targetUrl, err.message));
  }
});

// ── Web Proxy POST (form submissions) ────────────────────────
app.post('/proxy', express.urlencoded({ extended: true }), async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).send('Missing url');
  let targetUrl;
  try {
    targetUrl = decodeURIComponent(rawUrl);
    if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;
  } catch { return res.status(400).send('Invalid URL'); }
  try {
    const parsed = new URL(targetUrl);
    const upstream = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 Chrome/122.0.0.0 Safari/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': parsed.origin,
        'Origin': parsed.origin,
      },
      body: new URLSearchParams(req.body).toString(),
      redirect: 'follow',
    });
    if (upstream.redirected) {
      return res.redirect(`/proxy?url=${encodeURIComponent(upstream.url)}`);
    }
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(await upstream.text());
  } catch (err) {
    res.status(500).send(errorPage(targetUrl, err.message));
  }
});

// ── Interceptor script ────────────────────────────────────────
function buildInterceptor(finalUrl, finalOrigin) {
  const b = finalUrl.replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/`/g,'\\`');
  const o = finalOrigin.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
  return `<script>
(function(){
  var BASE='${b}';
  var ORIGIN='${o}';

  try{
    Object.defineProperty(window,'top',{get:function(){return window;},configurable:true});
    Object.defineProperty(window,'parent',{get:function(){return window;},configurable:true});
    Object.defineProperty(window,'frameElement',{get:function(){return null;},configurable:true});
  }catch(e){}

  function toAbs(href){
    if(!href||/^(javascript:|mailto:|tel:|#|blob:)/.test(href)) return null;
    try{return new URL(href,BASE).href;}catch(e){return null;}
  }
  function nav(url){
    var a=toAbs(url);
    if(!a) return;
    try{window.top.postMessage({type:'MP_NAV',url:a},'*');}catch(e){}
  }

  // Smart click interceptor — does NOT block UI clicks, only navigation
  document.addEventListener('click',function(e){
    // Never intercept canvas/iframe (games use these)
    var t=e.target;
    if(!t) return;
    if(t.tagName==='CANVAS'||t.tagName==='IFRAME'||t.tagName==='VIDEO'||t.tagName==='BUTTON'||t.tagName==='INPUT') return;

    // Walk up DOM to find closest <a>
    var el=t;
    while(el&&el.tagName!=='A') el=el.parentElement;
    if(!el) return;

    var href=el.getAttribute('href')||'';

    // Skip: no href, anchors, javascript:, already proxied links
    if(!href||/^(javascript:|#)/.test(href)||href.startsWith('/proxy?')) return;

    // Skip: links that have onclick (JS handles them)
    if(el.onclick||el.getAttribute('onclick')) return;

    // Skip: links with role="button" (UI elements)
    if(el.getAttribute('role')==='button') return;

    var a=toAbs(href);
    if(!a) return;

    // Only intercept cross-origin links — same-origin hrefs already rewritten by server
    try{
      var dest=new URL(a);
      var here=new URL(location.href);
      if(dest.hostname===here.hostname) return;
    }catch(ex){}

    e.preventDefault();
    e.stopPropagation();
    nav(a);
  },true);

  // window.open
  var _open=window.open;
  window.open=function(url,target,features){
    var a=toAbs(url);
    if(a){nav(a);return{focus:function(){},blur:function(){},closed:false,postMessage:function(){}};}
    return _open.apply(this,arguments);
  };

  // fetch
  var _fetch=window.fetch;
  if(_fetch) window.fetch=function(input,init){
    try{
      var url=typeof input==='string'?input:(input&&input.url?input.url:null);
      if(url){
        var abs=toAbs(url);
        if(abs&&!abs.startsWith(location.origin)){
          var px='/proxy?url='+encodeURIComponent(abs);
          input=typeof input==='string'?px:new Request(px,input);
        }
      }
    }catch(e){}
    return _fetch.call(this,input,init);
  };

  // XMLHttpRequest
  var _xhrOpen=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,url){
    try{
      if(typeof url==='string'){
        var abs=toAbs(url);
        if(abs&&!abs.startsWith(location.origin))
          url='/proxy?url='+encodeURIComponent(abs);
      }
    }catch(e){}
    var args=Array.prototype.slice.call(arguments);
    args[1]=url;
    return _xhrOpen.apply(this,args);
  };

  // location.assign / replace
  try{
    window.location.assign=function(u){nav(u);};
    window.location.replace=function(u){nav(u);};
  }catch(e){}

  // history.pushState / replaceState
  var _ps=history.pushState.bind(history);
  var _rs=history.replaceState.bind(history);
  history.pushState=function(s,t,u){
    if(u){try{window.top.postMessage({type:'MP_URL',url:new URL(u,BASE).href},'*');}catch(e){}}
    return _ps.apply(this,arguments);
  };
  history.replaceState=function(s,t,u){
    if(u){try{window.top.postMessage({type:'MP_URL',url:new URL(u,BASE).href},'*');}catch(e){}}
    return _rs.apply(this,arguments);
  };

  // MutationObserver — fix lazy-loaded resources added by JS
  new MutationObserver(function(ms){
    ms.forEach(function(m){
      m.addedNodes.forEach(function(n){
        if(n.nodeType!==1) return;
        ['src','data-src','data-lazy','data-original'].forEach(function(a){
          if(!n.hasAttribute||!n.hasAttribute(a)) return;
          var v=n.getAttribute(a);
          if(v&&v.startsWith('http')&&!v.startsWith(location.origin))
            n.setAttribute(a,'/proxy?url='+encodeURIComponent(v));
        });
        if(n.querySelectorAll) n.querySelectorAll('[data-src],[data-lazy],[data-original]').forEach(function(el){
          ['data-src','data-lazy','data-original'].forEach(function(a){
            var v=el.getAttribute(a);
            if(v&&v.startsWith('http')&&!v.startsWith(location.origin))
              el.setAttribute(a,'/proxy?url='+encodeURIComponent(v));
          });
        });
      });
    });
  }).observe(document.documentElement,{childList:true,subtree:true});

  // Unregister service workers
  if(navigator.serviceWorker){
    navigator.serviceWorker.getRegistrations().then(function(r){
      r.forEach(function(sw){sw.unregister();});
    }).catch(function(){});
  }

  // Report title to parent
  function report(){
    try{window.top.postMessage({type:'MP_TITLE',title:document.title,url:BASE},'*');}catch(e){}
  }
  document.addEventListener('DOMContentLoaded',report);
  window.addEventListener('load',report);
  setTimeout(report,800);
})();
<\/script>`;
}

function blockedPage(url, hostname) {
  return `<!DOCTYPE html><html><head><title>Blocked</title>
  <style>body{font-family:monospace;padding:60px 40px;background:#07070f;color:#eeeef5;max-width:540px;margin:0 auto;text-align:center}
  h2{color:#e94560;margin-bottom:12px}.icon{font-size:48px;margin-bottom:20px}p{color:#9a9abf;line-height:1.7}
  .url{background:#13132a;padding:8px 14px;border-radius:6px;color:#f5a623;font-size:12px;margin:16px 0;display:inline-block;word-break:break-all}
  a{color:#4d9de0}.tip{background:#0f1a2e;border:1px solid #1e3a5f;border-radius:8px;padding:14px 16px;margin-top:20px;text-align:left;font-size:13px;color:#6b9fcf;line-height:1.6}
  </style></head><body>
  <div class="icon">🔒</div><h2>Blocked by ${hostname}</h2>
  <div class="url">${url}</div>
  <p>This site enforces anti-proxy protection at the server level. No proxy can bypass it.</p>
  <div class="tip">💡 Spotify, Instagram, TikTok, Facebook and X all block proxies. Open them directly in a new tab.</div>
  <br><br><a href="javascript:history.back()">← Go back</a></body></html>`;
}

function errorPage(url, msg) {
  return `<!DOCTYPE html><html><head><title>Error</title>
  <style>body{font-family:monospace;padding:60px 40px;background:#07070f;color:#eeeef5;max-width:540px;margin:0 auto}
  h2{color:#e94560}p{color:#9a9abf;line-height:1.6}.url{background:#13132a;padding:8px 14px;border-radius:6px;color:#00d4aa;word-break:break-all;margin:12px 0;display:block;font-size:12px}
  .err{background:#1a0808;border:1px solid #e94560;padding:10px 14px;border-radius:6px;color:#e94560;margin:12px 0;font-size:13px}a{color:#4d9de0}
  </style></head><body>
  <h2>⚠ Proxy Error</h2><span class="url">${url}</span>
  <div class="err">${msg}</div>
  <p>The site may block proxies, require login, or be unavailable.</p>
  <a href="javascript:history.back()">← Go back</a></body></html>`;
}

app.listen(PORT, () => console.log('Maths Proxy v4 on port ' + PORT));
