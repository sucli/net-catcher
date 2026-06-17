// NetCatcher - Popup Script
// 负责展示请求列表、WebSocket连接、过滤、查看详情、导出、统计

let allRequests = [];
let allWsConnections = [];
let isCapturing = true;
let selectedId = null;
let selectedWsId = null;
let autoScroll = true;
let currentView = 'http'; // 'http' or 'ws'

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(['nc_autoScroll'], (data) => {
    if (data.nc_autoScroll !== undefined) autoScroll = data.nc_autoScroll;
    document.getElementById('chk-auto-scroll').checked = autoScroll;
  });

  loadRequests();
  bindEvents();
});

// 加载请求数据
function loadRequests() {
  chrome.runtime.sendMessage({ type: 'GET_REQUESTS' }, (res) => {
    if (chrome.runtime.lastError) return;
    if (res) {
      allRequests = res.requests || [];
      allWsConnections = res.wsConnections || [];
      isCapturing = res.isCapturing;
      updateToggleButton();
      updateCounts();
      if (currentView === 'http') {
        renderRequests();
        updateStats();
      } else {
        renderWsConnections();
      }
    }
  });
}

// 绑定事件
function bindEvents() {
  // 视图切换
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentView = btn.dataset.view;
      document.getElementById('stats-bar').style.display = currentView === 'http' ? '' : 'none';
      document.getElementById('filter-bar').style.display = currentView === 'http' ? '' : 'none';
      document.getElementById('request-list').style.display = currentView === 'http' ? '' : 'none';
      document.getElementById('ws-list').style.display = currentView === 'ws' ? '' : 'none';
      if (currentView === 'http') {
        renderRequests();
        updateStats();
      } else {
        renderWsConnections();
      }
    });
  });

  // 暂停/恢复
  document.getElementById('btn-toggle').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'TOGGLE_CAPTURE' }, (res) => {
      if (res) {
        isCapturing = res.isCapturing;
        updateToggleButton();
      }
    });
  });

  // 清除
  document.getElementById('btn-clear').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'CLEAR_REQUESTS' }, () => {
      allRequests = [];
      allWsConnections = [];
      if (currentView === 'http') {
        renderRequests();
        updateStats();
      } else {
        renderWsConnections();
      }
      updateCounts();
    });
  });

  // 导出 HAR
  document.getElementById('btn-export').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'EXPORT_HAR' }, (res) => {
      if (res && res.har) {
        const blob = new Blob([JSON.stringify(res.har, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `netcatcher-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.har`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('HAR 文件已导出');
      }
    });
  });

  // 关闭详情
  document.getElementById('btn-close-detail').addEventListener('click', closeDetail);
  document.getElementById('detail-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('detail-overlay')) closeDetail();
  });

  // 关闭 WS 详情
  document.getElementById('btn-close-ws-detail').addEventListener('click', closeWsDetail);
  document.getElementById('ws-detail-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('ws-detail-overlay')) closeWsDetail();
  });

  // 导出 WS 消息
  document.getElementById('btn-ws-export').addEventListener('click', exportWsMessages);

  // 复制 cURL
  document.getElementById('btn-curl').addEventListener('click', () => {
    if (selectedId) {
      const curl = generateCurl(allRequests.find(r => r.id === selectedId));
      navigator.clipboard.writeText(curl).then(() => {
        showToast('已复制 cURL 命令');
      });
    }
  });

  // Tab 切换
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(tab.dataset.tab).classList.add('active');
    });
  });

  // 过滤
  document.getElementById('filter-url').addEventListener('input', renderRequests);
  document.getElementById('filter-method').addEventListener('change', renderRequests);
  document.getElementById('filter-status').addEventListener('change', renderRequests);
  document.getElementById('filter-sort').addEventListener('change', renderRequests);

  // 自动滚动
  document.getElementById('chk-auto-scroll').addEventListener('change', (e) => {
    autoScroll = e.target.checked;
    chrome.storage.local.set({ nc_autoScroll: autoScroll });
  });

  // 键盘快捷键
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (document.getElementById('detail-overlay').style.display !== 'none') {
        closeDetail();
        return;
      }
      if (document.getElementById('ws-detail-overlay').style.display !== 'none') {
        closeWsDetail();
        return;
      }
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (currentView === 'http') navigateRequests(e.key === 'ArrowDown' ? 1 : -1);
    }
    if (e.key === 'Enter' && selectedId) {
      showDetail(selectedId);
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'c' && selectedId) {
      const sel = window.getSelection();
      if (!sel || sel.toString().length === 0) {
        const curl = generateCurl(allRequests.find(r => r.id === selectedId));
        navigator.clipboard.writeText(curl).then(() => {
          showToast('已复制 cURL 命令');
        });
      }
    }
  });

  // 监听更新
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'REQUESTS_UPDATED') {
      loadRequests();
    }
  });
}

