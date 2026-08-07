// NetCatcher - Background Service Worker
// 核心功能：请求捕获、存储、重放、Mock、过滤器管理

const MAX_REQUESTS = 500;
const MAX_WS_CONNECTIONS = 100;
const MAX_WS_MESSAGES = 200;
const MAX_WS_MESSAGE_CHARS = 4096;
const MAX_PERSISTED_WS_MESSAGES = 20;
const MAX_PERSISTED_BODY_BYTES = 4 * 1024 * 1024;
const MAX_CAPTURE_URL_LENGTH = 8192;
const MAX_CAPTURE_HEADER_CHARS = 64 * 1024;
const MAX_CAPTURE_BODY_CHARS = 1024 * 1024;
const MAX_NETWORK_RECORDS = 1000;
const MAX_SESSIONS = 20;
const DEFAULT_SETTINGS = {
  redactSensitive: true,
  sensitiveHeaders: ['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token'],
  excludedHosts: [],
};
const CAPTURE_TYPES = new Set([
  'NET_REQUEST', 'NET_RESPONSE', 'NET_RESPONSE_BODY', 'NET_ERROR',
  'NET_STREAM_CHUNK',
  'WS_OPEN', 'WS_READY', 'WS_MESSAGE', 'WS_CLOSE', 'WS_ERROR',
]);
let requests = [];
let wsConnections = new Map();
let networkRecords = new Map();
let isCapturing = true;
let requestId = 0;
let mockRules = [];
let savedFilters = [];
let scenarios = [];
let settings = { ...DEFAULT_SETTINGS };
let storageError = null;
let persistQueue = Promise.resolve();
let sessions = [];
let activeSessionId = 'default';

