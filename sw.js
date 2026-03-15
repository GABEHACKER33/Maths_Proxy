// Maths Proxy — Service Worker v5
// Intercepts ALL fetch requests from proxied pages and routes them through /bare/

const SW_VERSION = '5.0.0';
const PROXY_PREFIX = '/browse/';
const BARE_URL = '/bare/';

// ── URL encoding/decoding ─────────────────────────────────────
function encodeUrl(url) {
  return btoa(unescape(encodeURIComponent(url)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function decodeUrl(encoded) {
  try {
    const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 ? b64 + '='.repeat(4 - b64.length % 4) : b64;
    return decodeURIComponent(escape(atob(pad)));
  } catch { return null; }
}

function isProxied(url) {
  return url.pathname.startsWith(PROXY_PREFIX);
}

function extractTarget(url) {
  const encoded = url.pathname.slice(PROXY_PREFIX.length);
  if (!encoded) return null;
  return decodeUrl(encoded);
}

function proxyUrl(target) {
  return PROXY_PREFIX + encodeUrl(target);
}

function rewriteUrl(url, base) {
  if (!url) return url;
  const t = url.trim();
  if (t.startsWith('data:') || t.startsWith('blob:') || t.startsWith('javascript:') ||
      t.startsWith('#') || t.startsWith('mailto:') || t.startsWith('tel:')) return t;
  // Already proxied
  if (t.startsWith(PROXY_PREFIX)) return t;
  try {
    const abs = new URL(t, base).href;
    if (!abs.startsWith('http')) return t;
    return proxyUrl(abs);
  } catch { return t; }
}

// ── Install & activate ────────────────────────────────────────
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// ── Main fetch interceptor ────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Only intercept proxied routes
  if (!isProxied(url)) return;

  e.respondWith(handleProxied(e.request, url));
});

async function handleProxied(request, url) {
  const target = extractTarget(url);
  if (!target) return new Response('Invalid proxy URL', { status: 400 });

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return new Response('Invalid target URL', { status: 400 });
  }

  try {
    // Build fetch headers — spoof origin/referer
    const headers = new Headers();
    const skipReq = new Set(['host','connection','transfer-encoding','te','upgrade',
      'proxy-authorization','proxy-connection','trailer']);

    for (const [k, v] of request.headers.entries()) {
      if (skipReq.has(k.toLowerCase())) continue;
      if (k.toLowerCase() === 'referer') {
        // Rewrite referer to target origin
        try {
          const refUrl = new URL(v);
          if (refUrl.pathname.startsWith(PROXY_PREFIX)) {
            const refTarget = extractTarget(refUrl);
            if (refTarget) {
              headers.set('referer', refTarget);
              continue;
            }
          }
        } catch {}
      }
      if (k.toLowerCase() === 'origin') {
        headers.set('origin', targetUrl.origin);
        continue;
      }
      headers.set(k, v);
    }

    headers.set('user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36');
    headers.set('host', targetUrl.host);

    const body = ['GET','HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();

    const upstream = await fetch(targetUrl.href, {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
      credentials: 'omit',
    });

    // Handle redirects
    if ([301,302,303,307,308].includes(upstream.status)) {
      const loc = upstream.headers.get('location');
      if (loc) {
        const newTarget = new URL(loc, targetUrl.href).href;
        return Response.redirect(proxyUrl(newTarget), upstream.status);
      }
    }

    const ct = upstream.headers.get('content-type') || '';

    // Build response headers — strip security headers
    const resHeaders = new Headers();
    const skipRes = new Set(['x-frame-options','content-security-policy',
      'x-content-type-options','strict-transport-security','permissions-policy',
      'cross-origin-opener-policy','cross-origin-embedder-policy',
      'cross-origin-resource-policy','transfer-encoding','connection']);

    for (const [k, v] of upstream.headers.entries()) {
      if (skipRes.has(k.toLowerCase())) continue;
      if (k.toLowerCase() === 'location') continue; // handled above
      if (k.toLowerCase() === 'set-cookie') {
        // Rewrite cookie domain
        resHeaders.append('set-cookie', v.replace(/domain=[^;]+;?/gi, '').replace(/secure;?/gi, ''));
        continue;
      }
      resHeaders.set(k, v);
    }

    resHeaders.set('access-control-allow-origin', '*');

    // HTML — rewrite
    if (ct.includes('text/html') || ct.includes('application/xhtml')) {
      const html = await upstream.text();
      const rewritten = rewriteHTML(html, targetUrl.href);
      resHeaders.set('content-type', 'text/html; charset=utf-8');
      resHeaders.delete('content-length');
      return new Response(rewritten, { status: upstream.status, headers: resHeaders });
    }

    // CSS — rewrite url()
    if (ct.includes('text/css')) {
      const css = await upstream.text();
      const rewritten = rewriteCSS(css, targetUrl.href);
      resHeaders.set('content-type', 'text/css; charset=utf-8');
      resHeaders.delete('content-length');
      return new Response(rewritten, { status: upstream.status, headers: resHeaders });
    }

    // JS — pass through (interceptor handles runtime)
    if (ct.includes('javascript') || ct.includes('ecmascript')) {
      const js = await upstream.text();
      resHeaders.delete('content-length');
      return new Response(js, { status: upstream.status, headers: resHeaders });
    }

    // Everything else — stream through
    return new Response(upstream.body, { status: upstream.status, headers: resHeaders });

  } catch (err) {
    return new Response(`Proxy Error: ${err.message}`, {
      status: 502,
      headers: { 'content-type': 'text/plain' }
    });
  }
}

// ── HTML rewriter ─────────────────────────────────────────────
function rewriteHTML(html, base) {
  // Inject interceptor script + rewrite static attributes
  let result = html;

  // Rewrite href on <a>, <link>
  result = result.replace(/(<(?:a|link)[^>]*?\s)href\s*=\s*(['"])(.*?)\2/gi, (m, pre, q, url) => {
    return `${pre}href=${q}${rewriteUrl(url, base)}${q}`;
  });

  // Rewrite src on img, script, iframe, source, input, audio, video, track
  result = result.replace(/(<(?:img|script|iframe|source|input|audio|video|track|embed)[^>]*?\s)src\s*=\s*(['"])(.*?)\2/gi, (m, pre, q, url) => {
    return `${pre}src=${q}${rewriteUrl(url, base)}${q}`;
  });

  // Rewrite action on forms
  result = result.replace(/(<form[^>]*?\s)action\s*=\s*(['"])(.*?)\2/gi, (m, pre, q, url) => {
    return `${pre}action=${q}${rewriteUrl(url, base)}${q}`;
  });

  // Rewrite srcset
  result = result.replace(/srcset\s*=\s*(['"])(.*?)\1/gi, (m, q, srcset) => {
    const rw = srcset.replace(/([^\s,]+)(\s+[^\s,]+)?/g, (sm, u, d) => {
      if (!u || u.startsWith('data:')) return sm;
      return rewriteUrl(u, base) + (d || '');
    });
    return `srcset=${q}${rw}${q}`;
  });

  // Rewrite inline style url()
  result = result.replace(/style\s*=\s*(['"])(.*?)\1/gi, (m, q, style) => {
    return `style=${q}${rewriteCSS(style, base)}${q}`;
  });

  // Rewrite <style> blocks
  result = result.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, open, css, close) => {
    return open + rewriteCSS(css, base) + close;
  });

  // Rewrite data-src, data-href, data-lazy, data-original
  result = result.replace(/\b(data-(?:src|href|lazy|original|url|bg))\s*=\s*(['"])(.*?)\2/gi, (m, attr, q, url) => {
    return `${attr}=${q}${rewriteUrl(url, base)}${q}`;
  });

  // Rewrite meta refresh
  result = result.replace(/(<meta[^>]*?http-equiv\s*=\s*['"]refresh['"][^>]*?content\s*=\s*['"][^'"]*?url=)(.*?)(['"])/gi,
    (m, pre, url, q) => pre + rewriteUrl(url, base) + q);

  // Remove CSP and X-Frame-Options meta tags
  result = result.replace(/<meta[^>]*http-equiv\s*=\s*['"](?:content-security-policy|x-frame-options)['"][^>]*>/gi, '');

  // Remove frame-busting scripts
  result = result.replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, (m, code) => {
    if (/top\s*[!=]=\s*(self|window)|top\.location|self\.location|parent\.location|window\.top\s*!==\s*window/i.test(code)) {
      return '';
    }
    return m;
  });

  // Inject the runtime interceptor before </head> or at start of <body>
  const interceptor = buildInterceptor(base);
  if (result.includes('</head>')) {
    result = result.replace('</head>', interceptor + '</head>');
  } else if (result.includes('<body')) {
    result = result.replace(/<body[^>]*>/, m => m + interceptor);
  } else {
    result = interceptor + result;
  }

  return result;
}

// ── CSS rewriter ──────────────────────────────────────────────
function rewriteCSS(css, base) {
  if (!css) return css;
  // Rewrite url(...) references
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, url) => {
    const rw = rewriteUrl(url.trim(), base);
    return `url(${q}${rw}${q})`;
  })
  // Rewrite @import "..."
  .replace(/@import\s+(['"])(.*?)\1/gi, (m, q, url) => {
    return `@import ${q}${rewriteUrl(url, base)}${q}`;
  });
}

// ── Runtime interceptor injected into every page ──────────────
function buildInterceptor(base) {
  const safeBase = base.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
  return `<script>
(function(){
  var __BASE = \`${safeBase}\`;
  var __PFX = '${PROXY_PREFIX}';

  function enc(url){ return btoa(unescape(encodeURIComponent(url))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,''); }
  function toAbs(href){
    if(!href||/^(javascript:|mailto:|tel:|#|blob:|data:)/.test(href)) return null;
    try{ return new URL(href,__BASE).href; }catch(e){ return null; }
  }
  function px(url){ var a=toAbs(url); return a?__PFX+enc(a):url; }
  function nav(url){
    var a=toAbs(url);
    if(!a) return;
    try{ window.top.postMessage({type:'MP_NAV',url:a},'*'); }catch(e){}
  }

  // Anti frame-bust
  try{
    Object.defineProperty(window,'top',{get:function(){return window;},configurable:true});
    Object.defineProperty(window,'parent',{get:function(){return window;},configurable:true});
    Object.defineProperty(window,'frameElement',{get:function(){return null;},configurable:true});
  }catch(e){}

  // Smart click interceptor
  document.addEventListener('click',function(e){
    var t=e.target;
    if(!t||t.tagName==='CANVAS'||t.tagName==='VIDEO'||t.tagName==='BUTTON'||t.tagName==='INPUT') return;
    var el=t;
    while(el&&el.tagName!=='A') el=el.parentElement;
    if(!el) return;
    var href=el.getAttribute('href')||'';
    if(!href||/^(javascript:|#)/.test(href)) return;
    if(el.onclick||el.getAttribute('onclick')) return;
    if(el.getAttribute('role')==='button') return;
    var a=toAbs(href);
    if(!a) return;
    try{
      var dest=new URL(a);
      var here=new URL(location.href);
      if(dest.hostname===here.hostname) return;
    }catch(ex){}
    e.preventDefault(); e.stopPropagation();
    nav(a);
  },true);

  // window.open
  var _open=window.open;
  window.open=function(url){ var a=toAbs(url); if(a){nav(a);return{focus:function(){},closed:false,postMessage:function(){}};} return _open.apply(this,arguments); };

  // fetch
  var _fetch=window.fetch;
  if(_fetch) window.fetch=function(input,init){
    try{
      if(typeof input==='string'&&input.startsWith('http')&&!input.startsWith(location.origin))
        input=px(input);
      else if(input&&input.url&&input.url.startsWith('http')&&!input.url.startsWith(location.origin))
        input=new Request(px(input.url),input);
    }catch(e){}
    return _fetch.call(this,input,init);
  };

  // XHR
  var _xo=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,url){
    try{ if(typeof url==='string'&&url.startsWith('http')&&!url.startsWith(location.origin)) url=px(url); }catch(e){}
    var a=Array.prototype.slice.call(arguments); a[1]=url;
    return _xo.apply(this,a);
  };

  // location
  try{ window.location.assign=function(u){nav(u);}; window.location.replace=function(u){nav(u);}; }catch(e){}

  // history
  var _ps=history.pushState.bind(history),_rs=history.replaceState.bind(history);
  history.pushState=function(s,t,u){ if(u)try{window.top.postMessage({type:'MP_URL',url:new URL(u,__BASE).href},'*');}catch(e){} return _ps.apply(this,arguments); };
  history.replaceState=function(s,t,u){ if(u)try{window.top.postMessage({type:'MP_URL',url:new URL(u,__BASE).href},'*');}catch(e){} return _rs.apply(this,arguments); };

  // MutationObserver for lazy-loaded content
  new MutationObserver(function(ms){
    ms.forEach(function(m){
      m.addedNodes.forEach(function(n){
        if(n.nodeType!==1) return;
        ['src','data-src','data-lazy','data-original'].forEach(function(a){
          if(!n.hasAttribute||!n.hasAttribute(a)) return;
          var v=n.getAttribute(a);
          if(v&&v.startsWith('http')&&!v.startsWith(location.origin)) n.setAttribute(a,px(v));
        });
      });
    });
  }).observe(document.documentElement,{childList:true,subtree:true});

  // Unregister other service workers that might interfere
  if(navigator.serviceWorker){
    navigator.serviceWorker.getRegistrations().then(function(regs){
      regs.forEach(function(r){ if(!r.scope.includes(location.origin)) r.unregister(); });
    }).catch(function(){});
  }

  // Report title
  function report(){ try{window.top.postMessage({type:'MP_TITLE',title:document.title,url:__BASE},'*');}catch(e){} }
  document.addEventListener('DOMContentLoaded',report);
  window.addEventListener('load',report);
  setTimeout(report,500);
})();
<\/script>`;
}
