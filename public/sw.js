// Maths Proxy Service Worker v5.1

const PROXY_PREFIX = '/browse/';
const BARE = '/bare/';

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
  if (!t || t.startsWith('data:') || t.startsWith('blob:') ||
      t.startsWith('javascript:') || t.startsWith('#') ||
      t.startsWith('mailto:') || t.startsWith('tel:') ||
      t.startsWith(PROXY_PREFIX) || t.startsWith(BARE)) return t;
  try {
    const abs = new URL(t, base).href;
    if (!abs.startsWith('http')) return t;
    return proxyUrl(abs);
  } catch { return t; }
}

// ── SW lifecycle ──────────────────────────────────────────────
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// ── Intercept ─────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (!url.pathname.startsWith(PROXY_PREFIX)) return;
  e.respondWith(handle(e.request, url));
});

async function handle(request, reqUrl) {
  const encoded = reqUrl.pathname.slice(PROXY_PREFIX.length);
  if (!encoded) return errPage('No target URL provided');

  const target = decodeUrl(encoded);
  if (!target) return errPage('Could not decode proxy URL');

  let targetUrl;
  try { targetUrl = new URL(target); }
  catch { return errPage('Invalid target URL: ' + target); }

  // Forward query string too
  if (reqUrl.search) {
    targetUrl.search = reqUrl.search;
  }

  try {
    // Send to our bare server with the full absolute target URL
    const bareReq = new Request(BARE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bare-url': targetUrl.href,
        'x-bare-method': request.method,
      },
      body: JSON.stringify({
        url: targetUrl.href,
        method: request.method,
        headers: buildFwdHeaders(request, targetUrl),
        body: ['GET','HEAD'].includes(request.method.toUpperCase()) ? null
          : await request.text().catch(() => null),
      }),
    });

    const bareRes = await fetch(bareReq);
    if (!bareRes.ok) {
      const txt = await bareRes.text().catch(() => '');
      return errPage('Bare server error: ' + txt);
    }

    const data = await bareRes.json();

    // Redirect
    if (data.__redirect && data.location) {
      const newTarget = (() => {
        try { return new URL(data.location, targetUrl.href).href; }
        catch { return data.location; }
      })();
      return Response.redirect(proxyUrl(newTarget), 302);
    }

    if (data.error) return errPage(data.error);

    const status = data.status || 200;
    const ct = data.contentType || '';

    // Decode base64 body
    let bodyBytes;
    try { bodyBytes = Uint8Array.from(atob(data.body || ''), c => c.charCodeAt(0)); }
    catch { bodyBytes = new Uint8Array(0); }

    const outHeaders = buildResHeaders(data.headers || {});

    // HTML
    if (ct.includes('text/html') || ct.includes('application/xhtml')) {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bodyBytes);
      const rewritten = rewriteHTML(text, targetUrl.href);
      outHeaders.set('content-type', 'text/html; charset=utf-8');
      outHeaders.delete('content-length');
      return new Response(rewritten, { status, headers: outHeaders });
    }

    // CSS
    if (ct.includes('text/css')) {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bodyBytes);
      const rewritten = rewriteCSS(text, targetUrl.href);
      outHeaders.set('content-type', 'text/css; charset=utf-8');
      outHeaders.delete('content-length');
      return new Response(rewritten, { status, headers: outHeaders });
    }

    // JS, images, fonts, etc — pass raw bytes
    outHeaders.delete('content-length');
    return new Response(bodyBytes, { status, headers: outHeaders });

  } catch (err) {
    return errPage('Proxy Error: ' + err.message);
  }
}

function buildFwdHeaders(request, targetUrl) {
  const out = {};
  const skip = new Set(['host','connection','transfer-encoding','te','trailer',
    'upgrade','proxy-authorization','proxy-connection']);
  for (const [k, v] of request.headers.entries()) {
    if (skip.has(k.toLowerCase())) continue;
    if (k.toLowerCase() === 'referer') {
      try {
        const ref = new URL(v);
        if (ref.pathname.startsWith(PROXY_PREFIX)) {
          const dec = decodeUrl(ref.pathname.slice(PROXY_PREFIX.length));
          if (dec) { out['referer'] = dec; continue; }
        }
      } catch {}
    }
    if (k.toLowerCase() === 'origin') { out['origin'] = targetUrl.origin; continue; }
    out[k] = v;
  }
  out['host'] = targetUrl.host;
  out['referer'] = out['referer'] || targetUrl.origin + '/';
  out['origin'] = out['origin'] || targetUrl.origin;
  return out;
}

