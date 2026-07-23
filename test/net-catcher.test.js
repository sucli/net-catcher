const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

class FakeWindow {
  constructor(responder = null) {
    this.listeners = new Map();
    this.messages = [];
    this.responder = responder;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  postMessage(data) {
    this.messages.push(data);
    if (data.__netCatcher && data.messageId && this.responder) {
      const response = this.responder(data);
      queueMicrotask(() => this.emitMessage({
        __netCatcherResponse: true,
        messageId: data.messageId,
        response,
      }));
    }
  }

  emitMessage(data) {
    for (const listener of this.listeners.get('message') || []) {
      listener({ source: this, data });
    }
  }
}

class FakeProgressEvent extends Event {
  constructor(type, init = {}) {
    super(type);
    Object.assign(this, init);
  }
}

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    super();
    this.url = String(url);
    this._onmessage = null;
  }

  get onmessage() { return this._onmessage; }
  set onmessage(handler) {
    if (this._onmessage) this.removeEventListener('message', this._onmessage);
    this._onmessage = handler;
    if (handler) this.addEventListener('message', handler);
  }

  send() {}
}

function loadMainScript({ responder, fetchImpl = async () => new Response('ok') } = {}) {
  class LocalXMLHttpRequest extends EventTarget {
    static networkCalls = 0;

    open() { this.readyState = 1; }
    send() { LocalXMLHttpRequest.networkCalls += 1; }
    abort() {}
    setRequestHeader() {}
    getAllResponseHeaders() { return ''; }
  }

  const window = new FakeWindow(responder);
  window.fetch = fetchImpl;
  window.WebSocket = FakeWebSocket;

  const context = vm.createContext({
    window,
    XMLHttpRequest: LocalXMLHttpRequest,
    WebSocket: FakeWebSocket,
    fetch: fetchImpl,
    Headers,
    Request,
    Response,
    FormData,
    URLSearchParams,
    Blob,
    ArrayBuffer,
    TextDecoder,
    TextEncoder,
    URL,
    Event,
    ProgressEvent: FakeProgressEvent,
    crypto,
    performance: { timeOrigin: 1_700_000_000_000, now: () => 42 },
    setTimeout,
    clearTimeout,
    queueMicrotask,
  });
  const source = fs.readFileSync(path.join(projectRoot, 'content_script_main.js'), 'utf8');
  vm.runInContext(source, context);
  return { context, window, XMLHttpRequest: LocalXMLHttpRequest };
}

test('bridge forwards capture events and blocks page control commands', async () => {
  const window = new FakeWindow();
  const sent = [];
  const context = vm.createContext({
    window,
    chrome: {
      runtime: {
        sendMessage: async message => {
          sent.push(message);
          return { ok: true };
        },
      },
    },
  });
  vm.runInContext(fs.readFileSync(path.join(projectRoot, 'content_script_bridge.js'), 'utf8'), context);

  window.emitMessage({ __netCatcher: true, type: 'CLEAR_REQUESTS', data: {} });
  window.emitMessage({
    __netCatcher: true,
    messageId: 'request-1',
    type: 'NET_REQUEST',
    data: { captureId: 'capture-1' },
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'NET_REQUEST');
  assert.ok(window.messages.some(message =>
    message.__netCatcherResponse && message.messageId === 'request-1'
  ));
});

test('fetch returns a real mock response without issuing the network request', async () => {
  let networkCalls = 0;
  const { window } = loadMainScript({
    fetchImpl: async () => {
      networkCalls += 1;
      return new Response('network');
    },
    responder: message => message.type === 'NET_REQUEST' ? {
      mocked: true,
      mockResponse: {
        status: 201,
        headers: { 'content-type': 'application/json' },
        body: '{"mocked":true}',
      },
    } : null,
  });

  const response = await window.fetch('https://example.test/api');
  assert.equal(networkCalls, 0);
  assert.equal(response.status, 201);
  assert.equal(await response.text(), '{"mocked":true}');
});

test('fetch resolves before asynchronous response-body capture finishes', async () => {
  let releaseBody;
  const pendingBody = new Promise(resolve => { releaseBody = resolve; });
  const response = {
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'text/plain' }),
    clone() {
      return {
        body: {
          getReader: () => ({
            read: () => pendingBody,
            cancel: async () => {},
            releaseLock: () => {},
          }),
        },
      };
    },
  };
  const { window } = loadMainScript({
    fetchImpl: async () => response,
    responder: () => ({ mocked: false }),
  });

  const result = await Promise.race([
    window.fetch('https://example.test/stream'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('fetch was blocked by body capture')), 100)),
  ]);
  assert.equal(result, response);
  assert.ok(window.messages.some(message => message.type === 'NET_RESPONSE'));
  releaseBody({ done: true });
});

