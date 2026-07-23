// NetCatcher - Background Service Worker
// 核心功能：请求捕获、存储、重放、Mock、过滤器管理

const MAX_REQUESTS = 500;
const MAX_WS_CONNECTIONS = 100;
const MAX_WS_MESSAGES = 200;
const MAX_WS_MESSAGE_CHARS = 4096;
const MAX_PERSISTED_WS_MESSAGES = 20;
const MAX_PERSISTED_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_SETTINGS = {
  redactSensitive: true,
  sensitiveHeaders: ['authorization', 'cookie', 'set-cookie', 'x-api-key'],
  excludedHosts: [],
};
const CAPTURE_TYPES = new Set([
  'NET_REQUEST', 'NET_RESPONSE', 'NET_RESPONSE_BODY', 'NET_ERROR',
  'WS_OPEN', 'WS_READY', 'WS_MESSAGE', 'WS_CLOSE', 'WS_ERROR',
]);
let requests = [];
let wsConnections = new Map();
let isCapturing = true;
let requestId = 0;
let mockRules = [];
let savedFilters = [];
let settings = { ...DEFAULT_SETTINGS };

// Wait for persisted state before handling events after a service-worker wake-up.
const initialization = chrome.storage.local.get([
  'nc_requests', 'nc_wsConnections', 'nc_requestId', 'nc_isCapturing',
  'nc_mockRules', 'nc_savedFilters', 'nc_settings'
]).then(data => {
  if (data.nc_requests) requests = data.nc_requests;
  if (data.nc_requestId) requestId = data.nc_requestId;
  if (data.nc_isCapturing !== undefined) isCapturing = data.nc_isCapturing;
  if (data.nc_mockRules) mockRules = data.nc_mockRules;
  if (data.nc_savedFilters) savedFilters = data.nc_savedFilters;
  if (data.nc_settings) settings = { ...DEFAULT_SETTINGS, ...data.nc_settings };
  if (data.nc_wsConnections) {
    try {
      const arr = JSON.parse(data.nc_wsConnections);
      arr.forEach(conn => wsConnections.set(conn.id, conn));
    } catch {}
  }
}).catch(() => {});

// 持久化存储
function persist() {
  // 内存优化：限制 WebSocket 消息数量
  const wsArr = Array.from(wsConnections.values()).slice(-20);
  wsArr.forEach(conn => {
    if (conn.messages.length > MAX_WS_MESSAGES) {
      conn.messages = conn.messages.slice(-MAX_WS_MESSAGES);
    }
  });
  const persistedWsArr = wsArr.map(conn => ({
    ...conn,
    messages: conn.messages.slice(-MAX_PERSISTED_WS_MESSAGES),
  }));

  let persistedBodyBytes = 0;
  const persistedRequests = requests.slice(-200).reverse().map(request => {
    const copy = { ...request };
    for (const field of ['requestBody', 'responseBody']) {
      if (typeof copy[field] !== 'string') continue;
      const bytes = copy[field].length * 2;
      if (persistedBodyBytes + bytes > MAX_PERSISTED_BODY_BYTES) {
        copy[field] = null;
        copy.persistedBodyTruncated = true;
      } else {
        persistedBodyBytes += bytes;
      }
    }
    return copy;
  }).reverse();

  chrome.storage.local.set({
    nc_requests: persistedRequests,
    nc_wsConnections: JSON.stringify(persistedWsArr),
    nc_requestId: requestId,
    nc_isCapturing: isCapturing,
    nc_mockRules: mockRules,
    nc_savedFilters: savedFilters,
    nc_settings: settings,
  });
}

function isExcluded(url) {
  try {
    const host = new URL(url).hostname;
    return settings.excludedHosts.some(pattern => {
      const value = String(pattern).trim().toLowerCase();
      return value && (host === value || host.endsWith(`.${value}`));
    });
  } catch {
    return false;
  }
}

function redactHeaders(headers) {
  if (!settings.redactSensitive || !headers || typeof headers !== 'object') return headers || {};
  const sensitive = new Set((Array.isArray(settings.sensitiveHeaders) ? settings.sensitiveHeaders : DEFAULT_SETTINGS.sensitiveHeaders)
    .map(name => String(name).toLowerCase()));
  return Object.fromEntries(Object.entries(headers).map(([name, value]) =>
    [name, sensitive.has(name.toLowerCase()) ? '[REDACTED]' : value]
  ));
}

