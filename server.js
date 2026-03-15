const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

// ── DuckDuckGo search ──────────────────────────────────────────
app.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.redirect('/');

  try {
    const response = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
        },
      }
    );

    const html = await response.text();
    const $ = cheerio.load(html);
    const results = [];

    $('.result').each((i, el) => {
      const titleEl = $(el).find('.result__title a');
      const snippetEl = $(el).find('.result__snippet');
      const urlEl = $(el).find('.result__url');

      const title = titleEl.text().trim();
      const snippet = snippetEl.text().trim();
      const rawHref = titleEl.attr('href') || '';

      // Extract actual URL from DDG redirect
      let url = '';
      try {
        const urlParams = new URL('https://duckduckgo.com' + rawHref).searchParams;
        url = urlParams.get('uddg') || urlParams.get('u') || rawHref;
      } catch {
        url = rawHref;
      }

      if (title && url && !url.startsWith('//duckduckgo')) {
        results.push({ title, snippet, url, display: urlEl.text().trim() });
      }
    });

    res.json({ results: results.slice(0, 10) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Web proxy ──────────────────────────────────────────────────
app.get('/proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('Missing url');

  try {
    const targetUrl = decodeURIComponent(url);
    const parsed = new URL(targetUrl);

    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': parsed.origin,
      },
      redirect: 'follow',
    });

    const contentType = response.headers.get('content-type') || '';

    // Pass through non-HTML resources (images, fonts, CSS, JS)
    if (!contentType.includes('text/html')) {
      res.set('Content-Type', contentType);
      response.body.pipe(res);
      return;
    }

    let html = await response.text();
    const $ = cheerio.load(html);
    const base = parsed.origin;

    // Rewrite links to go through proxy
    const rewrite = (attr) => {
      $(`[${attr}]`).each((_, el) => {
        const val = $(el).attr(attr);
        if (!val || val.startsWith('data:') || val.startsWith('javascript:') || val.startsWith('#')) return;

        try {
          const abs = new URL(val, targetUrl).href;
          if (attr === 'href' && $(el).is('a')) {
            $(el).attr(attr, `/proxy?url=${encodeURIComponent(abs)}`);
          } else if (attr === 'src' || attr === 'href') {
            $(el).attr(attr, `/proxy?url=${encodeURIComponent(abs)}`);
          }
        } catch {}
      });
    };

    rewrite('href');
    rewrite('src');
    rewrite('action');

    // Rewrite srcset
    $('[srcset]').each((_, el) => {
      const srcset = $(el).attr('srcset');
      const rewritten = srcset.replace(/(\S+)(\s+\S+)?/g, (match, u, descriptor) => {
        try {
          const abs = new URL(u, targetUrl).href;
          return `/proxy?url=${encodeURIComponent(abs)}${descriptor || ''}`;
        } catch { return match; }
      });
      $(el).attr('srcset', rewritten);
    });

    // Inject script to break out of any frame detection
    $('head').prepend(`
      <base href="${base}">
      <script>
        // Disable frame-busting scripts
        Object.defineProperty(window, 'top', { get: () => window });
        Object.defineProperty(window, 'parent', { get: () => window });
        Object.defineProperty(window, 'frameElement', { get: () => null });
        // Add proxy toolbar
        window.__PROXY_URL__ = "${encodeURIComponent(targetUrl)}";
      </script>
    `);

    // Remove X-Frame-Options and CSP meta tags
    $('meta[http-equiv="X-Frame-Options"]').remove();
    $('meta[http-equiv="Content-Security-Policy"]').remove();

    // Inject top toolbar
    $('body').prepend(`
      <div id="__proxy_bar__" style="
        position:fixed;top:0;left:0;right:0;z-index:2147483647;
        background:#1a1a2e;color:#eee;font-family:monospace;font-size:12px;
        padding:6px 14px;display:flex;align-items:center;gap:10px;
        border-bottom:2px solid #e94560;box-shadow:0 2px 10px rgba(0,0,0,0.5);
      ">
        <a href="/" style="color:#e94560;font-weight:bold;text-decoration:none;letter-spacing:1px;">MATHS PROXY</a>
        <span style="color:#555;">|</span>
        <span style="color:#aaa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:500px;">${targetUrl}</span>
        <a href="javascript:history.back()" style="margin-left:auto;color:#aaa;text-decoration:none;">← Back</a>
        <a href="/" style="color:#aaa;text-decoration:none;">🔍 Search</a>
      </div>
      <div style="height:34px;"></div>
    `);

    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send($.html());

  } catch (err) {
    res.status(500).send(`
      <html><body style="font-family:monospace;padding:40px;background:#1a1a2e;color:#eee;">
        <h2 style="color:#e94560;">Proxy Error</h2>
        <p>${err.message}</p>
        <p><a href="/" style="color:#e94560;">← Back to search</a></p>
      </body></html>
    `);
  }
});

app.listen(PORT, () => console.log(`Maths Proxy running on port ${PORT}`));
