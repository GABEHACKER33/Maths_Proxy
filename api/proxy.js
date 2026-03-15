export default async function handler(req, res) {
  const TARGET_URL = process.env.TARGET_URL; // ej: https://api.ejemplo.com

  const { method, headers, body } = req;
  const path = req.url.replace('/api/proxy', '');

  try {
    const response = await fetch(`${TARGET_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SECRET_TOKEN}`,
        // ...otros headers que necesites
      },
      body: method !== 'GET' ? JSON.stringify(body) : undefined,
    });

    const data = await response.json();

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({ error: 'Proxy error', detail: error.message });
  }
}