function redactBody(body) {
  if (!settings.redactSensitive || typeof body !== 'string') return body;
  return body.replace(/("?(?:token|access_token|refresh_token|password|secret|api[_-]?key)"?\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"');
}

function sanitizeData(data) {
  return {
    ...data,
    requestHeaders: redactHeaders(data.requestHeaders),
    responseHeaders: redactHeaders(data.responseHeaders),
    requestBody: redactBody(data.requestBody),
    responseBody: redactBody(data.responseBody),
    body: redactBody(data.body),
  };
}

function isContentScriptSender(sender) {
  return sender.id === chrome.runtime.id && Number.isInteger(sender.tab?.id);
}

function isExtensionPageSender(sender) {
  return sender.id === chrome.runtime.id &&
    !sender.tab &&
    typeof sender.url === 'string' &&
    sender.url.startsWith(chrome.runtime.getURL(''));
}

function findCapturedRequest(data, sender) {
  return requests.find(request =>
    request.captureId === data.captureId &&
    request.tabId === sender.tab.id &&
    request.frameId === sender.frameId
  );
}

// 匹配 Mock 规则
function matchMockRule(url, method = '') {
  return mockRules.find(rule => {
    if (!rule.enabled) return false;
    if (rule.method && rule.method !== '*' && String(rule.method).toUpperCase() !== String(method).toUpperCase()) return false;
    if (rule.isRegex) {
      try {
        return new RegExp(rule.pattern).test(url);
      } catch {
        return false;
      }
    }
    return url.includes(rule.pattern);
  });
}

// 生成 Mock 响应
function getMockResponse(url, method) {
  const rule = matchMockRule(url, method);
  if (!rule) return null;
  const parsedStatus = Number.parseInt(rule.status, 10);
  return {
    status: Number.isInteger(parsedStatus) && parsedStatus >= 200 && parsedStatus <= 599 ? parsedStatus : 200,
    headers: rule.headers,
    body: rule.body,
    delay: Math.max(0, Number.parseInt(rule.delay, 10) || 0),
  };
}

function handleMessage(msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== 'string') {
    sendResponse({ error: '无效消息' });
    return;
  }

  if (CAPTURE_TYPES.has(msg.type)) {
    if (!isContentScriptSender(sender) || !msg.data || typeof msg.data !== 'object') {
      sendResponse({ error: '禁止的捕获消息' });
      return;
    }
  } else if (msg.type === 'GET_CAPTURE_CONFIG' && isContentScriptSender(sender)) {
    // The isolated bridge uses this to keep normal page requests off the mock decision path.
  } else if (!isExtensionPageSender(sender)) {
    sendResponse({ error: '禁止的扩展命令' });
    return;
  }

  if (CAPTURE_TYPES.has(msg.type) && isExcluded(msg.data.url || '')) {
    sendResponse(null);
    return;
  }

  if (msg.type === 'GET_CAPTURE_CONFIG') {
    sendResponse({ hasActiveMockRules: mockRules.some(rule => rule.enabled) });
    return true;
  }

  // ============ HTTP 请求相关 ============

  if (msg.type === 'NET_REQUEST') {
    if (!isCapturing) { sendResponse(null); return; }
    if (typeof msg.data.captureId !== 'string' || typeof msg.data.url !== 'string') {
      sendResponse(null);
      return;
    }

    // 检查是否有匹配的 Mock 规则
    const data = sanitizeData(msg.data);
    const mockResponse = data.allowMock === false ? null : getMockResponse(data.url, data.method);
    const rawMethod = String(data.method || 'GET').toUpperCase();
    const method = /^[!#$%&'*+.^_`|~0-9A-Z-]{1,32}$/.test(rawMethod) ? rawMethod : 'UNKNOWN';

    const entry = {
      id: ++requestId,
      captureId: data.captureId,
      url: data.url,
      method,
      status: null,
      statusText: '',
      requestHeaders: data.requestHeaders || {},
      requestBody: data.requestBody || null,
      responseHeaders: {},
      responseBody: null,
      startTime: data.startTime,
      endTime: null,
      duration: null,
      size: null,
      type: data.type === 'fetch' ? 'fetch' : 'xhr',
      tabId: sender.tab.id,
      frameId: sender.frameId,
      starred: false,
      tags: [],
      isMocked: !!mockResponse,
    };
    requests.push(entry);
    if (requests.length > MAX_REQUESTS) {
      requests = requests.slice(-MAX_REQUESTS);
    }

    // 如果有 Mock 规则，立即返回 mock 响应
    if (mockResponse) {
      entry.status = mockResponse.status;
      entry.statusText = 'Mocked';
      entry.responseHeaders = mockResponse.headers || {};
      entry.responseBody = mockResponse.body;
      entry.endTime = Date.now();
      entry.duration = Math.max(0, entry.endTime - entry.startTime);
      entry.size = mockResponse.body ? mockResponse.body.length : 0;
    }

    persist();
    broadcastUpdate();
    sendResponse({ id: entry.id, mocked: !!mockResponse, mockResponse });
    return true;
  }

  if (msg.type === 'NET_RESPONSE') {
    const data = sanitizeData(msg.data);
    const entry = findCapturedRequest(data, sender);
    if (entry) {
      entry.status = Number.isFinite(data.status) ? data.status : 0;
      entry.statusText = String(data.statusText || '');
      entry.responseHeaders = data.responseHeaders || {};
      entry.responseBody = data.responseBody;
      entry.endTime = data.endTime;
      entry.duration = data.endTime - entry.startTime;
      entry.size = data.size ?? (data.responseBody ? data.responseBody.length : null);
      persist();
      broadcastUpdate();
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'NET_RESPONSE_BODY') {
    const data = sanitizeData(msg.data);
    const entry = findCapturedRequest(data, sender);
    if (entry && !entry.isMocked) {
      entry.responseBody = data.body ?? null;
      if (Number.isFinite(data.size) && (!data.truncated || !entry.size)) {
        entry.size = data.size;
      }
      entry.bodyTruncated = !!data.truncated;
      persist();
      broadcastUpdate();
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'NET_ERROR') {
    const data = sanitizeData(msg.data);
    const entry = findCapturedRequest(data, sender);
    if (entry) {
      entry.status = 0;
      entry.statusText = data.error || 'Network Error';
      entry.endTime = data.endTime;
      entry.duration = data.endTime - entry.startTime;
      persist();
      broadcastUpdate();
    }
    sendResponse({ ok: true });
    return true;
  }

  // ============ WebSocket 相关 ============

  if (msg.type === 'WS_OPEN') {
    if (!isCapturing) { sendResponse(null); return; }
    if (typeof msg.data.id !== 'string' || typeof msg.data.url !== 'string') {
      sendResponse(null);
      return;
    }
    const conn = {
      id: msg.data.id,
      url: msg.data.url,
      protocols: msg.data.protocols,
      startTime: msg.data.startTime,
      tabId: sender.tab ? sender.tab.id : null,
      frameId: sender.frameId,
      status: 'connecting',
      closeCode: null,
      closeReason: '',
      endTime: null,
      messages: [],
      messageCount: { send: 0, receive: 0 },
    };
    wsConnections.set(msg.data.id, conn);
    if (wsConnections.size > MAX_WS_CONNECTIONS) {
      const oldestKey = wsConnections.keys().next().value;
      wsConnections.delete(oldestKey);
    }
    persist();
    broadcastUpdate();
    sendResponse({ id: msg.data.id });
    return true;
  }

  if (msg.type === 'WS_MESSAGE') {
    const conn = wsConnections.get(msg.data.id);
    if (conn && conn.tabId === sender.tab.id && conn.frameId === sender.frameId) {
      const rawData = String(msg.data.data ?? '');
      conn.messages.push({
        direction: msg.data.direction,
        type: msg.data.messageType === 'binary' ? 'binary' : 'text',
        data: rawData.slice(0, MAX_WS_MESSAGE_CHARS),
        truncated: rawData.length > MAX_WS_MESSAGE_CHARS,
        timestamp: msg.data.timestamp,
      });
      if (msg.data.direction === 'send' || msg.data.direction === 'receive') {
        conn.messageCount[msg.data.direction]++;
      }
      persist();
      broadcastUpdate();
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'WS_READY') {
    const conn = wsConnections.get(msg.data.id);
    if (conn && conn.tabId === sender.tab.id && conn.frameId === sender.frameId) {
      conn.status = 'open';
      conn.openTime = msg.data.timestamp;
      persist();
      broadcastUpdate();
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'WS_CLOSE') {
    const conn = wsConnections.get(msg.data.id);
    if (conn && conn.tabId === sender.tab.id && conn.frameId === sender.frameId) {
      conn.status = 'closed';
      conn.closeCode = msg.data.code;
      conn.closeReason = msg.data.reason;
      conn.wasClean = msg.data.wasClean;
      conn.endTime = msg.data.timestamp;
      conn.duration = msg.data.timestamp - conn.startTime;
      persist();
      broadcastUpdate();
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'WS_ERROR') {
    const conn = wsConnections.get(msg.data.id);
    if (conn && conn.tabId === sender.tab.id && conn.frameId === sender.frameId) {
      conn.status = 'error';
      conn.endTime = msg.data.timestamp;
      conn.duration = msg.data.timestamp - conn.startTime;
      persist();
      broadcastUpdate();
    }
    sendResponse({ ok: true });
    return true;
  }

  // ============ 请求重放 ============

  if (msg.type === 'REPLAY_REQUEST') {
    const req = requests.find(r => r.id === msg.data.id);
    if (!req) {
      sendResponse({ error: '请求不存在' });
      return true;
    }

    // 在 Service Worker 中执行 fetch
    const replay = msg.data.options || {};
    const fetchOptions = {
      method: String(replay.method || req.method).toUpperCase(),
      headers: replay.headers || req.requestHeaders,
    };
    const body = replay.body !== undefined ? replay.body : req.requestBody;
    if (body && !['GET', 'HEAD'].includes(fetchOptions.method)) {
      fetchOptions.body = body;
    }

    fetch(req.url, fetchOptions)
      .then(async response => {
        const body = await response.text();
        sendResponse({
          ok: true,
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          body: body,
        });
      })
      .catch(err => {
        sendResponse({ error: err.message });
      });
    return true; // 异步响应
  }

  // ============ Mock 规则管理 ============

  if (msg.type === 'GET_MOCK_RULES') {
    sendResponse({ rules: mockRules });
    return true;
  }

  if (msg.type === 'ADD_MOCK_RULE') {
    mockRules.push({
      id: Date.now(),
      name: msg.data.name || '',
      pattern: msg.data.pattern,
      isRegex: msg.data.isRegex || false,
      method: msg.data.method || '*',
      delay: Math.max(0, Number.parseInt(msg.data.delay, 10) || 0),
      enabled: true,
      status: msg.data.status || 200,
      headers: msg.data.headers || { 'content-type': 'application/json' },
      body: msg.data.body || '{}',
    });
    persist();
    broadcastUpdate();
    broadcastCaptureConfig();
    sendResponse({ ok: true, rules: mockRules });
    return true;
  }

  if (msg.type === 'UPDATE_MOCK_RULE') {
    const rule = mockRules.find(r => r.id === msg.data.id);
    if (rule) {
      Object.assign(rule, msg.data);
      persist();
      broadcastCaptureConfig();
    }
    sendResponse({ ok: true, rules: mockRules });
    return true;
  }

  if (msg.type === 'DELETE_MOCK_RULE') {
    mockRules = mockRules.filter(r => r.id !== msg.data.id);
    persist();
    broadcastCaptureConfig();
    sendResponse({ ok: true, rules: mockRules });
    return true;
  }

  if (msg.type === 'TOGGLE_MOCK_RULE') {
    const rule = mockRules.find(r => r.id === msg.data.id);
    if (rule) {
      rule.enabled = !rule.enabled;
      persist();
      broadcastCaptureConfig();
    }
    sendResponse({ ok: true, rules: mockRules });
    return true;
  }

  // ============ 过滤器管理 ============

  if (msg.type === 'GET_FILTERS') {
    sendResponse({ filters: savedFilters });
    return true;
  }

  if (msg.type === 'SAVE_FILTER') {
    savedFilters.push({
      id: Date.now(),
      name: msg.data.name,
      config: msg.data.config,
    });
    persist();
    sendResponse({ ok: true, filters: savedFilters });
    return true;
  }

  if (msg.type === 'DELETE_FILTER') {
    savedFilters = savedFilters.filter(f => f.id !== msg.data.id);
    persist();
    sendResponse({ ok: true, filters: savedFilters });
    return true;
  }

  // ============ 通用操作 ============

  if (msg.type === 'GET_REQUESTS') {
    const tabId = Number.isInteger(msg.data?.tabId) ? msg.data.tabId : null;
    const visibleRequests = tabId === null ? requests : requests.filter(request => request.tabId === tabId);
    const visibleWs = tabId === null ? Array.from(wsConnections.values()) :
      Array.from(wsConnections.values()).filter(connection => connection.tabId === tabId);
    sendResponse({
      requests: visibleRequests,
      wsConnections: visibleWs,
      isCapturing,
      mockRules,
    });
    return true;
  }

  if (msg.type === 'GET_WS_DETAIL') {
    const conn = wsConnections.get(msg.data.id);
    sendResponse({ connection: conn || null });
    return true;
  }

  if (msg.type === 'TOGGLE_CAPTURE') {
    isCapturing = !isCapturing;
    persist();
    sendResponse({ isCapturing });
    return true;
  }

  if (msg.type === 'CLEAR_REQUESTS') {
    const tabId = Number.isInteger(msg.data?.tabId) ? msg.data.tabId : null;
    if (tabId === null) {
      requests = [];
      wsConnections.clear();
      requestId = 0;
    } else {
      requests = requests.filter(request => request.tabId !== tabId);
      for (const [id, connection] of wsConnections) {
        if (connection.tabId === tabId) wsConnections.delete(id);
      }
    }
    persist();
    broadcastUpdate();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'EXPORT_HAR') {
    const tabId = Number.isInteger(msg.data?.tabId) ? msg.data.tabId : null;
    const exportRequests = tabId === null ? requests : requests.filter(request => request.tabId === tabId);
    const har = generateHAR(exportRequests);
    sendResponse({ har });
    return true;
  }

  if (msg.type === 'TOGGLE_STAR') {
    const req = requests.find(r => r.id === msg.data.id);
    if (req) {
      req.starred = !req.starred;
      persist();
      broadcastUpdate();
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'UPDATE_TAGS') {
    const req = requests.find(r => r.id === msg.data.id);
    if (req) {
      req.tags = Array.isArray(msg.data.tags) ? msg.data.tags.slice(0, 10).map(tag => String(tag).slice(0, 30)) : [];
      persist();
      broadcastUpdate();
    }
    sendResponse({ ok: !!req });
    return true;
  }

  if (msg.type === 'GET_SETTINGS') {
    sendResponse({ settings });
    return true;
  }

  if (msg.type === 'UPDATE_SETTINGS') {
    settings = {
      ...settings,
      ...msg.data,
      redactSensitive: msg.data?.redactSensitive !== false,
      sensitiveHeaders: Array.isArray(msg.data?.sensitiveHeaders) ? msg.data.sensitiveHeaders : settings.sensitiveHeaders,
      excludedHosts: Array.isArray(msg.data?.excludedHosts) ? msg.data.excludedHosts : settings.excludedHosts,
    };
    persist();
    sendResponse({ ok: true, settings });
    return true;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  initialization
    .then(() => handleMessage(msg, sender, sendResponse))
    .catch(error => sendResponse({ error: error.message }));
  return true;
});

function broadcastUpdate() {
  chrome.runtime.sendMessage({ type: 'REQUESTS_UPDATED' }).catch(() => {});
}

function broadcastCaptureConfig() {
  if (!chrome.tabs?.query) return;
  const message = {
    type: 'CAPTURE_CONFIG_UPDATED',
    hasActiveMockRules: mockRules.some(rule => rule.enabled),
  };
  chrome.tabs.query({}).then(tabs => Promise.all(tabs
    .filter(tab => Number.isInteger(tab.id))
    .map(tab => chrome.tabs.sendMessage(tab.id, message).catch(() => {}))))
    .catch(() => {});
}

function generateHAR(requests) {
  const entries = requests.filter(r => r.endTime).map(r => ({
    startedDateTime: new Date(r.startTime).toISOString(),
    time: r.duration || 0,
    request: {
      method: r.method,
      url: r.url,
      httpVersion: 'HTTP/2',
      headers: Object.entries(r.requestHeaders).map(([name, value]) => ({ name, value })),
      queryString: (() => {
        try {
          return Array.from(new URL(r.url).searchParams, ([name, value]) => ({ name, value }));
        } catch { return []; }
      })(),
      headersSize: -1,
      bodySize: r.requestBody ? r.requestBody.length : 0,
      postData: r.requestBody ? {
        mimeType: r.requestHeaders['content-type'] || r.requestHeaders['Content-Type'] || 'text/plain',
        text: r.requestBody,
      } : undefined,
    },
    response: {
      status: r.status,
      statusText: r.statusText,
      httpVersion: 'HTTP/2',
      headers: Object.entries(r.responseHeaders).map(([name, value]) => ({ name, value })),
      content: {
        size: r.size || 0,
        mimeType: r.responseHeaders['content-type'] || 'text/plain',
        text: r.responseBody || '',
      },
      headersSize: -1,
      bodySize: r.size || 0,
    },
    cache: {},
    timings: { send: 0, wait: r.duration || 0, receive: 0 },
  }));

  return {
    log: {
      version: '1.2',
      creator: { name: 'NetCatcher', version: chrome.runtime.getManifest().version },
      entries,
    },
  };
}
