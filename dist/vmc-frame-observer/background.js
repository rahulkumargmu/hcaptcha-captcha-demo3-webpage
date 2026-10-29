// VMC frame observer — service worker (MV3). Stores frame-observer batches per tab in
// chrome.storage.local, records frame navigations (webNavigation) for the frame manifest, and
// returns the data to the experiment page when the website collector exports. It makes no
// network requests.
importScripts('config.js', 'hsw_capture_download.js');
const CFG = self.VMC_EXTENSION_CONFIG || {};
const EXPERIMENT_ORIGINS = CFG.experiment_origins || [CFG.experiment_origin];
const experimentOriginForUrl = (url) => {
  try {
    const origin = new URL(url).origin;
    return EXPERIMENT_ORIGINS.includes(origin) ? origin : null;
  } catch (_) { return null; }
};
const VERSION = chrome.runtime.getManifest().version;
// Optional opt-in source-capture transport (only present in the source-archiver build).
try { importScripts('source_scope.js', 'source_capture.js'); } catch (_) { /* base observer build has neither */ }
const SRC = (self.VMC_SourceCapture && CFG.source_capture) ? new self.VMC_SourceCapture(CFG.source_capture) : null;
const pad = (n) => String(n).padStart(8, '0');
const counters = new Map(); // tabId + experiment origin -> {frames:Set, snapshots, records, batches}

const counter = (tabId, origin) => {
  const key = tabId + '|' + origin;
  if (!counters.has(key)) counters.set(key, { frames: new Set(), snapshots: 0, records: 0, batches: 0, rebuilt: false });
  return counters.get(key);
};

async function rebuildCounter(tabId, sinceMs, origin) {
  const c = counter(tabId, origin);
  const all = await chrome.storage.local.get(null);
  c.frames = new Set(); c.snapshots = 0; c.records = 0; c.batches = 0;
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith(`b|${tabId}|`) || v.receipt_date_now_ms < sinceMs
        || experimentOriginForUrl(v.tab_url) !== origin) continue;
    c.frames.add(v.frame_id); c.batches++; c.records += v.batch.records.length;
    c.snapshots += v.batch.records.filter((r) => r.record_type === 'vm_snapshot').length;
  }
  c.rebuilt = true;
  return c;
}

chrome.webNavigation.onCommitted.addListener(async (d) => {
  if (d.tabId < 0) return;
  let activeOrigin;
  if (d.frameId === 0) {
    activeOrigin = experimentOriginForUrl(d.url);
  } else {
    // Only frames inside a tab currently showing the experiment page (the tab URL is readable
    // only for hosts in host_permissions).
    let tab = null;
    try { tab = await chrome.tabs.get(d.tabId); } catch (_) { return; }
    activeOrigin = tab && experimentOriginForUrl(tab.url);
  }
  if (!activeOrigin) return;
  const key = `n|${d.tabId}|${d.frameId}|${d.timeStamp.toFixed(3)}`;
  await chrome.storage.local.set({ [key]: { tab_id: d.tabId, frame_id: d.frameId, parent_frame_id: d.parentFrameId, url: d.url,
    browser_document_id: d.documentId || null, parent_document_id: d.parentDocumentId || null,
    transition_type: d.transitionType, time_stamp_ms: d.timeStamp, experiment_origin: activeOrigin } });
}, { url: [...EXPERIMENT_ORIGINS.map((origin) => ({ urlPrefix: origin + '/' })),
  ...(CFG.frame_url_prefixes || []).map((p) => ({ urlPrefix: p }))] });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (err) => sendResponse({ error: String(err) }));
  return true;
});

