// NetCatcher - Content Script (MAIN world)
// Intercepts fetch, XMLHttpRequest and WebSocket without changing page handlers.

(function() {
  'use strict';

  const MAX_CAPTURE_BODY_BYTES = 1024 * 1024;
  const BRIDGE_TIMEOUT_MS = 80;
  const pendingBridgeRequests = new Map();
  let fallbackId = 0;
  // 默认不阻塞请求；等 bridge 配置后再决定是否走 mock/拦截路径
  let mockDecisionRequired = false;
  let capturingEnabled = true;
  let bridgeNonce = null;
  let bridgeNoncePromise = null;
  let bridgeNonceResolve = null;
  const wsInstances = new Map();

  function shouldSkipCapture(url) {
    return /^(chrome-extension|chrome|about|data|blob|devtools):/i.test(String(url || ''));
  }

  function waitForBridgeNonce() {
    if (bridgeNonce) return Promise.resolve(bridgeNonce);
    if (!bridgeNoncePromise) {
      bridgeNoncePromise = new Promise(resolve => { bridgeNonceResolve = resolve; });
      window.postMessage({ __netCatcher: true, __netCatcherHello: true }, '*');
    }
    return Promise.race([
      bridgeNoncePromise,
      new Promise(resolve => setTimeout(() => resolve(null), BRIDGE_TIMEOUT_MS)),
    ]);
  }

  function now() {
    return performance.timeOrigin + performance.now();
  }

  function createCaptureId(prefix) {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    fallbackId += 1;
    return `${prefix}-${Date.now()}-${fallbackId}-${Math.random().toString(16).slice(2)}`;
  }

  function sendToBridge(type, data) {
    if (bridgeNonce) {
      window.postMessage({ __netCatcher: true, type, data, nonce: bridgeNonce }, '*');
      return;
    }
    waitForBridgeNonce().then(nonce => {
      if (nonce) window.postMessage({ __netCatcher: true, type, data, nonce }, '*');
    });
  }

  function requestBridge(type, data) {
    const messageId = createCaptureId('bridge');
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        pendingBridgeRequests.delete(messageId);
        resolve(null);
      }, BRIDGE_TIMEOUT_MS);

      pendingBridgeRequests.set(messageId, response => {
        clearTimeout(timer);
        resolve(response);
      });
      waitForBridgeNonce().then(nonce => {
        if (!nonce) {
          pendingBridgeRequests.delete(messageId);
          clearTimeout(timer);
          resolve(null);
          return;
        }
        window.postMessage({ __netCatcher: true, messageId, type, data, nonce }, '*');
      });
    });
  }

  window.addEventListener('message', event => {
    if (event.source !== window) return;
    if (event.data?.__netCatcherBridgeReady && typeof event.data.nonce === 'string') {
      bridgeNonce = event.data.nonce;
      if (bridgeNonceResolve) bridgeNonceResolve(bridgeNonce);
      return;
    }
    if (event.data?.__netCatcherConfig) {
      if (event.data.nonce !== bridgeNonce) return;
      mockDecisionRequired = !!event.data.hasActiveMockRules;
      capturingEnabled = event.data.isCapturing !== false;
      return;
    }
    if (event.data?.__netCatcher && event.data.type === 'WS_REPLAY') {
      if (event.data.nonce !== bridgeNonce) return;
      const socket = wsInstances.get(event.data.data?.id);
      if (!socket || socket.readyState !== OriginalWebSocket.OPEN) return;
      try { socket.send(event.data.data.data); } catch {}
      return;
    }
    if (!event.data?.__netCatcherResponse) return;
    if (event.data.nonce !== bridgeNonce) return;
    const resolve = pendingBridgeRequests.get(event.data.messageId);
    if (!resolve) return;
    pendingBridgeRequests.delete(event.data.messageId);
    resolve(event.data.response ?? null);
  });
  window.postMessage({ __netCatcher: true, __netCatcherHello: true }, '*');

  function normalizeHeaders(headers) {
    const result = {};
    if (!headers) return result;
    try {
      new Headers(headers).forEach((value, name) => { result[name] = value; });
    } catch {}
    return result;
  }

  async function serializeRequestBody(body) {
    if (body === undefined || body === null) return null;
    if (typeof body === 'string') return body;
    if (body instanceof FormData) return '[FormData]';
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof Blob) {
      try { return await body.text(); } catch { return `[Blob ${body.size} bytes]`; }
    }
    if (body instanceof ArrayBuffer) {
      try { return new TextDecoder().decode(body); } catch { return `[ArrayBuffer ${body.byteLength} bytes]`; }
    }
    try { return JSON.stringify(body); } catch { return null; }
  }

  function serializeBeaconBody(body) {
    if (body === undefined || body === null) return null;
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof Blob) return `[Blob ${body.size} bytes]`;
    if (body instanceof ArrayBuffer) return `[ArrayBuffer ${body.byteLength} bytes]`;
    if (body instanceof FormData) return '[FormData]';
    try { return JSON.stringify(body); } catch { return null; }
  }

  function bytesToBase64(buffer) {
    if (typeof btoa !== 'function') return null;
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }

  function bytesToHex(buffer, maxBytes = 256) {
    const bytes = new Uint8Array(buffer).slice(0, maxBytes);
    return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join(' ');
  }

  function captureWebSocketMessage(id, direction, data) {
    if (typeof data === 'string') {
      sendToBridge('WS_MESSAGE', { id, direction, messageType: 'text', data, timestamp: now() });
      return;
    }
    const publishBinary = buffer => {
      const base64 = bytesToBase64(buffer);
      sendToBridge('WS_MESSAGE', {
        id, direction, messageType: 'binary', data: base64 || `[Binary ${buffer.byteLength} bytes]`,
        dataEncoding: base64 ? 'base64' : 'summary', dataSize: buffer.byteLength,
        dataHex: bytesToHex(buffer), timestamp: now(),
      });
    };
    if (data instanceof ArrayBuffer) {
      publishBinary(data);
    } else if (ArrayBuffer.isView(data)) {
      publishBinary(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    } else if (data instanceof Blob) {
      data.arrayBuffer().then(publishBinary).catch(() => {
        sendToBridge('WS_MESSAGE', {
          id, direction, messageType: 'binary', data: `[Blob ${data.size} bytes]`,
          dataEncoding: 'summary', dataSize: data.size, timestamp: now(),
        });
      });
    } else {
      sendToBridge('WS_MESSAGE', { id, direction, messageType: 'text', data: String(data), timestamp: now() });
    }
  }

  async function readResponseBody(response) {
    const contentType = response.headers?.get?.('content-type') || '';
    if (contentType.toLowerCase().startsWith('image/') && typeof response.arrayBuffer === 'function') {
      try {
        const buffer = await response.arrayBuffer();
        const body = bytesToBase64(buffer);
        return {
          body: buffer.byteLength <= MAX_CAPTURE_BODY_BYTES ? body : null,
          bodyEncoding: body && buffer.byteLength <= MAX_CAPTURE_BODY_BYTES ? 'base64' : undefined,
          bodyMimeType: contentType.split(';', 1)[0],
          size: buffer.byteLength,
          truncated: buffer.byteLength > MAX_CAPTURE_BODY_BYTES,
        };
      } catch {}
    }
    if (!response.body?.getReader) {
      const text = await response.text();
      return {
        body: text.slice(0, MAX_CAPTURE_BODY_BYTES),
        size: text.length,
        truncated: text.length > MAX_CAPTURE_BODY_BYTES,
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let body = '';
    let size = 0;
    let truncated = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        const remaining = MAX_CAPTURE_BODY_BYTES - body.length;
        if (remaining > 0) body += decoder.decode(value, { stream: true }).slice(0, remaining);
        if (size > MAX_CAPTURE_BODY_BYTES) {
          truncated = true;
          await reader.cancel();
          break;
        }
      }
      body += decoder.decode();
    } finally {
      reader.releaseLock();
    }

    return { body, size, truncated };
  }

  function createMockResponse(url, mock) {
    const status = Number(mock.status) || 200;
    const body = [204, 205, 304].includes(status) ? null : (mock.body ?? '');
    const response = new Response(body, {
      status,
      statusText: 'Mocked',
      headers: mock.headers || {},
    });
    try { Object.defineProperty(response, 'url', { value: url }); } catch {}
    return response;
  }

  // ============ fetch ============
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const input = args[0];
    const init = args[1] || {};
    const rawUrl = typeof input === 'string' ? input :
      input instanceof Request ? input.url : String(input);
    let url = rawUrl;
    try { url = new URL(rawUrl, window.location?.href).href; } catch {}

    // 快速路径：暂停捕获或特殊协议时不做任何拦截/序列化
    if (!capturingEnabled || shouldSkipCapture(url)) {
      return originalFetch.apply(this, args);
    }

    const method = (init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const requestHeaders = normalizeHeaders(init.headers || (input instanceof Request ? input.headers : null));
    const captureId = createCaptureId('http');
    const startTime = now();
    const hasBodyMethod = !['GET', 'HEAD'].includes(method);

    let requestBody = null;
    if (hasBodyMethod) {
      requestBody = await serializeRequestBody(init.body);
      if (init.body === undefined && input instanceof Request) {
        try { requestBody = await input.clone().text(); } catch {}
      }
    }

    const requestData = {
      captureId, url, method, requestHeaders, requestBody, startTime, type: 'fetch',
    };
    // 仅在存在拦截规则时阻塞；否则 fire-and-forget，避免拖慢页面
    const registration = mockDecisionRequired ?
      await requestBridge('NET_REQUEST', requestData) : (sendToBridge('NET_REQUEST', requestData), null);
    if (registration?.mocked && registration.mockResponse) {
      const delay = Math.max(0, Number(registration.mockResponse.delay) || 0);
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (registration.mockResponse.error) throw new TypeError(registration.mockResponse.error);
      return createMockResponse(url, registration.mockResponse);
    }

    let fetchUrl = url;
    let fetchInit = { ...init };
    let fetchInput = input;
    const intercept = registration?.intercept || null;

    if (intercept?.breakpointId) {
      const resume = await requestBridge('WAIT_BREAKPOINT', {
        breakpointId: intercept.breakpointId,
        captureId,
        snapshot: { url, method, requestHeaders, requestBody },
      });
      if (resume?.action === 'abort') throw new TypeError('Request aborted by breakpoint');
      if (resume?.options?.mock) {
        return createMockResponse(url, resume.options.mock);
      }
      if (resume?.options) {
        if (resume.options.url) fetchUrl = resume.options.url;
        if (resume.options.method) fetchInit.method = resume.options.method;
        if (resume.options.headers) fetchInit.headers = resume.options.headers;
        if (resume.options.body !== undefined && resume.options.body !== null) fetchInit.body = resume.options.body;
      }
    }

    if (intercept?.mapLocal) {
      const delay = Math.max(0, Number(intercept.mapLocal.delay) || 0);
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      return createMockResponse(url, intercept.mapLocal);
    }

    if (intercept?.throttle) {
      const delay = Math.max(0, Number(intercept.throttle.delayMs) || 0);
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      const rate = Number(intercept.throttle.errorRate) || 0;
      if (rate > 0 && Math.random() < rate) throw new TypeError(intercept.throttle.errorMessage || 'Throttled network error');
    }

    if (intercept?.rewrite) {
      if (intercept.rewrite.url) fetchUrl = intercept.rewrite.url;
      if (intercept.rewrite.method) fetchInit.method = intercept.rewrite.method;
      if (intercept.rewrite.headers) fetchInit.headers = intercept.rewrite.headers;
      if (intercept.rewrite.body !== undefined && intercept.rewrite.body !== null &&
          !['GET', 'HEAD'].includes(String(fetchInit.method || method).toUpperCase())) {
        fetchInit.body = intercept.rewrite.body;
      }
    }

    try {
      const fetchArgs = (fetchUrl !== url || fetchInit.method || fetchInit.headers || fetchInit.body)
        ? [fetchUrl, fetchInit]
        : args;
      let response = await originalFetch.apply(this, fetchArgs);
      if (intercept?.script?.script) {
        try {
          const text = await response.clone().text();
          const fn = new Function('body', 'request', `${intercept.script.script}\n;return body;`);
          const nextBody = String(fn(text, { url: fetchUrl, method, headers: requestHeaders }));
          if (nextBody !== text) {
            const headers = new Headers(response.headers);
            headers.delete('content-length');
            response = new Response(nextBody, { status: response.status, statusText: response.statusText, headers });
          }
        } catch {}
      }
      const endTime = now();
      const responseHeaders = {};
      response.headers.forEach((value, name) => { responseHeaders[name] = value; });

      sendToBridge('NET_RESPONSE', {
        captureId, url, status: response.status, statusText: response.statusText,
        responseHeaders, responseBody: null, endTime,
        size: Number.parseInt(response.headers.get('content-length'), 10) || null,
      });

      readResponseBody(response.clone()).then(result => {
        sendToBridge('NET_RESPONSE_BODY', { captureId, ...result });
      }).catch(() => {});

      return response;
    } catch (error) {
      sendToBridge('NET_ERROR', {
        captureId, url, error: error.message, endTime: now(),
      });
      throw error;
    }
  };

  // ============ EventSource / Beacon ============
  const OriginalEventSource = window.EventSource;
  if (typeof OriginalEventSource === 'function') {
    window.EventSource = function(url, configuration) {
      const captureId = createCaptureId('http');
      let normalizedUrl = String(url);
      try { normalizedUrl = new URL(normalizedUrl, window.location?.href).href; } catch {}
      sendToBridge('NET_REQUEST', {
        captureId, url: normalizedUrl, method: 'GET', requestHeaders: {}, requestBody: null,
        startTime: now(), type: 'eventsource',
      });
      const source = configuration === undefined ? new OriginalEventSource(url) :
        new OriginalEventSource(url, configuration);
      source.addEventListener('open', () => {
        sendToBridge('NET_RESPONSE', {
          captureId, url: normalizedUrl, status: 200, statusText: 'OPEN',
          responseHeaders: { 'content-type': 'text/event-stream' }, responseBody: null,
          endTime: now(), size: null,
        });
      });
      source.addEventListener('message', event => {
        sendToBridge('NET_STREAM_CHUNK', {
          captureId, url: normalizedUrl, data: event.data, body: event.data,
          eventType: event.type, lastEventId: event.lastEventId, timestamp: now(),
          bodyMimeType: 'text/event-stream',
        });
      });
      source.addEventListener('error', () => {
        if (source.readyState === OriginalEventSource.CLOSED) {
          sendToBridge('NET_ERROR', { captureId, url: normalizedUrl, error: 'EventSource closed', endTime: now() });
        }
      });
      return source;
    };
    window.EventSource.CONNECTING = OriginalEventSource.CONNECTING;
    window.EventSource.OPEN = OriginalEventSource.OPEN;
    window.EventSource.CLOSED = OriginalEventSource.CLOSED;
    window.EventSource.prototype = OriginalEventSource.prototype;
  }

  if (window.navigator?.sendBeacon) {
    const originalSendBeacon = window.navigator.sendBeacon.bind(window.navigator);
    window.navigator.sendBeacon = function(url, body) {
      let normalizedUrl = String(url);
      try { normalizedUrl = new URL(normalizedUrl, window.location?.href).href; } catch {}
      sendToBridge('NET_REQUEST', {
        captureId: createCaptureId('http'), url: normalizedUrl, method: 'POST',
        requestHeaders: {}, requestBody: serializeBeaconBody(body), startTime: now(), type: 'beacon',
      });
      return originalSendBeacon(url, body);
    };
  }

  // ============ XMLHttpRequest ============
  const XHR = XMLHttpRequest.prototype;
  const originalOpen = XHR.open;
  const originalSend = XHR.send;
  const originalAbort = XHR.abort;
  const originalSetRequestHeader = XHR.setRequestHeader;

  function cleanupXhrCapture(xhr, nc) {
    (nc.listenerRefs || []).forEach(({ type, listener }) => {
      xhr.removeEventListener(type, listener);
    });
    nc.listenerRefs = [];
  }

  function resetMockXhr(xhr, nc) {
    (nc.mockProperties || []).forEach(name => { delete xhr[name]; });
    (nc.mockMethods || []).forEach(name => { delete xhr[name]; });
    nc.mockProperties = [];
    nc.mockMethods = [];
  }

  XHR.open = function(method, url, ...rest) {
    const previous = this._netCatcher;
    if (previous) resetMockXhr(this, previous);
    this._netCatcher = {
      method: String(method).toUpperCase(),
      url: (() => { try { return new URL(String(url), window.location?.href).href; } catch { return String(url); } })(),
      requestHeaders: {},
      async: rest.length === 0 || rest[0] !== false,
      aborted: false,
      listenerRefs: [],
      mockTimer: null,
      mockProperties: [],
      mockMethods: [],
    };
    try {
      return originalOpen.apply(this, [method, url, ...rest]);
    } finally {
      if (previous) cleanupXhrCapture(this, previous);
    }
  };

  XHR.setRequestHeader = function(name, value) {
    if (this._netCatcher) this._netCatcher.requestHeaders[name] = value;
    return originalSetRequestHeader.apply(this, [name, value]);
  };

  XHR.abort = function() {
    if (this._netCatcher) {
      this._netCatcher.aborted = true;
      if (this._netCatcher.mockTimer) {
        clearTimeout(this._netCatcher.mockTimer);
        this._netCatcher.mockTimer = null;
      }
    }
    return originalAbort.apply(this);
  };

  function completeMockXhr(xhr, nc, mock) {
    nc.mocked = true;
    const status = Number(mock.status) || 200;
    const body = String(mock.body ?? '');
    const headers = normalizeHeaders(mock.headers);
    let readyState = 1;
    let response = body;

    if (xhr.responseType === 'json') {
      try { response = JSON.parse(body); } catch { response = null; }
    } else if (xhr.responseType === 'arraybuffer') {
      response = new TextEncoder().encode(body).buffer;
    } else if (xhr.responseType === 'blob') {
      response = new Blob([body], { type: headers['content-type'] || 'text/plain' });
    }

    const values = {
      readyState: () => readyState,
      status: () => status,
      statusText: () => 'Mocked',
      response: () => response,
      responseText: () => body,
      responseURL: () => nc.url,
      responseXML: () => null,
    };
    Object.entries(values).forEach(([name, get]) => {
      try {
        Object.defineProperty(xhr, name, { configurable: true, get });
        nc.mockProperties.push(name);
      } catch {}
    });

    xhr.getResponseHeader = name => headers[String(name).toLowerCase()] ?? null;
    xhr.getAllResponseHeaders = () => Object.entries(headers)
      .map(([name, value]) => `${name}: ${value}\r\n`).join('');
    nc.mockMethods.push('getResponseHeader', 'getAllResponseHeaders');

    const total = new TextEncoder().encode(body).byteLength;
    xhr.dispatchEvent(new ProgressEvent('loadstart', { lengthComputable: true, loaded: 0, total }));
    [2, 3, 4].forEach(state => {
      readyState = state;
      xhr.dispatchEvent(new Event('readystatechange'));
    });
    xhr.dispatchEvent(new ProgressEvent('progress', { lengthComputable: true, loaded: total, total }));
    xhr.dispatchEvent(new ProgressEvent('load', { lengthComputable: true, loaded: total, total }));
    xhr.dispatchEvent(new ProgressEvent('loadend', { lengthComputable: true, loaded: total, total }));
    cleanupXhrCapture(xhr, nc);
  }

  XHR.send = function(body) {
    if (!this._netCatcher) return originalSend.apply(this, [body]);

    const xhr = this;
    const nc = this._netCatcher;
    cleanupXhrCapture(this, nc);
    nc.listenerRefs = [];
    nc.captureId = createCaptureId('http');
    nc.startTime = now();
    nc.requestBody = null;
    if (body !== undefined && body !== null) {
      if (typeof body === 'string') nc.requestBody = body;
      else if (body instanceof FormData) nc.requestBody = '[FormData]';
      else if (body instanceof URLSearchParams) nc.requestBody = body.toString();
      else try { nc.requestBody = JSON.stringify(body); } catch {}
    }

    const loadListener = function() {
      if (nc.mocked) return;
      const responseHeaders = {};
      const headerString = this.getAllResponseHeaders();
      if (headerString) {
        headerString.split('\r\n').forEach(line => {
          const index = line.indexOf(':');
          if (index > 0) responseHeaders[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
        });
      }
      let responseBody = null;
      try { responseBody = typeof this.response === 'string' ? this.response : JSON.stringify(this.response); }
      catch { responseBody = String(this.response); }

      sendToBridge('NET_RESPONSE', {
        captureId: nc.captureId, url: nc.url, status: this.status, statusText: this.statusText,
        responseHeaders, responseBody, endTime: now(),
        size: responseBody ? responseBody.length : 0,
      });
      cleanupXhrCapture(xhr, nc);
    };

    const errorListener = function() {
      if (!nc.mocked) sendToBridge('NET_ERROR', {
        captureId: nc.captureId, url: nc.url, error: 'Network Error', endTime: now(),
      });
      cleanupXhrCapture(xhr, nc);
    };
    const abortListener = function() {
      if (!nc.mocked) sendToBridge('NET_ERROR', {
        captureId: nc.captureId, url: nc.url, error: 'Aborted', endTime: now(),
      });
      cleanupXhrCapture(xhr, nc);
    };
    [['load', loadListener], ['error', errorListener], ['abort', abortListener]].forEach(([type, listener]) => {
      this.addEventListener(type, listener);
      nc.listenerRefs.push({ type, listener });
    });

    const requestData = {
      captureId: nc.captureId, url: nc.url, method: nc.method,
      requestHeaders: nc.requestHeaders, requestBody: nc.requestBody,
      startTime: nc.startTime, type: 'xhr', allowMock: nc.async,
    };

    if (!nc.async || !capturingEnabled || shouldSkipCapture(nc.url)) {
      if (capturingEnabled && !shouldSkipCapture(nc.url)) sendToBridge('NET_REQUEST', requestData);
      return originalSend.apply(this, [body]);
    }

    if (!mockDecisionRequired) {
      sendToBridge('NET_REQUEST', requestData);
      return originalSend.apply(this, [body]);
    }

    requestBridge('NET_REQUEST', requestData).then(async registration => {
      if (nc.aborted) return;
      if (registration?.mocked && registration.mockResponse) {
        const delay = Math.max(0, Number(registration.mockResponse.delay) || 0);
        if (delay) {
          nc.mockTimer = setTimeout(() => {
            nc.mockTimer = null;
            if (!nc.aborted) {
              if (registration.mockResponse.error) {
                xhr.dispatchEvent(new Event('error'));
                cleanupXhrCapture(xhr, nc);
              } else completeMockXhr(xhr, nc, registration.mockResponse);
            }
          }, delay);
        }
        else if (registration.mockResponse.error) {
          xhr.dispatchEvent(new Event('error'));
          cleanupXhrCapture(xhr, nc);
        } else completeMockXhr(xhr, nc, registration.mockResponse);
        return;
      }

      const intercept = registration?.intercept || null;
      if (intercept?.breakpointId) {
        const resume = await requestBridge('WAIT_BREAKPOINT', {
          breakpointId: intercept.breakpointId,
          captureId: nc.captureId,
          snapshot: { url: nc.url, method: nc.method, requestHeaders: nc.requestHeaders, requestBody: nc.requestBody },
        });
        if (nc.aborted) return;
        if (resume?.action === 'abort') {
          xhr.dispatchEvent(new Event('error'));
          cleanupXhrCapture(xhr, nc);
          return;
        }
        if (resume?.options?.mock) {
          completeMockXhr(xhr, nc, resume.options.mock);
          return;
        }
        if (resume?.options?.body !== undefined && resume.options.body !== null) {
          body = resume.options.body;
        }
      }

      if (intercept?.mapLocal) {
        completeMockXhr(xhr, nc, intercept.mapLocal);
        return;
      }

      if (intercept?.throttle) {
        const delay = Math.max(0, Number(intercept.throttle.delayMs) || 0);
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        if (nc.aborted) return;
        const rate = Number(intercept.throttle.errorRate) || 0;
        if (rate > 0 && Math.random() < rate) {
          xhr.dispatchEvent(new Event('error'));
          cleanupXhrCapture(xhr, nc);
          return;
        }
      }

      originalSend.apply(xhr, [body]);
    }).catch(() => originalSend.apply(xhr, [body]));
  };

  // ============ WebSocket ============
  const OriginalWebSocket = window.WebSocket;

  window.WebSocket = function(url, protocols) {
    const startTime = now();
    const wsUrl = String(url);
    const wsId = createCaptureId('ws');
    const ws = protocols !== undefined ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);
    wsInstances.set(wsId, ws);

    sendToBridge('WS_OPEN', { id: wsId, url: wsUrl, startTime, protocols: protocols || null });
    ws.addEventListener('open', () => {
      sendToBridge('WS_READY', { id: wsId, timestamp: now() });
    });

    const originalWsSend = ws.send.bind(ws);
    ws.send = function(data) {
      captureWebSocketMessage(wsId, 'send', data);
      return originalWsSend(data);
    };

    ws.addEventListener('message', event => {
      captureWebSocketMessage(wsId, 'receive', event.data);
    });

    ws.addEventListener('close', event => {
      sendToBridge('WS_CLOSE', {
        id: wsId, code: event.code, reason: event.reason,
        wasClean: event.wasClean, timestamp: now(),
      });
      wsInstances.delete(wsId);
    });
    ws.addEventListener('error', () => {
      sendToBridge('WS_ERROR', { id: wsId, timestamp: now() });
    });

    return ws;
  };

  window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  window.WebSocket.OPEN = OriginalWebSocket.OPEN;
  window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
  window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;
  window.WebSocket.prototype = OriginalWebSocket.prototype;
})();
