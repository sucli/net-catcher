// NetCatcher - Popup Script v2.0
// 功能：请求列表、WebSocket、时间线、Mock、重放、对比、分组、过滤器

let allRequests = [];
let allWsConnections = [];
let mockRules = [];
let isCapturing = true;
let selectedIds = new Set(); // 支持多选对比
let selectedWsId = null;
let autoScroll = true;
let currentView = 'http';
let groupByDomain = false;
let compareMode = false;

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(['nc_autoScroll', 'nc_groupByDomain'], (data) => {
    if (data.nc_autoScroll !== undefined) autoScroll = data.nc_autoScroll;
    if (data.nc_groupByDomain !== undefined) groupByDomain = data.nc_groupByDomain;
    document.getElementById('chk-auto-scroll').checked = autoScroll;
    document.getElementById('btn-group-toggle').classList.toggle('active', groupByDomain);
  });
  loadRequests();
  loadFilters();
  bindEvents();
});

// 加载请求数据
function loadRequests() {
  chrome.runtime.sendMessage({ type: 'GET_REQUESTS' }, (res) => {
    if (chrome.runtime.lastError) return;
    if (res) {
      allRequests = res.requests || [];
      allWsConnections = res.wsConnections || [];
      mockRules = res.mockRules || [];
      isCapturing = res.isCapturing;
      updateToggleButton();
      updateCounts();
      if (currentView === 'http') { renderRequests(); updateStats(); }
      else if (currentView === 'ws') renderWsConnections();
      else if (currentView === 'timeline') renderTimeline();
      else if (currentView === 'mock') renderMockRules();
    }
  });
}

