// NetCatcher - Content Script (MAIN world)
// 拦截 fetch、XMLHttpRequest 和 WebSocket

(function() {
  'use strict';

  let requestCounter = 0;

  function sendToBridge(type, data) {
    window.postMessage({ __netCatcher: true, type, data }, '*');
  }

  // ============ 拦截 fetch ============
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const startTime = performance.now();
    const input = args[0];
    const init = args[1] || {};

    const url = typeof input === 'string' ? input :
                input instanceof Request ? input.url : String(input);
    const method = (init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();

    const requestHeaders = {};
    if (init.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => { requestHeaders[k] = v; });
      } else if (typeof init.headers === 'object') {
        Object.assign(requestHeaders, init.headers);
      }
    }

    let requestBody = null;
    if (init.body) {
      if (typeof init.body === 'string') requestBody = init.body;
      else if (init.body instanceof FormData) requestBody = '[FormData]';
      else if (init.body instanceof URLSearchParams) requestBody = init.body.toString();
      else try { requestBody = JSON.stringify(init.body); } catch {}
    }

    sendToBridge('NET_REQUEST', { url, method, requestHeaders, requestBody, startTime, type: 'fetch' });

    try {
      const response = await originalFetch.apply(this, args);
      const endTime = performance.now();
      const clone = response.clone();
      let responseBody = null;
      let size = 0;
      try {
        const text = await clone.text();
        responseBody = text;
        size = text.length;
      } catch {}
      const responseHeaders = {};
      response.headers.forEach((v, k) => { responseHeaders[k] = v; });

      sendToBridge('NET_RESPONSE', { url, status: response.status, statusText: response.statusText, responseHeaders, responseBody, endTime, size, startTime });
      return response;
    } catch (err) {
      sendToBridge('NET_ERROR', { url, error: err.message, endTime: performance.now(), startTime });
      throw err;
    }
  };

  // ============ 拦截 XMLHttpRequest ============
  const XHR = XMLHttpRequest.prototype;
  const originalOpen = XHR.open;
  const originalSend = XHR.send;
  const originalSetRequestHeader = XHR.setRequestHeader;

  XHR.open = function(method, url, ...rest) {
    this._netCatcher = { method: method.toUpperCase(), url, requestHeaders: {}, startTime: performance.now() };
    return originalOpen.apply(this, [method, url, ...rest]);
  };

  XHR.setRequestHeader = function(name, value) {
    if (this._netCatcher) this._netCatcher.requestHeaders[name] = value;
    return originalSetRequestHeader.apply(this, [name, value]);
  };

  XHR.send = function(body) {
    if (!this._netCatcher) return originalSend.apply(this, [body]);

    const nc = this._netCatcher;
    nc.requestBody = null;
    if (body) {
      if (typeof body === 'string') nc.requestBody = body;
      else if (body instanceof FormData) nc.requestBody = '[FormData]';
      else if (body instanceof URLSearchParams) nc.requestBody = body.toString();
      else try { nc.requestBody = JSON.stringify(body); } catch {}
    }

    sendToBridge('NET_REQUEST', {
      url: nc.url, method: nc.method, requestHeaders: nc.requestHeaders,
      requestBody: nc.requestBody, startTime: nc.startTime, type: 'xhr',
    });

    this.addEventListener('load', function() {
      const endTime = performance.now();
      const responseHeaders = {};
      const headerStr = this.getAllResponseHeaders();
      if (headerStr) {
        headerStr.split('\r\n').forEach(line => {
          const idx = line.indexOf(':');
          if (idx > 0) responseHeaders[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
        });
      }
      let responseBody = null;
      try { responseBody = typeof this.response === 'string' ? this.response : JSON.stringify(this.response); }
      catch { responseBody = String(this.response); }

      sendToBridge('NET_RESPONSE', {
        url: nc.url, status: this.status, statusText: this.statusText,
        responseHeaders, responseBody, endTime, size: responseBody ? responseBody.length : 0, startTime: nc.startTime,
      });
    });

    this.addEventListener('error', function() {
      sendToBridge('NET_ERROR', { url: nc.url, error: 'Network Error', endTime: performance.now(), startTime: nc.startTime });
    });

    this.addEventListener('abort', function() {
      sendToBridge('NET_ERROR', { url: nc.url, error: 'Aborted', endTime: performance.now(), startTime: nc.startTime });
    });

    return originalSend.apply(this, [body]);
  };

  // ============ 拦截 WebSocket ============
  const OriginalWebSocket = window.WebSocket;

  window.WebSocket = function(url, protocols) {
    const startTime = performance.now();
    const wsUrl = typeof url === 'string' ? url : url.toString();
    const wsId = ++requestCounter;

    sendToBridge('WS_OPEN', { id: wsId, url: wsUrl, startTime, protocols: protocols || null });

    const ws = protocols ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);

    // 拦截 send
    const originalSend = ws.send.bind(ws);
    ws.send = function(data) {
      let messageData = null;
      let messageType = 'text';

      if (typeof data === 'string') {
        messageData = data;
      } else if (data instanceof ArrayBuffer) {
        messageData = '[ArrayBuffer ' + data.byteLength + ' bytes]';
        messageType = 'binary';
      } else if (data instanceof Blob) {
        messageData = '[Blob ' + data.size + ' bytes]';
        messageType = 'binary';
      } else if (data instanceof ArrayBufferView) {
        messageData = '[ArrayBufferView ' + data.byteLength + ' bytes]';
        messageType = 'binary';
      } else {
        try { messageData = String(data); } catch { messageData = '[Unknown data]'; }
      }

      sendToBridge('WS_MESSAGE', { id: wsId, url: wsUrl, direction: 'send', messageType, data: messageData, timestamp: performance.now() });
      return originalSend(data);
    };

    // 拦截 onmessage - 只在用户设置时监听
    let userOnMessage = null;
    let onMessageListenerAdded = false;

    Object.defineProperty(ws, 'onmessage', {
      get: () => userOnMessage,
      set: (handler) => {
        userOnMessage = handler;
        if (handler && !onMessageListenerAdded) {
          onMessageListenerAdded = true;
          ws.addEventListener('message', function(event) {
            if (userOnMessage) {
              sendToBridge('WS_MESSAGE', {
                id: wsId, url: wsUrl, direction: 'receive',
                messageType: typeof event.data === 'string' ? 'text' : 'binary',
                data: typeof event.data === 'string' ? event.data : '[binary data]',
                timestamp: performance.now(),
              });
            }
          });
        }
      },
    });

    // 用 addEventListener 监听（捕获所有消息，包括用 addEventListener 注册的）
    // 这是主要的消息捕获方式
    ws.addEventListener('message', function(event) {
      // 避免与 onmessage handler 重复
      // 只有当用户没有设置 onmessage 时，才在这里发送
      if (userOnMessage) return; // onmessage handler 会处理

      let messageData = null;
      let messageType = 'text';

      if (typeof event.data === 'string') {
        messageData = event.data;
      } else if (event.data instanceof ArrayBuffer) {
        messageData = '[ArrayBuffer ' + event.data.byteLength + ' bytes]';
        messageType = 'binary';
      } else if (event.data instanceof Blob) {
        messageData = '[Blob ' + event.data.size + ' bytes]';
        messageType = 'binary';
      } else {
        try { messageData = String(event.data); } catch { messageData = '[Unknown data]'; }
      }

      sendToBridge('WS_MESSAGE', { id: wsId, url: wsUrl, direction: 'receive', messageType, data: messageData, timestamp: performance.now() });
    });

    // 拦截 onclose
    let userOnClose = null;
    Object.defineProperty(ws, 'onclose', {
      get: () => userOnClose,
      set: (handler) => {
        userOnClose = handler;
        if (handler) {
          ws.addEventListener('close', function(event) {
            sendToBridge('WS_CLOSE', { id: wsId, url: wsUrl, code: event.code, reason: event.reason, wasClean: event.wasClean, timestamp: performance.now(), startTime });
          });
        }
      },
    });

    // 拦截 onerror
    let userOnError = null;
    Object.defineProperty(ws, 'onerror', {
      get: () => userOnError,
      set: (handler) => {
        userOnError = handler;
        if (handler) {
          ws.addEventListener('error', function() {
            sendToBridge('WS_ERROR', { id: wsId, url: wsUrl, timestamp: performance.now(), startTime });
          });
        }
      },
    });

    // 用 addEventListener 监听 close 和 error（总是添加，不会重复因为事件只触发一次）
    ws.addEventListener('close', function(event) {
      sendToBridge('WS_CLOSE', { id: wsId, url: wsUrl, code: event.code, reason: event.reason, wasClean: event.wasClean, timestamp: performance.now(), startTime });
    });

    ws.addEventListener('error', function() {
      sendToBridge('WS_ERROR', { id: wsId, url: wsUrl, timestamp: performance.now(), startTime });
    });

    return ws;
  };

  // 复制静态属性
  window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  window.WebSocket.OPEN = OriginalWebSocket.OPEN;
  window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
  window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;
  window.WebSocket.prototype = OriginalWebSocket.prototype;

  console.log('[NetCatcher] MAIN world interceptor loaded');
})();
