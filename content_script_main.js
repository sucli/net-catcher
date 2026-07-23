// NetCatcher - Content Script (MAIN world)
// Intercepts fetch, XMLHttpRequest and WebSocket without changing page handlers.

(function() {
  'use strict';

  const MAX_CAPTURE_BODY_BYTES = 1024 * 1024;
  const BRIDGE_TIMEOUT_MS = 250;
  const pendingBridgeRequests = new Map();
  let fallbackId = 0;
  let mockDecisionRequired = true;

  function now() {
    return performance.timeOrigin + performance.now();
  }

  function createCaptureId(prefix) {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    fallbackId += 1;
    return `${prefix}-${Date.now()}-${fallbackId}-${Math.random().toString(16).slice(2)}`;
  }

  function sendToBridge(type, data) {
    window.postMessage({ __netCatcher: true, type, data }, '*');
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
      window.postMessage({ __netCatcher: true, messageId, type, data }, '*');
    });
  }

  window.addEventListener('message', event => {
    if (event.source !== window) return;
    if (event.data?.__netCatcherConfig) {
      mockDecisionRequired = !!event.data.hasActiveMockRules;
      return;
    }
    if (!event.data?.__netCatcherResponse) return;
    const resolve = pendingBridgeRequests.get(event.data.messageId);
    if (!resolve) return;
    pendingBridgeRequests.delete(event.data.messageId);
    resolve(event.data.response ?? null);
  });

  function normalizeHeaders(headers) {
    const result = {};
    if (!headers) return result;
    try {
      new Headers(headers).forEach((value, name) => { result[name] = value; });
    } catch {}
    return result;
  }

  async function readResponseBody(response) {
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
    const method = (init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const requestHeaders = normalizeHeaders(init.headers || (input instanceof Request ? input.headers : null));
    const captureId = createCaptureId('http');
    const startTime = now();

    let requestBody = null;
    if (init.body) {
      if (typeof init.body === 'string') requestBody = init.body;
      else if (init.body instanceof FormData) requestBody = '[FormData]';
      else if (init.body instanceof URLSearchParams) requestBody = init.body.toString();
      else try { requestBody = JSON.stringify(init.body); } catch {}
    }

    const requestData = {
      captureId, url, method, requestHeaders, requestBody, startTime, type: 'fetch',
    };
    const registration = mockDecisionRequired ?
      await requestBridge('NET_REQUEST', requestData) : (sendToBridge('NET_REQUEST', requestData), null);
    if (registration?.mocked && registration.mockResponse) {
      const delay = Math.max(0, Number(registration.mockResponse.delay) || 0);
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      return createMockResponse(url, registration.mockResponse);
    }

    try {
      const response = await originalFetch.apply(this, args);
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

  // ============ XMLHttpRequest ============
  const XHR = XMLHttpRequest.prototype;
  const originalOpen = XHR.open;
  const originalSend = XHR.send;
  const originalAbort = XHR.abort;
  const originalSetRequestHeader = XHR.setRequestHeader;

  XHR.open = function(method, url, ...rest) {
    this._netCatcher = {
      method: String(method).toUpperCase(),
      url: (() => { try { return new URL(String(url), window.location?.href).href; } catch { return String(url); } })(),
      requestHeaders: {},
      async: rest.length === 0 || rest[0] !== false,
      aborted: false,
    };
    return originalOpen.apply(this, [method, url, ...rest]);
  };

  XHR.setRequestHeader = function(name, value) {
    if (this._netCatcher) this._netCatcher.requestHeaders[name] = value;
    return originalSetRequestHeader.apply(this, [name, value]);
  };

  XHR.abort = function() {
    if (this._netCatcher) this._netCatcher.aborted = true;
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
      try { Object.defineProperty(xhr, name, { configurable: true, get }); } catch {}
    });

    xhr.getResponseHeader = name => headers[String(name).toLowerCase()] ?? null;
    xhr.getAllResponseHeaders = () => Object.entries(headers)
      .map(([name, value]) => `${name}: ${value}\r\n`).join('');

    const total = new TextEncoder().encode(body).byteLength;
    xhr.dispatchEvent(new ProgressEvent('loadstart', { lengthComputable: true, loaded: 0, total }));
    [2, 3, 4].forEach(state => {
      readyState = state;
      xhr.dispatchEvent(new Event('readystatechange'));
    });
    xhr.dispatchEvent(new ProgressEvent('progress', { lengthComputable: true, loaded: total, total }));
    xhr.dispatchEvent(new ProgressEvent('load', { lengthComputable: true, loaded: total, total }));
    xhr.dispatchEvent(new ProgressEvent('loadend', { lengthComputable: true, loaded: total, total }));
  }

  XHR.send = function(body) {
    if (!this._netCatcher) return originalSend.apply(this, [body]);

    const xhr = this;
    const nc = this._netCatcher;
    nc.captureId = createCaptureId('http');
    nc.startTime = now();
    nc.requestBody = null;
    if (body) {
      if (typeof body === 'string') nc.requestBody = body;
      else if (body instanceof FormData) nc.requestBody = '[FormData]';
      else if (body instanceof URLSearchParams) nc.requestBody = body.toString();
      else try { nc.requestBody = JSON.stringify(body); } catch {}
    }

    this.addEventListener('load', function() {
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
    });

    this.addEventListener('error', function() {
      if (!nc.mocked) sendToBridge('NET_ERROR', {
        captureId: nc.captureId, url: nc.url, error: 'Network Error', endTime: now(),
      });
    });
    this.addEventListener('abort', function() {
      if (!nc.mocked) sendToBridge('NET_ERROR', {
        captureId: nc.captureId, url: nc.url, error: 'Aborted', endTime: now(),
      });
    });

    const requestData = {
      captureId: nc.captureId, url: nc.url, method: nc.method,
      requestHeaders: nc.requestHeaders, requestBody: nc.requestBody,
      startTime: nc.startTime, type: 'xhr', allowMock: nc.async,
    };

    if (!nc.async) {
      sendToBridge('NET_REQUEST', requestData);
      return originalSend.apply(this, [body]);
    }

    if (!mockDecisionRequired) {
      sendToBridge('NET_REQUEST', requestData);
      return originalSend.apply(this, [body]);
    }

    requestBridge('NET_REQUEST', requestData).then(registration => {
      if (nc.aborted) return;
      if (registration?.mocked && registration.mockResponse) {
        const delay = Math.max(0, Number(registration.mockResponse.delay) || 0);
        if (delay) setTimeout(() => completeMockXhr(xhr, nc, registration.mockResponse), delay);
        else completeMockXhr(xhr, nc, registration.mockResponse);
      } else {
        originalSend.apply(xhr, [body]);
      }
    }).catch(() => originalSend.apply(xhr, [body]));
  };

  // ============ WebSocket ============
  const OriginalWebSocket = window.WebSocket;

  window.WebSocket = function(url, protocols) {
    const startTime = now();
    const wsUrl = String(url);
    const wsId = createCaptureId('ws');
    const ws = protocols !== undefined ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);

    sendToBridge('WS_OPEN', { id: wsId, url: wsUrl, startTime, protocols: protocols || null });
    ws.addEventListener('open', () => {
      sendToBridge('WS_READY', { id: wsId, timestamp: now() });
    });

    const originalWsSend = ws.send.bind(ws);
    ws.send = function(data) {
      let messageData;
      let messageType = 'text';
      if (typeof data === 'string') messageData = data;
      else if (data instanceof ArrayBuffer) {
        messageData = `[ArrayBuffer ${data.byteLength} bytes]`;
        messageType = 'binary';
      } else if (data instanceof Blob) {
        messageData = `[Blob ${data.size} bytes]`;
        messageType = 'binary';
      } else if (ArrayBuffer.isView(data)) {
        messageData = `[ArrayBufferView ${data.byteLength} bytes]`;
        messageType = 'binary';
      } else {
        try { messageData = String(data); } catch { messageData = '[Unknown data]'; }
      }
      sendToBridge('WS_MESSAGE', {
        id: wsId, direction: 'send', messageType, data: messageData, timestamp: now(),
      });
      return originalWsSend(data);
    };

    ws.addEventListener('message', event => {
      let data;
      let messageType = 'text';
      if (typeof event.data === 'string') data = event.data;
      else if (event.data instanceof ArrayBuffer) {
        data = `[ArrayBuffer ${event.data.byteLength} bytes]`;
        messageType = 'binary';
      } else if (event.data instanceof Blob) {
        data = `[Blob ${event.data.size} bytes]`;
        messageType = 'binary';
      } else {
        data = '[binary data]';
        messageType = 'binary';
      }
      sendToBridge('WS_MESSAGE', {
        id: wsId, direction: 'receive', messageType, data, timestamp: now(),
      });
    });

    ws.addEventListener('close', event => {
      sendToBridge('WS_CLOSE', {
        id: wsId, code: event.code, reason: event.reason,
        wasClean: event.wasClean, timestamp: now(),
      });
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
