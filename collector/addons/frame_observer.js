  // ==== frame observer addon (collection_context = extension_frame_observer) ====================
  // Inserted by collector/build.py into the core's scope for the extension's MAIN-world content
  // script. Batches go to the extension's isolated-world bridge as CustomEvents on `document`
  // with a JSON string detail. window.postMessage is deliberately not used: hcaptcha.html stores
  // foreign messages and passes them to the proof function (ctx.messages), which would alter the
  // data being observed.
  (function frameObserverAddon() {
    const CEv = window.CustomEvent;
    const dispatch = EventTarget.prototype.dispatchEvent;
    let bridgeReady = false;
    bindingMissingNoted = true; // replaced by the explicit bridge check below
    R(addEL, document, ['vmc:bridge-ready', () => {
      if (!bridgeReady) { bridgeReady = true; setTimeout(() => flush('bridge_ready'), 0); }
    }]);
    transport = {
      name: 'extension_bridge',
      available: () => bridgeReady,
      send: (batch) => { R(dispatch, document, [new CEv('vmc:frame-batch', { detail: jsonStringify(batch) })]); },
    };
    try { R(dispatch, document, [new CEv('vmc:observer-ping')]); } catch (_) {}
    setTimeout(() => {
      if (!bridgeReady) diag('bridge_unavailable', { after_ms: 3000, queued: queue.length });
    }, 3000);
  })();