async function handle(msg, sender) {
  const tabId = sender.tab ? sender.tab.id : -1;
  const activeOrigin = experimentOriginForUrl(sender.tab && sender.tab.url);
  if (['frame_batch', 'site_hello', 'site_status', 'export', 'hsw_capture_begin', 'hsw_capture_chunk'].includes(msg.type)
      && !activeOrigin) return { error: 'not an experiment tab' };
  if (msg.type === 'frame_batch') {
    const batch = JSON.parse(msg.batch);
    const key = `b|${tabId}|${batch.document_id}|${pad(batch.batch_seq)}`;
    const existing = await chrome.storage.local.get(key);
    const rec = { tab_id: tabId, frame_id: sender.frameId, browser_document_id: sender.documentId || null,
      frame_url: sender.url || null, tab_url: sender.tab ? sender.tab.url || null : null,
      receipt_date_now_ms: Date.now(), duplicate_deliveries: existing[key] ? (existing[key].duplicate_deliveries || 0) + 1 : 0,
      batch: existing[key] ? existing[key].batch : batch };
    await chrome.storage.local.set({ [key]: rec });
    if (!existing[key]) {
      const c = counter(tabId, activeOrigin);
      c.frames.add(sender.frameId); c.batches++; c.records += batch.records.length;
      c.snapshots += batch.records.filter((r) => r.record_type === 'vm_snapshot').length;
    }
    return { ok: true };
  }
  if (msg.type === 'site_hello' || msg.type === 'site_status') {
    const tkey = `t|${tabId}|${activeOrigin}`;
    const st = (await chrome.storage.local.get(tkey))[tkey] || { hellos: [] };
    if (st.session_id !== msg.session_id) st.hellos = [];
    if (!st.hellos.some((h) => h.document_id === msg.document_id)) {
      st.hellos.push({ document_id: msg.document_id, install_date_now_ms: msg.install_date_now_ms || null, date_now_ms: Date.now() });
    }
    Object.assign(st, { session_id: msg.session_id, tab_url: sender.tab ? sender.tab.url : null });
    await chrome.storage.local.set({ [tkey]: st });
    const c = counter(tabId, activeOrigin).rebuilt ? counter(tabId, activeOrigin)
      : await rebuildCounter(tabId, msg.since_ms || 0, activeOrigin);
    return { extension_version: VERSION, extension_id: chrome.runtime.id, frames_observed: c.frames.size,
      vm_snapshots: c.snapshots, records: c.records, batches: c.batches };
  }
  if (msg.type === 'export') {
    const data = await exportData(tabId, msg.session_id, msg.since_ms || 0, activeOrigin);
    if (SRC && SRC.tabId === tabId) {
      try { data.source_archive = await SRC.export(msg.session_id); }
      catch (err) { data.source_archive = { error: String(err) }; }
    }
    return data;
  }
  if (msg.type === 'hsw_capture_begin' || msg.type === 'hsw_capture_chunk') {
    return self.VMC_saveHswCapture(msg, sender);
  }
  // ---- source capture message routing ---------------------------------------------------------
  // Privileged (arm/disarm/config/status) is accepted only from the extension's own UI, which sends
  // runtime messages with no sender.tab. The page bridge (sender.tab set) may only mark the analysis
  // window and pull body chunks for the already-armed tab; it can never attach the debugger.
  if (msg.type && msg.type.startsWith('srccap_')) {
    if (!SRC) return { error: 'source capture not built into this extension' };
    const fromExtensionUi = !sender.tab;
    if (msg.type === 'srccap_config') return fromExtensionUi
      ? { experiment_origin: CFG.source_capture.experiment_origin, scope: CFG.source_capture.scope || null }
      : { error: 'not allowed from page' };
    if (msg.type === 'srccap_status') return { status: SRC.status() };
    if (msg.type === 'srccap_arm') return fromExtensionUi ? SRC.arm(msg.tab_id, msg.tab_url)
      : { error: 'arming must come from the extension UI, not the page' };
    if (msg.type === 'srccap_disarm') return fromExtensionUi ? SRC.disarm() : { error: 'not allowed from page' };
    if (msg.type === 'srccap_mark') {
      if (!sender.tab || sender.tab.id !== SRC.tabId) return { error: 'not the armed tab' };
      return SRC.mark(msg.which);
    }
    if (msg.type === 'srccap_export_chunk') {
      if (!sender.tab || sender.tab.id !== SRC.tabId) return { error: 'not the armed tab' };
      return SRC.exportChunk(msg.sha256, msg.seq);
    }
    return { error: 'unknown source capture message' };
  }
  return { error: 'unknown message type' };
}

