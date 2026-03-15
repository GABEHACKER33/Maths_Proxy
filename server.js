const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());

// ── Keep-alive (prevents Render free tier spin-down) ──────────
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  setInterval(() => {
    fetch(RENDER_URL + '/ping').catch(() => {});
  }, 14 * 60 * 1000);
}
app.get('/ping', (_, res) => res.send('pong'));

// ── DuckDuckGo Search ─────────────────────────────────────────
app.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json({ results: [] });

  try {
    // Use DuckDuckGo HTML endpoint
    const response = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=es-es`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate',
          'Cache-Control': 'no-cache',
          'Referer': 'https://duckduckgo.com/',
        },
      }
    );

    const html = await response.text();
    const $ = cheerio.load(html);
    const results = [];

    $('.result:not(.result--ad)').each((i, el) => {
      if (i >= 10) return false;

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
      } catch {
        url = rawHref;
      }

      if (title && url && url.startsWith('http') && !url.includes('duckduckgo.com')) {
        results.push({ title, snippet, url, display: displayUrl });
      }
    });

    res.json({ results });
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: err.message, results: [] });
  }
});

// ── Web Proxy ─────────────────────────────────────────────────
app.get('/proxy', async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).send('Missing url param');

  let targetUrl;
  try {
    targetUrl = decodeURIComponent(rawUrl);
    // Auto-add https if missing
    if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;
    new URL(targetUrl); // validate
  } catch {
    return res.status(400).send('Invalid URL');
  }

  try {
    const parsed = new URL(targetUrl);

    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
        'Referer': parsed.origin,
        'Origin': parsed.origin,
      },
      redirect: 'follow',
      timeout: 15000,
    });

    const contentType = response.headers.get('content-type') || '';
    const finalUrl = response.url || targetUrl;

    // Pass-through binary resources
    if (
      !contentType.includes('text/html') &&
      !contentType.includes('text/xml') &&
      !contentType.includes('application/xhtml')
    ) {
      res.set('Content-Type', contentType);
      res.removeHeader('X-Frame-Options');
      res.removeHeader('Content-Security-Policy');
      response.body.pipe(res);
      return;
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Helper: make URL absolute then proxy it
    const proxyUrl = (val, base) => {
      if (!val || val.startsWith('data:') || val.startsWith('javascript:') || val.startsWith('#') || val.startsWith('mailto:')) return val;
      try {
        const abs = new URL(val, base).href;
        return `/proxy?url=${encodeURIComponent(abs)}`;
      } catch { return val; }
    };

    // Rewrite all links
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      const abs = (() => {
        try { return new URL(href, finalUrl).href; } catch { return null; }
      })();
      if (abs && abs.startsWith('http')) {
        $(el).attr('href', `/proxy?url=${encodeURIComponent(abs)}`);
      }
    });

    // Rewrite assets
    $('[src]').each((_, el) => {
      const src = $(el).attr('src');
      const p = proxyUrl(src, finalUrl);
      if (p) $(el).attr('src', p);
    });

    $('link[href]').each((_, el) => {
      const href = $(el).attr('href');
      const p = proxyUrl(href, finalUrl);
      if (p) $(el).attr('href', p);
    });

    $('[srcset]').each((_, el) => {
      const srcset = $(el).attr('srcset') || '';
      const rewritten = srcset.replace(/([^\s,]+)(\s+[^\s,]+)?/g, (match, u, descriptor) => {
        if (!u || u.startsWith('data:')) return match;
        try {
          const abs = new URL(u, finalUrl).href;
          return `/proxy?url=${encodeURIComponent(abs)}${descriptor || ''}`;
        } catch { return match; }
      });
      $(el).attr('srcset', rewritten);
    });

    $('form[action]').each((_, el) => {
      const action = $(el).attr('action');
      const abs = (() => { try { return new URL(action, finalUrl).href; } catch { return null; } })();
      if (abs) $(el).attr('action', `/proxy?url=${encodeURIComponent(abs)}`);
    });

    // Remove frame-busting and CSP
    $('meta[http-equiv="X-Frame-Options"]').remove();
    $('meta[http-equiv="Content-Security-Policy"]').remove();
    $('meta[http-equiv="x-frame-options"]').remove();

    // Remove inline frame-busting scripts (common patterns)
    $('script').each((_, el) => {
      const code = $(el).html() || '';
      if (
        code.includes('top.location') ||
        code.includes('self.location') ||
        code.includes('window.top') ||
        code.includes('parent.location')
      ) {
        $(el).remove();
      }
    });

    // Inject anti-frame-bust + proxy base
    $('head').prepend(`
      <script>
        try {
          Object.defineProperty(window, 'top', { get: () => window, configurable: true });
          Object.defineProperty(window, 'parent', { get: () => window, configurable: true });
          Object.defineProperty(window, 'frameElement', { get: () => null, configurable: true });
        } catch(e) {}
      </script>
    `);

    // Inject proxy toolbar
    $('body').prepend(`
      <div id="__mp_bar__">
        <div class="__mp_left__">
          <a href="/" class="__mp_logo__">MP</a>
          <span class="__mp_sep__">|</span>
          <span class="__mp_url__" title="${finalUrl}">${finalUrl}</span>
        </div>
        <div class="__mp_right__">
          <button onclick="history.back()" class="__mp_btn__">← Back</button>
          <a href="${finalUrl}" target="_blank" class="__mp_btn__" title="Open original">↗</a>
          <a href="/" class="__mp_btn__">🔍</a>
        </div>
      </div>
      <div style="height:38px"></div>
      <style>
        #__mp_bar__{position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#0d0d1a;border-bottom:2px solid #e94560;display:flex;align-items:center;justify-content:space-between;padding:0 14px;height:38px;font-family:monospace;font-size:12px;gap:10px}
        .__mp_left__{display:flex;align-items:center;gap:8px;overflow:hidden;min-width:0}
        .__mp_logo__{color:#e94560;font-weight:bold;text-decoration:none;font-size:14px;flex-shrink:0}
        .__mp_sep__{color:#333;flex-shrink:0}
        .__mp_url__{color:#6b6b8a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .__mp_right__{display:flex;align-items:center;gap:6px;flex-shrink:0}
        .__mp_btn__{background:#13132a;border:1px solid #2a2a4a;color:#aaa;padding:3px 10px;border-radius:3px;cursor:pointer;font-size:11px;text-decoration:none;font-family:monospace}
        .__mp_btn__:hover{border-color:#e94560;color:#fff}
      </style>
    `);

    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('x-frame-options');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send($.html());

  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Proxy Error - Maths Proxy</title>
      <style>
        body{font-family:monospace;padding:60px 40px;background:#0d0d1a;color:#e8e8f0;max-width:600px;margin:0 auto}
        h2{color:#e94560;margin-bottom:16px}
        p{color:#a0a0b8;line-height:1.6;margin-bottom:8px}
        a{color:#4d9de0}
        .url{background:#13132a;padding:10px 14px;border-radius:4px;color:#07b39b;word-break:break-all;margin:16px 0;display:block}
        .err{background:#1a0a0a;border:1px solid #e94560;padding:10px 14px;border-radius:4px;color:#e94560;margin:16px 0}
      </style>
      </head>
      <body>
        <h2>⚠ Proxy Error</h2>
        <p>Could not load:</p>
        <span class="url">${targetUrl}</span>
        <div class="err">${err.message}</div>
        <p>This usually means the site blocks proxy requests, requires login, or is unavailable.</p>
        <p><a href="/">← Back to Maths Proxy</a></p>
      </body>
      </html>
    `);
  }
});

app.listen(PORT, () => console.log(`✓ Maths Proxy on port ${PORT}`));