// 更新计数
function updateCounts() {
  document.getElementById('http-count').textContent = allRequests.length;
  document.getElementById('ws-count').textContent = allWsConnections.length;
}

// 键盘导航
function navigateRequests(direction) {
  const items = document.querySelectorAll('.request-item');
  if (items.length === 0) return;

  const ids = Array.from(items).map(i => parseInt(i.dataset.id));
  let idx = ids.indexOf(selectedId);
  idx += direction;
  if (idx < 0) idx = 0;
  if (idx >= ids.length) idx = ids.length - 1;

  selectedId = ids[idx];
  document.querySelectorAll('.request-item').forEach(i => i.classList.remove('selected'));
  items[idx].classList.add('selected');
  items[idx].scrollIntoView({ block: 'nearest' });
}

function closeDetail() {
  document.getElementById('detail-overlay').style.display = 'none';
}

function closeWsDetail() {
  document.getElementById('ws-detail-overlay').style.display = 'none';
  selectedWsId = null;
}

function updateToggleButton() {
  const btn = document.getElementById('btn-toggle');
  if (isCapturing) {
    btn.textContent = '⏸ 暂停';
    btn.className = 'btn btn-green';
  } else {
    btn.textContent = '▶ 恢复';
    btn.className = 'btn btn-yellow';
  }
}

// 更新统计
function updateStats() {
  let total = allRequests.length;
  let s2 = 0, s3 = 0, s4 = 0, s5 = 0, err = 0, totalTime = 0, timeCount = 0;

  allRequests.forEach(r => {
    if (r.status === 0 || r.status === null) { err++; return; }
    if (r.status >= 200 && r.status < 300) s2++;
    else if (r.status >= 300 && r.status < 400) s3++;
    else if (r.status >= 400 && r.status < 500) s4++;
    else if (r.status >= 500) s5++;
    if (r.duration) { totalTime += r.duration; timeCount++; }
  });

  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-2xx').textContent = s2;
  document.getElementById('stat-3xx').textContent = s3;
  document.getElementById('stat-4xx').textContent = s4;
  document.getElementById('stat-5xx').textContent = s5;
  document.getElementById('stat-err').textContent = err;
  document.getElementById('stat-avg-time').textContent = timeCount > 0 ? Math.round(totalTime / timeCount) + 'ms' : '-';
}

// 渲染请求列表
function renderRequests() {
  const list = document.getElementById('request-list');
  const empty = document.getElementById('empty-state');
  const filtered = filterAndSortRequests(allRequests);

  document.getElementById('count').textContent = `${filtered.length} 条请求`;

  if (filtered.length === 0) {
    const items = list.querySelectorAll('.request-item');
    items.forEach(item => item.remove());
    empty.style.display = 'flex';
    return;
  }

  empty.style.display = 'none';
  const html = filtered.map(r => {
    const methodClass = `method-${r.method}`;
    const statusClass = r.status ? getStatusClass(r.status) : 'status-0';
    const statusText = r.status || '---';
    const duration = r.duration ? `${Math.round(r.duration)}ms` : '...';
    const size = r.size ? formatSize(r.size) : '...';
    const shortUrl = getShortUrl(r.url);
    const selected = r.id === selectedId ? ' selected' : '';

    return `<div class="request-item${selected}" data-id="${r.id}">
      <span class="req-method ${methodClass}">${r.method}</span>
      <span class="req-url" title="${escapeHtml(r.url)}">${escapeHtml(shortUrl)}</span>
      <span class="req-status ${statusClass}">${statusText}</span>
      <span class="req-duration">${duration}</span>
      <span class="req-size">${size}</span>
    </div>`;
  }).join('');

  list.innerHTML = html;

  list.querySelectorAll('.request-item').forEach(item => {
    item.addEventListener('click', () => {
      const id = parseInt(item.dataset.id);
      selectedId = id;
      document.querySelectorAll('.request-item').forEach(i => i.classList.remove('selected'));
      item.classList.add('selected');
      showDetail(id);
    });
  });

  if (autoScroll) {
    requestAnimationFrame(() => {
      list.scrollTop = list.scrollHeight;
    });
  }
}