// 加载过滤器
function loadFilters() {
  chrome.runtime.sendMessage({ type: 'GET_FILTERS' }, (res) => {
    if (res && res.filters) {
      const select = document.getElementById('saved-filters');
      select.innerHTML = '<option value="">过滤器...</option>';
      res.filters.forEach(f => {
        select.innerHTML += `<option value="${f.id}">${escapeHtml(f.name)}</option>`;
      });
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
      updateViewVisibility();
      if (currentView === 'http') { renderRequests(); updateStats(); }
      else if (currentView === 'ws') renderWsConnections();
      else if (currentView === 'timeline') renderTimeline();
      else if (currentView === 'mock') renderMockRules();
    });
  });

  // 更新视图可见性
  function updateViewVisibility() {
    document.getElementById('stats-bar').style.display = currentView === 'http' ? '' : 'none';
    document.getElementById('filter-bar').style.display = (currentView === 'http' || currentView === 'timeline') ? '' : 'none';
    document.getElementById('request-list').style.display = currentView === 'http' ? '' : 'none';
    document.getElementById('ws-list').style.display = currentView === 'ws' ? '' : 'none';
    document.getElementById('timeline-view').style.display = currentView === 'timeline' ? '' : 'none';
    document.getElementById('mock-view').style.display = currentView === 'mock' ? '' : 'none';
  }

  // 暂停/恢复
  document.getElementById('btn-toggle').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'TOGGLE_CAPTURE' }, (res) => {
      if (res) { isCapturing = res.isCapturing; updateToggleButton(); }
    });
  });

  // 清除
  document.getElementById('btn-clear').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'CLEAR_REQUESTS' }, () => {
      allRequests = []; allWsConnections = []; selectedIds.clear();
      if (currentView === 'http') { renderRequests(); updateStats(); }
      else if (currentView === 'ws') renderWsConnections();
      else if (currentView === 'timeline') renderTimeline();
      updateCounts();
    });
  });

  // 导出
  document.getElementById('btn-export').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'EXPORT_HAR' }, (res) => {
      if (res && res.har) {
        downloadFile(JSON.stringify(res.har, null, 2), 'application/json',
          `netcatcher-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.har`);
        showToast('HAR 文件已导出');
      }
    });
  });

  // 分组切换
  document.getElementById('btn-group-toggle').addEventListener('click', () => {
    groupByDomain = !groupByDomain;
    chrome.storage.local.set({ nc_groupByDomain: groupByDomain });
    document.getElementById('btn-group-toggle').classList.toggle('active', groupByDomain);
    renderRequests();
  });

  // 过滤器保存
  document.getElementById('btn-save-filter').addEventListener('click', () => {
    document.getElementById('save-filter-overlay').style.display = 'flex';
    document.getElementById('filter-name').value = '';
    document.getElementById('filter-name').focus();
  });

  document.getElementById('btn-confirm-save-filter').addEventListener('click', () => {
    const name = document.getElementById('filter-name').value.trim();
    if (!name) { showToast('请输入名称'); return; }
    const config = {
      url: document.getElementById('filter-url').value,
      method: document.getElementById('filter-method').value,
      status: document.getElementById('filter-status').value,
      type: document.getElementById('filter-type').value,
      sort: document.getElementById('filter-sort').value,
    };
    chrome.runtime.sendMessage({ type: 'SAVE_FILTER', data: { name, config } }, (res) => {
      if (res) { loadFilters(); showToast('过滤器已保存'); }
    });
    document.getElementById('save-filter-overlay').style.display = 'none';
  });

  document.getElementById('btn-close-save-filter').addEventListener('click', () => {
    document.getElementById('save-filter-overlay').style.display = 'none';
  });

  // 加载过滤器
  document.getElementById('saved-filters').addEventListener('change', (e) => {
    const id = parseInt(e.target.value);
    if (!id) return;
    chrome.runtime.sendMessage({ type: 'GET_FILTERS' }, (res) => {
      if (chrome.runtime.lastError || !res) return;
      const filter = res.filters.find(f => f.id === id);
      if (filter && filter.config) {
        document.getElementById('filter-url').value = filter.config.url || '';
        document.getElementById('filter-method').value = filter.config.method || '';
        document.getElementById('filter-status').value = filter.config.status || '';
        document.getElementById('filter-type').value = filter.config.type || '';
        document.getElementById('filter-sort').value = filter.config.sort || 'time-desc';
        renderRequests();
        showToast(`已加载: ${filter.name}`);
      }
    });
  });

  // 关闭面板
  document.getElementById('btn-close-detail').addEventListener('click', closeDetail);
  document.getElementById('detail-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('detail-overlay')) closeDetail();
  });
  document.getElementById('btn-close-ws-detail').addEventListener('click', closeWsDetail);
  document.getElementById('ws-detail-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('ws-detail-overlay')) closeWsDetail();
  });
  document.getElementById('btn-close-compare').addEventListener('click', () => {
    document.getElementById('compare-overlay').style.display = 'none';
  });
  document.getElementById('compare-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('compare-overlay')) {
      document.getElementById('compare-overlay').style.display = 'none';
    }
  });

  // 重放
  document.getElementById('btn-replay').addEventListener('click', replayRequest);

  // 收藏
  document.getElementById('btn-star').addEventListener('click', () => {
    const id = Array.from(selectedIds)[0];
    if (id) {
      chrome.runtime.sendMessage({ type: 'TOGGLE_STAR', data: { id } });
      showToast('已切换收藏状态');
    }
  });

  // 复制 cURL
  document.getElementById('btn-curl').addEventListener('click', () => {
    const id = Array.from(selectedIds)[0];
    if (id) {
      const curl = generateCurl(allRequests.find(r => r.id === id));
      navigator.clipboard.writeText(curl).then(() => showToast('已复制 cURL'));
    }
  });

  // 导出 WS
  document.getElementById('btn-ws-export').addEventListener('click', exportWsMessages);

  // Mock 规则管理
  document.getElementById('btn-add-mock').addEventListener('click', () => openMockEditor());
  document.getElementById('btn-save-mock').addEventListener('click', saveMockRule);
  document.getElementById('btn-close-mock-edit').addEventListener('click', () => {
    document.getElementById('mock-edit-overlay').style.display = 'none';
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
  ['filter-url', 'filter-method', 'filter-status', 'filter-type', 'filter-sort'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      if (currentView === 'http') renderRequests();
      else if (currentView === 'timeline') renderTimeline();
    });
  });

  // 自动滚动
  document.getElementById('chk-auto-scroll').addEventListener('change', (e) => {
    autoScroll = e.target.checked;
    chrome.storage.local.set({ nc_autoScroll: autoScroll });
  });

  // 键盘快捷键
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (document.getElementById('detail-overlay').style.display !== 'none') { closeDetail(); return; }
      if (document.getElementById('ws-detail-overlay').style.display !== 'none') { closeWsDetail(); return; }
      if (document.getElementById('compare-overlay').style.display !== 'none') {
        document.getElementById('compare-overlay').style.display = 'none'; return;
      }
    }
  });

  // 监听更新
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'REQUESTS_UPDATED') loadRequests();
  });
}

// ============ 请求重放 ============