test('fetch does not wait for the bridge when no mock rules are active', async () => {
  let networkCalls = 0;
  const { window } = loadMainScript({
    fetchImpl: async () => {
      networkCalls += 1;
      return new Response('network');
    },
  });
  window.location = { href: 'https://example.test/page' };
  window.emitMessage({ __netCatcherConfig: true, hasActiveMockRules: false });

  const response = await Promise.race([
    window.fetch('/fast'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('fetch waited for bridge')), 50)),
  ]);
  assert.equal(networkCalls, 1);
  assert.equal(await response.text(), 'network');
  const request = window.messages.find(message => message.type === 'NET_REQUEST');
  assert.equal(request.data.url, 'https://example.test/fast');
});

test('XMLHttpRequest mock completes without issuing the network request', async () => {
  const { XMLHttpRequest } = loadMainScript({
    responder: message => message.type === 'NET_REQUEST' ? {
      mocked: true,
      mockResponse: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"from":"mock"}',
      },
    } : null,
  });
  const xhr = new XMLHttpRequest();
  const states = [];
  let loadEvents = 0;
  xhr.open('GET', 'https://example.test/xhr', true);
  xhr.addEventListener('readystatechange', () => states.push(xhr.readyState));
  xhr.addEventListener('load', () => { loadEvents += 1; });
  xhr.send();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(XMLHttpRequest.networkCalls, 0);
  assert.deepEqual(states, [2, 3, 4]);
  assert.equal(loadEvents, 1);
  assert.equal(xhr.status, 200);
  assert.equal(xhr.responseText, '{"from":"mock"}');
});

test('WebSocket page handlers still run and capture IDs use absolute time', () => {
  const { window } = loadMainScript({ responder: () => null });
  const socket = new window.WebSocket('wss://example.test/socket');
  let received = 0;
  socket.onmessage = () => { received += 1; };
  const event = new Event('message');
  Object.defineProperty(event, 'data', { value: 'hello' });
  socket.dispatchEvent(event);

  assert.equal(received, 1);
  const open = window.messages.find(message => message.type === 'WS_OPEN');
  assert.equal(typeof open.data.id, 'string');
  assert.ok(open.data.startTime > 1_600_000_000_000);
  assert.equal(window.messages.filter(message => message.type === 'WS_MESSAGE').length, 1);
  socket.dispatchEvent(new Event('open'));
  assert.equal(window.messages.filter(message => message.type === 'WS_READY').length, 1);
});

function createBackgroundHarness(storageData = {}) {
  let listener;
  const writes = [];
  const chrome = {
    storage: {
      local: {
        get: async () => storageData,
        set: data => { writes.push(data); return Promise.resolve(); },
      },
    },
    runtime: {
      id: 'extension-id',
      getURL: suffix => `chrome-extension://extension-id/${suffix}`,
      getManifest: () => ({ version: '2.0.1' }),
      onMessage: { addListener: value => { listener = value; } },
      sendMessage: async () => {},
    },
  };
  const context = vm.createContext({ chrome, fetch: async () => new Response('ok'), Date, Map, Set, URL, console });
  vm.runInContext(fs.readFileSync(path.join(projectRoot, 'background.js'), 'utf8'), context);

  const dispatch = (message, sender) => new Promise(resolve => listener(message, sender, resolve));
  return { dispatch, writes };
}

