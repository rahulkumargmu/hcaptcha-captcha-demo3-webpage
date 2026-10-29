// Offline six-field hsw_ctx FIXTURE builder (synthetic, labelled, non-submittable).
//
// This is the JavaScript port of Resources/synthetic_to_hswctx/make_hsw_ctx_from_datapoints.py. It
// maps recorded input data points (mouse/keyboard/pointer/touch events) into the repository's THREE
// -SLOT TOY vm_data root for six-field parser/serialization tests. It is NOT hCaptcha's production
// 24-slot root, it does not reconstruct production selection logic, it never executes downloaded
// source, calls HSW, or performs any network request, and its output is stamped so it cannot be
// mistaken for or submitted as genuine telemetry:
//   - the sentinel string "SYNTHETIC_OFFLINE_ONLY" is embedded as the first element of vm_data;
//   - href is https://offline-fixture.invalid/ ; ardata and uj_data are null;
//   - the envelope carries synthetic:true, doNotSubmit:true, networkSubmission:false.
// collector/tests parity-check this against the Python reference byte-for-byte on the same events.
//
// Serialization note: to match Python json.dumps, coordinate/axis values are emitted as floats (an
// integer coordinate 84 becomes "84.0"), and channel keys keep insertion order (JS would otherwise
// reorder integer-like keys). A small custom serializer handles both.
(function (root) {
  'use strict';

  var SCHEMA = 'offline-hsw-ctx-datapoints/v1';
  var SENTINEL = 'SYNTHETIC_OFFLINE_ONLY';
  var CTX_FIELDS = ['href', 'ardata', 'vm_data', 'uj_data', 'errors', 'messages'];
  var SOURCE_FILES = ['api.js', 'hcaptcha.html', 'hsw.js'];
  var RAW_TTL_MS = 150000, RECENT_TTL_MS = 15000, RAW_CAP = 128, SAMPLE_PERIOD_MS = 16;
  var RECENT_CAPS = { '100': 12, '101': 12, '102': 12, '110': 12, '111': 12, '112': 256, '120': 12, '121': 12, '130': 256 };
  var RAW_CHANNELS = [['touchstart', '0'], ['touchend', '1'], ['touchmove', '2'], ['keydown', '20'], ['keyup', '21'],
    ['input', '30'], ['focus', '50'], ['blur', '51'], ['mouseenter', '52'], ['mouseleave', '53']];
  var RECENT_CHANNELS = [['touchstart', '100'], ['touchend', '101'], ['touchmove', '102'], ['mousedown', '110'],
    ['mouseup', '111'], ['mousemove', '112'], ['keydown', '120'], ['keyup', '121'], ['pointermove', '130']];
  var SUPPORTED = {};
  RAW_CHANNELS.concat(RECENT_CHANNELS).forEach(function (p) { SUPPORTED[p[0]] = true; });

  // Forced-float wrapper: ser() prints an integer value as "<n>.0" (matching Python float repr).
  function F(n) { this.n = n; }
  function isNum(v) { return typeof v === 'numbers'.slice(0, 6) && isFinite(v) && typeof v !== 'boolean'; }
  function finiteNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(record, names, dflt) {
    for (var i = 0; i < names.length; i++) { var v = record[names[i]]; if (finiteNum(v)) return v; }
    return dflt === undefined ? 0 : dflt;
  }
  function integer(record, names, dflt) { return Math.round(num(record, names, dflt === undefined ? 0 : dflt)); }
  function eventType(r) {
    var v = r.original_event_type !== undefined ? r.original_event_type : (r.event_type !== undefined ? r.event_type : r.type);
    return typeof v === 'string' ? v.toLowerCase() : null;
  }
  function eventTs(r) {
    var names = ['cb_date_now_ms', 'timestamp_ms', 'timestamp', 'time', 't', 'time_stamp'];
    for (var i = 0; i < names.length; i++) { var v = r[names[i]]; if (finiteNum(v)) return v; }
    return null;
  }
  function modifierMask(r) {
    return (r.shift_key === true ? 1 : 0) + (r.ctrl_key === true ? 2 : 0) + (r.alt_key === true ? 4 : 0) + (r.meta_key === true ? 8 : 0);
  }
  function xy(r) {
    var vp = r.main_viewport;
    if (vp && typeof vp === 'object' && finiteNum(vp.x) && finiteNum(vp.y)) return [vp.x, vp.y];
    return [num(r, ['client_x', 'x'], 0), num(r, ['client_y', 'y'], 0)];
  }

  function normalize(records) {
    var observed = {}, candidates = [];
    for (var seq = 0; seq < records.length; seq++) {
      var r = records[seq];
      var rt = r.record_type;
      if (rt !== undefined && rt !== null && rt !== 'event') continue;
      var kind = eventType(r);
      if (kind === null) continue;
      observed[kind] = (observed[kind] || 0) + 1;
      if (!SUPPORTED[kind]) continue;
      var ts = eventTs(r);
      if (ts === null) continue;
      candidates.push({ kind: kind, timestamp: ts, sequence: seq, record: r });
    }
    if (!candidates.length) throw new Error('no supported timestamped events found');
    candidates.sort(function (a, b) { return a.timestamp - b.timestamp || a.sequence - b.sequence; });
    var origin = candidates[0].timestamp, last = 0;
    candidates.forEach(function (it) {
      var rel = Math.max(0, Math.round(it.timestamp - origin));
      rel = Math.max(rel, last); last = rel; it.relative_ms = rel;
    });
    return { events: candidates, observed: observed };
  }

  function identity(r) {
    var target = r.target;
    if (target === undefined) target = 0;
    if (typeof target === 'boolean' || !(Number.isInteger(target) || typeof target === 'string')) target = 0;
    return (r.document_id || 'input') + ':' + target;
  }
  function buildTargetMap(events) {
    var map = {}, n = 0;
    events.forEach(function (it) { var id = identity(it.record); if (!(id in map)) map[id] = n++; });
    if (!n) map['input:0'] = 0;
    return map;
  }

  function rawTuple(it, map) {
    var kind = it.kind, r = it.record, ts = it.relative_ms, target = map[identity(r)];
    var c;
    if (kind === 'touchstart' || kind === 'touchend' || kind === 'touchmove') {
      c = xy(r); var tid = r.touch_id !== undefined ? r.touch_id : (r.identifier !== undefined ? r.identifier : 0);
      if (!finiteNum(tid)) tid = 0;
      return [tid, new F(c[0]), new F(c[1]), target, ts];
    }
    if (kind === 'keydown') return [null, modifierMask(r), target, ts];
    if (kind === 'keyup') return [0, modifierMask(r), target, ts];
    if (kind === 'input') {
      var resultLen = Math.max(0, integer(r, ['target_value_length', 'value_length'], 0));
      var editLen = integer(r, ['data_length'], -1);
      return [resultLen, Math.max(-1, editLen), target, ts];
    }
    if (kind === 'focus' || kind === 'blur' || kind === 'mouseenter' || kind === 'mouseleave') return [target, ts];
    throw new Error('no raw mapping for ' + kind);
  }
  function recentTuple(it) {
    var kind = it.kind, r = it.record, ts = it.relative_ms, c = xy(r);
    if (kind === 'touchstart' || kind === 'touchend' || kind === 'touchmove') {
      var tid = r.touch_id !== undefined ? r.touch_id : (r.identifier !== undefined ? r.identifier : 0);
      if (!finiteNum(tid)) tid = 0;
      return [[tid, new F(c[0]), new F(c[1])], ts];
    }
    if (kind === 'mousedown' || kind === 'mouseup' || kind === 'mousemove') {
      // Keys 110/111/112: [x, y, trustedFlag, secondaryFlag, relMs]. Trusted defaults to 1; secondary stays 0.
      return [new F(c[0]), new F(c[1]), new F(1), new F(0), ts];
    }
    if (kind === 'keydown' || kind === 'keyup') return [modifierMask(r), ts];
    if (kind === 'pointermove') return [new F(c[0]), new F(c[1]), ts];
    throw new Error('no recent mapping for ' + kind);
  }

  function retain(events, channel, recent, captureMs) {
    var ttl = recent ? RECENT_TTL_MS : RAW_TTL_MS;
    var cap = recent ? RECENT_CAPS[channel] : RAW_CAP;
    var eligible = events.filter(function (it) { return captureMs - it.relative_ms <= ttl; });
    var sampled = [];
    for (var i = eligible.length - 1; i >= 0; i--) {
      if (!sampled.length || sampled[sampled.length - 1].relative_ms - eligible[i].relative_ms >= SAMPLE_PERIOD_MS) sampled.push(eligible[i]);
    }
    sampled.reverse();
    return cap >= 0 && sampled.length > cap ? sampled.slice(sampled.length - cap) : sampled;
  }

  function buildVm(events, targetMap) {
    var byType = {};
    events.forEach(function (it) { (byType[it.kind] = byType[it.kind] || []).push(it); });
    var captureMs = events[events.length - 1].relative_ms;
    var raw = new Map();
    RAW_CHANNELS.forEach(function (p) {
      var kind = p[0], ch = p[1];
      if (byType[kind] && byType[kind].length) raw.set(ch, retain(byType[kind], ch, false, captureMs).map(function (it) { return rawTuple(it, targetMap); }));
    });
    var recent = new Map();
    RECENT_CHANNELS.forEach(function (p) {
      var kind = p[0], ch = p[1];
      if (byType[kind] && byType[kind].length) recent.set(ch, retain(byType[kind], ch, true, captureMs).map(recentTuple));
    });
    ['100', '101', '120', '121', '130'].forEach(function (ch) { if (!recent.has(ch)) recent.set(ch, []); });
    recent.set('150', 0);
    var state = new Map();
    var size = Object.keys(targetMap).length;
    for (var i = 0; i < size; i++) state.set(String(i), [0, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [], 1, 0, 0, 0]);
    return { vm16: [62, raw, state, 0], recent: recent, captureMs: captureMs };
  }

  // Custom serializer matching Python json.dumps(..., separators=(',',':')).
  function ser(v) {
    if (v === null || v === undefined) return 'null';
    if (v instanceof F) return Number.isInteger(v.n) ? (v.n + '.0') : String(v.n);
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(ser).join(',') + ']';
    if (v instanceof Map) {
      var parts = [];
      v.forEach(function (val, k) { parts.push(JSON.stringify(String(k)) + ':' + ser(val)); });
      return '{' + parts.join(',') + '}';
    }
    var ks = Object.keys(v);
    return '{' + ks.map(function (k) { return JSON.stringify(k) + ':' + ser(v[k]); }).join(',') + '}';
  }

  function vmDataString(events, targetMap) {
    var b = buildVm(events, targetMap);
    var root = [SENTINEL, b.recent, b.vm16];
    var inner = ser(root);
    return { vm_data: '[[0,' + JSON.stringify(inner) + ']]', captureMs: b.captureMs, vm16: b.vm16, recent: b.recent };
  }

  function buildCtx(records) {
    var norm = normalize(records);
    var targetMap = buildTargetMap(norm.events);
    var built = vmDataString(norm.events, targetMap);
    return {
      href: 'https://offline-fixture.invalid/', ardata: null, vm_data: built.vm_data, uj_data: null,
      errors: [SENTINEL + ': event-derived fixture; no captured runtime errors'],
      messages: [SENTINEL + ': event-derived fixture; no captured runtime messages'],
    };
  }

  function counts(obj) { var o = {}; Object.keys(obj).sort().forEach(function (k) { o[k] = obj[k]; }); return o; }

  function buildFixture(records, meta) {
    meta = meta || {};
    var norm = normalize(records);
    var targetMap = buildTargetMap(norm.events);
    var built = vmDataString(norm.events, targetMap);
    var mapped = {};
    norm.events.forEach(function (it) { mapped[it.kind] = (mapped[it.kind] || 0) + 1; });
    var rawCounts = {}, recentCounts = {};
    built.vm16[1].forEach(function (val, k) { rawCounts[k] = val.length; });
    built.recent.forEach(function (val, k) { if (Array.isArray(val)) recentCounts[k] = val.length; });
    return {
      schema: SCHEMA, synthetic: true, doNotSubmit: true, networkSubmission: false,
      purpose: 'six-field-parser-and-serialization-tests-from-datapoints-only',
      captureEpochMs: built.captureMs,
      input: {
        file: meta.file || 'events.jsonl', bytes: meta.bytes !== undefined ? meta.bytes : null,
        sha256: meta.sha256 || null, jsonRecords: records.length, mappedRecords: norm.events.length,
        observedEventCounts: counts(norm.observed), mappedEventCounts: counts(mapped),
        outputChannelCounts: { raw: rawCounts, recent: recentCounts }, targetMap: targetMap,
      },
      retentionPolicy: { rawTtlMs: RAW_TTL_MS, recentTtlMs: RECENT_TTL_MS, samplePeriodMs: SAMPLE_PERIOD_MS,
        rawChannelCap: RAW_CAP, recentChannelCaps: RECENT_CAPS },
      sourceReferences: SOURCE_FILES.map(function (f) {
        return { file: f, bytes: null, sha256: null, purpose: 'reference-only',
          availability: 'not_computed_in_browser (offline tool hashes the archived demo2 files; the extension never reads or executes them)' };
      }),
      sourceUse: 'Downloaded demo2 bytes are hashed references and are never imported or executed.',
      generatedBy: 'collector/synthetic_ctx.js (in-extension port of make_hsw_ctx_from_datapoints.py)',
      limitations: [
        'vm_data has a three-entry toy root, not the captured production 24-slot root.',
        'Known event fields are normalized into test tuples; unresolved internal fields use explicit toy values.',
        'A deterministic 16 ms thinning rule and documented caps are test-fixture policies, not a claim about production selection logic.',
        'ardata and uj_data are unavailable from event points and remain null.',
        'errors and messages are labelled fixture values; genuine calls may omit both fields.',
        'Generated in the browser from captured data points; this is a labelled offline test fixture and must never be submitted.',
      ],
      ctx: buildCtx(records),
    };
  }

  var api = { SCHEMA: SCHEMA, SENTINEL: SENTINEL, CTX_FIELDS: CTX_FIELDS, buildCtx: buildCtx, buildFixture: buildFixture, _ser: ser, _F: F };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.VMC_SYNTHETIC_CTX = api;
})(typeof self !== 'undefined' ? self : this);