function sessionStorageKey(id) {
  return `nc_session_${String(id).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function createDefaultSession() {
  return { id: 'default', name: '默认会话', createdAt: Date.now(), updatedAt: Date.now() };
}

function normalizeSessions(value) {
  if (!Array.isArray(value)) return [createDefaultSession()];
  const result = value.filter(item => item && typeof item.id === 'string' && typeof item.name === 'string')
    .slice(-MAX_SESSIONS)
    .map(item => ({
      id: item.id.slice(0, 80),
      name: item.name.slice(0, 80),
      createdAt: Number(item.createdAt) || Date.now(),
      updatedAt: Number(item.updatedAt) || Date.now(),
    }));
  return result.length ? result : [createDefaultSession()];
}

function applySessionSnapshot(snapshot) {
  requests = Array.isArray(snapshot?.requests) ? snapshot.requests : [];
  requestId = Number(snapshot?.requestId) || 0;
  wsConnections = new Map();
  if (Array.isArray(snapshot?.wsConnections)) {
    snapshot.wsConnections.forEach(conn => {
      if (conn && typeof conn.id === 'string') wsConnections.set(conn.id, conn);
    });
  } else if (typeof snapshot?.wsConnections === 'string') {
    try {
      JSON.parse(snapshot.wsConnections).forEach(conn => {
        if (conn && typeof conn.id === 'string') wsConnections.set(conn.id, conn);
      });
    } catch {}
  }
}

function createPersistedSnapshot() {
  const wsArr = Array.from(wsConnections.values()).slice(-20);
  wsArr.forEach(conn => {
    if (conn.messages.length > MAX_WS_MESSAGES) conn.messages = conn.messages.slice(-MAX_WS_MESSAGES);
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

  return { requests: persistedRequests, wsConnections: persistedWsArr, requestId };
}

// Wait for persisted state before handling events after a service-worker wake-up.
const initialization = chrome.storage.local.get([
  'nc_requests', 'nc_wsConnections', 'nc_requestId', 'nc_isCapturing',
  'nc_mockRules', 'nc_savedFilters', 'nc_scenarios', 'nc_settings', 'nc_sessions', 'nc_activeSessionId'
]).then(async data => {
  sessions = normalizeSessions(data.nc_sessions);
  activeSessionId = typeof data.nc_activeSessionId === 'string' &&
    sessions.some(session => session.id === data.nc_activeSessionId) ? data.nc_activeSessionId : sessions[0].id;
  const stored = await chrome.storage.local.get(sessionStorageKey(activeSessionId));
  const sessionData = stored?.[sessionStorageKey(activeSessionId)];
  applySessionSnapshot(sessionData || {
    requests: data.nc_requests,
    wsConnections: data.nc_wsConnections,
    requestId: data.nc_requestId,
  });
  if (data.nc_isCapturing !== undefined) isCapturing = data.nc_isCapturing;
  if (data.nc_mockRules) mockRules = data.nc_mockRules;
  if (data.nc_savedFilters) savedFilters = data.nc_savedFilters;
  if (Array.isArray(data.nc_scenarios)) scenarios = data.nc_scenarios;
  if (data.nc_settings) settings = { ...DEFAULT_SETTINGS, ...data.nc_settings };
}).catch(() => {});

// 持久化存储
function persist() {
  const snapshot = createPersistedSnapshot();
  const session = sessions.find(item => item.id === activeSessionId);
  if (session) session.updatedAt = Date.now();
  const payload = {
    nc_isCapturing: isCapturing,
    nc_mockRules: mockRules,
    nc_savedFilters: savedFilters,
    nc_scenarios: scenarios,
    nc_settings: settings,
    nc_sessions: sessions,
    nc_activeSessionId: activeSessionId,
    [sessionStorageKey(activeSessionId)]: snapshot,
  };
  persistQueue = persistQueue
    .catch(() => {})
    .then(() => chrome.storage.local.set(payload))
    .then(() => { storageError = null; })
    .catch(handleStorageError);
  return persistQueue;
}

function handleStorageError(error) {
  storageError = String(error?.message || error || 'storage write failed');
  try {
    Promise.resolve(chrome.runtime.sendMessage({ type: 'STORAGE_ERROR', message: storageError })).catch(() => {});
  } catch {}
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

function limitHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {};
  let used = 0;
  return Object.fromEntries(Object.entries(headers).flatMap(([name, value]) => {
    const text = String(value);
    if (used >= MAX_CAPTURE_HEADER_CHARS) return [];
    const limited = text.slice(0, MAX_CAPTURE_HEADER_CHARS - used);
    used += limited.length;
    return [[String(name).slice(0, 256), limited]];
  }));
}

function redactBody(body) {
  if (!settings.redactSensitive || typeof body !== 'string') return body;
  let result = body.replace(/("?(?:token|access_token|refresh_token|password|secret|api[_-]?key)"?\s*:\s*)(["'])[^"']*\2/gi, '$1"[REDACTED]"');
  return result.replace(/(^|&)([^=&]*(?:token|password|secret|api[_-]?key)[^=&]*)=[^&]*/gi, '$1$2=%5BREDACTED%5D');
}

function redactUrl(url) {
  if (!settings.redactSensitive || typeof url !== 'string') return url;
  try {
    const parsed = new URL(url);
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/(token|password|secret|api[_-]?key|auth|session)/i.test(key)) {
        parsed.searchParams.set(key, '[REDACTED]');
      }
    }
    return parsed.href;
  } catch {
    return url;
  }
}

function sanitizeData(data) {
  return {
    ...data,
    url: typeof data.url === 'string' ? redactUrl(data.url).slice(0, MAX_CAPTURE_URL_LENGTH) : data.url,
    requestHeaders: limitHeaders(redactHeaders(data.requestHeaders)),
    responseHeaders: limitHeaders(redactHeaders(data.responseHeaders)),
    requestBody: redactBody(typeof data.requestBody === 'string' ? data.requestBody.slice(0, MAX_CAPTURE_BODY_CHARS) : data.requestBody),
    responseBody: redactBody(typeof data.responseBody === 'string' ? data.responseBody.slice(0, MAX_CAPTURE_BODY_CHARS) : data.responseBody),
    body: redactBody(typeof data.body === 'string' ? data.body.slice(0, MAX_CAPTURE_BODY_CHARS) : data.body),
    data: redactBody(typeof data.data === 'string' ? data.data.slice(0, MAX_CAPTURE_BODY_CHARS) : data.data),
  };
}

function detectGraphQL(url, headers, body) {
  const contentType = Object.entries(headers || {}).find(([name]) => String(name).toLowerCase() === 'content-type')?.[1] || '';
  if (!String(url || '').toLowerCase().includes('graphql') && !String(contentType).includes('json')) return null;
  if (typeof body !== 'string') return null;
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed.query !== 'string') return null;
    return {
      operationName: String(parsed.operationName || '').slice(0, 120),
      query: parsed.query.slice(0, 4096),
      variables: parsed.variables && typeof parsed.variables === 'object' ? parsed.variables : {},
    };
  } catch {
    return null;
  }
}

function publicRequest(request) {
  const { replayHeaders, replayBody, ...safeRequest } = request;
  return safeRequest;
}

function byteLength(value) {
  if (typeof value !== 'string') return 0;
  try { return new TextEncoder().encode(value).byteLength; }
  catch { return value.length; }
}

function replayHeaders(headers) {
  const forbidden = new Set([
    'connection', 'content-length', 'cookie', 'host', 'origin', 'referer',
    'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'user-agent',
  ]);
  return Object.fromEntries(Object.entries(headers || {}).filter(([name]) => {
    const lowerName = String(name).toLowerCase();
    return !forbidden.has(lowerName) && !lowerName.startsWith('sec-');
  }));
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

function validRequestMethod(method) {
  const value = String(method || 'GET').toUpperCase();
  return /^[!#$%&'*+.^_`|~0-9A-Z-]{1,32}$/.test(value) ? value : 'UNKNOWN';
}

function networkUrlMatches(left, right) {
  return redactUrl(String(left || '')) === redactUrl(String(right || ''));
}

function findNetworkRecordForCapture(data, sender) {
  let match = null;
  let distance = Infinity;
  for (const record of networkRecords.values()) {
    if (record.captured) continue;
    if (record.tabId !== sender.tab.id || record.frameId !== sender.frameId) continue;
    if (record.type !== 'fetch' && record.type !== 'xmlhttprequest') continue;
    if (validRequestMethod(record.method) !== validRequestMethod(data.method)) continue;
    if (!networkUrlMatches(record.url, data.url)) continue;
    const delta = Math.abs(Number(record.startTime) - Number(data.startTime));
    if (delta > 5000 || delta >= distance) continue;
    match = record;
    distance = delta;
  }
  return match;
}

