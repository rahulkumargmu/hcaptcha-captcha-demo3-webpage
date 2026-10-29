/*
 * Installs globalThis.__hswCapture in the frame that executes HSW.
 * The extension copy runs at document_start. A console paste of this file
 * still works; see collector-capture.md for the two conditional breakpoints.
 * This observes existing calls; it does not invoke HSW or replace browser APIs.
 * Installed state is lost on navigation/frame replacement. Export before reload.
 */
(() => {
    "use strict";
    const root = globalThis;
    const key = "__hswCapture";
    const requiredOrigins = root.__VMC_HSW_CAPTURE_ORIGINS ||
      (typeof root.__VMC_HSW_CAPTURE_ORIGIN === "string" ? [root.__VMC_HSW_CAPTURE_ORIGIN] : null);
    if (requiredOrigins) {
      let topOrigin = null;
      try {
        if (root.top === root) topOrigin = root.location.origin;
        else {
          const ao = root.location.ancestorOrigins;
          topOrigin = ao && ao.length ? ao[ao.length - 1] : null;
        }
      } catch (_) { topOrigin = null; }
      if (!requiredOrigins.includes(topOrigin)) return;
    }
    if (Object.prototype.hasOwnProperty.call(root, key)) {
      console.info("__hswCapture already exists. Export it before removing/reinstalling.");
      return;
    }

    // Labels from hsw/27-collectors; these describe the supplied build only.
    const catalog = [
      {"number":1,"name":"navigator-properties","errorId":1044568702,"values":{"407766139":"navigatorSnapshot","1556940308":"sessionScrambledUserAgent"}},
      {"number":2,"name":"ua-client-hints","errorId":2446041220,"values":{"2781572169":"highEntropyHints"}},
      {"number":3,"name":"screen-metrics","errorId":1406964735,"values":{"3198788378":"screenMetrics"}},
      {"number":4,"name":"computed-style-keys","errorId":1475078716,"values":{"3961153289":"elapsedMs","3864989636":"propertyNames","2721127412":"propertyCount"}},
      {"number":5,"name":"global-namespace","errorId":691843552,"values":{"1644803226":"elapsedMs","2566390908":"windowNames","871146973":"windowNameCount","1725360295":"mixedInventory","67076235":"chromiumFeatures","238892247":"frameDepth","3674657951":"frameReachedTop"}},
      {"number":6,"name":"media-queries","errorId":167053777,"values":{"2917062982":"elapsedMs","2415992172":"matchedIndices"}},
      {"number":7,"name":"js-engine-quirks","errorId":490069929,"values":{"554936224":"engineSignature","3666888010":"engineQuirks","2230394036":"nanBitPattern","1294939382":"stackDepthElapsedMs","4152792911":"stackDepth"}},
      {"number":8,"name":"webgl-parameters","errorId":253465914,"values":{"777389697":"elapsedMs","87473596":"performanceCaveatFlag","1336980048":"scrambledVendorRenderer","1972507216":"sessionScrambledRenderer","1928516081":"identityExtensionsRaw","2555643228":"sortedUniqueNumbers","3919358648":"extensions","2773728290":"webglGroup0","1728923871":"webglGroup1","2509558564":"webglGroup2","4108958347":"webglGroup3","1897567861":"webglGroup4","3200244371":"webglGroup5","512302077":"webglGroup6","4181527125":"webglGroup7","1576020309":"webglGroup8"}},
      {"number":9,"name":"webgl-render-image","errorId":4050216581,"values":{"1220897592":"elapsedMs","4183559841":"imageDataUrl"}},
      {"number":10,"name":"canvas-shapes-image","errorId":3533666199,"values":{"341539906":"elapsedMs","355878060":"imageDataUrl"}},
      {"number":11,"name":"canvas-text-metrics","errorId":1021121379,"values":{"1211697671":"elapsedMs","1491083857":"emojiImage","3267688668":"arcPixels","3449420946":"systemUiMetrics","2229550873":"emojiMetrics","3802548514":"readbackFontsEmojiEmpty"}},
      {"number":12,"name":"audio-fingerprint","errorId":3826143991,"values":{"2716124778":"elapsedMs","911737141":"audioSum"}},
      {"number":13,"name":"css-layout-rects","errorId":1823042993,"values":{"3858950690":"elapsedMs","1471511403":"layoutValues"}},
      {"number":14,"name":"font-availability","errorId":1910426414,"values":{"23575694":"elapsedMs","1839678460":"loadedFontIndices"}},
      {"number":15,"name":"speech-voices","errorId":591597026,"values":{"1163222395":"elapsedMs","1901410523":"voices","295890166":"voiceSummary"}},
      {"number":16,"name":"media-devices","errorId":2005220780,"values":{"1906094535":"deviceCounts"}},
      {"number":17,"name":"media-codec-support","errorId":350034380,"values":{"1312620289":"elapsedMs","955236451":"supportedTypes"}},
      {"number":18,"name":"webrtc-codecs","errorId":1741946229,"values":{"3258277186":"elapsedMs","722121870":"codecString"}},
      {"number":19,"name":"permissions","errorId":1887910261,"values":{"445065433":"permissionStates"}},
      {"number":20,"name":"storage-quota","errorId":1721193090,"values":{"3499807236":"elapsedMs","3980758932":"storageVector","1959141261":"scrambledQuota"}},
      {"number":21,"name":"timezone-locale","errorId":2638142030,"values":{"4183929798":"scrambledTimeZone","2209466909":"sessionScrambledTimeZone","1510780632":"timezoneSignals","1276654579":"scrambledNow","2382200687":"localHour"}},
      {"number":22,"name":"api-descriptor-tampering","errorId":296055933,"values":{"2048032324":"elapsedMs","3608268250":"tamperedCategories"}},
      {"number":23,"name":"native-api-shape-scores","errorId":1157769296,"values":{"2163526058":"elapsedMs","613213317":"shapeScores","4038680764":"scoresAndTimelineCheck"}},
      {"number":24,"name":"function-call-timing","errorId":510397716,"values":{"1438853278":"callRateGapPercent"}},
      {"number":25,"name":"hidden-global-bindings","errorId":2386731714,"values":{"402070637":"signatureMatches"}},
      {"number":26,"name":"document-structure","errorId":2277192589,"values":{"2756500942":"elapsedMs","1990319134":"elementTree","2736322849":"scriptsAndStylesheets","4187597417":"scrambledReferrer","1752938557":"scrambledPageUrl"}},
      {"number":27,"name":"performance-timing","errorId":882481316,"values":{"3223510981":"timeOrigin","270510365":"resourceGroups","4042871315":"overallMedianWait","2567820746":"overallMedianTotal","162808171":"timerLoopElapsedMs","1395991053":"timerResolution"}}
    ];
    const modes = {
      0: [14, 16, 19, 2, 12, 18, 15, 20, 7, 21, 25, 8, 5, 23, 1, 10, 13, 4, 26, 17, 27, 3, 6, 11, 24, 22, 9],
      1: [2, 14, 19, 15, 20, 12, 16, 7, 18, 3, 27, 8, 26, 25, 24, 23, 6, 5, 17, 22, 9, 11, 21, 4, 1, 10, 13],
      2: [7, 21, 1],
    };
    const labels = new Map([
      [4272833909, { collector: 0, name: "runner", field: "performanceNow" }],
      [3610034899, { collector: 0, name: "runner", field: "totalElapsedMs" }],
      [1150169469, { collector: 0, name: "runner", field: "flags" }],
    ]);
    for (const item of catalog) {
      labels.set(item.errorId, { collector: item.number, name: item.name, field: "error" });
      for (const [id, field] of Object.entries(item.values)) {
        labels.set(Number(id), { collector: item.number, name: item.name, field });
      }
    }

    const clone = root.structuredClone.bind(root);
    const stringify = JSON.stringify.bind(JSON);
    const byArray = new WeakMap();
    const runs = [];
    let lastFinalizedRun = null;
    const diagnostics = [];
    const config = { enabled: true, pauseOnValueId: null, pauseOnFinish: false };
    const frame = { href: root.location?.href ?? null, timeOrigin: root.performance?.timeOrigin ?? null };

    function getRun(entries) {
      if (!Array.isArray(entries)) throw new TypeError("Expected the runner's collectedEntries/fC array.");
      let run = byArray.get(entries);
      if (!run) {
        run = {
          id: runs.length + 1, status: "collecting", task: null,
          records: [], lateRecords: [], storedEntries: null, checks: null, issues: [],
        };
        byArray.set(entries, run);
        runs.push(run);
      }
      return run;
    }

    function nestedNumbers(value, depth = 0) {
      return Array.isArray(value) && depth < 16 && value.every(item =>
        typeof item === "number" ? Number.isFinite(item) : nestedNumbers(item, depth + 1));
    }

    function storedKind(value) {
      if (typeof value === "string") return "json-text";
      if (nestedNumbers(value)) return "hashed-array";
      return "unexpected";
    }

    function errorText(error) {
      return String(error?.message ?? error);
    }

    // Called BEFORE the final assignment in recordProbeValue/hw. The serializer
    // or hash operation has already completed. Never call either operation again.
    function record(entries, valueId, value, stored) {
      if (!config.enabled) return false;
      try {
        if (!Number.isInteger(valueId) || valueId < 0 || valueId > 0xffffffff) {
          throw new TypeError("Expected a numeric uint32 value ID; check breakpoint scope.");
        }
        if (storedKind(stored) === "unexpected") {
          throw new TypeError("Stored value is not JSON text or a numeric array; check breakpoint location/build.");
        }
        const run = getRun(entries);
        const row = {
          index: entries.length, valueId,
          ...(labels.get(valueId) ?? { collector: null, name: "unknown", field: "unknown" }),
          storage: storedKind(stored), stored: clone(stored), rawCaptured: true,
        };
        try {
          row.value = clone(value);
        } catch (error) {
          row.rawCaptured = false;
          row.rawCaptureError = errorText(error);
          run.issues.push(`Raw snapshot failed at index ${row.index}: ${row.rawCaptureError}`);
        }
        if (run.status === "finalized") {
          // A timed-out Promise can still finish later. It was not in the final array.
          run.lateRecords.push(row);
        } else {
          run.records.push(row);
        }
        return config.pauseOnValueId === valueId;
      } catch (error) {
        diagnostics.push({ hook: "record", error: errorText(error) });
        return false;
      }
    }

    // Called at case 2, BEFORE UTF-8 encoding/encryption, after duration and flags.
    function finish(entries, task) {
      if (!config.enabled) return false;
      try {
        const run = getRun(entries);
        if (run.status === "finalized") return false;
        if (!task || typeof task !== "object" || !("f" in task) || !("t" in task)) {
          throw new TypeError("Expected the runner task with f and t; select the outer runner scope.");
        }
        // Intentionally retain only the selector and time budget from the task.
        run.task = clone({ f: task.f, t: task.t });
        run.storedEntries = clone(entries);
        const seen = new Map();
        const duplicateIndexes = [];
        for (const row of run.records) {
          if (seen.has(row.index)) duplicateIndexes.push(row.index);
          seen.set(row.index, row);
        }
        const missingRawIndexes = [];
        const mismatchedIndexes = [];
        const malformedIndexes = [];
        const unknownValueIds = new Set();
        let hashedEntries = 0;
        let jsonTextEntries = 0;
        entries.forEach((pair, index) => {
          if (!Array.isArray(pair) || pair.length !== 2 || !Number.isInteger(pair[0]) ||
              pair[0] < 0 || pair[0] > 0xffffffff || storedKind(pair[1]) === "unexpected") {
            malformedIndexes.push(index);
            return;
          }
          if (!labels.has(pair[0])) unknownValueIds.add(pair[0]);
          if (Array.isArray(pair[1])) hashedEntries += 1;
          else jsonTextEntries += 1;
          const row = seen.get(index);
          if (!row || !row.rawCaptured) missingRawIndexes.push(index);
          if (row && (row.valueId !== pair[0] || stringify(row.stored) !== stringify(pair[1]))) {
            mismatchedIndexes.push(index);
          }
        });
        const unexpectedIndexes = run.records.filter(row => row.index >= entries.length).map(row => row.index);
        run.checks = {
          finalEntryCount: entries.length, observedRecordCount: run.records.length,
          jsonTextEntries, hashedEntries, missingRawIndexes, mismatchedIndexes,
          duplicateIndexes, unexpectedIndexes, malformedIndexes,
          unknownValueIds: [...unknownValueIds],
          rawComplete: run.records.length === entries.length &&
            ![missingRawIndexes, mismatchedIndexes, duplicateIndexes, unexpectedIndexes, malformedIndexes].some(x => x.length),
          knownList: Object.prototype.hasOwnProperty.call(modes, task.f),
        };
        run.status = "finalized";
        lastFinalizedRun = run;
        console.info(`[HSW capture ${run.id}] ${entries.length} final entries; raw complete: ${run.checks.rawComplete}.`, run.checks);
        console.log(run.storedEntries);
        try {
          const report = json("report", run.id);
          root.document?.dispatchEvent(new CustomEvent("vmc:hsw-capture", {
            detail: stringify({ runId: run.id, href: frame.href, report }),
          }));
        } catch (error) {
          diagnostics.push({ hook: "download", error: errorText(error) });
        }
        return config.pauseOnFinish;
      } catch (error) {
        diagnostics.push({ hook: "finish", error: errorText(error) });
        return false;
      }
    }

    function selectedRun(id) {
      const run = id == null ? lastFinalizedRun : runs.find(item => item.id === id);
      if (!run || run.status !== "finalized") {
        throw new Error("No finalized run. Check frame, both breakpoints, and diagnostics; then let the page collect.");
      }
      return run;
    }

    function coverage(id) {
      const run = selectedRun(id);
      const order = modes[run.task.f];
      return catalog.map(item => {
        const observed = run.storedEntries.filter(pair => labels.get(pair[0])?.collector === item.number);
        return {
          collector: item.number, name: item.name,
          scheduledPosition: order?.includes(item.number) ? order.indexOf(item.number) : null,
          status: observed.some(pair => pair[0] === item.errorId) ? "error-recorded" :
            observed.length ? "recorded" : !order ? "unknown-list" :
              order.includes(item.number) ? "no-record-observed" : "not-in-selected-list",
          recordedIds: observed.map(pair => pair[0]),
        };
      });
    }

    function pairs(kind = "stored", id) {
      const run = selectedRun(id);
      if (kind === "stored") return clone(run.storedEntries);
      if (kind !== "raw") throw new Error('Use "stored" or "raw".');
      if (!run.checks.rawComplete) throw new Error('Raw capture is incomplete. Export json("report") to inspect the gaps.');
      return clone([...run.records].sort((a, b) => a.index - b.index).map(row => [row.valueId, row.value]));
    }

    // JSON cannot express these JS primitives. Tag them instead of silently
    // turning raw undefined/NaN/Infinity into null. Stored text stays untouched.
    function rawJsonReplacer(_key, value) {
      if (value === undefined) return { $hswCaptureType: "undefined" };
      if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) {
        return { $hswCaptureType: "number", value: Object.is(value, -0) ? "-0" : String(value) };
      }
      if (typeof value === "bigint") return { $hswCaptureType: "bigint", value: String(value) };
      return value;
    }

    function json(kind = "report", id) {
      if (kind === "stored") return stringify(pairs(kind, id), null, 2);
      if (kind === "raw") return stringify(pairs(kind, id), rawJsonReplacer, 2);
      if (kind !== "report") throw new Error('Use "report", "stored", or "raw".');
      const run = selectedRun(id);
      return stringify({
        schema: "hsw-devtools-observation/1", frame,
        sourceCatalog: "Supplied local HSW build; live source identity not verified",
        rawMeaning: "record argument at append; collector-level scrambling remains",
        instrumentation: "Global __hswCapture and debugger conditions can affect inventory, timing and timeouts",
        ...run, coverage: coverage(run.id), diagnostics,
      }, rawJsonReplacer, 2);
    }

    root[key] = { version: 1, config, runs, diagnostics, catalog, record, finish, pairs, json, coverage };
    console.info("HSW capture installed in", frame.href,
      "\nAdd both conditional breakpoints from collector-capture.md. When the extension injected this script, finish() downloads the full report. copy(__hswCapture.json()) still works.");
  })();