function replayRequest() {
  const id = Array.from(selectedIds)[0];
  if (!id) return;

  const btn = document.getElementById('btn-replay');
  btn.textContent = '⏳ 重放中...';
  btn.disabled = true;

  chrome.runtime.sendMessage({ type: 'REPLAY_REQUEST', data: { id } }, (res) => {
    btn.textContent = '🔄 重放';
    btn.disabled = false;

    // 切换到重放结果 tab
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelector('.tab[data-tab="tab-replay-result"]').classList.add('active');
    document.getElementById('tab-replay-result').classList.add('active');

    if (res.error) {
      document.getElementById('tab-replay-result').innerHTML =
        `<div class="replay-error">❌ 错误: ${escapeHtml(res.error)}</div>`;
    } else {
      let html = '<div class="replay-result">';
      html += `<div class="replay-status ${res.status < 400 ? 'status-2xx' : 'status-5xx'}">${res.status} ${res.statusText}</div>`;
      html += '<div class="header-section-title">响应头</div>';
      html += '<table class="header-table">';
      Object.entries(res.headers || {}).forEach(([k, v]) => {
        html += `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`;
      });
      html += '</table>';
      html += '<div class="header-section-title">响应体</div>';
      html += `<div class="body-content">${formatBody(res.body)}</div>`;
      html += '</div>';
      document.getElementById('tab-replay-result').innerHTML = html;
    }
  });
}

// ============ 渲染 HTTP 请求列表 ============

function renderRequests() {
  const list = document.getElementById('request-list');
  const empty = document.getElementById('empty-state');
  const filtered = filterAndSortRequests(allRequests);

  document.getElementById('http-count').textContent = allRequests.length;

  if (filtered.length === 0) {
    list.querySelectorAll('.request-item, .request-group').forEach(el => el.remove());
    empty.style.display = 'flex';
    return;
  }

  empty.style.display = 'none';

  if (groupByDomain) {
    renderGroupedRequests(list, filtered);
  } else {
    renderFlatRequests(list, filtered);
  }

  if (autoScroll) {
    requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }
}

function renderFlatRequests(list, requests) {
  const html = requests.map(r => {
    const selected = selectedIds.has(r.id) ? ' selected' : '';
    const starred = r.starred ? ' ⭐' : '';
    const mocked = r.isMocked ? ' 🎭' : '';
    return `<div class="request-item${selected}" data-id="${r.id}">
      <span class="req-method method-${r.method}">${r.method}</span>
      <span class="req-url" title="${escapeHtml(r.url)}">${escapeHtml(getShortUrl(r.url))}${starred}${mocked}</span>
      <span class="req-status ${r.status ? getStatusClass(r.status) : 'status-0'}">${r.status || '---'}</span>
      <span class="req-duration">${r.duration ? Math.round(r.duration) + 'ms' : '...'}</span>
      <span class="req-size">${r.size ? formatSize(r.size) : '...'}</span>
    </div>`;
  }).join('');

  list.innerHTML = html;
  bindRequestClicks(list);
}

function renderGroupedRequests(list, requests) {
  const groups = {};
  requests.forEach(r => {
    try {
      const domain = new URL(r.url).hostname;
      if (!groups[domain]) groups[domain] = [];
      groups[domain].push(r);
    } catch {
      if (!groups['other']) groups['other'] = [];
      groups['other'].push(r);
    }
  });

  let html = '';
  Object.entries(groups).forEach(([domain, items]) => {
    html += `<div class="request-group">
      <div class="group-header" data-domain="${domain}">
        <span class="group-toggle">▶</span>
        <span class="group-domain">${escapeHtml(domain)}</span>
        <span class="group-count">${items.length} 个请求</span>
      </div>
      <div class="group-items" style="display:none">`;
    items.forEach(r => {
      const selected = selectedIds.has(r.id) ? ' selected' : '';
      html += `<div class="request-item${selected}" data-id="${r.id}">
        <span class="req-method method-${r.method}">${r.method}</span>
        <span class="req-url" title="${escapeHtml(r.url)}">${escapeHtml(getShortUrl(r.url))}</span>
        <span class="req-status ${r.status ? getStatusClass(r.status) : 'status-0'}">${r.status || '---'}</span>
        <span class="req-duration">${r.duration ? Math.round(r.duration) + 'ms' : '...'}</span>
      </div>`;
    });
    html += '</div></div>';
  });

  list.innerHTML = html;

  // 分组折叠
  list.querySelectorAll('.group-header').forEach(header => {
    header.addEventListener('click', () => {
      const items = header.nextElementSibling;
      const toggle = header.querySelector('.group-toggle');
      const isOpen = items.style.display !== 'none';
      items.style.display = isOpen ? 'none' : 'block';
      toggle.textContent = isOpen ? '▶' : '▼';
    });
  });

  bindRequestClicks(list);
}

