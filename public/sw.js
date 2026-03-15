// Maths Proxy Service Worker v5
// All requests go through the server's /bare/ endpoint — no direct fetches from browser

const PROXY_PREFIX = '/browse/';

function encodeUrl(url) {
  return btoa(unescape(encodeURIComponent(url)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function decodeUrl(enc) {
  try {
    const b = enc.replace(/-/g, '+').replace(/_/g, '/');
    const p = b.length % 4 ? b + '='.repeat(4 - b.length % 4) : b;
    return decodeURIComponent(escape(atob(p)));
  } catch { return null; }
}

function proxyUrl(target) {
  return PROXY_PREFIX + encodeUrl(target);
}

function rewriteUrl(url, base) {
  if (!url) return url;
  const t = url.trim();
  if (t.startsWith('data:') || t.startsWith('blob:') || t.startsWith('javascript:') ||
      t.startsWith('#') || t.startsWith('mailto:') || t.startsWith('tel:') ||
      t.startsWith(PROXY_PREFIX)) return t;
  try {
    const abs = new URL(t, base).href;
    if (!abs.startsWith('http')) return t;
    return proxyUrl(abs);
  } catch { return t; }
}

// ── Install & activate ────────────────────────────────────────
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// ── Fetch intercept ───────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (!url.pathname.startsWith(PROXY_PREFIX)) return;
  e.respondWith(handleRequest(e.request, url));
});

async function handleRequest(request, url) {
  // Decode target URL from path
  const encoded = url.pathname.slice(PROXY_PREFIX.length);
  const target = decodeUrl(encoded);
  if (!target) return errorPage('Invalid proxy URL');

  let targetUrl;
  try { targetUrl = new URL(target); }
  catch { return errorPage('Invalid target URL'); }

  try {
    // ── Route through our server /bare/ endpoint ──────────────
    // This is the key fix: browser → our server → target site
    // Avoids ALL CORS issues since the server makes the request

    const bareUrl = '/bare/?url=' + encodeURIComponent(targetUrl.href);

    // Build headers to pass to bare server
    const headers = new Headers();
    headers.set('x-bare-url', targetUrl.href);
    headers.set('x-bare-method', request.method);

    // Forward original request headers encoded
    const fwdHeaders = {};
    const skip = new Set(['host','connection','transfer-encoding','te','trailer','upgrade']);
    for (const [k, v] of request.headers.entries()) {
      if (skip.has(k.toLowerCase())) continue;
      if (k.toLowerCase() === 'referer') {
        // Rewrite referer back to real URL
        try {
          const refU = new URL(v);
          if (refU.pathname.startsWith(PROXY_PREFIX)) {
            const refDec = decodeUrl(refU.pathname.slice(PROXY_PREFIX.length));
            if (refDec) { fwdHeaders['referer'] = refDec; continue; }
          }
        } catch {}
      }
      if (k.toLowerCase() === 'origin') { fwdHeaders['origin'] = targetUrl.origin; continue; }
      fwdHeaders[k] = v;
    }
    fwdHeaders['host'] = targetUrl.host;
    headers.set('x-bare-headers', JSON.stringify(fwdHeaders));

    const body = ['GET','HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();

    const upstream = await fetch(bareUrl, {
      method: 'POST',
      headers,
      body,
    });

    if (!upstream.ok && upstream.status !== 200) {
      const text = await upstream.text();
      return errorPage('Server error: ' + text);
    }

    const data = await upstream.json();

    // Handle redirects
    if (data.__redirect) {
      const newTarget = new URL(data.location, targetUrl.href).href;
      return Response.redirect(proxyUrl(newTarget), 302);
    }

    // Get the actual response
    const { status, headers: resHdrs, body: resBody, contentType } = data;
    const ct = contentType || '';

    const outHeaders = new Headers();
    if (resHdrs) {
      for (const [k, v] of Object.entries(resHdrs)) {
        const kl = k.toLowerCase();
        if (['x-frame-options','content-security-policy','x-content-type-options',
             'strict-transport-security','permissions-policy',
             'cross-origin-opener-policy','cross-origin-embedder-policy',
             'cross-origin-resource-policy'].includes(kl)) continue;
        if (kl === 'set-cookie') {
          outHeaders.append('set-cookie', v.replace(/domain=[^;]+;?/gi,'').replace(/secure;?/gi,''));
          continue;
        }
        try { outHeaders.set(k, v); } catch {}
      }
    }
    outHeaders.set('access-control-allow-origin', '*');

    // Decode body from base64
    let bodyBuf;
    try { bodyBuf = Uint8Array.from(atob(resBody), c => c.charCodeAt(0)); }
    catch { bodyBuf = new Uint8Array(0); }

    const bodyText = new TextDecoder('utf-8', { fatal: false }).decode(bodyBuf);

    // HTML
    if (ct.includes('text/html') || ct.includes('application/xhtml')) {
      const rewritten = rewriteHTML(bodyText, targetUrl.href);
      outHeaders.set('content-type', 'text/html; charset=utf-8');
      outHeaders.delete('content-length');
      return new Response(rewritten, { status: status || 200, headers: outHeaders });
    }

    // CSS
    if (ct.includes('text/css')) {
      const rewritten = rewriteCSS(bodyText, targetUrl.href);
      outHeaders.set('content-type', 'text/css; charset=utf-8');
      outHeaders.delete('content-length');
      return new Response(rewritten, { status: status || 200, headers: outHeaders });
    }

    // Everything else (JS, images, fonts, etc.) — pass through raw bytes
    outHeaders.delete('content-length');
    return new Response(bodyBuf, { status: status || 200, headers: outHeaders });

  } catch (err) {
    return errorPage('Proxy Error: ' + err.message);
  }
}

// ── HTML rewriter ─────────────────────────────────────────────
function rewriteHTML(html, base) {
  let r = html;

  // Kill security meta tags
  r = r.replace(/<meta[^>]*http-equiv\s*=\s*['"](?:content-security-policy|x-frame-options)['"][^>]*>/gi, '');

  // Remove frame-busting scripts
  r = r.replace(/<script(?:\s[^>]*)?>[\s\S]*?<\/script>/gi, m => {
    const code = m.replace(/<script[^>]*>/i,'').replace(/<\/script>/i,'');
    if (/top\s*[!=]=\s*(self|window)|top\.location|self\.location|parent\.location/i.test(code)) return '';
    return m;
  });

  // Rewrite href
  r = r.replace(/(<(?:a|link|area)[^>]+\s)href\s*=\s*(['"])(.*?)\2/gi, (m, pre, q, u) =>
    /^(mailto:|tel:|javascript:|#)/.test(u) ? m : `${pre}href=${q}${rewriteUrl(u, base)}${q}`);

  // Rewrite src
  r = r.replace(/(<(?:img|script|iframe|source|audio|video|track|embed|input)[^>]+\s)src\s*=\s*(['"])(.*?)\2/gi, (m, pre, q, u) =>
    u.startsWith('data:') ? m : `${pre}src=${q}${rewriteUrl(u, base)}${q}`);

  // Rewrite srcset
  r = r.replace(/srcset\s*=\s*(['"])(.*?)\1/gi, (m, q, ss) => {
    const rw = ss.replace(/([^\s,]+)(\s+[^\s,]+)?/g, (sm, u, d) =>
      u.startsWith('data:') ? sm : rewriteUrl(u, base) + (d || ''));
    return `srcset=${q}${rw}${q}`;
  });

  // Rewrite action
  r = r.replace(/(<form[^>]+\s)action\s*=\s*(['"])(.*?)\2/gi, (m, pre, q, u) =>
    `${pre}action=${q}${rewriteUrl(u, base)}${q}`);

  // Rewrite inline style
  r = r.replace(/style\s*=\s*(['"])(.*?)\1/gi, (m, q, s) =>
    `style=${q}${rewriteCSS(s, base)}${q}`);

  // Rewrite <style> blocks
  r = r.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, o, css, c) =>
    o + rewriteCSS(css, base) + c);

  // Rewrite data-src etc
  r = r.replace(/\b(data-(?:src|href|lazy|original|bg|url))\s*=\s*(['"])(.*?)\2/gi, (m, attr, q, u) =>
    `${attr}=${q}${rewriteUrl(u, base)}${q}`);

  // Inject interceptor
  const inj = buildInterceptor(base);
  if (r.includes('</head>')) r = r.replace('</head>', inj + '</head>');
  else if (/<body/i.test(r)) r = r.replace(/<body[^>]*>/i, m => m + inj);
  else r = inj + r;

  return r;
}

// ── CSS rewriter ──────────────────────────────────────────────
function rewriteCSS(css, base) {
  if (!css) return css;
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) =>
      `url(${q}${rewriteUrl(u.trim(), base)}${q})`)
    .replace(/@import\s+(['"])(.*?)\1/gi, (m, q, u) =>
      `@import ${q}${rewriteUrl(u, base)}${q}`);
}

// ── Runtime interceptor ───────────────────────────────────────
function buildInterceptor(base) {
  const b = base.replace(/\\/g,'\\\\').replace(/`/g,'\\`').replace(/\$/g,'\\$');
  return `<script>
(function(){
  var BASE=\`${b}\`;
  var PFX='${PROXY_PREFIX}';
  function enc(u){return btoa(unescape(encodeURIComponent(u))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,'');}
  function abs(h){if(!h||/^(javascript:|mailto:|tel:|#|blob:|data:)/.test(h))return null;try{return new URL(h,BASE).href;}catch{return null;}}
  function px(u){var a=abs(u);return a?PFX+enc(a):u;}
  function nav(u){var a=abs(u);if(!a)return;try{window.top.postMessage({type:'MP_NAV',url:a},'*');}catch(e){}}

  try{
    Object.defineProperty(window,'top',{get:function(){return window;},configurable:true});
    Object.defineProperty(window,'parent',{get:function(){return window;},configurable:true});
    Object.defineProperty(window,'frameElement',{get:function(){return null;},configurable:true});
  }catch(e){}

  document.addEventListener('click',function(e){
    var t=e.target;
    if(!t||['CANVAS','VIDEO','BUTTON','INPUT','TEXTAREA'].includes(t.tagName))return;
    var el=t; while(el&&el.tagName!=='A')el=el.parentElement;
    if(!el)return;
    var h=el.getAttribute('href')||'';
    if(!h||/^(javascript:|#)/.test(h))return;
    if(el.onclick||el.getAttribute('onclick'))return;
    if(el.getAttribute('role')==='button')return;
    var a=abs(h); if(!a)return;
    try{var d=new URL(a),here=new URL(location.href);if(d.hostname===here.hostname)return;}catch(x){}
    e.preventDefault();e.stopPropagation();nav(a);
  },true);

  var _open=window.open;
  window.open=function(u){var a=abs(u);if(a){nav(a);return{focus:function(){},closed:false,postMessage:function(){}};}return _open.apply(this,arguments);};

  var _fetch=window.fetch;
  if(_fetch)window.fetch=function(input,init){
    try{
      var u=typeof input==='string'?input:(input&&input.url?input.url:null);
      if(u){var a=abs(u);if(a&&!a.startsWith(location.origin))input=typeof input==='string'?px(u):new Request(px(u),input);}
    }catch(e){}
    return _fetch.call(this,input,init);
  };

  var _xo=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){
    try{var a=abs(u);if(a&&!a.startsWith(location.origin))u=px(a);}catch(e){}
    var args=Array.prototype.slice.call(arguments);args[1]=u;return _xo.apply(this,args);
  };

  try{window.location.assign=function(u){nav(u);};window.location.replace=function(u){nav(u);};}catch(e){}

  var _ps=history.pushState.bind(history),_rs=history.replaceState.bind(history);
  history.pushState=function(s,t,u){if(u)try{window.top.postMessage({type:'MP_URL',url:new URL(u,BASE).href},'*');}catch(e){}return _ps.apply(this,arguments);};
  history.replaceState=function(s,t,u){if(u)try{window.top.postMessage({type:'MP_URL',url:new URL(u,BASE).href},'*');}catch(e){}return _rs.apply(this,arguments);};

  new MutationObserver(function(ms){ms.forEach(function(m){m.addedNodes.forEach(function(n){
    if(n.nodeType!==1)return;
    ['src','data-src','data-lazy','data-original'].forEach(function(a){
      if(!n.hasAttribute||!n.hasAttribute(a))return;
      var v=n.getAttribute(a);if(v&&v.startsWith('http')&&!v.startsWith(location.origin))n.setAttribute(a,px(v));
    });
  });});}).observe(document.documentElement,{childList:true,subtree:true});

  function report(){try{window.top.postMessage({type:'MP_TITLE',title:document.title,url:BASE},'*');}catch(e){}}
  document.addEventListener('DOMContentLoaded',report);
  window.addEventListener('load',report);
  setTimeout(report,500);
})();
<\/script>`;
}

function errorPage(msg) {
  return new Response(`<!DOCTYPE html><html><head><title>Proxy Error</title>
<style>body{font-family:monospace;padding:60px 40px;background:#07070f;color:#eeeef5;max-width:500px;margin:0 auto}
h2{color:#e94560;margin-bottom:12px}p{color:#9a9abf;line-height:1.6}a{color:#4d9de0}</style></head><body>
<h2>⚠ Proxy Error</h2><p>${msg}</p><p><a href="javascript:history.back()">← Go back</a></p>
</body></html>`, { status: 502, headers: { 'content-type': 'text/html' } });
}
