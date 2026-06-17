// NetCatcher - Background Service Worker
// 核心功能：请求捕获、存储、重放、Mock、过滤器管理

const MAX_REQUESTS = 500;
const MAX_WS_CONNECTIONS = 100;
const MAX_WS_MESSAGES = 200;
let requests = [];
let wsConnections = new Map();
let isCapturing = true;
let requestId = 0;
let mockRules = [];
let savedFilters = [];

// 初始化：从存储恢复数据
chrome.storage.local.get([
  'nc_requests', 'nc_wsConnections', 'nc_requestId', 'nc_isCapturing',
  'nc_mockRules', 'nc_savedFilters'
], (data) => {
  if (data.nc_requests) requests = data.nc_requests;
  if (data.nc_requestId) requestId = data.nc_requestId;
  if (data.nc_isCapturing !== undefined) isCapturing = data.nc_isCapturing;
  if (data.nc_mockRules) mockRules = data.nc_mockRules;
  if (data.nc_savedFilters) savedFilters = data.nc_savedFilters;
  if (data.nc_wsConnections) {
    try {
      const arr = JSON.parse(data.nc_wsConnections);
      arr.forEach(conn => wsConnections.set(conn.id, conn));
    } catch {}
  }
});

// 持久化存储
function persist() {
  // 内存优化：限制 WebSocket 消息数量
  const wsArr = Array.from(wsConnections.values()).slice(-20);
  wsArr.forEach(conn => {
    if (conn.messages.length > MAX_WS_MESSAGES) {
      conn.messages = conn.messages.slice(-MAX_WS_MESSAGES);
    }
  });

  chrome.storage.local.set({
    nc_requests: requests.slice(-200),
    nc_wsConnections: JSON.stringify(wsArr),
    nc_requestId: requestId,
    nc_isCapturing: isCapturing,
    nc_mockRules: mockRules,
    nc_savedFilters: savedFilters,
  });
}

// 请求去重：检查是否是重复请求
function isDuplicateRequest(url, startTime) {
  const threshold = 50; // 50ms 内的相同 URL 视为重复
  return requests.some(r =>
    r.url === url &&
    Math.abs(r.startTime - startTime) < threshold &&
    r.endTime === null
  );
}