function attachNetworkRecord(entry, record) {
  if (!entry || !record) return;
  record.entryId = entry.id;
  entry.webRequestId = record.requestId;
  entry.resourceType = record.type;
  entry.networkCaptured = true;
  if (Object.keys(record.requestHeaders || {}).length > 0 && Object.keys(entry.requestHeaders || {}).length === 0) {
    entry.requestHeaders = limitHeaders(redactHeaders(record.requestHeaders));
  }
  if (record.responseHeaders) entry.responseHeaders = limitHeaders(redactHeaders(record.responseHeaders));
  if (Number.isFinite(record.statusCode) && (entry.status === null || entry.status === undefined)) {
    entry.status = record.statusCode;
    entry.statusText = record.statusLine || entry.statusText || '';
  }
  if (Number.isFinite(record.endTime) && !entry.endTime) {
    entry.endTime = record.endTime;
    entry.duration = Math.max(0, record.endTime - entry.startTime);
  }
}

function createNetworkOnlyEntry(record) {
  const entry = {
    id: ++requestId,
    captureId: null,
    url: redactUrl(record.url).slice(0, MAX_CAPTURE_URL_LENGTH),
    method: validRequestMethod(record.method),
    status: Number.isFinite(record.statusCode) ? record.statusCode : null,
    statusText: record.statusLine || '',
    requestHeaders: limitHeaders(redactHeaders(record.requestHeaders || {})),
    requestBody: null,
    responseHeaders: limitHeaders(redactHeaders(record.responseHeaders || {})),
    responseBody: null,
    startTime: record.startTime,
    endTime: Number.isFinite(record.endTime) ? record.endTime : null,
    duration: Number.isFinite(record.endTime) ? Math.max(0, record.endTime - record.startTime) : null,
    size: null,
    type: 'network',
    resourceType: record.type,
    webRequestId: record.requestId,
    networkCaptured: true,
    tabId: record.tabId,
    frameId: record.frameId,
    starred: false,
    tags: [],
    isMocked: false,
  };
  record.entryId = entry.id;
  requests.push(entry);
  if (requests.length > MAX_REQUESTS) requests = requests.slice(-MAX_REQUESTS);
  return entry;
}

function updateNetworkRecord(record, details) {
  if (!record) return;
  if (details.requestHeaders) record.requestHeaders = details.requestHeaders;
  if (details.responseHeaders) record.responseHeaders = details.responseHeaders;
  if (Number.isFinite(details.statusCode)) record.statusCode = details.statusCode;
  if (details.statusLine) record.statusLine = details.statusLine;
  if (details.final && Number.isFinite(details.timeStamp)) record.endTime = details.timeStamp;
  const entry = record.entryId ? requests.find(item => item.id === record.entryId) : createNetworkOnlyEntry(record);
  attachNetworkRecord(entry, record);
  persist();
  broadcastUpdate();
}

function registerWebRequestListeners() {
  if (!chrome.webRequest?.onBeforeRequest?.addListener) return;
  const filter = { urls: ['<all_urls>'] };
  chrome.webRequest.onBeforeRequest.addListener(details => {
    if (!isCapturing || !Number.isInteger(details.tabId) || details.tabId < 0 || isExcluded(details.url)) return;
    const record = {
      requestId: String(details.requestId),
      url: details.url,
      method: details.method,
      type: details.type,
      tabId: details.tabId,
      frameId: Number.isInteger(details.frameId) ? details.frameId : 0,
      startTime: Number(details.timeStamp) || Date.now(),
      requestHeaders: {},
      responseHeaders: {},
      statusCode: null,
      entryId: null,
    };
    networkRecords.set(record.requestId, record);
    if (networkRecords.size > MAX_NETWORK_RECORDS) {
      networkRecords.delete(networkRecords.keys().next().value);
    }
    const entry = createNetworkOnlyEntry(record);
    persist();
    broadcastUpdate();
    return entry;
  }, filter);

  chrome.webRequest.onBeforeSendHeaders?.addListener(details => {
    const record = networkRecords.get(String(details.requestId));
    if (record) updateNetworkRecord(record, details);
  }, filter, ['requestHeaders']);

  chrome.webRequest.onHeadersReceived?.addListener(details => {
    const record = networkRecords.get(String(details.requestId));
    if (record) updateNetworkRecord(record, details);
  }, filter, ['responseHeaders']);

  chrome.webRequest.onBeforeRedirect?.addListener(details => {
    const record = networkRecords.get(String(details.requestId));
    if (record) {
      record.redirectUrl = details.redirectUrl;
      updateNetworkRecord(record, { ...details, final: true });
    }
  }, filter);

  chrome.webRequest.onCompleted?.addListener(details => {
    const record = networkRecords.get(String(details.requestId));
    if (record) updateNetworkRecord(record, { ...details, final: true });
  }, filter);

  chrome.webRequest.onErrorOccurred?.addListener(details => {
    const record = networkRecords.get(String(details.requestId));
    if (!record) return;
    record.statusCode = 0;
    record.statusLine = details.error || 'Network Error';
    updateNetworkRecord(record, { timeStamp: details.timeStamp, final: true });
  }, filter);
}

