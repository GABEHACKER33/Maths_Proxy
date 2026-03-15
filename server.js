const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
// Parse JSON bodies (from SW)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Keep-alive for Render free tier
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  setInterval(() => fetch(RENDER_URL + '/ping').catch(() => {}), 14 * 60 * 1000);
}
app.get('/ping', (_, res) => res.send('pong'));

// ── CORS headers for all routes ───────────────────────────────
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── DuckDuckGo Search ─────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json({ results: [] });
  try {
    const r = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=es-es`,
      { headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,*/*;q=0.8',
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

// ── /bare/ — core proxy endpoint ─────────────────────────────
// Called by the Service Worker with a JSON body containing:
// { url, method, headers, body }
// Returns JSON: { status, contentType, headers, body (base64) }

app.post('/bare/', async (req, res) => {
  // Get target URL from JSON body or header
  const payload = req.body || {};
  const targetUrl = payload.url || req.headers['x-bare-url'];

  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing target URL' });
  }

  // Validate URL
  let parsed;
  try {
    const decoded = decodeURIComponent(targetUrl);
    parsed = new URL(decoded.startsWith('http') ? decoded : 'https://' + decoded);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid URL: ' + targetUrl });
  }

  const method = (payload.method || 'GET').toUpperCase();
  const fwdHeaders = payload.headers || {};

  // Build request headers — spoof as real browser visiting the site
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': fwdHeaders['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': fwdHeaders['accept-language'] || 'es-ES,es;q=0.9,en;q=0.8',
    'Accept-Encoding': 'identity',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Host': parsed.host,
    'Referer': fwdHeaders['referer'] || parsed.origin + '/',
    'Origin': fwdHeaders['origin'] || parsed.origin,
  };

  // Forward cookie if present
  if (fwdHeaders['cookie']) headers['Cookie'] = fwdHeaders['cookie'];
  if (fwdHeaders['authorization']) headers['Authorization'] = fwdHeaders['authorization'];
  if (fwdHeaders['content-type']) headers['Content-Type'] = fwdHeaders['content-type'];

  const body = ['GET','HEAD'].includes(method) ? undefined : (payload.body || undefined);

  try {
    const upstream = await fetch(parsed.href, {
      method,
      headers,
      body,
      redirect: 'manual',
      follow: 0,
    });

    // Handle redirects
    if ([301, 302, 303, 307, 308].includes(upstream.status)) {
      const loc = upstream.headers.get('location') || '';
      let newLoc = loc;
      try { newLoc = new URL(loc, parsed.href).href; } catch {}
      return res.json({ __redirect: true, status: upstream.status, location: newLoc });
    }

    // Collect safe response headers
    const resHeaders = {};
    const strip = new Set([
      'transfer-encoding', 'connection', 'keep-alive',
      'x-frame-options', 'content-security-policy', 'x-content-type-options',
      'strict-transport-security', 'permissions-policy',
      'cross-origin-opener-policy', 'cross-origin-embedder-policy',
      'cross-origin-resource-policy',
    ]);
    upstream.headers.forEach((v, k) => {
      if (!strip.has(k.toLowerCase())) resHeaders[k] = v;
    });

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';

    // Read full body as buffer → base64
    const buffer = await upstream.buffer();
    const base64 = buffer.toString('base64');

    return res.json({
      status: upstream.status,
      contentType,
      headers: resHeaders,
      body: base64,
    });

  } catch (err) {
    console.error('[bare] fetch error:', parsed.href, err.message);
    return res.status(502).json({ error: err.message });
  }
});

// GET /bare/ fallback for debugging
app.get('/bare/', (req, res) => {
  res.json({ status: 'Maths Proxy bare server v5 running' });
});

app.listen(PORT, () => console.log(`✓ Maths Proxy v5 on port ${PORT}`));
