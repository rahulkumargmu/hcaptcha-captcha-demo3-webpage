  // ==== website addon (collection_context = site_collector) =====================================
  // Inserted by collector/build.py into the core's scope. Continuous parent-page collection on
  // the experiment website: per-tab session identity, in-page store with IndexedDB persistence,
  // Record/Stop analysis-window markers, local export (zip in the existing file layout), iframe
  // geometry sampling, and a CustomEvent link to the optional frame observer extension.
  (function siteAddon() {
    const SITE = CFG.site || {};
    const SS_KEY = 'vmc.site.session';
    const FRAME_ID = IS_TOP ? 'frame-0' : 'frame-unknown-' + randomHex(4);
    const PAGE_ID = 'page-1';

    // ---- session identity (per browser tab) -----------------------------------------------------
    let SESSION_ID = null, PREV_DOC = null, sessionIdSource = 'sessionStorage', openWindow = null;
    const wantNew = /[?&]vmc=new-session(&|$)/.test(location.search);
    try {
      const raw = sessionStorage.getItem(SS_KEY);
      const st = raw && !wantNew ? jsonParse(raw) : null;
      if (st && st.session_id) {
        SESSION_ID = st.session_id;
        PREV_DOC = st.last_document_id || null;
        openWindow = st.open_window || null;
      } else {
        SESSION_ID = 'site-' + new Date(INSTALL_DATE_NOW).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') + '-' + randomHex(3);
        sessionIdSource = wantNew ? 'new_by_url_parameter' : 'new';
      }
    } catch (err) {
      SESSION_ID = 'site-nostorage-' + randomHex(4);
      sessionIdSource = 'storage_unavailable';
      diag('session_storage_unavailable', { error: errText(err) });
    }
    const saveSessionState = () => {
      try {
        sessionStorage.setItem(SS_KEY, jsonStringify({ session_id: SESSION_ID, last_document_id: DOC_ID, open_window: openWindow }));
      } catch (_) {}
    };
    saveSessionState();
    if (openWindow) currentWindowId = openWindow.id;

    // ---- store and persistence ----------------------------------------------------------------------
    const mem = { batches: [], records: 0 };
    let droppedTotal = 0;
    let db = null, dbState = 'opening', persisted = 0, persistErrors = 0;
    const pendingPersist = [];
    const persist = (b) => {
      if (dbState === 'opening') { pendingPersist.push(b); return; }
      if (dbState !== 'open') return;
      try {
        const tx = db.transaction('batches', 'readwrite');
        tx.objectStore('batches').put(b);
        tx.oncomplete = () => { persisted++; };
        tx.onerror = () => { persistErrors++; diag('persistence_error', { batch: b.key, error: String(tx.error) }); };
      } catch (err) { persistErrors++; diag('persistence_error', { batch: b.key, error: errText(err) }); }
    };
    try {
      const req = indexedDB.open('vmc-site-collector', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('batches')) d.createObjectStore('batches', { keyPath: 'key' }).createIndex('session', 'session_id');
      };
      req.onsuccess = () => { db = req.result; dbState = 'open'; for (const b of pendingPersist.splice(0)) persist(b); };
      req.onerror = () => { dbState = 'unavailable'; diag('persistence_unavailable', { error: String(req.error) }); };
    } catch (err) { dbState = 'unavailable'; diag('persistence_unavailable', { error: errText(err) }); }
    const idbSessionBatches = () => new Promise((resolve) => {
      if (dbState !== 'open') return resolve([]);
      try {
        const rq = db.transaction('batches', 'readonly').objectStore('batches').index('session').getAll(SESSION_ID);
        rq.onsuccess = () => resolve(rq.result || []);
        rq.onerror = () => { diag('persistence_error', { where: 'export_read', error: String(rq.error) }); resolve([]); };
      } catch (err) { diag('persistence_error', { where: 'export_read', error: errText(err) }); resolve([]); }
    });

    const STASH_KEY = 'vmc.site.pending';
    const stash = (meta) => {
      try {
        const cur = jsonParse(sessionStorage.getItem(STASH_KEY) || '[]');
        cur.push(meta);
        sessionStorage.setItem(STASH_KEY, jsonStringify(cur));
      } catch (err) { diag('persistence_error', { where: 'unload_stash', error: errText(err) }); }
    };
    const recovered = [];
    try {
      const pending = jsonParse(sessionStorage.getItem(STASH_KEY) || '[]');
      sessionStorage.removeItem(STASH_KEY);
      for (const m of pending) {
        if (m && m.session_id === SESSION_ID) { recovered.push(m); persist(m); }
      }
    } catch (err) { diag('persistence_error', { where: 'unload_stash_recovery', error: errText(err) }); }

    const STAMP_TOP_URL = new Set(['event', 'coalesced_sample']);
    transport = {
      name: 'site_local_store',
      available: () => true,
      send: (batch) => {
        const bid = batch.document_id + '#b' + batch.batch_seq;
        for (const r of batch.records) {
          r.session_id = SESSION_ID;
          r.frame_id = FRAME_ID;
          r.page_id = PAGE_ID;
          r.transport_batch_id = bid;
          if (IS_TOP && STAMP_TOP_URL.has(r.record_type)) {
            r.top_level_url = r.frame_url || location.href;
            r.top_level_url_source = 'in_page_location';
            if ('client_x' in r && 'client_y' in r) r.main_viewport = { x: r.client_x, y: r.client_y, status: 'identity_main_frame' };
            for (const lst of ['touches', 'changed_touches', 'target_touches']) {
              for (const t of r[lst] || []) {
                if ('client_x' in t && 'client_y' in t) t.main_viewport = { x: t.client_x, y: t.client_y, status: 'identity_main_frame' };
              }
            }
          }
        }
        const meta = {
          key: SESSION_ID + '|' + batch.document_id + '|' + String(batch.batch_seq).padStart(8, '0'),
          session_id: SESSION_ID, document_id: batch.document_id, batch_seq: batch.batch_seq, reason: batch.reason,
          sent_date_now_ms: batch.sent_date_now_ms, sent_perf_now_ms: batch.sent_perf_now_ms,
          sequence_high_watermark: batch.sequence_high_watermark, diagnostic_counts: batch.diagnostic_counts,
          stored_date_now_ms: dateNow(), records: batch.records,
        };
        for (const r of batch.records) {
          if (r.record_type === 'collector_diagnostic' && r.kind === 'queue_overflow') droppedTotal += (r.details || {}).dropped_records || 0;
        }
        mem.batches.push(meta);
        mem.records += batch.records.length;
        persist(meta);
        // IndexedDB writes are asynchronous and may not finish during pagehide; the final batch is
        // also written synchronously to sessionStorage and moved to IndexedDB by the next document.
        if (batch.reason === 'pagehide' || batch.reason === 'visibilitychange') stash(meta);
      },
    };

    hooks.install.push((install) => {
      install.session_id_source = sessionIdSource;
      install.previous_document_id = PREV_DOC;
    });

    // ---- hCaptcha loader detection (for the "before hCaptcha initialization" status) ----------------
    const hc = { present_at_install: typeof window.hcaptcha !== 'undefined', first_seen_ms: null };
    const hcPoll = setInterval(() => {
      if (typeof window.hcaptcha !== 'undefined') {
        clearInterval(hcPoll);
        hc.first_seen_ms = dateNow();
        const r = base('collector_marker');
        r.marker = 'hcaptcha_global_first_seen';
        r.cb_date_now_ms = hc.first_seen_ms;
        r.cb_perf_now_ms = perfNow();
        r.details = { polling_interval_ms: 50 };
        push(r);
      }
    }, 50);

    // ---- iframe geometry sampling (parent side, for offline coordinate translation) -----------------
    const lastGeom = new WeakMap();
    const sampleIframes = (trigger) => {
      let frames;
      try { frames = Array.from(document.querySelectorAll('iframe')); } catch (_) { return; }
      for (const f of frames) {
        try {
          const b = R(getRect, f, []);
          const cs = getComputedStyle(f);
          let transformed = 0;
          for (let n = f; n && n.nodeType === 1; n = n.parentElement) {
            const s = getComputedStyle(n);
            if (s.transform !== 'none' || (s.zoom && s.zoom !== '1' && s.zoom !== 'normal')) transformed++;
          }
          const g = {
            rect: { x: b.x, y: b.y, width: b.width, height: b.height },
            client_left: f.clientLeft, client_top: f.clientTop,
            padding_left: parseFloat(cs.paddingLeft) || 0, padding_top: parseFloat(cs.paddingTop) || 0,
            offset_width: f.offsetWidth, offset_height: f.offsetHeight, transformed_elements: transformed,
            visible: b.width > 0 && b.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
            src: f.getAttribute('src'),
          };
          const key = jsonStringify(g);
          if (lastGeom.get(f) === key) continue;
          lastGeom.set(f, key);
          const r = base('iframe_geometry');
          r.cb_date_now_ms = dateNow();
          r.cb_perf_now_ms = perfNow();
          r.trigger = trigger;
          r.iframe = ref(f, r.record_id);
          Object.assign(r, g);
          push(r);
        } catch (err) { diag('handler_error', { where: 'iframe_geometry', error: errText(err) }); }
      }
    };
    setInterval(() => sampleIframes('poll_detected_change'), 250);
    hooks.event.push((e) => {
      if (e.type === 'resize' || e.type === 'scroll') sampleIframes(e.type);
    });

    // ---- frame observer link (extension bridge, optional) -------------------------------------------
    const EXT = { state: 'waiting', info: null, last_ms: null };
    const CEv = window.CustomEvent;
    const dispatch = EventTarget.prototype.dispatchEvent;
    const toExt = (msg) => {
      try { R(dispatch, document, [new CEv('vmc:site-to-ext', { detail: jsonStringify(msg) })]); } catch (_) {}
    };
    const pendingExport = new Map();
    R(addEL, document, ['vmc:ext-to-site', (e) => {
      try {
        const m = jsonParse(e.detail);
        if (m.type === 'status') { EXT.state = 'available'; EXT.info = m; EXT.last_ms = dateNow(); }
        else if ((m.type === 'export_data' || m.type === 'srccap_response') && pendingExport.has(m.request_id)) { pendingExport.get(m.request_id)(m); pendingExport.delete(m.request_id); }
      } catch (err) { diag('handler_error', { where: 'extension_bridge', error: errText(err) }); }
    }]);
    const hello = (type) => toExt({ type, protocol: 1, session_id: SESSION_ID, document_id: DOC_ID,
      install_date_now_ms: INSTALL_DATE_NOW, since_ms: INSTALL_DATE_NOW - 60000 });
    setInterval(() => {
      hello('status');
      if (EXT.state === 'waiting' && dateNow() - INSTALL_DATE_NOW > 3000) EXT.state = 'not_detected';
      if (EXT.state === 'available' && dateNow() - EXT.last_ms > 5000) EXT.state = 'stale';
    }, 1000);
    const requestFrameData = (sinceMs) => new Promise((resolve) => {
      if (EXT.state !== 'available') return resolve(null);
      const id = randomHex(6);
      const timer = setTimeout(() => { pendingExport.delete(id); resolve({ error: 'timeout waiting for the frame observer' }); }, 15000);
      pendingExport.set(id, (m) => { clearTimeout(timer); resolve(m); });
      toExt({ type: 'export', request_id: id, session_id: SESSION_ID, since_ms: sinceMs });
    });
    const requestChunk = (sha, seq) => new Promise((resolve) => {
      const id = randomHex(6);
      const timer = setTimeout(() => { pendingExport.delete(id); resolve({ error: 'timeout waiting for a body chunk' }); }, 15000);
      pendingExport.set(id, (m) => { clearTimeout(timer); resolve(m); });
      toExt({ type: 'srccap_export_chunk', request_id: id, sha256: sha, seq });
    });
    // Reassemble each archived body from bounded base64 chunks, verifying the running sha256 and the
    // declared byte length before it is written to the zip. A body that fails verification is skipped
    // and reported, never written under its claimed name.
    const collectAssetFiles = async (archive) => {
      const files = [], results = [];
      if (!archive || archive.error || !archive.body_index) return { files, results, error: archive && archive.error };
      const b64ToBytes = (b64) => { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
      for (const bi of archive.body_index) {
        let b64 = '';
        for (let seq = 0; seq < 100000; seq++) {
          const r = await requestChunk(bi.sha256, seq);
          if (r.error) { results.push({ sha256: bi.sha256, status: 'chunk_error', detail: r.error }); b64 = null; break; }
          b64 += r.data || '';
          if (r.is_last) break;
        }
        if (b64 === null) continue;
        const bytes = b64ToBytes(b64);
        let sha = null;
        try { sha = hex(await crypto.subtle.digest('SHA-256', bytes)); } catch (_) {}
        if (bytes.length !== bi.byte_length || (sha && sha !== bi.sha256)) {
          results.push({ sha256: bi.sha256, status: 'verification_failed', got_length: bytes.length, got_sha256: sha });
          continue;
        }
        files.push({ name: bi.archive_path, data: bytes });
        results.push({ sha256: bi.sha256, status: 'written', bytes: bytes.length });
      }
      return { files, results };
    };

    // ---- analysis windows ----------------------------------------------------------------------------
    const recordWindow = () => {
      if (openWindow) return;
      const dn = dateNow(), pn = perfNow();
      const id = emitMarker('analysis_window_started', 'panel:record-button', { dateNow: dn, perfNow: pn, flush: true,
        details: { note: 'analysis-window start only; collection is continuous and the clock is not reset' } });
      openWindow = { id, started_ms: dn };
      currentWindowId = id;
      toExt({ type: 'srccap_mark', which: 'record' });
      saveSessionState();
    };
    const stopWindow = () => {
      if (!openWindow) return;
      const dn = dateNow(), pn = perfNow();
      emitMarker('analysis_window_stopped', 'panel:stop-button', { dateNow: dn, perfNow: pn, flush: true,
        details: { window_id: openWindow.id, started_ms: openWindow.started_ms, duration_ms: dn - openWindow.started_ms } });
      openWindow = null;
      currentWindowId = null;
      toExt({ type: 'srccap_mark', which: 'stop' });
      saveSessionState();
    };

    // ---- export -----------------------------------------------------------------------------------------
    const enc = new TextEncoder();
    const crcTable = (() => {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
      return t;
    })();
    const crc32 = (u8) => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
    const makeZip = (files) => {
      const parts = [], central = [];
      let offset = 0;
      const d = new Date();
      const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
      const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
      for (const f of files) {
        const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
        const lh = new DataView(new ArrayBuffer(30));
        lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
        lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true);
        lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
        parts.push(new Uint8Array(lh.buffer), name, f.data);
        const ch = new DataView(new ArrayBuffer(46));
        ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
        ch.setUint16(10, 0, true); ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true);
        ch.setUint32(20, size, true); ch.setUint32(24, size, true); ch.setUint16(28, name.length, true);
        ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true);
        ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
        central.push(new Uint8Array(ch.buffer), name);
        offset += 30 + name.length + size;
      }
      const cdSize = central.reduce((a, p) => a + p.length, 0);
      const end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
      end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
      return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
    };
    const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

    const NODE_TYPES = { node: 'nodes', node_state: 'node_states', inventory: 'inventories' };
    const VM_TYPES = new Set(['vm_snapshot', 'vm_proof_call', 'vm_proof_outcome']);

    const buildExport = async () => {
      const exportMs = dateNow();
      emitMarker('export_requested', 'panel:export-button', { dateNow: exportMs, perfNow: perfNow(), flush: true });
      const byKey = new Map();
      for (const b of await idbSessionBatches()) byKey.set(b.key, b);
      for (const b of recovered) if (!byKey.has(b.key)) byKey.set(b.key, b);
      for (const b of mem.batches) byKey.set(b.key, b);
      const batches = [...byKey.values()].sort((a, b) => (a.sent_date_now_ms - b.sent_date_now_ms) || (a.key < b.key ? -1 : 1));
      const siteRecords = [];
      for (const b of batches) for (const r of b.records) siteRecords.push(r);
      let startMs = INSTALL_DATE_NOW;
      for (const r of siteRecords) if (typeof r.cb_date_now_ms === 'number' && r.cb_date_now_ms < startMs) startMs = r.cb_date_now_ms;
      const frame = await requestFrameData(startMs);
      const frameRecords = frame && frame.records ? frame.records : [];
      const frameBatches = frame && frame.batches ? frame.batches : [];
      const assetBundle = await collectAssetFiles(frame && frame.source_archive);
      const split = (records) => {
        const out = { events: [], nodes: { nodes: [], node_states: [], inventories: [] }, vm: [] };
        for (const r of records) {
          if (NODE_TYPES[r.record_type]) out.nodes[NODE_TYPES[r.record_type]].push(r);
          else if (VM_TYPES.has(r.record_type)) out.vm.push(r);
          else out.events.push(r);
        }
        return out;
      };
      const site = split(siteRecords), fo = split(frameRecords);

      // hsw context rows (level B only), export_version 2. One contract, shared with
      // collector/hswctx.py: a row is written for every proof call whose second argument was a non-null
      // object (ctx.status === 'object') and whose record carries a ctx_verbatim key (key presence, not
      // truthiness). Rows are numbered over all frames in (cb_date_now_ms, record_id) order and hold
      // exactly what the legacy DevTools harvester computes: undefined/absent properties are omitted,
      // explicit nulls kept (href omitted when null), jwt_len = String(first argument).length, vm_len =
      // String(ctx.vm_data).length. Provenance goes to provenance/hsw_ctx_index.json, never into the
      // rows. The JWT text and proof results are never stored.
      const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
      const isNum = (v) => typeof v === 'number';
      const snapByCall = new Map();
      for (const r of fo.vm) if (r.record_type === 'vm_snapshot' && r.proof_call_id && !snapByCall.has(r.proof_call_id)) snapByCall.set(r.proof_call_id, r);
      const rowExpected = (c) => !!c.ctx && c.ctx.status === 'object' && own(c, 'ctx_verbatim');
      const INDEX_KEY = /^(0|[1-9][0-9]*)$/;
      const HARVESTED = ['href', 'ardata', 'uj_data'];
      const secondArg = (c) => {
        const x = c.ctx;
        if (!x || !x.status) return { status: 'unrecorded' };
        if (x.status === 'absent') return { status: 'absent', argument_count: c.arg_count };
        if (x.status === 'not_object') return { status: x.type === 'null' ? 'null' : 'primitive', type: x.type };
        if (x.status !== 'object') return { status: 'unrecorded', recorded_status: x.status };
        const keys = (x.keys || []).filter((k) => typeof k === 'string');
        const idx = keys.filter((k) => INDEX_KEY.test(k));
        let contiguous = keys.length > 0 && idx.length === keys.length;
        if (contiguous) { const nums = keys.map(Number).sort((a, b) => a - b); contiguous = nums.every((n, i) => n === i); }
        const harvested = HARVESTED.concat(['vm_data']).filter((k) => keys.includes(k));
        const shape = !keys.length ? 'empty_object' : contiguous ? 'array_like_contiguous_index_keys' : harvested.length ? 'context_object' : 'other_object';
        return { status: 'object', shape, own_enumerable_key_count: keys.length, array_index_key_count: idx.length,
          harvester_keys_present: harvested, vm_data_present: x.vm_data_present };
      };
      const category = (c) => {
        const a = secondArg(c);
        if (a.status === 'absent') return c.arg_count === 1 ? 'single_argument_call' : 'no_arguments';
        if (a.status === 'null' || a.status === 'primitive') return a.status + '_second_argument';
        if (a.status !== 'object') return 'unrecorded';
        return { empty_object: 'empty_object_second_argument', array_like_contiguous_index_keys: 'array_like_second_argument',
          context_object: a.vm_data_present ? 'context_object_with_vm_data' : 'context_object_without_vm_data',
          other_object: 'other_object_second_argument' }[a.shape];
      };
      const verbatimStatus = (c, k) => {
        if (secondArg(c).status !== 'object') return 'not_applicable:no_context_object';
        const cv = c.ctx_verbatim;
        if (!cv || typeof cv !== 'object') return 'unavailable:verbatim_capture_not_recorded';
        if (own(cv, k)) {
          const v = cv[k];
          if (v === null) return 'null';
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            const ks = Object.keys(v);
            if (ks.length === 1 && v.accessor_not_read === true) return 'unavailable:accessor_not_read';
            if (ks.length === 1 && own(v, 'unserialisable')) return 'unavailable:unserialisable';
          }
          return 'present';
        }
        if ((c.ctx.keys || []).includes(k)) return ((c.ctx.value_kinds || {})[k] === 'undefined') ? 'undefined_own_property' : 'unavailable:not_exported';
        return 'absent';
      };
      const vmStatus = (c, snap) => {
        const a = secondArg(c);
        if (a.status !== 'object') return 'not_applicable:no_context_object';
        if (!a.vm_data_present) return 'absent';
        if (!snap) return 'unavailable:no_paired_snapshot';
        const vt = snap.vm_data_value_type;
        if (vt === 'string') return 'present';
        if (vt === 'null') return 'null';
        if (vt === 'undefined') return 'undefined_own_property';
        if (vt === 'accessor') return 'unavailable:accessor_not_read';
        return own(snap, 'vm_data') ? 'present_non_string_json_copy' : 'unavailable:unserialisable';
      };
      const presenceOf = (c, snap) => {
        const a = secondArg(c);
        const p = { context: { absent: 'absent', null: 'null', primitive: 'not_object:' + a.type, object: 'present' }[a.status] || 'unrecorded' };
        for (const k of HARVESTED) p[k] = verbatimStatus(c, k);
        p.vm_data = vmStatus(c, snap);
        return p;
      };
      const firstArg = (c) => {
        const a0 = c.arg0 || {};
        const out = { type: a0.type, string_length: a0.type === 'string' && isNum(a0.length) ? a0.length : null, text_stored: false };
        if (a0.type === 'string' && isNum(a0.length)) Object.assign(out, { harvester_jwt_len: a0.length, harvester_jwt_len_basis: 'string_length' });
        else if (a0.type === 'undefined' || a0.type === 'null') Object.assign(out, { harvester_jwt_len: 0, harvester_jwt_len_basis: 'null_or_undefined_gives_0' });
        else if (['number', 'boolean', 'bigint'].includes(a0.type) && isNum(a0.string_length)) Object.assign(out, { harvester_jwt_len: a0.string_length, harvester_jwt_len_basis: 'string_of_primitive' });
        else if (['number', 'boolean', 'bigint'].includes(a0.type)) Object.assign(out, { harvester_jwt_len: null, harvester_jwt_len_basis: 'not_recorded_before_collector_1_2_0' });
        else Object.assign(out, { harvester_jwt_len: null, harvester_jwt_len_basis: 'not_computed_without_side_effects' });
        out.proof_sized_heuristic = { result: a0.type === 'string' && isNum(a0.length) ? a0.length > 100 : false,
          rule: 'string first argument longer than 100 characters; a size heuristic only, not evidence that a server accepted anything' };
        return out;
      };
      const harvesterRow = (c, snap) => {
        const p = presenceOf(c, snap);
        const cv = c.ctx_verbatim || {};
        const row = { t: c.cb_date_now_ms };
        if (p.href === 'present') row.href = cv.href;
        for (const k of ['ardata', 'uj_data']) if (p[k] === 'present' || p[k] === 'null') row[k] = cv[k];
        if (['present', 'null', 'present_non_string_json_copy'].includes(p.vm_data)) row.vm_data = snap.vm_data;
        const jl = firstArg(c).harvester_jwt_len;
        row.jwt_len = isNum(jl) ? jl : 0;
        row.vm_len = isNum(c.vm_len) ? c.vm_len : 0;
        return row;
      };
      const byTime = (a, b) => (a.cb_date_now_ms - b.cb_date_now_ms) || (String(a.record_id) < String(b.record_id) ? -1 : 1);
      const proofCalls = fo.vm.filter((r) => r.record_type === 'vm_proof_call').sort(byTime);
      const rowCalls = proofCalls.filter(rowExpected);
      const sha256hex = async (text) => { try { return hex(await crypto.subtle.digest('SHA-256', enc.encode(text))); } catch (_) { return null; } };
      const hswCtxRows = rowCalls.map((c, i) => {
        const row = harvesterRow(c, snapByCall.get(c.record_id));
        return { call: c, n: i + 1, text: JSON.stringify(row), is_proof: row.jwt_len > 100 && !!row.vm_data && !!row.href };
      });
      const hswCtxFiles = hswCtxRows.map((r) => ({ name: 'hsw_ctx/hsw_ctx_' + r.n + '.json', text: r.text }));
      const hswCtxProofs = hswCtxRows.filter((r) => r.is_proof).length;
      const rowOf = new Map(hswCtxRows.map((r) => [r.call.record_id, r]));
      const indexEntries = [];
      for (const c of proofCalls) {
        const snap = snapByCall.get(c.record_id);
        const r = rowOf.get(c.record_id);
        const e = { scoped_id: { session_id: c.session_id, document_id: c.document_id, frame_id: c.frame_id, record_id: c.record_id },
          call: { global_name: c.global_name, observed_date_now_ms: c.cb_date_now_ms, observed_perf_now_ms: c.cb_perf_now_ms,
            frame_url: c.frame_url, argument_count: c.arg_count, first_argument: firstArg(c), second_argument: secondArg(c),
            category: category(c) },
          presence: presenceOf(c, snap) };
        e.context_file = r ? { status: 'written', path: 'hsw_ctx/hsw_ctx_' + r.n + '.json', row_number: r.n,
          association_basis: 'export_index', sha256: await sha256hex(r.text), bytes: enc.encode(r.text).length }
          : { status: 'not_written', reason: secondArg(c).status === 'object' ? 'no ctx_verbatim key on the call record'
            : 'no object second argument (' + category(c) + ')' };
        if (snap && typeof snap.vm_data === 'string') {
          e.vm = { value_type: snap.vm_data_value_type, length_utf16: snap.vm_data.length, sha256: await sha256hex(snap.vm_data),
            paired_snapshot: { snapshot_id: snap.snapshot_id, record_id: snap.record_id, observation_point: snap.observation_point } };
        } else if (snap) {
          e.vm = { value_type: snap.vm_data_value_type, paired_snapshot: { snapshot_id: snap.snapshot_id, record_id: snap.record_id,
            observation_point: snap.observation_point } };
        } else {
          e.vm = null;
          const pv = e.presence.vm_data;
          if (pv === 'absent' || pv === 'not_applicable:no_context_object') e.vm_status = 'no VM provided by this call (not a capture loss)';
          else if (pv.startsWith('unavailable')) e.vm_status = 'VM reported but not captured: ' + pv;
        }
        indexEntries.push(e);
      }
      const hswCtxIndex = { index_version: '1.0.0', kind: 'hsw_ctx_index', generated_by: 'addons/site.js export_version 2',
        session_id: SESSION_ID, export_version: 2, source: { exported_date_now_ms: exportMs },
        contract: { row_written_when: "second argument present and a non-null object (ctx.status == 'object') and the record "
            + 'carries a ctx_verbatim key; key presence counts, not truthiness',
          row_numbering: '1..N over all frames in (cb_date_now_ms, record_id) order',
          row_schema: 'legacy harvester schema {t, href?, ardata?, uj_data?, vm_data?, jwt_len, vm_len}; undefined/absent '
            + 'omitted, explicit null kept (href omitted when null); provenance only in this index',
          identity_scope: '(session_id, document_id, frame_id, record_id)',
          definitions: 'collector/hswctx.py CONTRACT (same version)' },
        counts: { proof_calls: proofCalls.length, rows_written: hswCtxRows.length,
          rows_with_vm_string: hswCtxRows.filter((r) => typeof (snapByCall.get(r.call.record_id) || {}).vm_data === 'string').length },
        entries: indexEntries };

      // Documents, per-document accounting and frames for the assembled (merged) view.
      const docs = {}, perDoc = {};
      const allBatches = batches.map((b) => ({ ...b, frame_id: FRAME_ID })).concat(frameBatches);
      for (const b of allBatches) {
        const p = perDoc[b.document_id] || (perDoc[b.document_id] = { max_sequence_received: 0, received: new Set(),
          sequence_high_watermark: 0, batch_seqs: [], frame_id: b.frame_id });
        p.sequence_high_watermark = Math.max(p.sequence_high_watermark, b.sequence_high_watermark || 0);
        p.batch_seqs.push(b.batch_seq);
      }
      const allRecords = siteRecords.concat(frameRecords);
      for (const r of allRecords) {
        const p = perDoc[r.document_id];
        if (!p) continue;
        p.received.add(r.document_sequence);
        p.max_sequence_received = Math.max(p.max_sequence_received, r.document_sequence);
        const d = docs[r.document_id] || (docs[r.document_id] = { document_id: r.document_id, frame_id: r.frame_id, page_id: r.page_id,
          record_counts: {}, event_type_counts: {} });
        d.record_counts[r.record_type] = (d.record_counts[r.record_type] || 0) + 1;
        if (r.record_type === 'collector_install') {
          for (const k of ['install_date_now_ms', 'install_perf_now_ms', 'time_origin_ms', 'frame_url', 'is_top', 'ready_state_at_install',
            'document_element_present_at_install', 'scripts_in_document_at_install', 'referrer', 'ancestor_origins', 'top_origin',
            'in_experiment', 'user_agent', 'navigator_webdriver', 'navigation', 'monitored_event_types', 'listeners', 'api_support',
            'vm_observer', 'collection_context', 'hcaptcha_state_at_install', 'session_id_source', 'previous_document_id',
            'collector_script_element', 'other_scripts_in_document_at_install']) {
            if (k in r) d[k] = r[k];
          }
          d.install_received = true;
          d.install_record_id = r.record_id;
        }
        if (r.record_type === 'event') d.event_type_counts[r.original_event_type] = (d.event_type_counts[r.original_event_type] || 0) + 1;
      }
      for (const d of Object.values(docs)) {
        const monitored = d.monitored_event_types || [];
        const counts = d.event_type_counts;
        d.event_type_counts = {};
        for (const t of monitored) d.event_type_counts[t] = counts[t] || 0;
        const extra = {};
        for (const [t, n] of Object.entries(counts)) if (!monitored.includes(t)) extra[t] = n;
        if (Object.keys(extra).length) d.event_type_counts_unlisted = extra;
        const p = perDoc[d.document_id];
        d.max_sequence_received = p ? p.max_sequence_received : 0;
        d.received_sequences = p ? p.received.size : 0;
        d.missing_sequences_count = Math.max(0, d.max_sequence_received - d.received_sequences);
      }
      const transportPerDoc = {};
      for (const [doc, p] of Object.entries(perDoc)) {
        const seqs = p.batch_seqs.slice().sort((a, b) => a - b);
        const anomalies = [];
        seqs.forEach((s, i) => { if (s !== i + 1) anomalies.push({ expected: i + 1, received: s }); });
        transportPerDoc[doc] = { max_sequence_received: p.max_sequence_received, received_sequences: p.received.size,
          sequence_high_watermark: p.sequence_high_watermark, batch_seq_anomalies: anomalies.slice(0, 20),
          unreceived_after_last_batch: Math.max(0, p.sequence_high_watermark - p.max_sequence_received) };
      }
      const siteDocs = Object.values(docs).filter((d) => d.frame_id === FRAME_ID).sort((a, b) => a.install_date_now_ms - b.install_date_now_ms);
      const frames = [{ frame_id: FRAME_ID, parent_frame_id: null, page_id: PAGE_ID, is_main_frame: IS_TOP,
        documents: siteDocs.map((d) => d.document_id),
        navigations: siteDocs.map((d) => ({ url: d.frame_url, wall_ns: Math.round(d.install_date_now_ms * 1e6),
          probe: { status: 'installed_install_record_received', reported_document_id: d.document_id, source: 'site_collector_install_record' } })),
        source: 'site_collector' }];
      const gaps = [];
      for (const f of (frame && frame.manifest && frame.manifest.frames) || []) {
        frames.push(f);
        for (const n of f.navigations || []) {
          if (n.probe && n.probe.status !== 'installed_install_record_received') gaps.push({ frame_id: f.frame_id, url: n.url, navigated_wall_ns: n.wall_ns, probe: n.probe });
        }
      }
      const unsupported = {};
      for (const d of Object.values(docs)) for (const [api, ok] of Object.entries(d.api_support || {})) if (ok === false) (unsupported[api] = unsupported[api] || []).push(d.document_id);
      const windows = [];
      for (const r of site.events) {
        if (r.record_type !== 'lifecycle_marker') continue;
        if (r.marker_type === 'analysis_window_started') windows.push({ window_id: r.marker_id, start_marker: r.marker_id, start_ms: r.cb_date_now_ms, stop_marker: null, stop_ms: null });
        if (r.marker_type === 'analysis_window_stopped') {
          const w = windows.find((x) => x.window_id === (r.details || {}).window_id);
          if (w) { w.stop_marker = r.marker_id; w.stop_ms = r.cb_date_now_ms; }
        }
      }
      const coverageLevel = frame && !frame.error && frame.manifest && (frame.manifest.observer_documents || []).length
        ? 'B_parent_and_frame_observer' : 'A_parent_only';
      const limitations = [];
      if (coverageLevel === 'A_parent_only') limitations.push('No frame observer data: hCaptcha iframe events and genuine VM snapshots are not in this export. '
        + 'A working Record button does not imply iframe or VM coverage.');
      if (frame && frame.error) limitations.push('Frame observer request failed: ' + frame.error);
      if (frame && frame.manifest) for (const l of frame.manifest.limitations || []) limitations.push(l);
      if (dbState !== 'open') limitations.push('IndexedDB persistence unavailable: records of earlier documents in this tab session could not be included.');
      const snapshots = fo.vm.filter((r) => r.record_type === 'vm_snapshot').map((r) => ({ snapshot_id: r.snapshot_id, observation_point: r.observation_point,
        frame_id: r.frame_id, document_id: r.document_id, parent_document_id: r.parent_document_id, observed_date_now_ms: r.cb_date_now_ms }));
      const resources = (() => {
        try { return performance.getEntriesByType('resource').filter((x) => /\.(js|wasm|html)(\?|#|$)/.test(x.name)).map((x) => x.name); } catch (_) { return []; }
      })();
      const buildIds = [...new Set(resources.concat(((frame && frame.manifest && frame.manifest.resource_urls) || []))
        .map((u) => (u.match(/\/([0-9a-f]{40})(?=\/|$)/) || [])[1]).filter(Boolean))];

      const session = {
        schema_version: CFG.schema_version, record_type: 'session', session_id: SESSION_ID, status: 'exported_while_collecting',
        producer: { kind: 'site_collector', collector_version: CFG.collector_version, build: CFG.build || null },
        experiment: { name: SITE.experiment_name || null, url: SITE.experiment_url || (location.origin + location.pathname),
          origin: CFG.experiment_origin, config_sha256: CFG.config_sha256 || null,
          config: { comparison: SITE.comparison || { timing_tolerance_ms: 3, association_window_ms: 50 }, collector: CFG.collector } },
        collection_boundaries: {
          session_start_wall_ns: Math.round(startMs * 1e6), session_start_iso: new Date(startMs).toISOString(),
          session_end_wall_ns: Math.round((dateNow() + 1) * 1e6), session_end_iso: new Date(dateNow()).toISOString(),
          end_reason: 'export (collection continues after export)', analysis_windows: windows, recording_windows: [],
          policy: 'Continuous collection from document initialization. Record/Stop only add analysis-window markers; they '
            + 'never reset the collector clock or remove events. Clocks: Date.now() in ms; *_wall_ns fields are Date.now()*1e6.',
        },
        collector: {
          collector_version: CFG.collector_version, schema_version: CFG.schema_version, sources: (CFG.build || {}).sources || null,
          installation: { mechanism: 'synchronous <script> in the experiment page <head>, placed before the hCaptcha loader',
            execution_context: 'main world of the top-level document', timing: 'per document: ready_state_at_install, '
            + 'scripts_in_document_at_install, hcaptcha_state_at_install' },
          processing: { batching: 'queued in page memory; moved to the in-page store every ' + CFG.collector.flush_interval_ms + ' ms',
            persistence: 'IndexedDB database vmc-site-collector (per origin), one entry per batch', queue_limit: CFG.collector.queue_limit,
            deduplication: 'batches keyed by session|document|batch_seq', filtering: 'message events only for hCaptcha JSON messages; '
            + 'field values, clipboard contents and tokens are never stored' },
          not_monitored: CFG.not_monitored || {},
          footprint: ['window.__vmcInstalled (non-enumerable)', 'window.__vmcApi (non-enumerable)', 'window.__vmcMark (non-enumerable)',
            'control panel element (closed shadow root) appended to <html>', 'IndexedDB database vmc-site-collector',
            'sessionStorage key ' + SS_KEY, '<script src> of the collector in <head>'],
        },
        browser: { user_agent: navigator.userAgent,
          user_agent_data: navigator.userAgentData ? { brands: navigator.userAgentData.brands, mobile: navigator.userAgentData.mobile,
            platform: navigator.userAgentData.platform } : null, navigator_webdriver: navigator.webdriver },
        pages: [{ page_id: PAGE_ID }],
        frames,
        documents: docs,
        coverage: { level: coverageLevel, limitations, frame_observer: frame ? (frame.manifest ? frame.manifest.summary || null : { error: frame.error || null }) : { state: EXT.state },
          navigations_without_confirmed_collector: gaps, frames_without_any_collector_document: frames.filter((f) => !(f.documents || []).length).map((f) => f.frame_id),
          unsupported_apis: unsupported, dialogs: [] },
        transport: { batches: allBatches.length, records_received: allRecords.length, duplicate_records: (frame && frame.duplicate_records) || 0,
          retransmitted_records: 0, per_document: transportPerDoc },
        counts: { files: { events_jsonl_lines: site.events.length + fo.events.length, vm_snapshots_jsonl_lines: site.vm.length + fo.vm.length,
          nodes: site.nodes.nodes.length + fo.nodes.nodes.length, node_states: site.nodes.node_states.length + fo.nodes.node_states.length,
          inventories: site.nodes.inventories.length + fo.nodes.inventories.length,
          hsw_ctx_files: hswCtxFiles.length, hsw_ctx_proof_rows: hswCtxProofs },
          note: 'counts describe the assembled view (parent files plus frame_observer/ files)' },
        vm_observation: { source: coverageLevel === 'A_parent_only' ? 'unavailable' : 'extension_frame_observer', snapshots,
          note: 'decoded offline by python3 recorder.py analyze' },
        assets: [], asset_note: 'Response bodies are not readable from page scripts; script URLs are listed in builds.resource_urls.',
        builds: { build_ids_in_loaded_urls: buildIds, resource_urls: resources },
        clocks: { time_stamp: 'event.timeStamp (ms since the document timeOrigin)', cb_date_now_ms: 'Date.now() at listener entry',
          cb_perf_now_ms: 'performance.now() at listener entry', time_origin_ms: 'performance.timeOrigin per document',
          frame_observer_receipt: 'extension service worker Date.now() per batch (frame_observer/manifest.json)' },
        coordinates: { original: 'client/page/screen/offset/movement exactly as read', main_viewport: 'identity for top-document events; '
          + 'frame-observer coordinates stay in the frame\'s own client space; iframe_geometry records allow offline translation' },
      };
      const jsonl = (rows) => rows.map((r) => jsonStringify(r)).join('\n') + (rows.length ? '\n' : '');
      const nodesFile = (n) => jsonStringify({ schema_version: CFG.schema_version, record_type: 'nodes_file', session_id: SESSION_ID, ...n });
      const siteEventsText = jsonl(site.events);
      const files = [
        { name: 'session.json', text: JSON.stringify(session, null, 2) },
        { name: 'events.jsonl', text: siteEventsText },
        { name: 'nodes.json', text: nodesFile(site.nodes) },
        { name: 'vm_snapshots.jsonl', text: jsonl(site.vm) },
      ];
      // Labelled synthetic six-field hsw_ctx fixture, built offline from the captured data points
      // (collector/synthetic_ctx.js, a port of make_hsw_ctx_from_datapoints.py). It is a toy
      // three-slot root for parser/serialization tests, stamped SYNTHETIC_OFFLINE_ONLY and marked
      // doNotSubmit; it is never submitted and never fed to a challenge.
      if (SITE.synthetic_ctx_fixture !== false && self.VMC_SYNTHETIC_CTX) {
        try {
          const evBytes = enc.encode(siteEventsText);
          let evSha = null;
          try { evSha = hex(await crypto.subtle.digest('SHA-256', evBytes)); } catch (_) {}
          const fixture = self.VMC_SYNTHETIC_CTX.buildFixture(site.events, { file: 'events.jsonl', bytes: evBytes.length, sha256: evSha });
          files.push({ name: 'synthetic/hsw_ctx_from_datapoints_offline.json', text: JSON.stringify(fixture, null, 2) + '\n' });
          files.push({ name: 'synthetic/hsw_ctx_from_datapoints_six_values.json', text: JSON.stringify(fixture.ctx, null, 2) + '\n' });
        } catch (err) {
          files.push({ name: 'synthetic/hsw_ctx_from_datapoints_offline.json',
            text: JSON.stringify({ schema: 'offline-hsw-ctx-datapoints/v1', synthetic: true, doNotSubmit: true,
              networkSubmission: false, error: 'no supported timestamped data points to map: ' + errText(err) }, null, 2) + '\n' });
        }
      }
      if (frame && !frame.error) {
        files.push({ name: 'frame_observer/events.jsonl', text: jsonl(fo.events) },
          { name: 'frame_observer/nodes.json', text: nodesFile(fo.nodes) },
          { name: 'frame_observer/vm_snapshots.jsonl', text: jsonl(fo.vm) },
          { name: 'frame_observer/manifest.json', text: JSON.stringify(frame.manifest || {}, null, 2) });
        for (const f of hswCtxFiles) files.push(f);
        files.push({ name: 'provenance/hsw_ctx_index.json', text: JSON.stringify(hswCtxIndex, null, 1) });
      }
      // Opt-in source archive (only when the extension's debugger capture was armed for this tab).
      // Bodies are written as binary; requests.jsonl and manifest.json are the extension's own output.
      const srcArchive = frame && frame.source_archive;
      if (srcArchive && !srcArchive.error && srcArchive.requests) {
        files.push({ name: 'assets/requests.jsonl', text: srcArchive.requests.map((r) => jsonStringify(r)).join('\n') + (srcArchive.requests.length ? '\n' : '') });
        files.push({ name: 'assets/manifest.json', text: JSON.stringify({ ...srcArchive.manifest,
          export_reassembly: assetBundle.results, export_reassembly_note: 'per-body status when the page reassembled the '
            + 'chunked bytes from the extension and verified sha256 and length' }, null, 2) });
        for (const f of assetBundle.files) files.push(f);
      }
      files.push({ name: 'README.txt', text: 'VM comparison collector export (schema ' + CFG.schema_version + ').\n'
        + 'Coverage level: ' + coverageLevel + '\n' + limitations.map((l) => '- ' + l).join('\n')
        + (hswCtxFiles.length ? '\nhsw_ctx/: ' + hswCtxFiles.length + ' captured hsw ctx row(s), '
            + hswCtxProofs + ' with a proof-sized JWT and vm_data '
            + '(legacy harvester schema {t, href, ardata, uj_data, vm_data, jwt_len, vm_len}: undefined values omitted, '
            + 'explicit nulls kept; JWT text not stored). Provenance per call: provenance/hsw_ctx_index.json.' : '')
        + (SITE.synthetic_ctx_fixture !== false ? '\nsynthetic/: a LABELLED SYNTHETIC offline six-field hsw_ctx '
            + 'fixture built from the captured data points (toy 3-slot root stamped SYNTHETIC_OFFLINE_ONLY, '
            + 'doNotSubmit:true). For parser/serialization tests only; it is not production vm_data and must never '
            + 'be submitted. See docs/SYNTHETIC_CTX.md.' : '')
        + '\nAnalyse with: python3 recorder.py analyze <this zip> --out <new directory>\n' });
      const out = [];
      const manifest = { export_version: 2, schema_version: CFG.schema_version, session_id: SESSION_ID, coverage_level: coverageLevel,
        exported_date_now_ms: exportMs, files: [] };
      for (const f of files) {
        const data = f.data instanceof Uint8Array ? f.data : enc.encode(f.text);
        let sha = null;
        try { sha = hex(await crypto.subtle.digest('SHA-256', data)); } catch (_) {}
        manifest.files.push({ name: f.name, bytes: data.length, sha256: sha });
        out.push({ name: f.name, data });
      }
      out.push({ name: 'export_manifest.json', data: enc.encode(JSON.stringify(manifest, null, 2)) });
      const zip = makeZip(out);
      const stamp = new Date(exportMs).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(zip);
      a.download = 'vmc-export-' + SESSION_ID + '-' + stamp + '.zip';
      a.rel = 'noopener';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      return { name: a.download, coverageLevel, records: allRecords.length };
    };

    // ---- control panel ------------------------------------------------------------------------------------
    let ui = null, lastExport = null;
    const mount = () => {
      if (!IS_TOP || ui || !document.documentElement) return;
      const host = document.createElement('div');
      host.style.cssText = 'all:initial;position:fixed;left:12px;bottom:12px;z-index:2147483646;';
      const root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = '<style>'
        + '.p{font:12px/1.45 system-ui,-apple-system,sans-serif;color:#e4e4e7;background:rgba(24,24,27,.95);border:1px solid #3f3f46;'
        + 'border-radius:10px;padding:8px 10px;width:320px;box-shadow:0 6px 18px rgba(0,0,0,.3)}'
        + '.t{font-weight:700;margin-bottom:4px}.r{display:flex;justify-content:space-between;gap:10px}'
        + '.k{color:#a1a1aa;white-space:nowrap}.v{text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}'
        + '.ok{color:#4ade80}.warn{color:#fbbf24}.bad{color:#f87171}'
        + '.b{display:flex;gap:6px;margin-top:8px}button{flex:1;font:inherit;font-weight:600;border:0;border-radius:6px;padding:5px 0;'
        + 'color:#fff;cursor:pointer}#rec{background:#16a34a}#stop{background:#dc2626}#exp{background:#2563eb}'
        + 'button:disabled{opacity:.35;cursor:default}.n{color:#a1a1aa;font-size:11px;margin-top:6px}</style>'
        + '<div class="p"><div class="t">VM comparison collector</div>'
        + '<div class="r"><span class="k">Parent collector</span><span class="v" id="c"></span></div>'
        + '<div class="r"><span class="k">Installed before hCaptcha</span><span class="v" id="h"></span></div>'
        + '<div class="r"><span class="k">Session</span><span class="v" id="s"></span></div>'
        + '<div class="r"><span class="k">Document</span><span class="v" id="d"></span></div>'
        + '<div class="r"><span class="k">Records</span><span class="v" id="n"></span></div>'
        + '<div class="r"><span class="k">Dropped / errors</span><span class="v" id="e"></span></div>'
        + '<div class="r"><span class="k">Iframe observer</span><span class="v" id="f"></span></div>'
        + '<div class="r"><span class="k">Analysis window</span><span class="v" id="w"></span></div>'
        + '<div class="b"><button id="rec" tabindex="-1">Record</button><button id="stop" tabindex="-1">Stop</button>'
        + '<button id="exp" tabindex="-1">Export</button></div><div class="n" id="x">Collecting continuously. Dummy data only.</div></div>';
      const $ = (id) => root.getElementById(id);
      ui = { c: $('c'), h: $('h'), s: $('s'), d: $('d'), n: $('n'), e: $('e'), f: $('f'), w: $('w'), rec: $('rec'), stop: $('stop'), exp: $('exp'), x: $('x') };
      for (const b of [ui.rec, ui.stop, ui.exp]) R(addEL, b, ['mousedown', (ev) => ev.preventDefault()]);
      R(addEL, ui.rec, ['click', () => { recordWindow(); render(); }]);
      R(addEL, ui.stop, ['click', () => { stopWindow(); render(); }]);
      R(addEL, ui.exp, ['click', () => {
        ui.exp.disabled = true;
        ui.x.textContent = 'Exporting…';
        buildExport().then((res) => { lastExport = res; ui.x.textContent = 'Exported ' + res.name + ' (' + res.coverageLevel + ')'; },
          (err) => { diag('export_error', { error: errText(err) }); ui.x.textContent = 'Export failed: ' + errText(err); })
          .finally(() => { ui.exp.disabled = false; });
      }]);
      document.documentElement.appendChild(host);
      panelHost = host;
      ref(host, 'site_control_panel');
    };
    const set = (el, text, cls) => { el.textContent = text; el.className = 'v ' + (cls || ''); };
    const render = () => {
      if (!ui) return;
      if (!panelHost.isConnected && document.documentElement) document.documentElement.appendChild(panelHost);
      set(ui.c, 'installed ' + new Date(INSTALL_DATE_NOW).toLocaleTimeString(), 'ok');
      const before = !hc.present_at_install;
      set(ui.h, before ? 'yes' : 'no (hcaptcha present)', before ? 'ok' : 'bad');
      set(ui.s, SESSION_ID);
      set(ui.d, DOC_ID + (PREV_DOC ? ' (after ' + PREV_DOC.slice(4, 10) + '…)' : ''));
      set(ui.n, String(seq) + (dbState === 'open' ? ' · stored' : ' · memory only'), dbState === 'open' ? '' : 'warn');
      const errs = Object.entries(diagCounts).reduce((a, [, n]) => a + n, 0);
      const dropped = droppedTotal + overflow.count;
      set(ui.e, dropped + ' / ' + errs, dropped || errs ? 'warn' : 'ok');
      const fi = EXT.info || {};
      if (EXT.state === 'available') set(ui.f, (fi.frames_observed || 0) + ' frames · ' + (fi.vm_snapshots || 0) + ' VM snapshots', fi.frames_observed ? 'ok' : 'warn');
      else if (EXT.state === 'waiting') set(ui.f, 'checking…', 'warn');
      else set(ui.f, EXT.state === 'stale' ? 'stopped responding' : 'not detected (parent only)', 'bad');
      set(ui.w, openWindow ? 'open ' + ((dateNow() - openWindow.started_ms) / 1000).toFixed(1) + ' s' : 'closed', openWindow ? 'ok' : '');
      ui.rec.disabled = !!openWindow;
      ui.stop.disabled = !openWindow;
    };
    hooks.afterInstall.push(() => {
      hello('hello');
      if (!IS_TOP) return;
      const tick = () => { try { mount(); render(); } catch (err) { diag('handler_error', { where: 'panel', error: errText(err) }); } };
      if (document.documentElement) tick();
      setInterval(tick, 250);
    });
    Object.defineProperty(window, '__vmcSite', { value: Object.freeze({
      session_id: () => SESSION_ID, document_id: () => DOC_ID, record: recordWindow, stop: stopWindow,
      export: () => buildExport(), status: () => ({ ext: EXT.state, db: dbState, persisted, persistErrors, window: openWindow, hc }),
    }), enumerable: false });
  })();
