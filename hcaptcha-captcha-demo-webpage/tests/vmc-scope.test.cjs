const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const extension = path.resolve(root, '../dist/vmc-frame-observer');
const read = (name) => readFileSync(path.join(extension, name), 'utf8');
const configBytes = readFileSync(path.join(root, 'vmc-config.json'));
const config = JSON.parse(configBytes);
const origins = config.experiment_origins;
const manifest = JSON.parse(read('manifest.json'));
const tick = () => new Promise(setImmediate);

function bundleConfig(filename) {
  const source = readFileSync(filename, 'utf8');
  return JSON.parse(source.slice(source.lastIndexOf('\n})(') + 4).trim().slice(0, -2));
}

function bridgeContext(topOrigin, frame = false) {
  const document = new EventTarget();
  const messages = [];
  const responses = [];
  const window = {};
  window.top = frame ? {} : window;
  const location = {
    origin: frame ? 'https://newassets.hcaptcha.com' : topOrigin,
    href: frame ? 'https://newassets.hcaptcha.com/captcha/test/hcaptcha.html' : topOrigin + '/',
    ancestorOrigins: frame ? [topOrigin] : [],
  };
  const context = vm.createContext({
    self: window, window, document, location, CustomEvent, console,
    chrome: { runtime: { sendMessage(message, callback) {
      messages.push(message);
      // Transport stub only; this test does not claim live frames or VM snapshots.
      callback({ extension_version: manifest.version, frames_observed: 0, vm_snapshots: 0 });
    } } },
  });
  document.addEventListener('vmc:ext-to-site', (event) => responses.push(JSON.parse(event.detail)));
  vm.runInContext(read('config.js'), context);
  vm.runInContext(read('bridge.js'), context);
  return { document, messages, responses };
}

function backgroundContext() {
  const storage = {};
  const tabs = new Map();
  let receive, navigate, navigationFilter;
  const chrome = {
    runtime: {
      id: 'unit-test-extension', getManifest: () => manifest,
      onMessage: { addListener(listener) { receive = listener; } },
    },
    storage: { local: {
      async get(key) {
        return structuredClone(key === null ? storage : { [key]: storage[key] });
      },
      async set(values) { Object.assign(storage, structuredClone(values)); },
    } },
    tabs: { async get(id) { return tabs.get(id); } },
    webNavigation: { onCommitted: { addListener(listener, filter) {
      navigate = listener; navigationFilter = filter;
    } } },
  };
  const context = vm.createContext({ self: {}, chrome, URL, Blob, setTimeout, clearTimeout });
  context.importScripts = (...names) => {
    for (const name of names) vm.runInContext(read(name), context);
  };
  vm.runInContext(read('background.js'), context);
  return {
    context, storage, tabs, navigationFilter,
    navigate: (event) => navigate(event),
    send: (message, sender) => new Promise((resolve) => receive(message, sender, resolve)),
  };
}

test('the manifest and all embedded scopes contain the same two exact origins', () => {
  const site = bundleConfig(path.join(root, 'public/vmc/vmc-site-collector.js'));
  const observer = bundleConfig(path.join(extension, 'observer-main.js'));
  const runtime = { self: {} };
  vm.runInNewContext(read('config.js'), runtime);
  const expected = [
    'https://hcaptcha-captcha-demo2-webpage.vercel.app',
    'https://hcaptcha-captcha-demo3-webpage.vercel.app',
  ];
  assert.deepEqual([...origins].sort(), expected);
  assert.equal(site.experiment_origin, expected[1]);
  assert.equal(site.site.experiment_url, expected[1] + '/');
  assert.equal(site.vm_observer.enabled, false);
  assert.equal(observer.vm_observer.enabled, true);
  const hash = createHash('sha256').update(configBytes).digest('hex');
  assert.equal(site.config_sha256, hash);
  assert.equal(observer.config_sha256, hash);
  for (const embedded of [observer, runtime.self.VMC_EXTENSION_CONFIG]) {
    assert.deepEqual([...embedded.experiment_origins].sort(), expected);
  }
  assert.deepEqual([...manifest.host_permissions].sort(), [
    ...expected.map((origin) => origin + '/*'), 'https://newassets.hcaptcha.com/*',
  ].sort());
  for (const origin of expected) assert.ok(manifest.content_scripts[0].matches.includes(origin + '/*'));
  assert.ok(manifest.content_scripts.every((script) => script.run_at === 'document_start' && script.all_frames));
  assert.ok(!manifest.permissions.includes('debugger'));
  const capture = {};
  vm.runInNewContext(read('collector-capture.js').split('\n')[0], capture);
  assert.deepEqual([...capture.__VMC_HSW_CAPTURE_ORIGINS].sort(), expected);
});

test('the real bridge answers website status requests on both sites', async () => {
  for (const origin of origins) {
    const { document, messages, responses } = bridgeContext(origin);
    document.dispatchEvent(new CustomEvent('vmc:site-to-ext', {
      detail: JSON.stringify({ type: 'status', session_id: 'unit-session', document_id: 'unit-document' }),
    }));
    await tick();
    assert.equal(messages.length, 1, origin);
    assert.equal(messages[0].type, 'site_status');
    assert.equal(messages[0].session_id, 'unit-session');
    assert.equal(responses[0].type, 'status');
    assert.equal(responses[0].extension_version, manifest.version);
  }
});

test('the real bridge relays hCaptcha frame batches under both sites', async () => {
  for (const origin of origins) {
    const { document, messages } = bridgeContext(origin, true);
    const batch = JSON.stringify({ document_id: 'unit-document', batch_seq: 1, records: [] });
    document.dispatchEvent(new CustomEvent('vmc:frame-batch', { detail: batch }));
    await tick();
    assert.equal(messages.length, 1, origin);
    assert.equal(messages[0].type, 'frame_batch');
    assert.equal(messages[0].batch, batch);
  }
});

