// NetCatcher - Background Service Worker
// 接收 content script 发来的请求数据，存储并转发给 popup

const MAX_REQUESTS = 500;
let requests = [];
let isCapturing = true;
let requestId = 0;

// 从持久化存储恢复数据
chrome.storage.local.get(['nc_requests', 'nc_requestId', 'nc_isCapturing'], (data) => {
  if (data.nc_requests) requests = data.nc_requests;
  if (data.nc_requestId) requestId = data.nc_requestId;
  if (data.nc_isCapturing !== undefined) isCapturing = data.nc_isCapturing;
  console.log('[NetCatcher BG] Restored:', requests.length, 'requests, capturing:', isCapturing);
});

// 保存到持久化存储
function persist() {
  chrome.storage.local.set({
    nc_requests: requests.slice(-200),
    nc_requestId: requestId,
    nc_isCapturing: isCapturing,
  });
}

// 监听来自 content script 和 popup 的消息
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[NetCatcher BG] Received message:', msg.type, msg.data?.url);

  if (msg.type === 'NET_REQUEST') {
    if (!isCapturing) {
      console.log('[NetCatcher BG] Capturing disabled, skipping');
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
      initiator: msg.data.initiator || '',
    };
    requests.push(entry);
    if (requests.length > MAX_REQUESTS) {
      requests = requests.slice(-MAX_REQUESTS);
    }
    console.log('[NetCatcher BG] Added request #' + entry.id, entry.url);
    persist();
    broadcastUpdate();
    sendResponse({ id: entry.id });
    return true;
  }

  if (msg.type === 'NET_RESPONSE') {
    // 通过 URL + startTime 精确匹配
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
      console.log('[NetCatcher BG] Updated request #' + entry.id, entry.status);
      persist();
      broadcastUpdate();
    } else {
      console.warn('[NetCatcher BG] No matching request for response:', msg.data.url);
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
      console.log('[NetCatcher BG] Request error #' + entry.id, entry.statusText);
      persist();
      broadcastUpdate();
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'GET_REQUESTS') {
    sendResponse({ requests, isCapturing });
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
      creator: { name: 'NetCatcher', version: '1.1.0' },
      entries,
    },
  };
}