function bindRequestClicks(list) {
  list.querySelectorAll('.request-item').forEach(item => {
    item.addEventListener('click', (e) => {
      const id = parseInt(item.dataset.id);

      if (e.ctrlKey || e.metaKey) {
        // 多选模式
        if (selectedIds.has(id)) selectedIds.delete(id);
        else selectedIds.add(id);
        item.classList.toggle('selected');

        // 选中 2 个时显示对比按钮
        if (selectedIds.size === 2) {
          showCompare();
        }
      } else {
        // 单选
        selectedIds.clear();
        selectedIds.add(id);
        list.querySelectorAll('.request-item').forEach(i => i.classList.remove('selected'));
        item.classList.add('selected');
        showDetail(id);
      }
    });
  });
}

// ============ 请求对比 ============

function showCompare() {
  const ids = Array.from(selectedIds);
  const r1 = allRequests.find(r => r.id === ids[0]);
  const r2 = allRequests.find(r => r.id === ids[1]);
  if (!r1 || !r2) return;

  let html = '<div class="compare-grid">';
  html += '<div class="compare-col"><div class="compare-col-header">请求 1</div>';
  html += buildCompareCard(r1);
  html += '</div>';
  html += '<div class="compare-col"><div class="compare-col-header">请求 2</div>';
  html += buildCompareCard(r2);
  html += '</div>';

  // 差异对比
  html += '<div class="compare-diff">';
  html += '<div class="header-section-title">主要差异</div>';
  html += '<table class="header-table">';
  html += `<tr><td>URL</td><td>${r1.url !== r2.url ? '❌ 不同' : '✅ 相同'}</td></tr>`;
  html += `<tr><td>方法</td><td>${r1.method !== r2.method ? '❌ 不同' : '✅ 相同'}</td></tr>`;
  html += `<tr><td>状态码</td><td>${r1.status !== r2.status ? '❌ 不同 (' + r1.status + ' vs ' + r2.status + ')' : '✅ 相同'}</td></tr>`;
  html += `<tr><td>耗时</td><td>${Math.round(r1.duration || 0)}ms vs ${Math.round(r2.duration || 0)}ms</td></tr>`;
  html += `<tr><td>大小</td><td>${formatSize(r1.size || 0)} vs ${formatSize(r2.size || 0)}</td></tr>`;
  html += '</table>';

  // Body diff
  if (r1.responseBody && r2.responseBody) {
    html += '<div class="header-section-title">响应体差异</div>';
    html += `<div class="diff-content">${generateDiff(r1.responseBody, r2.responseBody)}</div>`;
  }
  html += '</div>';

  html += '</div>';
  document.getElementById('compare-content').innerHTML = html;
  document.getElementById('compare-overlay').style.display = 'flex';
}

function buildCompareCard(r) {
  return `<table class="header-table">
    <tr><td>URL</td><td class="compare-url">${escapeHtml(getShortUrl(r.url))}</td></tr>
    <tr><td>方法</td><td>${r.method}</td></tr>
    <tr><td>状态</td><td class="${getStatusClass(r.status)}">${r.status || '---'}</td></tr>
    <tr><td>耗时</td><td>${r.duration ? Math.round(r.duration) + 'ms' : '---'}</td></tr>
    <tr><td>大小</td><td>${r.size ? formatSize(r.size) : '---'}</td></tr>
  </table>`;
}

function generateDiff(text1, text2) {
  const lines1 = text1.split('\n');
  const lines2 = text2.split('\n');
  let html = '';
  const maxLen = Math.max(lines1.length, lines2.length);

  for (let i = 0; i < maxLen; i++) {
    const l1 = lines1[i] || '';
    const l2 = lines2[i] || '';
    if (l1 === l2) {
      html += `<div class="diff-line diff-same">${escapeHtml(l1)}</div>`;
    } else {
      if (l1) html += `<div class="diff-line diff-removed">- ${escapeHtml(l1)}</div>`;
      if (l2) html += `<div class="diff-line diff-added">+ ${escapeHtml(l2)}</div>`;
    }
  }
  return html;
}

// ============ 时间线视图 ============