async function exportData(tabId, sessionId, sinceMs, activeOrigin) {
  const all = await chrome.storage.local.get(null);
  const st = all[`t|${tabId}|${activeOrigin}`] || { hellos: [] };
  const batches = Object.values(all).filter((v) => v && v.batch && v.tab_id === tabId
    && experimentOriginForUrl(v.tab_url) === activeOrigin && v.receipt_date_now_ms >= sinceMs)
    .sort((a, b) => (a.batch.document_id < b.batch.document_id ? -1 : a.batch.document_id > b.batch.document_id ? 1 : a.batch.batch_seq - b.batch.batch_seq));
  const navs = Object.values(all).filter((v) => v && v.time_stamp_ms !== undefined && v.tab_id === tabId
    && v.experiment_origin === activeOrigin && v.time_stamp_ms >= sinceMs - 60000);
  const helloTime = (h) => (h.install_date_now_ms || h.date_now_ms);
  const hellos = (st.hellos || []).slice().sort((a, b) => helloTime(a) - helloTime(b));
  const records = [], outBatches = [], docs = {};
  const seen = new Set();
  let dup = 0, snap = 0;
  for (const b of batches) {
    const fid = `frame-${b.frame_id}`;
    const bid = `${b.batch.document_id}#b${b.batch.batch_seq}`;
    dup += b.duplicate_deliveries || 0;
    outBatches.push({ document_id: b.batch.document_id, batch_seq: b.batch.batch_seq, frame_id: fid,
      sequence_high_watermark: b.batch.sequence_high_watermark, sent_date_now_ms: b.batch.sent_date_now_ms,
      receipt_date_now_ms: b.receipt_date_now_ms, browser_document_id: b.browser_document_id, duplicate_deliveries: b.duplicate_deliveries || 0 });
    const d = docs[b.batch.document_id] || (docs[b.batch.document_id] = { document_id: b.batch.document_id, frame_id: fid,
      browser_frame_id: b.frame_id, browser_document_id: b.browser_document_id, frame_url: b.frame_url, batches: 0, records: 0,
      first_receipt_ms: b.receipt_date_now_ms, install: null });
    d.batches++;
    for (const r of b.batch.records) {
      const k = `${r.document_id}:${r.document_sequence}`;
      if (seen.has(k)) { dup++; continue; }
      seen.add(k);
      d.records++;
      r.session_id = sessionId;
      r.frame_id = fid;
      r.page_id = 'page-1';
      r.transport_batch_id = bid;
      if (['event', 'coalesced_sample', 'vm_snapshot', 'vm_proof_call'].includes(r.record_type)) {
        r.top_level_url = b.tab_url || st.tab_url || null;
        r.top_level_url_source = 'extension_sender_tab_url';
      }
      if (r.record_type === 'collector_install') d.install = r;
      records.push(r);
    }
  }
  const snaps = records.filter((r) => r.record_type === 'vm_snapshot').sort((a, b) => a.cb_date_now_ms - b.cb_date_now_ms);
  for (const r of snaps) {
    r.snapshot_id = `snap-${String(++snap).padStart(4, '0')}`;
    // The frame document belongs to the website document that was installed most recently before
    // the frame document itself was installed (both times from the pages' own Date.now()).
    const od = docs[r.document_id];
    const t = od && od.install ? od.install.install_date_now_ms : r.cb_date_now_ms;
    const h = hellos.filter((x) => helloTime(x) <= t).pop();
    r.parent_document_id = h ? h.document_id : null;
    r.parent_document_id_source = 'extension: latest website document installed before the observing frame document was installed';
    r.parent_document_sequence_high_at_receipt = null;
    r.generation_time = { status: 'unknown', note: 'Generation happens in the parent page before the value reaches this frame. Bounds are derived in comparison.json.' };
  }
  // Frame manifest from webNavigation commits plus observer install records.
  const frames = new Map();
  const observerDocs = Object.values(docs);
  const late = [];
  for (const d of observerDocs) {
    const i = d.install || {};
    const reasons = [];
    if (i.ready_state_at_install && i.ready_state_at_install !== 'loading') reasons.push(`readyState ${i.ready_state_at_install} at install`);
    if (i.scripts_in_document_at_install) reasons.push(`${i.scripts_in_document_at_install} scripts before install`);
    for (const t of ((i.vm_observer || {}).proof_traps || [])) if (t.status !== 'installed') reasons.push(`proof trap ${t.name}: ${t.status}`);
    if (!d.install) reasons.push('no install record received');
    d.late_installation = reasons.length > 0;
    d.late_installation_reasons = reasons;
    if (reasons.length) late.push({ document_id: d.document_id, frame_id: d.frame_id, reasons });
  }
  for (const n of navs.sort((a, b) => a.time_stamp_ms - b.time_stamp_ms)) {
    if (n.frame_id === 0) continue; // the top-level frame is covered by the website collector
    const fid = `frame-${n.frame_id}`;
    const f = frames.get(fid) || { frame_id: fid, parent_frame_id: n.parent_frame_id >= 0 ? `frame-${n.parent_frame_id}` : null,
      page_id: 'page-1', is_main_frame: false, documents: [], navigations: [], source: 'extension_webNavigation' };
    const inScope = (CFG.frame_url_prefixes || []).some((p) => n.url.startsWith(p));
    const match = observerDocs.find((d) => d.frame_id === fid && d.install && d.install.install_date_now_ms >= n.time_stamp_ms - 2000
      && d.install.install_date_now_ms <= n.time_stamp_ms + 15000);
    f.navigations.push({ url: n.url, wall_ns: Math.round(n.time_stamp_ms * 1e6), browser_document_id: n.browser_document_id,
      transition_type: n.transition_type, probe: match
        ? { status: 'installed_install_record_received', reported_document_id: match.document_id, source: 'observer_install_record' }
        : { status: inScope ? 'collector_not_installed' : 'not_in_observer_scope', source: 'extension_webNavigation',
          note: inScope ? 'frame URL is in observer scope but no observer install record was received (e.g. extension loaded after the frame was created)' : 'frame URL outside the observer content-script matches' } });
    if (match && !f.documents.includes(match.document_id)) f.documents.push(match.document_id);
    frames.set(fid, f);
  }
  for (const d of observerDocs) {
    if (![...frames.values()].some((f) => f.documents.includes(d.document_id))) {
      const f = frames.get(d.frame_id) || { frame_id: d.frame_id, parent_frame_id: 'frame-0', page_id: 'page-1', is_main_frame: false,
        documents: [], navigations: [], source: 'observer_records_only' };
      f.documents.push(d.document_id);
      f.navigations.push({ url: d.frame_url, wall_ns: Math.round(((d.install || {}).install_date_now_ms || d.first_receipt_ms) * 1e6),
        probe: { status: 'installed_install_record_received', reported_document_id: d.document_id, source: 'observer_install_record',
          note: 'no webNavigation commit recorded for this document (e.g. committed before the service worker started)' } });
      frames.set(d.frame_id, f);
    }
  }
  const limitations = [];
  if (!observerDocs.length) limitations.push('The frame observer received no data for this tab: iframe events and VM snapshots are missing.');
  for (const l of late) limitations.push(`Late or incomplete observer installation in ${l.frame_id} (${l.document_id}): ${l.reasons.join('; ')}. Earlier history in that document is missing.`);
  const gapCount = [...frames.values()].reduce((a, f) => a + f.navigations.filter((n) => n.probe.status === 'collector_not_installed').length, 0);
  if (gapCount) limitations.push(`${gapCount} hCaptcha frame navigation(s) without an observer document.`);
  return {
    records, batches: outBatches, duplicate_records: dup,
    manifest: {
      extension: { name: chrome.runtime.getManifest().name, version: VERSION, id: chrome.runtime.id },
      config: { ...CFG, experiment_origin: activeOrigin, experiment_url: activeOrigin + '/' }, frames: [...frames.values()],
      observer_documents: observerDocs.map(({ install, ...rest }) => ({ ...rest, install_date_now_ms: install ? install.install_date_now_ms : null })),
      late_installations: late, website_documents_reported: hellos,
      summary: { frames_observed: new Set(observerDocs.map((d) => d.frame_id)).size, vm_snapshots: snaps.length, records: records.length,
        batches: outBatches.length, late_installations: late.length, frames_without_observer: gapCount, duplicate_records: dup },
      limitations,
      resource_urls: observerDocs.map((d) => d.frame_url).filter(Boolean),
      clock: 'receipt_date_now_ms is the service worker Date.now() when a batch arrived',
    },
  };
}