function buildResHeaders(hdrs) {
  const out = new Headers();
  const strip = new Set(['x-frame-options','content-security-policy',
    'x-content-type-options','strict-transport-security','permissions-policy',
    'cross-origin-opener-policy','cross-origin-embedder-policy',
    'cross-origin-resource-policy','transfer-encoding','connection']);
  for (const [k, v] of Object.entries(hdrs)) {
    if (strip.has(k.toLowerCase())) continue;
    if (k.toLowerCase() === 'set-cookie') {
      out.append('set-cookie', String(v).replace(/domain=[^;]+;?/gi,'').replace(/;\s*secure/gi,''));
      continue;
    }
    try { out.set(k, v); } catch {}
  }
  out.set('access-control-allow-origin', '*');
  return out;
}

// ── HTML rewriter ─────────────────────────────────────────────
function rewriteHTML(html, base) {
  let r = html;

  // Kill CSP and X-Frame-Options meta
  r = r.replace(/<meta[^>]*http-equiv\s*=\s*['"](?:content-security-policy|x-frame-options)['"][^>]*\/?>/gi, '');

  // Remove frame-busting scripts
  r = r.replace(/<script(?:\s[^>]*)?>[\s\S]*?<\/script>/gi, m => {
    const inner = m.replace(/<script[^>]*>/i,'').replace(/<\/script>/i,'');
    if (/top\s*[!=]=\s*(self|window)|top\.location|self\.location|parent\.location|window\.top\s*!==\s*window/i.test(inner))
      return '';
    return m;
  });

  // <a href>, <link href>, <area href>
  r = r.replace(/(<(?:a|link|area)\b[^>]*?\s)href\s*=\s*(['"])(.*?)\2/gi, (m, pre, q, u) => {
    if (/^(mailto:|tel:|javascript:|#)/.test(u)) return m;
    return `${pre}href=${q}${rewriteUrl(u, base)}${q}`;
  });

  // src attributes
  r = r.replace(/(<(?:img|script|iframe|source|audio|video|track|embed|input)\b[^>]*?\s)src\s*=\s*(['"])(.*?)\2/gi, (m, pre, q, u) => {
    if (u.startsWith('data:') || u.startsWith('blob:')) return m;
    return `${pre}src=${q}${rewriteUrl(u, base)}${q}`;
  });

  // srcset
  r = r.replace(/\bsrcset\s*=\s*(['"])(.*?)\1/gi, (m, q, ss) => {
    const rw = ss.replace(/([^\s,]+)(\s+[^\s,]+)?/g, (sm, u, d) => {
      if (!u || u.startsWith('data:')) return sm;
      return rewriteUrl(u, base) + (d || '');
    });
    return `srcset=${q}${rw}${q}`;
  });

  // form action
  r = r.replace(/(<form\b[^>]*?\s)action\s*=\s*(['"])(.*?)\2/gi, (m, pre, q, u) =>
    `${pre}action=${q}${rewriteUrl(u, base)}${q}`);

  // inline style
  r = r.replace(/\bstyle\s*=\s*(['"])(.*?)\1/gi, (m, q, s) =>
    `style=${q}${rewriteCSS(s, base)}${q}`);

  // <style> blocks
  r = r.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, o, css, c) =>
    o + rewriteCSS(css, base) + c);

  // data-src, data-lazy, data-original etc
  r = r.replace(/\b(data-(?:src|href|lazy|original|bg|url))\s*=\s*(['"])(.*?)\2/gi, (m, attr, q, u) =>
    `${attr}=${q}${rewriteUrl(u, base)}${q}`);

  // meta refresh
  r = r.replace(/(<meta[^>]*?http-equiv\s*=\s*['"]refresh['"][^>]*?content\s*=\s*['"][^'"]*?url=)(.*?)(['"])/gi,
    (m, pre, u, q) => `${pre}${rewriteUrl(u.trim(), base)}${q}`);

  // poster attribute on video
  r = r.replace(/\bposter\s*=\s*(['"])(.*?)\1/gi, (m, q, u) =>
    `poster=${q}${rewriteUrl(u, base)}${q}`);

  // Inject runtime interceptor
  const inj = buildInterceptor(base);
  if (/<\/head>/i.test(r)) r = r.replace(/<\/head>/i, inj + '</head>');
  else if (/<body\b/i.test(r)) r = r.replace(/<body\b[^>]*>/i, m => m + inj);
  else r = inj + r;

  return r;
}

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
  const safeBase = base.replace(/\\/g,'\\\\').replace(/`/g,'\\`').replace(/\$/g,'\\$');
  return `<script>
(function(){
  var BASE=\`${safeBase}\`;
  var PFX='${PROXY_PREFIX}';
  function enc(u){return btoa(unescape(encodeURIComponent(u))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,'');}
  function abs(h){
    if(!h||/^(javascript:|mailto:|tel:|#|blob:|data:)/.test(h))return null;
    try{return new URL(h,BASE).href;}catch(e){return null;}
  }
  function px(u){var a=abs(u);return a?PFX+enc(a):u;}
  function nav(u){var a=abs(u);if(!a)return;try{window.top.postMessage({type:'MP_NAV',url:a},'*');}catch(e){}}

  // Anti frame-bust
  try{
    Object.defineProperty(window,'top',{get:function(){return window;},configurable:true});
    Object.defineProperty(window,'parent',{get:function(){return window;},configurable:true});
    Object.defineProperty(window,'frameElement',{get:function(){return null;},configurable:true});
  }catch(e){}

  // Click interceptor — smart, doesn't break game buttons
  document.addEventListener('click',function(e){
    var t=e.target;
    if(!t||['CANVAS','VIDEO','BUTTON','INPUT','TEXTAREA','SELECT'].includes(t.tagName))return;
    var el=t;
    while(el&&el.tagName!=='A')el=el.parentElement;
    if(!el)return;
    var h=el.getAttribute('href')||'';
    if(!h||/^(javascript:|#)/.test(h))return;
    if(el.onclick||el.getAttribute('onclick'))return;
    if(el.getAttribute('role')==='button')return;
    var a=abs(h);if(!a)return;
    try{var d=new URL(a),here=new URL(location.href);if(d.hostname===here.hostname)return;}catch(x){}
    e.preventDefault();e.stopPropagation();nav(a);
  },true);

  // window.open
  var _open=window.open;
  window.open=function(u){
    var a=abs(u);
    if(a){nav(a);return{focus:function(){},blur:function(){},closed:false,postMessage:function(){},location:{href:''}};}
    return _open.apply(this,arguments);
  };

  // fetch intercept
  var _fetch=window.fetch;
  if(_fetch)window.fetch=function(input,init){
    try{
      var u=typeof input==='string'?input:(input&&input.url?input.url:null);
      if(u){
        var a=abs(u);
        if(a&&!a.startsWith(location.origin)){
          input=typeof input==='string'?px(u):new Request(px(u),input);
        }
      }
    }catch(e){}
    return _fetch.call(this,input,init);
  };

  // XHR intercept
  var _xo=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){
    try{
      var a=abs(typeof u==='string'?u:'');
      if(a&&!a.startsWith(location.origin))u=px(a);
    }catch(e){}
    var args=Array.prototype.slice.call(arguments);args[1]=u;
    return _xo.apply(this,args);
  };

  // location navigation
  try{
    window.location.assign=function(u){nav(u);};
    window.location.replace=function(u){nav(u);};
  }catch(e){}

  // history API
  var _ps=history.pushState.bind(history),_rs=history.replaceState.bind(history);
  history.pushState=function(s,t,u){
    if(u)try{window.top.postMessage({type:'MP_URL',url:new URL(u,BASE).href},'*');}catch(e){}
    return _ps.apply(this,arguments);
  };
  history.replaceState=function(s,t,u){
    if(u)try{window.top.postMessage({type:'MP_URL',url:new URL(u,BASE).href},'*');}catch(e){}
    return _rs.apply(this,arguments);
  };

  // MutationObserver for lazy-loaded content
  new MutationObserver(function(ms){
    ms.forEach(function(m){
      m.addedNodes.forEach(function(n){
        if(n.nodeType!==1)return;
        ['src','data-src','data-lazy','data-original','data-bg'].forEach(function(a){
          if(!n.hasAttribute||!n.hasAttribute(a))return;
          var v=n.getAttribute(a);
          if(v&&v.startsWith('http')&&!v.startsWith(location.origin))
            n.setAttribute(a,px(v));
        });
        if(n.querySelectorAll){
          n.querySelectorAll('[data-src],[data-lazy],[data-original]').forEach(function(el){
            ['data-src','data-lazy','data-original'].forEach(function(a){
              var v=el.getAttribute(a);
              if(v&&v.startsWith('http')&&!v.startsWith(location.origin))
                el.setAttribute(a,px(v));
            });
          });
        }
      });
    });
  }).observe(document.documentElement,{childList:true,subtree:true});

  // Report title to parent frame
  function report(){
    try{window.top.postMessage({type:'MP_TITLE',title:document.title,url:BASE},'*');}catch(e){}
  }
  document.addEventListener('DOMContentLoaded',report);
  window.addEventListener('load',report);
  setTimeout(report,500);
})();
<\/script>`;
}

function errPage(msg) {
  return new Response(
    `<!DOCTYPE html><html><head><title>Proxy Error</title>
    <style>body{font-family:monospace;padding:60px 40px;background:#07070f;color:#eeeef5;max-width:500px;margin:0 auto}
    h2{color:#e94560;margin-bottom:12px}p{color:#9a9abf;line-height:1.6}a{color:#4d9de0}
    .err{background:#1a0808;border:1px solid #e94560;padding:10px 14px;border-radius:6px;margin:12px 0;font-size:13px}</style></head><body>
    <h2>⚠ Proxy Error</h2><div class="err">${msg}</div>
    <p><a href="javascript:history.back()">← Go back</a></p></body></html>`,
    { status: 502, headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}