// 匹配 Mock 规则
function matchMockRule(url) {
  return mockRules.find(rule => {
    if (!rule.enabled) return false;
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

// 消息处理
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ============ HTTP 请求相关 ============

  if (msg.type === 'NET_REQUEST') {
    if (!isCapturing) { sendResponse(null); return; }

    // 请求去重
    if (isDuplicateRequest(msg.data.url, msg.data.startTime)) {
      sendResponse(null);
      return;
    }

    const entry = {
      id: ++requestId,
      url: msg.data.url,
      method: msg.data.method,
      status: null,
      statusText: '',
      requestHeaders: msg.data.requestHeaders || {},
      requestBody: msg.data.requestBody || null,
      responseHeaders: {},
      responseBody: null,
      startTime: msg.data.startTime,
      endTime: null,
      duration: null,
      size: null,
      type: msg.data.type || 'xhr',
      tabId: sender.tab ? sender.tab.id : null,
      starred: false,
      tags: [],
    };
    requests.push(entry);
    if (requests.length > MAX_REQUESTS) {
      requests = requests.slice(-MAX_REQUESTS);
    }
    persist();
    broadcastUpdate();
    sendResponse({ id: entry.id });
    return true;
  }

  if (msg.type === 'NET_RESPONSE') {
    const entry = requests.find(r =>
      r.url === msg.data.url &&
      Math.abs(r.startTime - msg.data.startTime) < 1 &&
      r.endTime === null
    );
    if (entry) {
      entry.status = msg.data.status;
      entry.statusText = msg.data.statusText;
      entry.responseHeaders = msg.data.responseHeaders || {};
      entry.responseBody = msg.data.responseBody;
      entry.endTime = msg.data.endTime;
      entry.duration = msg.data.endTime - entry.startTime;
      entry.size = msg.data.size || (msg.data.responseBody ? msg.data.responseBody.length : 0);
      persist();
      broadcastUpdate();
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'NET_ERROR') {
    const entry = requests.find(r =>
      r.url === msg.data.url &&
      Math.abs(r.startTime - msg.data.startTime) < 1 &&
      r.endTime === null
    );
    if (entry) {
      entry.status = 0;
      entry.statusText = msg.data.error || 'Network Error';
      entry.endTime = msg.data.endTime;
      entry.duration = msg.data.endTime - entry.startTime;
      persist();
      broadcastUpdate();
    }
    sendResponse({ ok: true });
    return true;
  }

  // ============ WebSocket 相关 ============

  if (msg.type === 'WS_OPEN') {
    if (!isCapturing) { sendResponse(null); return; }
    const conn = {
      id: msg.data.id,
      url: msg.data.url,
      protocols: msg.data.protocols,
      startTime: msg.data.startTime,
      tabId: sender.tab ? sender.tab.id : null,
      status: 'open',
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
    if (conn) {
      conn.messages.push({
        direction: msg.data.direction,
        type: msg.data.messageType,
        data: msg.data.data,
        timestamp: msg.data.timestamp,
      });
      conn.messageCount[msg.data.direction]++;
      persist();
      broadcastUpdate();
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'WS_CLOSE') {
    const conn = wsConnections.get(msg.data.id);
    if (conn) {
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
    if (conn) {
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
    const fetchOptions = {
      method: req.method,
      headers: req.requestHeaders,
    };
    if (req.requestBody && ['POST', 'PUT', 'PATCH'].includes(req.method)) {
      fetchOptions.body = req.requestBody;
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
      enabled: true,
      status: msg.data.status || 200,
      headers: msg.data.headers || { 'content-type': 'application/json' },
      body: msg.data.body || '{}',
    });
    persist();
    broadcastUpdate();
    sendResponse({ ok: true, rules: mockRules });
    return true;
  }

  if (msg.type === 'UPDATE_MOCK_RULE') {
    const rule = mockRules.find(r => r.id === msg.data.id);
    if (rule) {
      Object.assign(rule, msg.data);
      persist();
    }
    sendResponse({ ok: true, rules: mockRules });
    return true;
  }

  if (msg.type === 'DELETE_MOCK_RULE') {
    mockRules = mockRules.filter(r => r.id !== msg.data.id);
    persist();
    sendResponse({ ok: true, rules: mockRules });
    return true;
  }

  if (msg.type === 'TOGGLE_MOCK_RULE') {
    const rule = mockRules.find(r => r.id === msg.data.id);
    if (rule) {
      rule.enabled = !rule.enabled;
      persist();
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
    sendResponse({
      requests,
      wsConnections: Array.from(wsConnections.values()),
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
    requests = [];
    wsConnections.clear();
    requestId = 0;
    persist();
    broadcastUpdate();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'EXPORT_HAR') {
    const har = generateHAR(requests);
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
});

function broadcastUpdate() {
  chrome.runtime.sendMessage({ type: 'REQUESTS_UPDATED' }).catch(() => {});
}

function generateHAR(requests) {
  const entries = requests.filter(r => r.endTime).map(r => ({
    startedDateTime: new Date(r.startTime).toISOString(),
    time: r.duration || 0,
    request: {
      method: r.method,
      url: r.url,
      httpVersion: 'HTTP/1.1',
      headers: Object.entries(r.requestHeaders).map(([name, value]) => ({ name, value })),
      queryString: [],
      headersSize: -1,
      bodySize: r.requestBody ? r.requestBody.length : 0,
      postData: r.requestBody ? { mimeType: 'application/json', text: r.requestBody } : undefined,
    },
    response: {
      status: r.status,
      statusText: r.statusText,
      httpVersion: 'HTTP/1.1',
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
      creator: { name: 'NetCatcher', version: '2.0.0' },
      entries,
    },
  };
}