// 渲染 WebSocket 连接列表
function renderWsConnections() {
  const list = document.getElementById('ws-list');
  const empty = document.getElementById('ws-empty-state');

  document.getElementById('count').textContent = `${allWsConnections.length} 个连接`;

  if (allWsConnections.length === 0) {
    list.querySelectorAll('.ws-item').forEach(item => item.remove());
    empty.style.display = 'flex';
    return;
  }

  empty.style.display = 'none';
  const html = allWsConnections.map(conn => {
    const statusClass = conn.status === 'open' ? 'ws-open' : (conn.status === 'error' ? 'ws-error' : 'ws-closed');
    const statusText = conn.status === 'open' ? '已连接' : (conn.status === 'error' ? '错误' : '已关闭');
    const shortUrl = getShortUrl(conn.url);
    const duration = conn.duration ? formatDuration(conn.duration) : (conn.status === 'open' ? '运行中' : '...');
    const msgCount = conn.messageCount ? (conn.messageCount.send + conn.messageCount.receive) : conn.messages.length;

    return `<div class="ws-item" data-id="${conn.id}">
      <span class="ws-status ${statusClass}">${statusText}</span>
      <span class="ws-url" title="${escapeHtml(conn.url)}">${escapeHtml(shortUrl)}</span>
      <span class="ws-messages">📨 ${msgCount}</span>
      <span class="ws-duration">${duration}</span>
    </div>`;
  }).join('');

  list.innerHTML = html;

  list.querySelectorAll('.ws-item').forEach(item => {
    item.addEventListener('click', () => {
      const id = parseInt(item.dataset.id);
      selectedWsId = id;
      document.querySelectorAll('.ws-item').forEach(i => i.classList.remove('selected'));
      item.classList.add('selected');
      showWsDetail(id);
    });
  });
}

// 显示 WebSocket 详情
function showWsDetail(id) {
  const conn = allWsConnections.find(c => c.id === id);
  if (!conn) return;

  selectedWsId = id;
  document.getElementById('ws-detail-title').textContent = `WebSocket: ${getShortUrl(conn.url)}`;

  // 连接信息
  let infoHtml = '<table class="header-table">';
  infoHtml += `<tr><td>URL</td><td>${escapeHtml(conn.url)}</td></tr>`;
  infoHtml += `<tr><td>状态</td><td><span class="ws-status ${conn.status === 'open' ? 'ws-open' : (conn.status === 'error' ? 'ws-error' : 'ws-closed')}">${conn.status}</span></td></tr>`;
  if (conn.protocols) infoHtml += `<tr><td>协议</td><td>${escapeHtml(conn.protocols)}</td></tr>`;
  if (conn.closeCode) infoHtml += `<tr><td>关闭代码</td><td>${conn.closeCode}</td></tr>`;
  if (conn.closeReason) infoHtml += `<tr><td>关闭原因</td><td>${escapeHtml(conn.closeReason)}</td></tr>`;
  infoHtml += `<tr><td>消息数</td><td>发送: ${conn.messageCount.send}, 接收: ${conn.messageCount.receive}</td></tr>`;
  infoHtml += '</table>';
  document.getElementById('ws-info').innerHTML = infoHtml;

  // 消息列表
  const messages = conn.messages || [];
  let msgHtml = '';
  messages.forEach((msg, idx) => {
    const dirClass = msg.direction === 'send' ? 'ws-msg-send' : 'ws-msg-receive';
    const dirIcon = msg.direction === 'send' ? '↑' : '↓';
    const time = formatTimestamp(msg.timestamp);
    let data = msg.data;
    // 尝试格式化 JSON
    try {
      const obj = JSON.parse(data);
      data = JSON.stringify(obj, null, 2);
    } catch {}

    msgHtml += `<div class="ws-message ${dirClass}">
      <div class="ws-msg-header">
        <span class="ws-msg-dir">${dirIcon} ${msg.direction === 'send' ? '发送' : '接收'}</span>
        <span class="ws-msg-type">${msg.type}</span>
        <span class="ws-msg-time">${time}</span>
      </div>
      <div class="ws-msg-data"><pre>${escapeHtml(data)}</pre></div>
    </div>`;
  });

  if (messages.length === 0) {
    msgHtml = '<div class="ws-no-messages">暂无消息</div>';
  }

  document.getElementById('ws-messages').innerHTML = msgHtml;
  document.getElementById('ws-detail-overlay').style.display = 'flex';

  // 滚动到底部
  const container = document.getElementById('ws-messages');
  container.scrollTop = container.scrollHeight;
}

