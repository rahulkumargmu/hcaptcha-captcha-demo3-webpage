// VMC frame observer — isolated-world bridge (content script, document_start, all frames).
// In hCaptcha frames of the experiment page: relays observer batches to the service worker.
// In the experiment page itself: answers the website collector (status, export).
// Communication with page-world code uses CustomEvents on `document` with JSON string details.
(() => {
  const CFG = self.VMC_EXTENSION_CONFIG || {};
  const isTop = window.top === window;
  const topOrigin = (() => {
    try {
      if (isTop) return location.origin;
      const ao = location.ancestorOrigins;
      return ao && ao.length ? ao[ao.length - 1] : null;
    } catch (_) { return null; }
  })();
  const experimentOrigins = CFG.experiment_origins || [CFG.experiment_origin];
  if (!experimentOrigins.includes(topOrigin)) return;

  const send = (msg) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : res));
    } catch (err) { resolve({ error: String(err) }); }
  });
  const toPage = (type, detail) => document.dispatchEvent(new CustomEvent(type, { detail: JSON.stringify(detail) }));

  if (!isTop) {
    document.addEventListener('vmc:frame-batch', (e) => { send({ type: 'frame_batch', batch: e.detail }); });
    document.addEventListener('vmc:hsw-capture', async (e) => {
      let payload;
      try { payload = JSON.parse(e.detail); } catch (_) { return; }
      const report = payload && payload.report;
      if (typeof report !== 'string') return;
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const size = 256 * 1024;
      const count = Math.max(1, Math.ceil(report.length / size));
      const begin = await send({ type: 'hsw_capture_begin', id, count, runId: payload.runId, href: payload.href || location.href });
      if (!begin || begin.error) {
        console.warn('[HSW capture] extension did not accept the report', begin && begin.error);
        return;
      }
      for (let seq = 0; seq < count; seq++) {
        const res = await send({ type: 'hsw_capture_chunk', id, seq, chunk: report.slice(seq * size, seq * size + size) });
        if (!res || res.error) {
          console.warn('[HSW capture] download failed', res && res.error);
          return;
        }
        if (res.filename) console.info('[HSW capture] saved', res.filename);
      }
    });
    document.addEventListener('vmc:observer-ping', () => toPage('vmc:bridge-ready', {}));
    toPage('vmc:bridge-ready', {});
    return;
  }
  document.addEventListener('vmc:site-to-ext', async (e) => {
    let m;
    try { m = JSON.parse(e.detail); } catch (_) { return; }
    if (m.type === 'hello' || m.type === 'status') {
      const res = await send({ type: 'site_' + m.type, session_id: m.session_id, document_id: m.document_id,
        install_date_now_ms: m.install_date_now_ms, since_ms: m.since_ms });
      toPage('vmc:ext-to-site', { type: 'status', ...res });
    } else if (m.type === 'export') {
      const res = await send({ type: 'export', session_id: m.session_id, since_ms: m.since_ms });
      toPage('vmc:ext-to-site', { type: 'export_data', request_id: m.request_id, ...res });
    } else if (m.type === 'srccap_mark') {
      // Analysis-window mark only. It never attaches the debugger; the service worker still checks
      // that this is the armed tab.
      send({ type: 'srccap_mark', which: m.which });
    } else if (m.type === 'srccap_export_chunk') {
      const res = await send({ type: 'srccap_export_chunk', sha256: m.sha256, seq: m.seq });
      toPage('vmc:ext-to-site', { type: 'srccap_response', request_id: m.request_id, ...res });
    }
  });
})();
