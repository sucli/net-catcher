// NetCatcher - Content Script (MAIN world)
// 在页面上下文中拦截 fetch 和 XMLHttpRequest，通过 postMessage 发送给 ISOLATED world

(function() {
  'use strict';

  let requestCounter = 0;

  function sendToBridge(type, data) {
    const msg = { __netCatcher: true, type, data, _reqNum: ++requestCounter };
    console.log('[NetCatcher MAIN]', type, data.url);
    window.postMessage(msg, '*');
  }

  // 拦截 fetch
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const startTime = performance.now();
    const input = args[0];
    const init = args[1] || {};

    const url = typeof input === 'string' ? input :
                input instanceof Request ? input.url :
                String(input);
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
      const endTime = performance.now();
      sendToBridge('NET_ERROR', { url, error: err.message, endTime, startTime });
      throw err;
    }
  };

  // 拦截 XMLHttpRequest
  const XHR = XMLHttpRequest.prototype;
  const originalOpen = XHR.open;
  const originalSend = XHR.send;
  const originalSetRequestHeader = XHR.setRequestHeader;

  XHR.open = function(method, url, ...rest) {
    this._netCatcher = {
      method: method.toUpperCase(),
      url: url,
      requestHeaders: {},
      startTime: performance.now(),
    };
    return originalOpen.apply(this, [method, url, ...rest]);
  };

  XHR.setRequestHeader = function(name, value) {
    if (this._netCatcher) {
      this._netCatcher.requestHeaders[name] = value;
    }
    return originalSetRequestHeader.apply(this, [name, value]);
  };

  XHR.send = function(body) {
    if (!this._netCatcher) {
      return originalSend.apply(this, [body]);
    }

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
          if (idx > 0) {
            responseHeaders[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
          }
        });
      }
      let responseBody = null;
      try {
        responseBody = typeof this.response === 'string' ? this.response : JSON.stringify(this.response);
      } catch { responseBody = String(this.response); }

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

  console.log('[NetCatcher] MAIN world interceptor loaded');
})();