// 导出 WebSocket 消息
function exportWsMessages() {
  const conn = allWsConnections.find(c => c.id === selectedWsId);
  if (!conn) return;

  const data = {
    url: conn.url,
    status: conn.status,
    protocols: conn.protocols,
    startTime: new Date(conn.startTime).toISOString(),
    endTime: conn.endTime ? new Date(conn.endTime).toISOString() : null,
    messages: conn.messages.map(m => ({
      direction: m.direction,
      type: m.type,
      data: m.data,
      time: new Date(m.timestamp).toISOString(),
    })),
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `websocket-${getShortUrl(conn.url).replace(/[\/\\?<>\\:*|"]/g, '_')}-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('WebSocket 消息已导出');
}

// 过滤 + 排序
function filterAndSortRequests(requests) {
  const urlFilter = document.getElementById('filter-url').value.toLowerCase();
  const methodFilter = document.getElementById('filter-method').value;
  const statusFilter = document.getElementById('filter-status').value;
  const sort = document.getElementById('filter-sort').value;

  let result = requests.filter(r => {
    if (urlFilter && !r.url.toLowerCase().includes(urlFilter)) return false;
    if (methodFilter && r.method !== methodFilter) return false;
    if (statusFilter) {
      if (statusFilter === '0') {
        if (r.status !== 0 && r.status !== null) return false;
      } else if (statusFilter === '2xx') {
        if (!(r.status >= 200 && r.status < 300)) return false;
      } else if (statusFilter === '3xx') {
        if (!(r.status >= 300 && r.status < 400)) return false;
      } else if (statusFilter === '4xx') {
        if (!(r.status >= 400 && r.status < 500)) return false;
      } else if (statusFilter === '5xx') {
        if (!(r.status >= 500 && r.status < 600)) return false;
      }
    }
    return true;
  });

  result.sort((a, b) => {
    switch (sort) {
      case 'time-asc': return a.startTime - b.startTime;
      case 'time-desc': return b.startTime - a.startTime;
      case 'duration-asc': return (a.duration || 0) - (b.duration || 0);
      case 'duration-desc': return (b.duration || 0) - (a.duration || 0);
      case 'size-asc': return (a.size || 0) - (b.size || 0);
      case 'size-desc': return (b.size || 0) - (a.size || 0);
      default: return b.startTime - a.startTime;
    }
  });

  return result;
}

// 生成 cURL 命令
function generateCurl(r) {
  if (!r) return '';
  let parts = [`curl -X ${r.method}`];

  parts.push(`'${r.url}'`);

  if (r.requestHeaders) {
    for (const [k, v] of Object.entries(r.requestHeaders)) {
      const lower = k.toLowerCase();
      if (lower === 'host' || lower === 'connection' || lower === 'origin' || lower === 'referer') continue;
      parts.push(`-H '${k}: ${v}'`);
    }
  }

  if (r.requestBody && ['POST', 'PUT', 'PATCH'].includes(r.method)) {
    try {
      JSON.parse(r.requestBody);
      parts.push(`-H 'Content-Type: application/json'`);
      parts.push(`-d '${r.requestBody.replace(/'/g, "\\'")}'`);
    } catch {
      parts.push(`-d '${r.requestBody.replace(/'/g, "\\'")}'`);
    }
  }

  return parts.join(' \\\n  ');
}