test('the bridge remains inactive on unrelated origins and lookalike hosts', async () => {
  for (const unrelated of [origins[1] + '.example.invalid', origins[1].replace('https:', 'http:'), 'https://example.invalid']) {
    for (const frame of [false, true]) {
      const { document, messages, responses } = bridgeContext(unrelated, frame);
      document.dispatchEvent(new CustomEvent('vmc:site-to-ext', { detail: '{"type":"status"}' }));
      document.dispatchEvent(new CustomEvent('vmc:frame-batch', { detail: '{"records":[]}' }));
      await tick();
      assert.equal(messages.length, 0, unrelated);
      assert.equal(responses.length, 0, unrelated);
    }
  }
});

test('MAIN observer and capture guards admit both sites before the installation check', () => {
  for (const origin of [...origins, 'https://example.invalid']) {
    for (const [file, installedKey] of [['observer-main.js', '__vmcInstalled'], ['collector-capture.js', '__hswCapture']]) {
      let reachedInstallationCheck = false;
      const window = new Proxy({ [installedKey]: true, top: {} }, {
        getOwnPropertyDescriptor(target, key) {
          if (key === installedKey) reachedInstallationCheck = true;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
      window.location = {
        origin: 'https://newassets.hcaptcha.com',
        ancestorOrigins: [origin], href: 'https://newassets.hcaptcha.com/captcha/test/hcaptcha.html',
      };
      // The existing-install guard stops execution before any recording or proof function runs.
      vm.runInNewContext(read(file), {
        window, globalThis: window, location: window.location, console: { info() {} },
      });
      assert.equal(reachedInstallationCheck, origins.includes(origin), file + ' ' + origin);
    }
  }
});

test('the background worker keeps demo2 and demo3 batches and exports separate by tab', async () => {
  const background = backgroundContext();
  const senders = origins.map((origin, index) => ({
    tab: { id: index + 10, url: origin + '/' }, frameId: 1,
    url: 'https://newassets.hcaptcha.com/captcha/test/hcaptcha.html',
  }));
  for (const [index, sender] of senders.entries()) {
    background.tabs.set(sender.tab.id, sender.tab);
    for (let frame = 1; frame <= index + 1; frame++) {
      const batch = { document_id: `unit-${index}-${frame}`, batch_seq: 1, records: [] };
      const result = await background.send({ type: 'frame_batch', batch: JSON.stringify(batch) }, { ...sender, frameId: frame });
      assert.equal(result.ok, true);
    }
    const status = await background.send({ type: 'site_status', session_id: `unit-session-${index}`, document_id: `unit-parent-${index}` }, sender);
    assert.equal(status.frames_observed, index + 1);
    assert.equal(status.vm_snapshots, 0);
    const exported = await background.send({ type: 'export', session_id: `unit-session-${index}` }, sender);
    assert.equal(exported.batches.length, index + 1);
    assert.ok(exported.batches.every((batch) => batch.document_id.startsWith(`unit-${index}-`)));
    assert.equal(exported.manifest.config.experiment_origin, origins[index]);
  }
  const result = await background.send({ type: 'site_status' }, { tab: { id: 99, url: 'https://example.invalid/' } });
  assert.equal(result.error, 'not an experiment tab');
});

test('switching origins in the same tab cannot mix the two experiments', async () => {
  const background = backgroundContext();
  for (const [index, origin] of origins.entries()) {
    const sender = { tab: { id: 20, url: origin + '/' }, frameId: 1,
      url: 'https://newassets.hcaptcha.com/captcha/test/hcaptcha.html' };
    await background.send({ type: 'frame_batch', batch: JSON.stringify({
      document_id: `unit-origin-${index}`, batch_seq: 1, records: [],
    }) }, sender);
    const status = await background.send({ type: 'site_status', session_id: `unit-session-${index}` }, sender);
    assert.equal(status.frames_observed, 1);
    assert.equal(status.batches, 1);
    const exported = await background.send({ type: 'export', session_id: `unit-session-${index}` }, sender);
    assert.equal(exported.batches.length, 1);
    assert.equal(exported.batches[0].document_id, `unit-origin-${index}`);
    assert.equal(exported.manifest.config.experiment_origin, origin);
  }
});

test('navigation and HSW report guards accept either site and reject other tabs', async () => {
  const background = backgroundContext();
  const filters = background.navigationFilter.url.map((rule) => rule.urlPrefix);
  for (const [index, origin] of origins.entries()) {
    assert.ok(filters.includes(origin + '/'));
    background.tabs.set(index, { url: origin + '/' });
    await background.navigate({ tabId: index, frameId: 1, parentFrameId: 0,
      url: 'https://newassets.hcaptcha.com/captcha/test/hcaptcha.html', timeStamp: index + 1 });
    background.context.sender = { tab: { id: index, url: origin + '/' },
      url: 'https://newassets.hcaptcha.com/captcha/test/hcaptcha.html' };
    assert.equal(vm.runInContext('hswFrameAllowed(sender)', background.context), true);
  }
  assert.equal(Object.keys(background.storage).length, 2);
  background.tabs.set(99, { url: 'https://example.invalid/' });
  await background.navigate({ tabId: 99, frameId: 1, url: 'https://newassets.hcaptcha.com/captcha/test/hcaptcha.html', timeStamp: 5 });
  assert.equal(Object.keys(background.storage).length, 2);
  background.context.sender = { tab: { id: 99, url: 'https://example.invalid/' },
    url: 'https://newassets.hcaptcha.com/captcha/test/hcaptcha.html' };
  assert.equal(vm.runInContext('hswFrameAllowed(sender)', background.context), false);
});
