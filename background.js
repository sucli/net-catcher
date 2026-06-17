// NetCatcher - Background Service Worker
// 接收 content script 发来的请求数据，存储并转发给 popup

const MAX_REQUESTS = 500;
const MAX_WS_CONNECTIONS = 100;
const MAX_WS_MESSAGES_PER_CONNECTION = 200;
let requests = [];
let wsConnections = new Map(); // id -> { ...connection, messages: [] }
let isCapturing = true;
let requestId = 0;

// 从持久化存储恢复数据
chrome.storage.local.get(['nc_requests', 'nc_wsConnections', 'nc_requestId', 'nc_isCapturing'], (data) => {
  if (data.nc_requests) requests = data.nc_requests;
  if (data.nc_requestId) requestId = data.nc_requestId;
  if (data.nc_isCapturing !== undefined) isCapturing = data.nc_isCapturing;
  if (data.nc_wsConnections) {
    try {
      const arr = JSON.parse(data.nc_wsConnections);
      arr.forEach(conn => wsConnections.set(conn.id, conn));
    } catch {}
  }
});

// 保存到持久化存储
function persist() {
  const wsArr = Array.from(wsConnections.values()).slice(-20);
  wsArr.forEach(conn => {
    conn.messages = conn.messages.slice(-50); // 只持久化最近50条消息
  });
  chrome.storage.local.set({
    nc_requests: requests.slice(-200),
    nc_wsConnections: JSON.stringify(wsArr),
    nc_requestId: requestId,
    nc_isCapturing: isCapturing,
  });
}

// 监听来自 content script 和 popup 的消息
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'NET_REQUEST') {
    if (!isCapturing) {
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

  // WebSocket 事件处理
  if (msg.type === 'WS_OPEN') {
    if (!isCapturing) {
      sendResponse(null);
      return;
    }
    const wsId = msg.data.id;
    const conn = {
      id: wsId,
      url: msg.data.url,
      protocols: msg.data.protocols,
      startTime: msg.data.startTime,
      tabId: sender.tab ? sender.tab.id : null,
      status: 'open', // open, closed, error
      closeCode: null,
      closeReason: '',
      endTime: null,
      messages: [],
      messageCount: { send: 0, receive: 0 },
    };
    wsConnections.set(wsId, conn);
    if (wsConnections.size > MAX_WS_CONNECTIONS) {
      const oldestKey = wsConnections.keys().next().value;
      wsConnections.delete(oldestKey);
    }
    persist();
    broadcastUpdate();
    sendResponse({ id: wsId });
    return true;
  }

  if (msg.type === 'WS_MESSAGE') {
    const conn = wsConnections.get(msg.data.id);
    if (conn) {
      const message = {
        direction: msg.data.direction, // 'send' or 'receive'
        type: msg.data.messageType,    // 'text' or 'binary'
        data: msg.data.data,
        timestamp: msg.data.timestamp,
      };
      conn.messages.push(message);
      if (conn.messages.length > MAX_WS_MESSAGES_PER_CONNECTION) {
        conn.messages = conn.messages.slice(-MAX_WS_MESSAGES_PER_CONNECTION);
      }
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

  if (msg.type === 'GET_REQUESTS') {
    sendResponse({
      requests,
      wsConnections: Array.from(wsConnections.values()),
      isCapturing,
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
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'EXPORT_HAR') {
    const har = generateHAR(requests);
    sendResponse({ har });
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
    timings: {
      send: 0,
      wait: r.duration || 0,
      receive: 0,
    },
  }));

  return {
    log: {
      version: '1.2',
      creator: { name: 'NetCatcher', version: '1.2.0' },
      entries,
    },
  };
}
