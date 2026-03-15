// Maths Proxy — Service Worker registration
(function () {
  const PROXY_PREFIX = '/browse/';

  function encodeUrl(url) {
    return btoa(unescape(encodeURIComponent(url)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  // Register the service worker
  async function registerSW() {
    if (!('serviceWorker' in navigator)) return false;
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
      return true;
    } catch (e) {
      console.warn('SW registration failed:', e);
      return false;
    }
  }

  // Navigate to a URL through the proxy
  window.mpNavigate = function (url) {
    if (!url) return;
    if (!url.startsWith('http')) url = 'https://' + url;
    window.location.href = PROXY_PREFIX + encodeUrl(url);
  };

  // Initialize
  registerSW().then(ok => {
    window.__MP_SW_READY = ok;
    document.dispatchEvent(new CustomEvent('mp:ready', { detail: { sw: ok } }));
  });
})();