function renderTimeline() {
  const filtered = filterAndSortRequests(allRequests).filter(r => r.endTime);
  const container = document.getElementById('timeline-container');

  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">📊</div><div>暂无已完成的请求</div><div class="empty-hint">等待请求完成或刷新页面</div></div>';
    return;
  }

  const minTime = Math.min(...filtered.map(r => r.startTime));
  const maxTime = Math.max(...filtered.map(r => r.endTime));
  const totalDuration = maxTime - minTime || 1;

  let html = '<div class="timeline-header">';
  html += `<span class="timeline-label">0ms</span>`;
  html += `<span class="timeline-label">${Math.round(totalDuration)}ms</span>`;
  html += '</div>';
  html += '<div class="timeline-rows">';

  filtered.forEach((r, idx) => {
    const startPct = ((r.startTime - minTime) / totalDuration) * 100;
    const widthPct = r.duration ? Math.max(((r.duration) / totalDuration) * 100, 1) : 2;
    const statusClass = r.status ? getStatusClass(r.status) : 'status-0';
    const shortUrl = getShortUrl(r.url);

    html += `<div class="timeline-row" data-id="${r.id}" title="${r.method} ${r.url}\n${r.status || '---'} | ${r.duration ? Math.round(r.duration) + 'ms' : '...'}">
      <div class="timeline-label">${escapeHtml(shortUrl.slice(0, 30))}</div>
      <div class="timeline-bar-container">
        <div class="timeline-bar ${statusClass}" style="left:${startPct}%;width:${widthPct}%"></div>
      </div>
    </div>`;
  });

  html += '</div>';
  container.innerHTML = html;

  container.querySelectorAll('.timeline-row').forEach(row => {
    row.addEventListener('click', () => {
      const id = parseInt(row.dataset.id);
      selectedIds.clear();
      selectedIds.add(id);
      showDetail(id);
    });
  });
}

// ============ Mock 规则管理 ============