// 显示详情
function showDetail(id) {
  const r = allRequests.find(x => x.id === id);
  if (!r) return;

  selectedId = id;
  document.getElementById('detail-title').textContent = `${r.method} ${getShortUrl(r.url)}`;

  let headersHtml = '';
  headersHtml += '<div class="header-section-title">常规信息</div>';
  headersHtml += `<table class="header-table">
    <tr><td>请求 URL</td><td>${escapeHtml(r.url)}</td></tr>
    <tr><td>请求方法</td><td>${r.method}</td></tr>
    <tr><td>状态码</td><td>${r.status || '---'} ${r.statusText || ''}</td></tr>
    <tr><td>耗时</td><td>${r.duration ? Math.round(r.duration) + 'ms' : '---'}</td></tr>
    <tr><td>大小</td><td>${r.size ? formatSize(r.size) : '---'}</td></tr>
  </table>`;

  const reqHeaders = r.requestHeaders || {};
  const reqKeys = Object.keys(reqHeaders);
  if (reqKeys.length > 0) {
    headersHtml += '<div class="header-section-title">请求头 (Request Headers)</div>';
    headersHtml += '<table class="header-table">';
    reqKeys.forEach(k => {
      headersHtml += `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(reqHeaders[k]))}</td></tr>`;
    });
    headersHtml += '</table>';
  }

  const resHeaders = r.responseHeaders || {};
  const resKeys = Object.keys(resHeaders);
  if (resKeys.length > 0) {
    headersHtml += '<div class="header-section-title">响应头 (Response Headers)</div>';
    headersHtml += '<table class="header-table">';
    resKeys.forEach(k => {
      headersHtml += `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(resHeaders[k]))}</td></tr>`;
    });
    headersHtml += '</table>';
  }

  document.getElementById('tab-headers').innerHTML = headersHtml;

  document.getElementById('tab-request').innerHTML = r.requestBody
    ? `<div class="body-content">${formatBody(r.requestBody)}</div>`
    : '<div class="no-data">无请求体</div>';

  document.getElementById('tab-response').innerHTML = r.responseBody
    ? `<div class="body-content">${formatBody(r.responseBody)}</div>`
    : '<div class="no-data">无响应体（等待响应或不支持捕获）</div>';

  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelector('.tab[data-tab="tab-headers"]').classList.add('active');
  document.getElementById('tab-headers').classList.add('active');

  document.getElementById('detail-overlay').style.display = 'flex';
}

// 格式化 body
function formatBody(body) {
  if (!body) return '<span class="no-data">无数据</span>';
  try {
    const obj = JSON.parse(body);
    return syntaxHighlight(JSON.stringify(obj, null, 2));
  } catch {
    return escapeHtml(body);
  }
}

// JSON 语法高亮
function syntaxHighlight(json) {
  return json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
      (match) => {
        let cls = 'json-number';
        if (/^"/.test(match)) {
          cls = /:$/.test(match) ? 'json-key' : 'json-string';
        } else if (/true|false/.test(match)) {
          cls = 'json-boolean';
        } else if (/null/.test(match)) {
          cls = 'json-null';
        }
        return `<span class="${cls}">${match}</span>`;
      });
}

// Toast 提示
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, 2000);
}

// 工具函数
function getStatusClass(status) {
  if (status >= 200 && status < 300) return 'status-2xx';
  if (status >= 300 && status < 400) return 'status-3xx';
  if (status >= 400 && status < 500) return 'status-4xx';
  if (status >= 500) return 'status-5xx';
  return 'status-0';
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatDuration(ms) {
  if (ms < 1000) return Math.round(ms) + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return Math.round(ms / 60000) + 'min';
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString() + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function getShortUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