// 匹配 Mock 规则
function matchMockRule(url, method = '', requestHeaders = {}, requestBody = '') {
  const normalizedHeaders = Object.fromEntries(Object.entries(requestHeaders || {})
    .map(([name, value]) => [String(name).toLowerCase(), String(value)]));
  return [...mockRules].sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0) ||
    (Number(a.id) || 0) - (Number(b.id) || 0)).find(rule => {
    if (!rule.enabled) return false;
    if (rule.method && rule.method !== '*' && String(rule.method).toUpperCase() !== String(method).toUpperCase()) return false;
    if (rule.matchQuery && typeof rule.matchQuery === 'object') {
      try {
        const query = new URL(url).searchParams;
        if (Object.entries(rule.matchQuery).some(([key, value]) => query.get(key) !== String(value))) return false;
      } catch { return false; }
    }
    if (rule.matchHeaders && typeof rule.matchHeaders === 'object') {
      if (Object.entries(rule.matchHeaders).some(([key, value]) => {
        const actual = normalizedHeaders[String(key).toLowerCase()];
        return actual === undefined || !actual.toLowerCase().includes(String(value).toLowerCase());
      })) return false;
    }
    if (rule.matchBody && !String(requestBody || '').includes(String(rule.matchBody))) return false;
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
function getMockResponse(url, method, requestHeaders = {}, requestBody = '') {
  const rule = matchMockRule(url, method, requestHeaders, requestBody);
  if (!rule) return null;
  if (rule.action === 'error') {
    return { error: String(rule.error || 'Mock Network Error').slice(0, 200), delay: Math.max(0, Number.parseInt(rule.delay, 10) || 0) };
  }
  const parsedStatus = Number.parseInt(rule.status, 10);
  return {
    status: Number.isInteger(parsedStatus) && parsedStatus >= 200 && parsedStatus <= 599 ? parsedStatus : 200,
    headers: rule.headers,
    body: rule.body,
    delay: Math.max(0, Number.parseInt(rule.delay, 10) || 0),
    action: rule.action || 'respond',
  };
}

function normalizeMockRuleInput(data, existing = {}) {
  return {
    ...existing,
    name: String(data.name ?? existing.name ?? '').slice(0, 100),
    pattern: String(data.pattern ?? existing.pattern ?? '').slice(0, 2048),
    isRegex: data.isRegex ?? existing.isRegex ?? false,
    method: String(data.method ?? existing.method ?? '*').toUpperCase().slice(0, 32),
    priority: Math.max(-1000, Math.min(1000, Number.parseInt(data.priority ?? existing.priority, 10) || 0)),
    delay: Math.max(0, Math.min(60000, Number.parseInt(data.delay ?? existing.delay, 10) || 0)),
    enabled: data.enabled ?? existing.enabled ?? true,
    action: ['respond', 'error'].includes(data.action ?? existing.action) ? (data.action ?? existing.action) : 'respond',
    error: String(data.error ?? existing.error ?? 'Mock Network Error').slice(0, 200),
    status: Number.parseInt(data.status ?? existing.status, 10) || 200,
    headers: data.headers && typeof data.headers === 'object' ? data.headers : (existing.headers || { 'content-type': 'application/json' }),
    body: String(data.body ?? existing.body ?? '{}').slice(0, MAX_CAPTURE_BODY_CHARS),
    matchQuery: data.matchQuery && typeof data.matchQuery === 'object' ? data.matchQuery : (existing.matchQuery || {}),
    matchHeaders: data.matchHeaders && typeof data.matchHeaders === 'object' ? data.matchHeaders : (existing.matchHeaders || {}),
    matchBody: String(data.matchBody ?? existing.matchBody ?? '').slice(0, 4096),
  };
}

function clearCaptureState() {
  requests = [];
  wsConnections.clear();
  networkRecords.clear();
  requestId = 0;
}

async function switchSession(sessionId) {
  const target = sessions.find(session => session.id === sessionId);
  if (!target) return { error: '会话不存在' };
  await persist();
  const stored = await chrome.storage.local.get(sessionStorageKey(target.id));
  activeSessionId = target.id;
  applySessionSnapshot(stored?.[sessionStorageKey(target.id)] || {});
  networkRecords.clear();
  target.updatedAt = Date.now();
  await persist();
  broadcastUpdate();
  return { ok: true, sessions, activeSessionId };
}

async function createSession(name) {
  await persist();
  const id = `session-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const session = {
    id,
    name: String(name || '新会话').trim().slice(0, 80) || '新会话',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  sessions = [...sessions, session].slice(-MAX_SESSIONS);
  activeSessionId = id;
  clearCaptureState();
  await persist();
  broadcastUpdate();
  return { ok: true, sessions, activeSessionId };
}

async function deleteSession(sessionId) {
  if (sessions.length <= 1) return { error: '至少保留一个会话' };
  const target = sessions.find(session => session.id === sessionId);
  if (!target) return { error: '会话不存在' };
  const remaining = sessions.filter(session => session.id !== sessionId);
  if (activeSessionId === sessionId) {
    sessions = remaining;
    activeSessionId = remaining[remaining.length - 1].id;
    const stored = await chrome.storage.local.get(sessionStorageKey(activeSessionId));
    applySessionSnapshot(stored?.[sessionStorageKey(activeSessionId)] || {});
    networkRecords.clear();
  } else {
    sessions = remaining;
  }
  if (chrome.storage.local.remove) await chrome.storage.local.remove(sessionStorageKey(sessionId));
  await persist();
  broadcastUpdate();
  return { ok: true, sessions, activeSessionId };
}

function headersArrayToObject(headers) {
  if (!Array.isArray(headers)) return headers && typeof headers === 'object' ? headers : {};
  return Object.fromEntries(headers.slice(0, 500).map(item => [String(item.name || ''), String(item.value || '')])
    .filter(([name]) => name));
}

function addImportedRequest(input, source = 'import') {
  if (!input || typeof input.url !== 'string' || input.url.length > MAX_CAPTURE_URL_LENGTH) return null;
  const data = sanitizeData({
    ...input,
    url: input.url,
    requestHeaders: headersArrayToObject(input.requestHeaders),
    responseHeaders: headersArrayToObject(input.responseHeaders),
  });
  const method = validRequestMethod(data.method);
  const entry = {
    id: ++requestId,
    captureId: typeof data.captureId === 'string' ? data.captureId : `import-${requestId}`,
    url: data.url,
    method,
    status: Number.isFinite(data.status) ? data.status : null,
    statusText: String(data.statusText || ''),
    requestHeaders: data.requestHeaders || {},
    requestBody: data.requestBody || null,
    responseHeaders: data.responseHeaders || {},
    responseBody: data.responseBody ?? null,
    startTime: Number(data.startTime) || Date.now(),
    endTime: Number(data.endTime) || null,
    duration: Number(data.duration) || null,
    size: Number(data.size) || null,
    type: String(data.type || source).slice(0, 32),
    source,
    imported: true,
    bodyEncoding: data.bodyEncoding,
    bodyMimeType: data.bodyMimeType,
    graphql: detectGraphQL(data.url, data.requestHeaders, data.requestBody),
    tabId: Number.isInteger(input.tabId) ? input.tabId : null,
    frameId: 0,
    starred: false,
    tags: [],
    isMocked: false,
  };
  Object.defineProperties(entry, {
    replayHeaders: { value: limitHeaders(headersArrayToObject(input.requestHeaders || {})), enumerable: false, configurable: false },
    replayBody: {
      value: typeof input.requestBody === 'string' ? input.requestBody.slice(0, MAX_CAPTURE_BODY_CHARS) : null,
      enumerable: false,
      configurable: false,
    },
  });
  requests.push(entry);
  if (requests.length > MAX_REQUESTS) requests = requests.slice(-MAX_REQUESTS);
  return entry;
}

function importHar(har, tabId = null) {
  const entries = Array.isArray(har?.log?.entries) ? har.log.entries.slice(0, 200) : [];
  const imported = entries.map(entry => {
    const request = entry.request || {};
    const response = entry.response || {};
    const content = response.content || {};
    return addImportedRequest({
      url: request.url,
      method: request.method,
      requestHeaders: request.headers,
      requestBody: request.postData?.text || null,
      responseHeaders: response.headers,
      responseBody: content.text || null,
      bodyEncoding: content.encoding,
      bodyMimeType: content.mimeType,
      status: response.status,
      statusText: response.statusText,
      startTime: Date.parse(entry.startedDateTime) || Date.now(),
      duration: Number(entry.time) || 0,
      endTime: (Date.parse(entry.startedDateTime) || Date.now()) + (Number(entry.time) || 0),
      size: Number(content.size ?? response.bodySize) || null,
      type: 'har',
      tabId,
    }, 'har');
  }).filter(Boolean);
  if (imported.length) {
    persist();
    broadcastUpdate();
  }
  return imported;
}

function replayableBody(body, encoding) {
  if (typeof body !== 'string') return body;
  if (encoding !== 'base64') return body;
  try {
    const binary = atob(body);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch {
    return body;
  }
}

async function performReplay(req, options = {}) {
  const method = validRequestMethod(options.method || req.method);
  const fetchOptions = {
    method,
    headers: replayHeaders(options.headers || req.replayHeaders || req.requestHeaders),
  };
  const sourceBody = options.body !== undefined ? options.body : (req.replayBody ?? req.requestBody);
  if (sourceBody !== undefined && sourceBody !== null && !['GET', 'HEAD'].includes(method)) {
    fetchOptions.body = replayableBody(sourceBody, req.bodyEncoding);
  }
  const response = await fetch(req.url, fetchOptions);
  const body = (await response.text()).slice(0, MAX_CAPTURE_BODY_CHARS);
  return {
    ok: true,
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    body,
  };
}

function normalizeAssertions(assertions = {}) {
  const jsonChecks = Array.isArray(assertions.jsonChecks) ? assertions.jsonChecks.slice(0, 20).map(check => ({
    path: String(check.path || '').slice(0, 200),
    expected: String(check.expected ?? '').slice(0, 500),
  })).filter(check => check.path) : [];
  const status = Number.parseInt(assertions.status, 10);
  const maxDurationMs = Number.parseInt(assertions.maxDurationMs, 10);
  return {
    status: Number.isInteger(status) ? status : null,
    maxDurationMs: Number.isInteger(maxDurationMs) && maxDurationMs >= 0 ? maxDurationMs : null,
    jsonChecks,
  };
}

function readJsonPath(value, path) {
  const normalized = String(path || '').replace(/^\$\.?/, '');
  if (!normalized) return value;
  return normalized.split('.').reduce((current, key) => {
    const match = key.match(/^([^[]+)(?:\[(\d+)\])?$/);
    if (!match || current === null || current === undefined) return undefined;
    const next = current[match[1]];
    return match[2] === undefined ? next : next?.[Number(match[2])];
  }, value);
}

function evaluateAssertions(result, assertions, elapsedMs) {
  const normalized = normalizeAssertions(assertions);
  const failures = [];
  if (normalized.status !== null && result.status !== normalized.status) {
    failures.push(`状态码应为 ${normalized.status}，实际为 ${result.status}`);
  }
  if (normalized.maxDurationMs !== null && elapsedMs > normalized.maxDurationMs) {
    failures.push(`耗时超过 ${normalized.maxDurationMs}ms`);
  }
  let json = null;
  if (normalized.jsonChecks.length) {
    try { json = JSON.parse(result.body || ''); } catch { failures.push('响应不是有效 JSON'); }
  }
  normalized.jsonChecks.forEach(check => {
    if (json === null) return;
    const actual = readJsonPath(json, check.path);
    let expected = check.expected;
    try { expected = JSON.parse(expected); } catch {}
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failures.push(`${check.path} 应为 ${check.expected}`);
    }
  });
  return { passed: failures.length === 0, failures };
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
    if (typeof msg.data.captureId !== 'string' || typeof msg.data.url !== 'string' ||
      msg.data.captureId.length > 256 || msg.data.url.length > MAX_CAPTURE_URL_LENGTH) {
      sendResponse(null);
      return;
    }

    // 检查是否有匹配的 Mock 规则
    const rawData = msg.data;
    const data = sanitizeData(rawData);
    const mockResponse = rawData.allowMock === false ? null : getMockResponse(
      rawData.url, rawData.method, rawData.requestHeaders, rawData.requestBody
    );
    const method = validRequestMethod(data.method);
    const type = ['fetch', 'xhr', 'eventsource', 'beacon'].includes(data.type) ? data.type : 'xhr';
    const networkRecord = findNetworkRecordForCapture(data, sender);
    const existingEntry = networkRecord?.entryId ? requests.find(item => item.id === networkRecord.entryId) : null;
    const entry = existingEntry || {
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
      type,
      tabId: sender.tab.id,
      frameId: sender.frameId,
      starred: false,
      tags: [],
      isMocked: !!mockResponse,
      graphql: detectGraphQL(data.url, data.requestHeaders, data.requestBody),
    };
  if (existingEntry) {
      Object.assign(existingEntry, {
        captureId: data.captureId,
        url: data.url,
        method,
        requestHeaders: data.requestHeaders || existingEntry.requestHeaders || {},
        requestBody: data.requestBody || null,
        type,
        tabId: sender.tab.id,
        frameId: sender.frameId,
        isMocked: !!mockResponse,
      });
      attachNetworkRecord(existingEntry, networkRecord);
      networkRecord.captured = true;
    }
    Object.defineProperties(entry, {
      replayHeaders: {
        value: limitHeaders(rawData.requestHeaders || {}),
        enumerable: false,
        configurable: false,
      },
      replayBody: {
        value: typeof rawData.requestBody === 'string' ? rawData.requestBody.slice(0, MAX_CAPTURE_BODY_CHARS) : null,
        enumerable: false,
        configurable: false,
      },
    });
    if (!existingEntry) requests.push(entry);
    if (requests.length > MAX_REQUESTS) {
      requests = requests.slice(-MAX_REQUESTS);
    }

    // 如果有 Mock 规则，立即返回 mock 响应
    if (mockResponse) {
      entry.status = mockResponse.error ? 0 : mockResponse.status;
      entry.statusText = mockResponse.error || 'Mocked';
      entry.responseHeaders = mockResponse.headers || {};
      entry.responseBody = mockResponse.body || null;
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
      entry.bodyEncoding = data.bodyEncoding;
      entry.bodyMimeType = data.bodyMimeType;
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

  if (msg.type === 'NET_STREAM_CHUNK') {
    const data = sanitizeData(msg.data);
    const entry = findCapturedRequest(data, sender);
    if (entry && !entry.isMocked) {
      if (!Array.isArray(entry.streamChunks)) entry.streamChunks = [];
      const chunk = String(data.body ?? data.data ?? '').slice(0, MAX_CAPTURE_BODY_CHARS);
      const used = entry.streamChunks.reduce((sum, item) => sum + String(item.data || '').length, 0);
      if (used < MAX_CAPTURE_BODY_CHARS) {
        entry.streamChunks.push({
          data: chunk.slice(0, MAX_CAPTURE_BODY_CHARS - used),
          timestamp: Number(data.timestamp) || Date.now(),
          eventType: String(data.eventType || 'message').slice(0, 40),
          lastEventId: String(data.lastEventId || '').slice(0, 200),
        });
        entry.responseBody = entry.streamChunks.map(item => item.data).join('\n');
        entry.bodyMimeType = data.bodyMimeType || entry.bodyMimeType || 'text/event-stream';
        entry.size = byteLength(entry.responseBody);
      }
      entry.streamOpen = true;
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
      const safeData = sanitizeData(msg.data);
      const rawData = String(safeData.data ?? '');
      conn.messages.push({
        direction: msg.data.direction,
        type: msg.data.messageType === 'binary' ? 'binary' : 'text',
        data: rawData.slice(0, MAX_WS_MESSAGE_CHARS),
        truncated: rawData.length > MAX_WS_MESSAGE_CHARS,
        encoding: msg.data.dataEncoding || null,
        size: Number(msg.data.dataSize) || (msg.data.messageType === 'binary' ? null : rawData.length),
        hex: typeof msg.data.dataHex === 'string' ? msg.data.dataHex.slice(0, 1024) : null,
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

  if (msg.type === 'REPLAY_WS') {
    const conn = wsConnections.get(String(msg.data?.id || ''));
    if (!conn || !Number.isInteger(conn.tabId) || !chrome.tabs?.sendMessage) {
      sendResponse({ error: 'WebSocket 不存在或已脱离页面' });
      return true;
    }
    chrome.tabs.sendMessage(conn.tabId, {
      type: 'WS_REPLAY',
      data: { id: conn.id, data: String(msg.data?.data ?? '').slice(0, MAX_WS_MESSAGE_CHARS) },
    }, { frameId: conn.frameId }).then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }

  // ============ 请求重放 ============

  if (msg.type === 'REPLAY_REQUEST') {
    const req = requests.find(r => r.id === msg.data.id);
    if (!req) {
      sendResponse({ error: '请求不存在' });
      return true;
    }
    performReplay(req, msg.data.options || {})
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true; // 异步响应
  }

  if (msg.type === 'REPLAY_BATCH') {
    const ids = Array.isArray(msg.data?.ids) ? msg.data.ids.slice(0, 50) : [];
    const selected = ids.map(id => requests.find(request => request.id === id)).filter(Boolean);
    (async () => {
      const results = [];
      for (const req of selected) {
        try {
          results.push({ id: req.id, url: req.url, ...(await performReplay(req, msg.data.options || {})) });
        } catch (error) {
          results.push({ id: req.id, url: req.url, error: error.message });
        }
      }
      return { ok: true, results };
    })().then(sendResponse).catch(error => sendResponse({ error: error.message }));
    return true;
  }

  if (msg.type === 'UPDATE_ASSERTIONS') {
    const req = requests.find(item => item.id === msg.data?.id);
    if (req) {
      req.assertions = normalizeAssertions(msg.data.assertions);
      persist();
      broadcastUpdate();
    }
    sendResponse({ ok: !!req, assertions: req?.assertions || null });
    return true;
  }

  if (msg.type === 'GET_SCENARIOS') {
    sendResponse({ scenarios });
    return true;
  }

  if (msg.type === 'SAVE_SCENARIO') {
    const ids = Array.isArray(msg.data?.ids) ? msg.data.ids.slice(0, 20) : [];
    const steps = ids.map(id => requests.find(request => request.id === id)).filter(Boolean)
      .map(request => ({ id: request.id, assertions: normalizeAssertions(request.assertions) }));
    if (!steps.length) {
      sendResponse({ error: '请先选择至少一个请求' });
      return true;
    }
    scenarios.push({
      id: Date.now(),
      name: String(msg.data?.name || '未命名场景').trim().slice(0, 100) || '未命名场景',
      createdAt: Date.now(),
      steps,
    });
    scenarios = scenarios.slice(-50);
    persist();
    sendResponse({ ok: true, scenarios });
    return true;
  }

  if (msg.type === 'DELETE_SCENARIO') {
    scenarios = scenarios.filter(scenario => scenario.id !== msg.data?.id);
    persist();
    sendResponse({ ok: true, scenarios });
    return true;
  }

  if (msg.type === 'RUN_SCENARIO') {
    const scenario = scenarios.find(item => item.id === msg.data?.id);
    if (!scenario) {
      sendResponse({ error: '测试场景不存在' });
      return true;
    }
    (async () => {
      const results = [];
      for (const step of scenario.steps) {
        const req = requests.find(request => request.id === step.id);
        if (!req) {
          results.push({ id: step.id, passed: false, failures: ['请求已不存在'] });
          continue;
        }
        const started = Date.now();
        try {
          const replay = await performReplay(req);
          results.push({ id: req.id, url: req.url, status: replay.status, ...evaluateAssertions(replay, step.assertions, Date.now() - started) });
        } catch (error) {
          results.push({ id: req.id, url: req.url, passed: false, failures: [error.message] });
        }
      }
      return { ok: true, scenarioId: scenario.id, results };
    })().then(sendResponse).catch(error => sendResponse({ error: error.message }));
    return true;
  }

  if (msg.type === 'IMPORT_HAR') {
    const imported = importHar(msg.data?.har, msg.data?.tabId);
    sendResponse({ ok: true, count: imported.length, ids: imported.map(item => item.id) });
    return true;
  }

  if (msg.type === 'IMPORT_REQUESTS') {
    const imported = Array.isArray(msg.data?.requests) ? msg.data.requests.slice(0, 200)
      .map(item => addImportedRequest({ ...item, tabId: msg.data?.tabId }, 'import')).filter(Boolean) : [];
    if (imported.length) {
      persist();
      broadcastUpdate();
    }
    sendResponse({ ok: true, count: imported.length, ids: imported.map(item => item.id) });
    return true;
  }

  // ============ Mock 规则管理 ============

  if (msg.type === 'GET_MOCK_RULES') {
    sendResponse({ rules: mockRules });
    return true;
  }

  if (msg.type === 'ADD_MOCK_RULE') {
    mockRules.push({ id: Date.now(), ...normalizeMockRuleInput(msg.data || {}) });
    persist();
    broadcastUpdate();
    broadcastCaptureConfig();
    sendResponse({ ok: true, rules: mockRules });
    return true;
  }

  if (msg.type === 'UPDATE_MOCK_RULE') {
    const rule = mockRules.find(r => r.id === msg.data.id);
    if (rule) {
      Object.assign(rule, normalizeMockRuleInput(msg.data || {}, rule));
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

  if (msg.type === 'CREATE_SESSION') {
    createSession(msg.data?.name).then(sendResponse).catch(error => sendResponse({ error: error.message }));
    return true;
  }

  if (msg.type === 'SWITCH_SESSION') {
    switchSession(String(msg.data?.id || '')).then(sendResponse).catch(error => sendResponse({ error: error.message }));
    return true;
  }

  if (msg.type === 'DELETE_SESSION') {
    deleteSession(String(msg.data?.id || '')).then(sendResponse).catch(error => sendResponse({ error: error.message }));
    return true;
  }

  // ============ 通用操作 ============

  if (msg.type === 'GET_REQUESTS') {
    const tabId = Number.isInteger(msg.data?.tabId) ? msg.data.tabId : null;
    const visibleRequests = tabId === null ? requests : requests.filter(request => request.tabId === tabId);
    const visibleWs = tabId === null ? Array.from(wsConnections.values()) :
      Array.from(wsConnections.values()).filter(connection => connection.tabId === tabId);
    sendResponse({
      requests: visibleRequests.map(publicRequest),
      wsConnections: visibleWs,
      isCapturing,
      mockRules,
      scenarios,
      storageError,
      sessions,
      activeSessionId,
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
      clearCaptureState();
    } else {
      requests = requests.filter(request => request.tabId !== tabId);
      for (const [id, connection] of wsConnections) {
        if (connection.tabId === tabId) wsConnections.delete(id);
      }
      for (const [id, record] of networkRecords) {
        if (record.tabId === tabId) networkRecords.delete(id);
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

  if (msg.type === 'EXPORT_OPENAPI') {
    const tabId = Number.isInteger(msg.data?.tabId) ? msg.data.tabId : null;
    const exportRequests = tabId === null ? requests : requests.filter(request => request.tabId === tabId);
    sendResponse({ openapi: generateOpenAPI(exportRequests) });
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

registerWebRequestListeners();

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
      httpVersion: 'unknown',
      headers: Object.entries(r.requestHeaders).map(([name, value]) => ({ name, value })),
      queryString: (() => {
        try {
          return Array.from(new URL(r.url).searchParams, ([name, value]) => ({ name, value }));
        } catch { return []; }
      })(),
      headersSize: -1,
      bodySize: r.requestBody ? byteLength(r.requestBody) : 0,
      postData: r.requestBody ? {
        mimeType: r.requestHeaders['content-type'] || r.requestHeaders['Content-Type'] || 'text/plain',
        text: r.requestBody,
      } : undefined,
    },
    response: {
      status: r.status,
      statusText: r.statusText,
      httpVersion: 'unknown',
      headers: Object.entries(r.responseHeaders).map(([name, value]) => ({ name, value })),
      content: {
        size: r.size || 0,
        mimeType: r.responseHeaders['content-type'] || 'text/plain',
        text: r.responseBody || '',
        ...(r.bodyEncoding ? { encoding: r.bodyEncoding } : {}),
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

function generateOpenAPI(capturedRequests) {
  const paths = {};
  const servers = new Map();
  capturedRequests.filter(request => request.url).forEach(request => {
    let parsed;
    try { parsed = new URL(request.url); } catch { return; }
    const path = parsed.pathname || '/';
    servers.set(parsed.origin, true);
    const method = String(request.method || 'GET').toLowerCase();
    if (!/^[a-z]+$/.test(method)) return;
    if (!paths[path]) paths[path] = {};
    const responseStatus = String(Number.isFinite(request.status) && request.status > 0 ? request.status : 200);
    const operation = paths[path][method] || {
      summary: `${method.toUpperCase()} ${path}`,
      parameters: [],
      responses: {},
    };
    if (parsed.search) {
      for (const [name] of parsed.searchParams) {
        if (!operation.parameters.some(parameter => parameter.name === name)) {
          operation.parameters.push({ name, in: 'query', required: false, schema: { type: 'string' } });
        }
      }
    }
    if (request.requestBody && !['get', 'head'].includes(method)) {
      const mimeType = request.requestHeaders?.['content-type'] || request.requestHeaders?.['Content-Type'] || 'text/plain';
      operation.requestBody = {
        required: true,
        content: { [String(mimeType).split(';', 1)[0]]: { schema: { type: 'object' }, example: request.requestBody } },
      };
    }
    operation.responses[responseStatus] = {
      description: request.statusText || 'Captured response',
      content: request.responseBody ? {
        [request.responseHeaders?.['content-type'] || 'application/json']: {
          schema: { type: 'object' },
        },
      } : undefined,
    };
    paths[path][method] = operation;
  });
  return {
    openapi: '3.0.3',
    info: { title: 'NetCatcher Capture', version: '1.0.0' },
    servers: Array.from(servers.keys()).map(url => ({ url })),
    paths,
  };
}
