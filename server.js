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

// ── DuckDuckGo Search ─────────────────────────────────────────
app.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json({ results: [] });

  try {
    const response = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=es-es`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
          'Referer': 'https://duckduckgo.com/',
        },
      }
    );

    const html = await response.text();
    const $ = cheerio.load(html);
    const results = [];

    $('.result:not(.result--ad)').each((i, el) => {
      if (i >= 12) return false;
      const titleEl = $(el).find('.result__title a');
      const snippetEl = $(el).find('.result__snippet');
      const urlEl = $(el).find('.result__url');
      const title = titleEl.text().trim();
      const snippet = snippetEl.text().trim();
      const rawHref = titleEl.attr('href') || '';
      const displayUrl = urlEl.text().trim();

      let url = '';
      try {
        const u = new URL('https://duckduckgo.com' + rawHref);
        url = u.searchParams.get('uddg') || u.searchParams.get('u') || rawHref;
        if (url.startsWith('//')) url = 'https:' + url;
      } catch { url = rawHref; }

      if (title && url && url.startsWith('http') && !url.includes('duckduckgo.com')) {
        results.push({ title, snippet, url, display: displayUrl });
      }
    });

    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message, results: [] });
  }
});

// ── Web Proxy ─────────────────────────────────────────────────
app.get('/proxy', async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).send('Missing url');

  let targetUrl;
  try {
    targetUrl = decodeURIComponent(rawUrl);
    if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;
    new URL(targetUrl);
  } catch {
    return res.status(400).send('Invalid URL');
  }

  // Special handling for known blocked sites
  const BLOCKED = ['spotify.com', 'instagram.com', 'tiktok.com', 'facebook.com', 'twitter.com', 'x.com'];
  const parsed = new URL(targetUrl);
  const isBlocked = BLOCKED.some(d => parsed.hostname.includes(d));

  if (isBlocked) {
    return res.send(blockedPage(targetUrl, parsed.hostname));
  }

  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity',
        'Referer': parsed.origin,
        'Origin': parsed.origin,
      },
      redirect: 'follow',
    });

    const contentType = response.headers.get('content-type') || '';
    const finalUrl = response.url || targetUrl;

    // Pass-through binary
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      res.set('Content-Type', contentType);
      res.removeHeader('X-Frame-Options');
      res.removeHeader('Content-Security-Policy');
      response.body.pipe(res);
      return;
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    const toProxy = (val, base) => {
      if (!val || val.startsWith('data:') || val.startsWith('javascript:') || val.startsWith('#') || val.startsWith('mailto:')) return val;
      try {
        const abs = new URL(val, base).href;
        return `/proxy?url=${encodeURIComponent(abs)}`;
      } catch { return val; }
    };

    // Rewrite links — navigate inside proxy
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      try {
        const abs = new URL(href, finalUrl).href;
        if (abs.startsWith('http')) $(el).attr('href', `/proxy?url=${encodeURIComponent(abs)}`);
      } catch {}
    });

    $('[src]').each((_, el) => {
      const p = toProxy($(el).attr('src'), finalUrl);
      if (p) $(el).attr('src', p);
    });

    $('link[href]').each((_, el) => {
      const p = toProxy($(el).attr('href'), finalUrl);
      if (p) $(el).attr('href', p);
    });

    $('[srcset]').each((_, el) => {
      const rewritten = ($(el).attr('srcset') || '').replace(/([^\s,]+)(\s+[^\s,]+)?/g, (match, u, d) => {
        if (!u || u.startsWith('data:')) return match;
        try { return `/proxy?url=${encodeURIComponent(new URL(u, finalUrl).href)}${d || ''}`; }
        catch { return match; }
      });
      $(el).attr('srcset', rewritten);
    });

    $('form[action]').each((_, el) => {
      try {
        const abs = new URL($(el).attr('action'), finalUrl).href;
        $(el).attr('action', `/proxy?url=${encodeURIComponent(abs)}`);
      } catch {}
    });

    // Remove CSP/frame headers
    $('meta[http-equiv="X-Frame-Options"], meta[http-equiv="Content-Security-Policy"], meta[http-equiv="x-frame-options"]').remove();

    // Remove frame-busting scripts
    $('script').each((_, el) => {
      const code = $(el).html() || '';
      if (code.includes('top.location') || code.includes('self.location') || code.includes('window.top !== window.self')) {
        $(el).remove();
      }
    });

    // Anti frame-bust + link interceptor
    $('head').prepend(`<script>
      (function(){
        try {
          Object.defineProperty(window,'top',{get:()=>window,configurable:true});
          Object.defineProperty(window,'parent',{get:()=>window,configurable:true});
          Object.defineProperty(window,'frameElement',{get:()=>null,configurable:true});
        } catch(e){}

        var BASE = '${finalUrl}';

        function toAbs(href) {
          if (!href) return null;
          if (href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('#')) return null;
          try { return new URL(href, BASE).href; } catch { return null; }
        }

        function sendNav(url) {
          try { window.top.postMessage({type:'MP_NAV', url:url}, '*'); } catch(e){}
        }

        // Intercept all link clicks
        document.addEventListener('click', function(e) {
          var el = e.target;
          // Walk up to find <a>
          while (el && el.tagName !== 'A') el = el.parentElement;
          if (!el || !el.href) return;
          var abs = toAbs(el.getAttribute('href'));
          if (!abs || !abs.startsWith('http')) return;
          e.preventDefault();
          e.stopPropagation();
          sendNav(abs);
        }, true);

        // Intercept window.open
        var origOpen = window.open;
        window.open = function(url) {
          var abs = toAbs(url);
          if (abs && abs.startsWith('http')) { sendNav(abs); return null; }
          return origOpen.apply(this, arguments);
        };

        // Intercept location changes
        var origAssign = window.location.assign.bind(window.location);
        var origReplace = window.location.replace.bind(window.location);
        try {
          window.location.assign = function(url) {
            var abs = toAbs(url);
            if (abs && abs.startsWith('http')) { sendNav(abs); return; }
            origAssign(url);
          };
          window.location.replace = function(url) {
            var abs = toAbs(url);
            if (abs && abs.startsWith('http')) { sendNav(abs); return; }
            origReplace(url);
          };
        } catch(e){}

        // Report page title changes to parent
        document.addEventListener('DOMContentLoaded', function() {
          try { window.top.postMessage({type:'MP_TITLE', title: document.title, url: window.location.href}, '*'); } catch(e){}
        });
        window.addEventListener('load', function() {
          try { window.top.postMessage({type:'MP_TITLE', title: document.title, url: window.location.href}, '*'); } catch(e){}
        });
      })();
    </script>`);

    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('x-frame-options');
    res.set('Content-Type', 'text/html; charset=utf-8');
    // Pass final URL so client can update address bar
    res.set('X-Proxy-Final-Url', finalUrl);
    res.send($.html());

  } catch (err) {
    res.status(500).send(errorPage(targetUrl, err.message));
  }
});

function blockedPage(url, hostname) {
  return `<!DOCTYPE html><html><head><title>Site blocked - Maths Proxy</title>
  <style>body{font-family:monospace;padding:60px 40px;background:#07070f;color:#eeeef5;max-width:560px;margin:0 auto;text-align:center}
  h2{color:#e94560;font-size:22px;margin-bottom:12px}.icon{font-size:48px;margin-bottom:20px}
  p{color:#9a9abf;line-height:1.7;margin-bottom:8px}.url{background:#13132a;padding:8px 14px;border-radius:6px;color:#f5a623;font-size:13px;margin:16px 0;display:inline-block}
  a{color:#4d9de0}.tip{background:#0f1a2e;border:1px solid #1e3a5f;border-radius:8px;padding:16px;margin-top:24px;text-align:left;font-size:13px;color:#6b9fcf}
  </style></head><body>
  <div class="icon">🔒</div>
  <h2>Blocked by ${hostname}</h2>
  <div class="url">${url}</div>
  <p>This site actively blocks all proxy and iframe access at the server level.<br>This is a browser + server restriction — no proxy can bypass it.</p>
  <div class="tip">💡 <strong>To access this site:</strong> open it directly in a new tab. Proxies cannot load Spotify, Instagram, TikTok, Facebook or Twitter — this is by their design, not a bug in Maths Proxy.</div>
  <br><a href="javascript:history.back()">← Go back</a>
  </body></html>`;
}

function errorPage(url, msg) {
  return `<!DOCTYPE html><html><head><title>Error - Maths Proxy</title>
  <style>body{font-family:monospace;padding:60px 40px;background:#07070f;color:#eeeef5;max-width:560px;margin:0 auto}
  h2{color:#e94560}p{color:#9a9abf;line-height:1.6}.url{background:#13132a;padding:8px 14px;border-radius:6px;color:#00d4aa;word-break:break-all;margin:12px 0;display:block}
  .err{background:#1a0808;border:1px solid #e94560;padding:10px 14px;border-radius:6px;color:#e94560;margin:12px 0}a{color:#4d9de0}
  </style></head><body>
  <h2>⚠ Proxy Error</h2>
  <span class="url">${url}</span>
  <div class="err">${msg}</div>
  <p>The site may block proxies, require login, or be unavailable.</p>
  <a href="javascript:history.back()">← Go back</a>
  </body></html>`;
}

app.listen(PORT, () => console.log(`✓ Maths Proxy v3 on port ${PORT}`));