test('background rejects control commands from content scripts and correlates by capture ID', async () => {
  const { dispatch } = createBackgroundHarness();
  const contentSender = { id: 'extension-id', tab: { id: 7 }, frameId: 0, url: 'https://example.test/' };
  const popupSender = { id: 'extension-id', url: 'chrome-extension://extension-id/popup.html' };

  const denied = await dispatch({ type: 'CLEAR_REQUESTS' }, contentSender);
  assert.match(denied.error, /禁止/);

  const base = {
    url: 'https://example.test/api', method: 'GET', startTime: 1_700_000_000_000, type: 'fetch',
  };
  await dispatch({ type: 'NET_REQUEST', data: { ...base, captureId: 'first' } }, contentSender);
  await dispatch({ type: 'NET_REQUEST', data: { ...base, captureId: 'second' } }, contentSender);
  await dispatch({
    type: 'NET_RESPONSE',
    data: { captureId: 'second', status: 204, statusText: 'OK', endTime: base.startTime + 12 },
  }, contentSender);

  const result = await dispatch({ type: 'GET_REQUESTS' }, popupSender);
  assert.equal(result.requests.length, 2);
  assert.equal(result.requests.find(request => request.captureId === 'first').status, null);
  assert.equal(result.requests.find(request => request.captureId === 'second').status, 204);
});

test('background returns configured mock data to the page interceptor', async () => {
  const { dispatch } = createBackgroundHarness({
    nc_mockRules: [{
      id: 1,
      pattern: '/mocked',
      enabled: true,
      isRegex: false,
      status: 202,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
    }],
  });
  const sender = { id: 'extension-id', tab: { id: 1 }, frameId: 0, url: 'https://example.test/' };
  const result = await dispatch({
    type: 'NET_REQUEST',
    data: {
      captureId: 'mock-request', url: 'https://example.test/mocked',
      method: 'GET', startTime: Date.now(), type: 'fetch',
    },
  }, sender);

  assert.equal(result.mocked, true);
  assert.equal(result.mockResponse.status, 202);
  assert.equal(result.mockResponse.body, '{"ok":true}');
});

test('background applies sensitive-data redaction and excludes configured hosts', async () => {
  const { dispatch } = createBackgroundHarness();
  const popupSender = { id: 'extension-id', url: 'chrome-extension://extension-id/popup.html' };
  const sender = { id: 'extension-id', tab: { id: 3 }, frameId: 0, url: 'https://example.test/' };

  await dispatch({ type: 'UPDATE_SETTINGS', data: { excludedHosts: ['blocked.test'] } }, popupSender);
  const excluded = await dispatch({ type: 'NET_REQUEST', data: {
    captureId: 'excluded', url: 'https://api.blocked.test/data', startTime: 1, type: 'fetch',
  } }, sender);
  assert.equal(excluded, null);

  await dispatch({ type: 'NET_REQUEST', data: {
    captureId: 'redacted', url: 'https://api.example.test/data', startTime: 1, type: 'fetch',
    requestHeaders: { Authorization: 'secret' }, requestBody: '{"token":"secret"}',
  } }, sender);
  const result = await dispatch({ type: 'GET_REQUESTS', data: { tabId: 3 } }, popupSender);
  assert.equal(result.requests[0].requestHeaders.Authorization, '[REDACTED]');
  assert.equal(result.requests[0].requestBody, '{"token":"[REDACTED]"}');
});

