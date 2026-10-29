// Saves a finished __hswCapture report from an experiment hCaptcha frame.
// The page script chunks the JSON through the isolated-world bridge. This file
// makes no network requests; chrome.downloads writes a local file.
const HSW_CHUNK = 256 * 1024;
const HSW_MAX_CHUNKS = 256;
const hswPending = new Map();

function hswFrameAllowed(sender) {
  const cfg = self.VMC_EXTENSION_CONFIG || {};
  if (!sender.tab || sender.tab.id < 0) return false;
  const tabUrl = sender.tab.url || '';
  const frameUrl = sender.url || '';
  const experimentOrigins = cfg.experiment_origins || [cfg.experiment_origin];
  if (!experimentOrigins.some((origin) => tabUrl.startsWith(origin + '/'))) return false;
  return (cfg.frame_url_prefixes || []).some((p) => frameUrl.startsWith(p));
}

function hswDrop(id) {
  const row = hswPending.get(id);
  if (row && row.timer) clearTimeout(row.timer);
  hswPending.delete(id);
}

async function saveHswReport(text, runId) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `vmc/hsw-capture-run-${runId == null ? 'x' : runId}-${stamp}.json`;
  // MV3 service workers do not expose URL.createObjectURL. A data URL keeps
  // the original report text local and works with the downloads permission.
  try {
    const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(text);
    const downloadId = await chrome.downloads.download({
      url, filename, saveAs: false, conflictAction: 'uniquify',
    });
    return { ok: true, filename, downloadId, via: 'data-url' };
  } catch (err) {
    return { error: 'download failed: ' + err };
  }
}

self.VMC_saveHswCapture = async function (msg, sender) {
  if (!hswFrameAllowed(sender)) return { error: 'not an experiment hCaptcha frame' };
  const tabId = sender.tab.id;
  if (msg.type === 'hsw_capture_begin') {
    const count = msg.count;
    if (!Number.isInteger(count) || count < 1 || count > HSW_MAX_CHUNKS) return { error: 'bad chunk count' };
    const id = String(msg.id || '');
    if (!id || id.length > 80) return { error: 'bad capture id' };
    hswDrop(id);
    const row = {
      tabId, count, runId: Number.isInteger(msg.runId) ? msg.runId : null,
      chunks: new Array(count), got: 0,
    };
    row.timer = setTimeout(() => hswDrop(id), 60000);
    hswPending.set(id, row);
    return { ok: true };
  }
  if (msg.type === 'hsw_capture_chunk') {
    const id = String(msg.id || '');
    const row = hswPending.get(id);
    if (!row || row.tabId !== tabId) return { error: 'unknown capture' };
    if (!Number.isInteger(msg.seq) || msg.seq < 0 || msg.seq >= row.count) return { error: 'bad chunk seq' };
    if (typeof msg.chunk !== 'string' || msg.chunk.length > HSW_CHUNK) return { error: 'bad chunk' };
    if (row.chunks[msg.seq] == null) row.got++;
    row.chunks[msg.seq] = msg.chunk;
    if (row.got < row.count) return { ok: true };
    if (row.chunks.some((part) => typeof part !== 'string')) return { error: 'incomplete capture' };
    const text = row.chunks.join('');
    const runId = row.runId;
    hswDrop(id);
    return saveHswReport(text, runId);
  }
  return { error: 'unknown hsw capture message' };
};