function renderMockRules() {
  const list = document.getElementById('mock-list');
  if (mockRules.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">🎭</div><div>暂无 Mock 规则</div><div class="empty-hint">点击上方按钮添加规则</div></div>';
    return;
  }

  list.innerHTML = mockRules.map(rule => `
    <div class="mock-item" data-id="${rule.id}">
      <div class="mock-item-header">
        <label class="mock-toggle">
          <input type="checkbox" ${rule.enabled ? 'checked' : ''} data-id="${rule.id}">
          <span class="mock-name">${escapeHtml(rule.name || rule.pattern)}</span>
        </label>
        <div class="mock-actions">
          <button class="btn btn-small mock-edit" data-id="${rule.id}">✏️</button>
          <button class="btn btn-small btn-red mock-delete" data-id="${rule.id}">🗑</button>
        </div>
      </div>
      <div class="mock-item-detail">
        <span class="mock-pattern">${rule.isRegex ? '🔤' : '📝'} ${escapeHtml(rule.pattern)}</span>
        <span class="mock-status">${rule.status}</span>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.mock-toggle input').forEach(input => {
    input.addEventListener('change', () => {
      chrome.runtime.sendMessage({ type: 'TOGGLE_MOCK_RULE', data: { id: parseInt(input.dataset.id) } });
    });
  });

  list.querySelectorAll('.mock-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const rule = mockRules.find(r => r.id === parseInt(btn.dataset.id));
      if (rule) openMockEditor(rule);
    });
  });

  list.querySelectorAll('.mock-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'DELETE_MOCK_RULE', data: { id: parseInt(btn.dataset.id) } }, () => {
        loadRequests();
        showToast('规则已删除');
      });
    });
  });
}

function openMockEditor(rule) {
  document.getElementById('mock-edit-title').textContent = rule ? '编辑 Mock 规则' : '添加 Mock 规则';
  document.getElementById('mock-name').value = rule?.name || '';
  document.getElementById('mock-pattern').value = rule?.pattern || '';
  document.getElementById('mock-is-regex').checked = rule?.isRegex || false;
  document.getElementById('mock-status').value = rule?.status || 200;
  document.getElementById('mock-headers').value = JSON.stringify(rule?.headers || { 'content-type': 'application/json' });
  document.getElementById('mock-body').value = rule?.body || '{"code":0,"data":{}}';
  document.getElementById('mock-edit-overlay').dataset.editId = rule?.id || '';
  document.getElementById('mock-edit-overlay').style.display = 'flex';
}

function saveMockRule() {
  const pattern = document.getElementById('mock-pattern').value.trim();
  if (!pattern) { showToast('请输入 URL 匹配规则'); return; }

  let headers = {};
  try { headers = JSON.parse(document.getElementById('mock-headers').value); } catch {}

  const data = {
    name: document.getElementById('mock-name').value.trim(),
    pattern,
    isRegex: document.getElementById('mock-is-regex').checked,
    status: parseInt(document.getElementById('mock-status').value) || 200,
    headers,
    body: document.getElementById('mock-body').value,
  };

  const editId = document.getElementById('mock-edit-overlay').dataset.editId;
  if (editId) {
    chrome.runtime.sendMessage({ type: 'UPDATE_MOCK_RULE', data: { id: parseInt(editId), ...data } }, () => {
      loadRequests();
      showToast('规则已更新');
    });
  } else {
    chrome.runtime.sendMessage({ type: 'ADD_MOCK_RULE', data }, () => {
      loadRequests();
      showToast('规则已添加');
    });
  }

  document.getElementById('mock-edit-overlay').style.display = 'none';
}

// ============ 详情面板 ============

function showDetail(id) {
  const r = allRequests.find(x => x.id === id);
  if (!r) return;

  selectedIds.clear();
  selectedIds.add(id);

  document.getElementById('detail-title').textContent = `${r.method} ${getShortUrl(r.url)}`;

  let headersHtml = '<div class="header-section-title">常规信息</div>';
  headersHtml += `<table class="header-table">
    <tr><td>请求 URL</td><td class="detail-url">${escapeHtml(r.url)}</td></tr>
    <tr><td>请求方法</td><td>${r.method}</td></tr>
    <tr><td>类型</td><td>${r.type}</td></tr>
    <tr><td>状态码</td><td class="${getStatusClass(r.status)}">${r.status || '---'} ${r.statusText || ''}</td></tr>
    <tr><td>耗时</td><td>${r.duration ? Math.round(r.duration) + 'ms' : '---'}</td></tr>
    <tr><td>大小</td><td>${r.size ? formatSize(r.size) : '---'}</td></tr>
  </table>`;

  const reqHeaders = r.requestHeaders || {};
  if (Object.keys(reqHeaders).length > 0) {
    headersHtml += '<div class="header-section-title">请求头</div><table class="header-table">';
    Object.entries(reqHeaders).forEach(([k, v]) => {
      headersHtml += `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`;
    });
    headersHtml += '</table>';
  }

  const resHeaders = r.responseHeaders || {};
  if (Object.keys(resHeaders).length > 0) {
    headersHtml += '<div class="header-section-title">响应头</div><table class="header-table">';
    Object.entries(resHeaders).forEach(([k, v]) => {
      headersHtml += `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`;
    });
    headersHtml += '</table>';
  }

  document.getElementById('tab-headers').innerHTML = headersHtml;
  document.getElementById('tab-request').innerHTML = r.requestBody ?
    `<div class="body-content">${formatBody(r.requestBody)}</div>` : '<div class="no-data">无请求体</div>';
  document.getElementById('tab-response').innerHTML = r.responseBody ?
    `<div class="body-content">${formatBody(r.responseBody)}</div>` : '<div class="no-data">无响应体</div>';

  // 响应预览
  renderPreview(r);

  document.getElementById('tab-replay-result').innerHTML = '<div class="no-data">点击「重放」按钮测试请求</div>';

  // 重置 tab
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelector('.tab[data-tab="tab-headers"]').classList.add('active');
  document.getElementById('tab-headers').classList.add('active');

  document.getElementById('detail-overlay').style.display = 'flex';
}

function renderPreview(r) {
  const preview = document.getElementById('tab-preview');
  if (!r.responseBody) {
    preview.innerHTML = '<div class="no-data">无响应数据</div>';
    return;
  }

  const contentType = (r.responseHeaders?.['content-type'] || '').toLowerCase();

  // JSON 预览
  if (contentType.includes('json') || r.responseBody.trim().startsWith('{') || r.responseBody.trim().startsWith('[')) {
    preview.innerHTML = `<div class="preview-json"><div class="body-content">${formatBody(r.responseBody)}</div></div>`;
    return;
  }

  // HTML 预览
  if (contentType.includes('html')) {
    preview.innerHTML = `<div class="preview-html"><iframe srcdoc="${escapeHtml(r.responseBody)}" sandbox="allow-same-origin"></iframe></div>`;
    return;
  }

  // 图片预览
  if (contentType.includes('image')) {
    preview.innerHTML = `<div class="preview-image"><img src="${r.url}" alt="预览" onerror="this.style.display='none';this.nextElementSibling.style.display='block'"><div class="no-data" style="display:none">图片加载失败</div></div>`;
    return;
  }

  // 文本预览
  preview.innerHTML = `<div class="body-content">${escapeHtml(r.responseBody)}</div>`;
}

// ============ WebSocket ============

function renderWsConnections() {
  const list = document.getElementById('ws-list');
  const empty = document.getElementById('ws-empty-state');
  document.getElementById('ws-count').textContent = allWsConnections.length;

  if (allWsConnections.length === 0) {
    list.querySelectorAll('.ws-item').forEach(el => el.remove());
    empty.style.display = 'flex';
    return;
  }

  empty.style.display = 'none';
  list.innerHTML = allWsConnections.map(conn => {
    const statusClass = conn.status === 'open' ? 'ws-open' : (conn.status === 'error' ? 'ws-error' : 'ws-closed');
    const msgCount = conn.messageCount ? (conn.messageCount.send + conn.messageCount.receive) : conn.messages.length;
    return `<div class="ws-item" data-id="${conn.id}">
      <span class="ws-status ${statusClass}">${conn.status === 'open' ? '已连接' : (conn.status === 'error' ? '错误' : '已关闭')}</span>
      <span class="ws-url" title="${escapeHtml(conn.url)}">${escapeHtml(getShortUrl(conn.url))}</span>
      <span class="ws-messages">📨 ${msgCount}</span>
      <span class="ws-duration">${conn.duration ? formatDuration(conn.duration) : (conn.status === 'open' ? '运行中' : '...')}</span>
    </div>`;
  }).join('');

  list.querySelectorAll('.ws-item').forEach(item => {
    item.addEventListener('click', () => {
      showWsDetail(parseInt(item.dataset.id));
    });
  });
}

function showWsDetail(id) {
  const conn = allWsConnections.find(c => c.id === id);
  if (!conn) return;
  selectedWsId = id;

  document.getElementById('ws-detail-title').textContent = `WebSocket: ${getShortUrl(conn.url)}`;

  let infoHtml = '<table class="header-table">';
  infoHtml += `<tr><td>URL</td><td>${escapeHtml(conn.url)}</td></tr>`;
  infoHtml += `<tr><td>状态</td><td><span class="ws-status ${conn.status === 'open' ? 'ws-open' : 'ws-closed'}">${conn.status}</span></td></tr>`;
  if (conn.protocols) infoHtml += `<tr><td>协议</td><td>${escapeHtml(conn.protocols)}</td></tr>`;
  if (conn.closeCode) infoHtml += `<tr><td>关闭代码</td><td>${conn.closeCode}</td></tr>`;
  if (conn.closeReason) infoHtml += `<tr><td>关闭原因</td><td>${escapeHtml(conn.closeReason)}</td></tr>`;
  infoHtml += `<tr><td>消息数</td><td>发送: ${conn.messageCount.send}, 接收: ${conn.messageCount.receive}</td></tr>`;
  infoHtml += '</table>';
  document.getElementById('ws-info').innerHTML = infoHtml;

  const messages = conn.messages || [];
  document.getElementById('ws-messages').innerHTML = messages.length === 0 ?
    '<div class="ws-no-messages">暂无消息</div>' :
    messages.map(msg => {
      const dirClass = msg.direction === 'send' ? 'ws-msg-send' : 'ws-msg-receive';
      let data = msg.data;
      try { data = JSON.stringify(JSON.parse(msg.data), null, 2); } catch {}
      return `<div class="ws-message ${dirClass}">
        <div class="ws-msg-header">
          <span class="ws-msg-dir">${msg.direction === 'send' ? '↑ 发送' : '↓ 接收'}</span>
          <span class="ws-msg-type">${msg.type}</span>
          <span class="ws-msg-time">${formatTimestamp(msg.timestamp)}</span>
        </div>
        <div class="ws-msg-data"><pre>${escapeHtml(data)}</pre></div>
      </div>`;
    }).join('');

  document.getElementById('ws-detail-overlay').style.display = 'flex';
  const container = document.getElementById('ws-messages');
  container.scrollTop = container.scrollHeight;
}

function closeWsDetail() {
  document.getElementById('ws-detail-overlay').style.display = 'none';
  selectedWsId = null;
}

function exportWsMessages() {
  const conn = allWsConnections.find(c => c.id === selectedWsId);
  if (!conn) return;
  downloadFile(JSON.stringify({
    url: conn.url, status: conn.status, protocols: conn.protocols,
    startTime: new Date(conn.startTime).toISOString(),
    endTime: conn.endTime ? new Date(conn.endTime).toISOString() : null,
    messages: conn.messages.map(m => ({
      direction: m.direction, type: m.type, data: m.data,
      time: new Date(m.timestamp).toISOString(),
    })),
  }, null, 2), 'application/json', `ws-${Date.now()}.json`);
  showToast('WebSocket 消息已导出');
}

// ============ 工具函数 ============

function closeDetail() {
  document.getElementById('detail-overlay').style.display = 'none';
}

function updateCounts() {
  document.getElementById('http-count').textContent = allRequests.length;
  document.getElementById('ws-count').textContent = allWsConnections.length;
}

function updateToggleButton() {
  const btn = document.getElementById('btn-toggle');
  btn.textContent = isCapturing ? '⏸' : '▶';
  btn.className = isCapturing ? 'btn btn-green' : 'btn btn-yellow';
}

function updateStats() {
  let s2 = 0, s3 = 0, s4 = 0, s5 = 0, err = 0, totalTime = 0, timeCount = 0;
  allRequests.forEach(r => {
    if (r.status === 0 || r.status === null) { err++; return; }
    if (r.status >= 200 && r.status < 300) s2++;
    else if (r.status >= 300 && r.status < 400) s3++;
    else if (r.status >= 400 && r.status < 500) s4++;
    else if (r.status >= 500) s5++;
    if (r.duration) { totalTime += r.duration; timeCount++; }
  });
  document.getElementById('stat-total').textContent = allRequests.length;
  document.getElementById('stat-2xx').textContent = s2;
  document.getElementById('stat-3xx').textContent = s3;
  document.getElementById('stat-4xx').textContent = s4;
  document.getElementById('stat-5xx').textContent = s5;
  document.getElementById('stat-err').textContent = err;
  document.getElementById('stat-avg-time').textContent = timeCount > 0 ? Math.round(totalTime / timeCount) + 'ms' : '-';
}

function filterAndSortRequests(requests) {
  const urlFilter = document.getElementById('filter-url').value.toLowerCase();
  const methodFilter = document.getElementById('filter-method').value;
  const statusFilter = document.getElementById('filter-status').value;
  const typeFilter = document.getElementById('filter-type').value;
  const sort = document.getElementById('filter-sort').value;

  return requests.filter(r => {
    if (urlFilter && !r.url.toLowerCase().includes(urlFilter)) return false;
    if (methodFilter && r.method !== methodFilter) return false;
    if (typeFilter && r.type !== typeFilter) return false;
    if (statusFilter) {
      if (statusFilter === '0' && (r.status !== 0 && r.status !== null)) return false;
      if (statusFilter === '2xx' && !(r.status >= 200 && r.status < 300)) return false;
      if (statusFilter === '3xx' && !(r.status >= 300 && r.status < 400)) return false;
      if (statusFilter === '4xx' && !(r.status >= 400 && r.status < 500)) return false;
      if (statusFilter === '5xx' && !(r.status >= 500)) return false;
    }
    return true;
  }).sort((a, b) => {
    switch (sort) {
      case 'time-asc': return a.startTime - b.startTime;
      case 'duration-asc': return (a.duration || 0) - (b.duration || 0);
      case 'duration-desc': return (b.duration || 0) - (a.duration || 0);
      case 'size-asc': return (a.size || 0) - (b.size || 0);
      case 'size-desc': return (b.size || 0) - (a.size || 0);
      default: return b.startTime - a.startTime;
    }
  });
}

function generateCurl(r) {
  if (!r) return '';
  let parts = [`curl -X ${r.method} '${r.url}'`];
  if (r.requestHeaders) {
    Object.entries(r.requestHeaders).forEach(([k, v]) => {
      if (!['host', 'connection', 'origin', 'referer'].includes(k.toLowerCase())) {
        parts.push(`-H '${k}: ${v}'`);
      }
    });
  }
  if (r.requestBody && ['POST', 'PUT', 'PATCH'].includes(r.method)) {
    parts.push(`-d '${r.requestBody.replace(/'/g, "\\'")}'`);
  }
  return parts.join(' \\\n  ');
}

function formatBody(body) {
  if (!body) return '<span class="no-data">无数据</span>';
  try { return syntaxHighlight(JSON.stringify(JSON.parse(body), null, 2)); }
  catch { return escapeHtml(body); }
}

function syntaxHighlight(json) {
  return json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, (m) => {
      let cls = 'json-number';
      if (/^"/.test(m)) cls = /:$/.test(m) ? 'json-key' : 'json-string';
      else if (/true|false/.test(m)) cls = 'json-boolean';
      else if (/null/.test(m)) cls = 'json-null';
      return `<span class="${cls}">${m}</span>`;
    });
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, 2000);
}

function downloadFile(content, type, filename) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function getStatusClass(s) {
  if (s >= 200 && s < 300) return 'status-2xx';
  if (s >= 300 && s < 400) return 'status-3xx';
  if (s >= 400 && s < 500) return 'status-4xx';
  if (s >= 500) return 'status-5xx';
  return 'status-0';
}

function formatSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
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
  try { const u = new URL(url); return u.pathname + u.search; }
  catch { return url; }
}

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