test('background isolates requests by tab and supports method-specific mocks', async () => {
  const { dispatch } = createBackgroundHarness();
  const popupSender = { id: 'extension-id', url: 'chrome-extension://extension-id/popup.html' };
  const sender1 = { id: 'extension-id', tab: { id: 1 }, frameId: 0 };
  const sender2 = { id: 'extension-id', tab: { id: 2 }, frameId: 0 };

  await dispatch({ type: 'ADD_MOCK_RULE', data: {
    pattern: '/only-post', method: 'POST', status: 201, body: 'created', delay: 12,
  } }, popupSender);
  const getResult = await dispatch({ type: 'NET_REQUEST', data: {
    captureId: 'get', url: 'https://example.test/only-post', method: 'GET', startTime: 1, type: 'fetch',
  } }, sender1);
  const postResult = await dispatch({ type: 'NET_REQUEST', data: {
    captureId: 'post', url: 'https://example.test/only-post', method: 'POST', startTime: 1, type: 'fetch',
  } }, sender1);
  await dispatch({ type: 'NET_REQUEST', data: {
    captureId: 'other-tab', url: 'https://example.test/other', method: 'GET', startTime: 1, type: 'fetch',
  } }, sender2);

  assert.equal(getResult.mocked, false);
  assert.equal(postResult.mocked, true);
  assert.equal(postResult.mockResponse.delay, 12);
  const scoped = await dispatch({ type: 'GET_REQUESTS', data: { tabId: 1 } }, popupSender);
  assert.equal(scoped.requests.length, 2);
  await dispatch({ type: 'CLEAR_REQUESTS', data: { tabId: 1 } }, popupSender);
  const remaining = await dispatch({ type: 'GET_REQUESTS' }, popupSender);
  assert.equal(remaining.requests.length, 1);
  assert.equal(remaining.requests[0].captureId, 'other-tab');
});

test('background tracks WebSocket readiness and request tags', async () => {
  const { dispatch } = createBackgroundHarness();
  const popupSender = { id: 'extension-id', url: 'chrome-extension://extension-id/popup.html' };
  const sender = { id: 'extension-id', tab: { id: 4 }, frameId: 0 };
  await dispatch({ type: 'WS_OPEN', data: { id: 'ws-1', url: 'wss://example.test', startTime: 10 } }, sender);
  let result = await dispatch({ type: 'GET_WS_DETAIL', data: { id: 'ws-1' } }, popupSender);
  assert.equal(result.connection.status, 'connecting');
  await dispatch({ type: 'WS_READY', data: { id: 'ws-1', timestamp: 20 } }, sender);
  result = await dispatch({ type: 'GET_WS_DETAIL', data: { id: 'ws-1' } }, popupSender);
  assert.equal(result.connection.status, 'open');

  await dispatch({ type: 'NET_REQUEST', data: {
    captureId: 'tagged', url: 'https://example.test/tagged', startTime: 1, type: 'fetch',
  } }, sender);
  const updated = await dispatch({ type: 'UPDATE_TAGS', data: { id: 1, tags: ['important', 'api'] } }, popupSender);
  assert.equal(updated.ok, true);
  result = await dispatch({ type: 'GET_REQUESTS', data: { tabId: 4 } }, popupSender);
  assert.deepEqual(result.requests[0].tags, ['important', 'api']);
});

test('HAR export includes query parameters and request MIME type', async () => {
  const { dispatch } = createBackgroundHarness();
  const popupSender = { id: 'extension-id', url: 'chrome-extension://extension-id/popup.html' };
  const sender = { id: 'extension-id', tab: { id: 5 }, frameId: 0 };
  await dispatch({ type: 'NET_REQUEST', data: {
    captureId: 'har-1', url: 'https://example.test/api?a=1&b=two', method: 'POST', startTime: 100,
    type: 'fetch', requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' }, requestBody: 'a=1',
  } }, sender);
  await dispatch({ type: 'NET_RESPONSE', data: {
    captureId: 'har-1', status: 200, statusText: 'OK', endTime: 120, responseHeaders: {}, responseBody: 'ok',
  } }, sender);
  const result = await dispatch({ type: 'EXPORT_HAR', data: { tabId: 5 } }, popupSender);
  const entry = result.har.log.entries[0];
  assert.equal(JSON.stringify(entry.request.queryString), JSON.stringify([{ name: 'a', value: '1' }, { name: 'b', value: 'two' }]));
  assert.equal(entry.request.postData.mimeType, 'application/x-www-form-urlencoded');
});
