const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Keep-alive for Render free tier
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  setInterval(() => fetch(RENDER_URL + '/ping').catch(() => {}), 14 * 60 * 1000);
}
app.get('/ping', (_, res) => res.send('pong'));

// ── DuckDuckGo Search API ─────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json({ results: [] });
  try {
    const cheerio = require('cheerio');
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
      const title = titleEl.text().trim();
      const snippet = $(el).find('.result__snippet').text().trim();
      const displayUrl = $(el).find('.result__url').text().trim();
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

// ── Bare server (Service Worker fetch relay) ──────────────────
// The SW sends requests here to be fetched server-side
app.use('/bare/', async (req, res) => {
  // Decode the target URL from the path or header
  const target = req.headers['x-bare-url'] || req.query.url;
  if (!target) return res.status(400).json({ error: 'No target URL' });

  let targetUrl;
  try {
    targetUrl = decodeURIComponent(target);
    if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;
  } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  try {
    const headers = {};
    // Forward select headers from the original request
    const forward = ['accept','accept-language','accept-encoding','content-type',
                     'referer','origin','cookie','authorization','cache-control'];
    forward.forEach(h => { if (req.headers[h]) headers[h] = req.headers[h]; });
    headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36';

    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: ['GET','HEAD'].includes(req.method) ? undefined : req,
      redirect: 'manual', // handle redirects ourselves
    });

    // Copy response headers
    const skipHeaders = new Set(['content-encoding','transfer-encoding','connection',
      'x-frame-options','content-security-policy','x-content-type-options']);
    upstream.headers.forEach((v, k) => {
      if (!skipHeaders.has(k.toLowerCase())) {
        try { res.set(k, v); } catch {}
      }
    });

    // Handle redirects — return 200 with redirect info so SW can handle
    if ([301,302,303,307,308].includes(upstream.status)) {
      const loc = upstream.headers.get('location');
      return res.status(200).json({
        __redirect: true,
        status: upstream.status,
        location: loc,
      });
    }

    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', '*');
    res.set('Access-Control-Allow-Methods', '*');
    res.set('x-bare-status', String(upstream.status));
    res.set('x-bare-status-text', upstream.statusText || 'OK');
    res.status(upstream.status);
    upstream.body.pipe(res);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CORS preflight
app.options('/bare/*', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', '*');
  res.set('Access-Control-Allow-Methods', '*');
  res.sendStatus(204);
});

// ── Supabase auth endpoints (optional server-side) ────────────
// Auth is handled client-side via Supabase JS SDK

app.listen(PORT, () => console.log(`✓ Maths Proxy SW on port ${PORT}`));
