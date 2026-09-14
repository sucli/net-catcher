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
let activeTabId = null;
let captureScope = 'current';
let captureSettings = { redactSensitive: true, excludedHosts: [] };
let replayDefaults = null;
let lastStorageError = '';
let sessions = [];
let activeSessionId = '';
let scenarios = [];
let cachedWindowId = null;
let currentRuleTab = 'mock';
let advancedRules = {
  rewrite: [], mapLocal: [], throttle: [], breakpoint: [], hostMap: [], script: [], pending: [],
};

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  try {
    chrome.storage.local.get(['nc_autoScroll', 'nc_groupByDomain'], (data) => {
      if (data.nc_autoScroll !== undefined) autoScroll = data.nc_autoScroll;
      if (data.nc_groupByDomain !== undefined) groupByDomain = data.nc_groupByDomain;
      const scrollEl = document.getElementById('chk-auto-scroll');
      const groupEl = document.getElementById('btn-group-toggle');
      if (scrollEl) scrollEl.checked = autoScroll;
      if (groupEl) groupEl.classList.toggle('active', groupByDomain);
    });
  } catch {}

  try {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      activeTabId = tabs?.[0]?.id ?? null;
      cachedWindowId = tabs?.[0]?.windowId ?? null;
      loadRequests();
    });
  } catch {}

  // 兜底缓存 windowId。注意：callback 版 getCurrent 返回 undefined，不能链 .catch
  try {
    if (chrome.windows?.getCurrent) {
      const maybePromise = chrome.windows.getCurrent(win => {
        if (Number.isInteger(win?.id)) cachedWindowId = win.id;
      });
      if (maybePromise && typeof maybePromise.catch === 'function') {
        maybePromise.catch(() => {});
      }
    }
  } catch {}

  loadFilters();
  loadSettings();

  try {
    bindEvents();
  } catch (error) {
    console.error('[NetCatcher] bindEvents failed', error);
  }
});

// 加载请求数据
function loadRequests() {
  const data = captureScope === 'current' && Number.isInteger(activeTabId) ? { tabId: activeTabId } : {};
  chrome.runtime.sendMessage({ type: 'GET_REQUESTS', data }, (res) => {
    if (chrome.runtime.lastError) return;
    if (res) {
      allRequests = res.requests || [];
      allWsConnections = res.wsConnections || [];
      mockRules = res.mockRules || [];
      isCapturing = res.isCapturing;
      sessions = res.sessions || [];
      activeSessionId = res.activeSessionId || '';
      scenarios = res.scenarios || [];
      renderSessions();
      renderScenarios();
      if (res.storageError && res.storageError !== lastStorageError) {
        lastStorageError = res.storageError;
        showToast(`存储失败: ${res.storageError}`);
      }
      updateToggleButton();
      updateCounts();
      if (currentView === 'http') { renderRequests({ incremental: true }); updateStats(); }
      else if (currentView === 'ws') renderWsConnections();
      else if (currentView === 'timeline') renderTimeline();
      else if (currentView === 'mock') {
        loadAdvancedRules().then(() => {
          if (currentRuleTab === 'mock') renderMockRules();
          else renderAdvancedRules();
        });
      }
    }
  });
}

function loadSettings() {
  chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, res => {
    if (!res?.settings) return;
    captureSettings = res.settings;
    document.getElementById('chk-redact').checked = captureSettings.redactSensitive !== false;
    document.getElementById('excluded-hosts').value = (captureSettings.excludedHosts || []).join(', ');
  });
}

function renderSessions() {
  const select = document.getElementById('session-select');
  if (!select) return;
  select.innerHTML = '<option value="">会话...</option>' + sessions.map(session =>
    `<option value="${escapeHtml(session.id)}" ${session.id === activeSessionId ? 'selected' : ''}>${escapeHtml(session.name)}</option>`
  ).join('');
}

function renderScenarios() {
  const select = document.getElementById('scenario-select');
  if (!select) return;
  select.innerHTML = '<option value="">测试场景...</option>' + scenarios.map(scenario =>
    `<option value="${scenario.id}">${escapeHtml(scenario.name)} (${scenario.steps.length})</option>`
  ).join('');
}

function saveSettings() {
  captureSettings = {
    ...captureSettings,
    redactSensitive: document.getElementById('chk-redact').checked,
    excludedHosts: document.getElementById('excluded-hosts').value.split(',').map(value => value.trim()).filter(Boolean),
  };
  chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', data: captureSettings });
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
function setPanelVisible(id, visible) {
  const el = document.getElementById(id);
  if (!el) return;
  el.hidden = !visible;
  el.style.display = visible ? '' : 'none';
}

function updateViewVisibility() {
  hideHoverTooltip();
  setPanelVisible('stats-bar', currentView === 'http');
  setPanelVisible('filter-bar', currentView === 'http' || currentView === 'timeline');
  setPanelVisible('http-col-header', currentView === 'http');
  setPanelVisible('request-list', currentView === 'http');
  setPanelVisible('ws-filter-bar', currentView === 'ws');
  setPanelVisible('ws-col-header', currentView === 'ws');
  setPanelVisible('ws-list', currentView === 'ws');
  setPanelVisible('timeline-view', currentView === 'timeline');
  setPanelVisible('mock-view', currentView === 'mock');
}

function bindMoreMenu() {
  const trigger = document.getElementById('btn-more');
  const menu = document.getElementById('more-menu');
  if (!trigger || !menu) return;

  const closeMenu = () => {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  };

  const openMenu = () => {
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
  };

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    if (menu.hidden) openMenu();
    else closeMenu();
  });

  document.addEventListener('click', (event) => {
    if (menu.hidden) return;
    if (!menu.contains(event.target) && event.target !== trigger) closeMenu();
  });

  menu.addEventListener('click', (event) => {
    event.stopPropagation();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) closeMenu();
  });
}

function bindSidePanelButton() {
  const btn = document.getElementById('btn-open-sidepanel');
  if (!btn || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';

  btn.addEventListener('click', () => {
    // 立刻给反馈，确认点击已生效
    showToast('正在打开侧边栏…');

    if (!chrome.sidePanel || typeof chrome.sidePanel.open !== 'function') {
      showToast('当前 Chrome 不支持 sidePanel.open，请升级浏览器');
      return;
    }

    const report = (err) => {
      if (err) showToast(`打开侧边栏失败：${err}`);
      else showToast('侧边栏已打开');
    };

    const invokeOpen = (options) => {
      try {
        const ret = chrome.sidePanel.open(options);
        if (ret && typeof ret.then === 'function') {
          ret.then(() => report(null)).catch(e => report(e?.message || String(e)));
          return;
        }
        // 旧版 callback API
        chrome.sidePanel.open(options, () => {
          const lastError = chrome.runtime.lastError;
          report(lastError?.message || null);
        });
      } catch (e) {
        report(e?.message || String(e));
      }
    };

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      const windowId = (tab && Number.isInteger(tab.windowId)) ? tab.windowId : cachedWindowId;
      if (Number.isInteger(windowId)) {
        invokeOpen({ windowId });
        return;
      }
      if (tab && Number.isInteger(tab.id)) {
        invokeOpen({ tabId: tab.id });
        return;
      }
      invokeOpen({ windowId: chrome.windows?.WINDOW_ID_CURRENT });
    });
  });
}

function bindEvents() {
  // 侧栏按钮最先绑定，避免后续逻辑异常导致未注册
  bindSidePanelButton();
  bindMoreMenu();
  bindRequestListEvents();
  bindContextMenu();
  bindMockTransferEvents();
  bindScenarioResultEvents();
  bindAdvancedRulesUI();
  bindStatsAndBaseline();
  bindSessionPackage();
  bindShortcutsHelp();
  updateViewVisibility();

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
      else if (currentView === 'mock') {
        loadAdvancedRules().then(() => {
          if (currentRuleTab === 'mock') renderMockRules();
          else renderAdvancedRules();
        });
      }
    });
  });

  // 暂停/恢复
  document.getElementById('capture-scope').addEventListener('change', e => {
    captureScope = e.target.value;
    loadRequests();
  });
  document.getElementById('chk-redact').addEventListener('change', saveSettings);
  document.getElementById('excluded-hosts').addEventListener('change', saveSettings);

  document.getElementById('session-select').addEventListener('change', event => {
    const id = event.target.value;
    if (!id || id === activeSessionId) return;
    chrome.runtime.sendMessage({ type: 'SWITCH_SESSION', data: { id } }, res => {
      if (res?.error) { showToast(res.error); return; }
      loadRequests();
    });
  });
  document.getElementById('btn-new-session').addEventListener('click', () => {
    const name = window.prompt('会话名称', `会话 ${sessions.length + 1}`);
    if (name === null) return;
    chrome.runtime.sendMessage({ type: 'CREATE_SESSION', data: { name } }, res => {
      if (res?.error) { showToast(res.error); return; }
      loadRequests();
      showToast('会话已创建');
    });
  });
  document.getElementById('btn-delete-session').addEventListener('click', () => {
    if (!activeSessionId || !window.confirm('删除当前会话及其抓包记录？')) return;
    chrome.runtime.sendMessage({ type: 'DELETE_SESSION', data: { id: activeSessionId } }, res => {
      if (res?.error) { showToast(res.error); return; }
      loadRequests();
      showToast('会话已删除');
    });
  });
  document.getElementById('btn-save-scenario').addEventListener('click', () => {
    const ids = Array.from(selectedIds);
    if (!ids.length) { showToast('请先选择请求'); return; }
    const name = window.prompt('测试场景名称', `场景 ${scenarios.length + 1}`);
    if (!name) return;
    chrome.runtime.sendMessage({ type: 'SAVE_SCENARIO', data: { name, ids } }, res => {
      if (res?.error) { showToast(res.error); return; }
      scenarios = res.scenarios || scenarios;
      renderScenarios();
      showToast('测试场景已保存');
    });
  });
  document.getElementById('btn-run-scenario').addEventListener('click', () => {
    const id = Number(document.getElementById('scenario-select').value);
    if (!id) { showToast('请选择测试场景'); return; }
    chrome.runtime.sendMessage({ type: 'RUN_SCENARIO', data: { id } }, res => {
      if (res?.error) { showToast(res.error); return; }
      showScenarioResults(res?.results || [], res?.scenarioId);
    });
  });
  document.getElementById('btn-delete-scenario').addEventListener('click', () => {
    const id = Number(document.getElementById('scenario-select').value);
    if (!id) return;
    chrome.runtime.sendMessage({ type: 'DELETE_SCENARIO', data: { id } }, res => {
      scenarios = res?.scenarios || scenarios.filter(item => item.id !== id);
      renderScenarios();
      showToast('测试场景已删除');
    });
  });

  document.getElementById('btn-toggle').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'TOGGLE_CAPTURE' }, (res) => {
      if (res) { isCapturing = res.isCapturing; updateToggleButton(); }
    });
  });

  // 清除
  document.getElementById('btn-clear').addEventListener('click', () => {
    const data = captureScope === 'current' && Number.isInteger(activeTabId) ? { tabId: activeTabId } : {};
    chrome.runtime.sendMessage({ type: 'CLEAR_REQUESTS', data }, () => {
      allRequests = []; allWsConnections = []; selectedIds.clear();
      if (currentView === 'http') { renderRequests(); updateStats(); }
      else if (currentView === 'ws') renderWsConnections();
      else if (currentView === 'timeline') renderTimeline();
      updateCounts();
    });
  });

  // 导出
  function buildExportPayload() {
    const data = captureScope === 'current' && Number.isInteger(activeTabId) ? { tabId: activeTabId } : {};
    if (selectedIds.size > 0) data.ids = Array.from(selectedIds);
    return data;
  }

  document.getElementById('btn-export').addEventListener('click', () => {
    const data = buildExportPayload();
    chrome.runtime.sendMessage({ type: 'EXPORT_HAR', data }, (res) => {
      if (res && res.har) {
        const scope = data.ids ? `选中${data.ids.length}` : '范围';
        downloadFile(JSON.stringify(res.har, null, 2), 'application/json',
          `netcatcher-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.har`);
        showToast(`HAR 已导出（${scope}）`);
      }
    });
  });
  document.getElementById('btn-export-openapi').addEventListener('click', () => {
    const data = buildExportPayload();
    chrome.runtime.sendMessage({ type: 'EXPORT_OPENAPI', data }, res => {
      if (!res?.openapi) return;
      const scope = data.ids ? `选中${data.ids.length}` : '范围';
      downloadFile(JSON.stringify(res.openapi, null, 2), 'application/json',
        `netcatcher-openapi-${new Date().toISOString().slice(0, 10)}.json`);
      showToast(`OpenAPI 已导出（${scope}）`);
    });
  });

  document.getElementById('btn-import-har').addEventListener('click', () => {
    document.getElementById('har-file-input').click();
  });
  document.getElementById('har-file-input').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const har = JSON.parse(await file.text());
      chrome.runtime.sendMessage({ type: 'IMPORT_HAR', data: { har, tabId: activeTabId } }, res => {
        if (res?.error) { showToast(res.error); return; }
        loadRequests();
        showToast(`已导入 ${res?.count || 0} 条请求`);
      });
    } catch {
      showToast('HAR 文件格式无效');
    }
  });
  document.getElementById('btn-import-curl').addEventListener('click', () => {
    const value = window.prompt('粘贴 cURL 命令');
    if (!value) return;
    const request = parseCurl(value);
    if (!request) { showToast('无法解析 cURL'); return; }
    chrome.runtime.sendMessage({ type: 'IMPORT_REQUESTS', data: { requests: [request], tabId: activeTabId } }, res => {
      if (res?.error) { showToast(res.error); return; }
      loadRequests();
      showToast('cURL 已导入');
    });
  });
  document.getElementById('btn-batch-replay').addEventListener('click', () => {
    const ids = Array.from(selectedIds);
    if (!ids.length) { showToast('请先选择请求（Ctrl/⌘+点击）'); return; }
    chrome.runtime.sendMessage({ type: 'REPLAY_BATCH', data: { ids } }, res => {
      if (res?.error) { showToast(res.error); return; }
      showBatchReplayResults(res?.results || []);
    });
  });
  document.getElementById('btn-close-batch-replay').addEventListener('click', () => {
    document.getElementById('batch-replay-overlay').style.display = 'none';
  });
  document.getElementById('batch-replay-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('batch-replay-overlay')) {
      document.getElementById('batch-replay-overlay').style.display = 'none';
    }
  });
  document.getElementById('btn-mock-from-request').addEventListener('click', () => {
    const id = Array.from(selectedIds)[0];
    const request = allRequests.find(r => r.id === id);
    if (!request) { showToast('请先选择请求'); return; }
    openMockEditorFromRequest(request);
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
      tags: document.getElementById('filter-tags')?.value || '',
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
        if (document.getElementById('filter-tags')) {
          document.getElementById('filter-tags').value = filter.config.tags || '';
        }
        renderRequests();
        showToast(`已加载: ${filter.name}`);
      }
    });
  });
  document.getElementById('btn-delete-filter').addEventListener('click', () => {
    const id = parseInt(document.getElementById('saved-filters').value, 10);
    if (!id) return;
    chrome.runtime.sendMessage({ type: 'DELETE_FILTER', data: { id } }, () => {
      loadFilters();
      showToast('过滤器已删除');
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
  document.getElementById('btn-save-assertion').addEventListener('click', () => {
    const id = Array.from(selectedIds)[0];
    if (!id) return;
    const jsonChecks = document.getElementById('assert-json').value.split('\n').map(line => line.trim()).filter(Boolean)
      .map(line => {
        const index = line.indexOf('=');
        return index > 0 ? { path: line.slice(0, index).trim(), expected: line.slice(index + 1).trim() } : null;
      }).filter(Boolean);
    chrome.runtime.sendMessage({ type: 'UPDATE_ASSERTIONS', data: {
      id,
      assertions: {
        status: document.getElementById('assert-status').value,
        maxDurationMs: document.getElementById('assert-duration').value,
        jsonChecks,
      },
    } }, res => {
      if (res?.ok) showToast('断言已保存');
    });
  });

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
  document.getElementById('btn-ws-send').addEventListener('click', () => {
    const data = document.getElementById('ws-send-input').value;
    if (!selectedWsId || !data) return;
    chrome.runtime.sendMessage({ type: 'REPLAY_WS', data: { id: selectedWsId, data } }, res => {
      if (res?.error) { showToast(res.error); return; }
      document.getElementById('ws-send-input').value = '';
      showToast('WebSocket 消息已发送');
    });
  });
  document.getElementById('ws-filter').addEventListener('input', () => {
    renderWsConnections();
    if (selectedWsId) showWsDetail(selectedWsId);
  });
  document.getElementById('ws-direction').addEventListener('change', () => {
    if (selectedWsId) showWsDetail(selectedWsId);
  });

  // Mock 规则管理（新建按钮由 bindAdvancedRulesUI 统一处理）
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
  ['filter-url', 'filter-method', 'filter-status', 'filter-type', 'filter-sort', 'filter-tags'].forEach(id => {
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
  document.getElementById('filter-starred').addEventListener('change', renderRequests);

  // 键盘快捷键
  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag);
    if (e.key === '?' && !typing) {
      e.preventDefault();
      document.getElementById('shortcuts-overlay').style.display = 'flex';
      return;
    }
    if (e.key === '/' && !typing) {
      e.preventDefault();
      document.getElementById('filter-url')?.focus();
      return;
    }
    if (!typing && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const visible = filterAndSortRequests(allRequests);
      const current = Array.from(selectedIds)[0];
      let index = visible.findIndex(request => request.id === current);
      index = e.key === 'ArrowDown' ? Math.min(visible.length - 1, index + 1) : Math.max(0, index - 1);
      if (visible[index]) { e.preventDefault(); showDetail(visible[index].id); }
      return;
    }
    if (!typing && e.key === 'Enter' && selectedIds.size === 1) {
      e.preventDefault();
      showDetail(Array.from(selectedIds)[0]);
      return;
    }
    if (!typing && e.key.toLowerCase() === 'r' && selectedIds.size === 1) {
      e.preventDefault();
      replayRequest();
      return;
    }
    if (!typing && e.key.toLowerCase() === 'c' && selectedIds.size === 1) {
      e.preventDefault();
      const curl = generateCurl(allRequests.find(r => r.id === Array.from(selectedIds)[0]));
      navigator.clipboard.writeText(curl).then(() => showToast('已复制 cURL'));
      return;
    }
    if (!typing && e.key.toLowerCase() === 'm') {
      e.preventDefault();
      document.getElementById('tab-mock')?.click();
      return;
    }
    if (!typing && e.key.toLowerCase() === 't') {
      e.preventDefault();
      document.getElementById('tab-timeline')?.click();
      return;
    }
    if (!typing && e.key.toLowerCase() === 's') {
      e.preventDefault();
      document.getElementById('btn-show-stats')?.click();
      return;
    }
    if (e.key === 'Escape') {
      if (document.getElementById('detail-overlay').style.display !== 'none') { closeDetail(); return; }
      if (document.getElementById('ws-detail-overlay').style.display !== 'none') { closeWsDetail(); return; }
      if (document.getElementById('compare-overlay').style.display !== 'none') {
        document.getElementById('compare-overlay').style.display = 'none'; return;
      }
      if (document.getElementById('shortcuts-overlay')?.style.display === 'flex') {
        document.getElementById('shortcuts-overlay').style.display = 'none'; return;
      }
      if (document.getElementById('stats-overlay')?.style.display === 'flex') {
        document.getElementById('stats-overlay').style.display = 'none'; return;
      }
      if (document.getElementById('baseline-overlay')?.style.display === 'flex') {
        document.getElementById('baseline-overlay').style.display = 'none'; return;
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
  btn.textContent = '重放中...';
  btn.disabled = true;

  let replayHeaders = {};
  try { replayHeaders = JSON.parse(document.getElementById('replay-headers').value || '{}'); } catch {
    document.getElementById('replay-output').innerHTML = '<div class="replay-error">请求头 JSON 格式无效</div>';
    btn.textContent = '重放';
    btn.disabled = false;
    return;
  }
  const currentReplayMethod = document.getElementById('replay-method').value;
  const currentReplayBody = document.getElementById('replay-body').value;
  const currentReplayHeaders = document.getElementById('replay-headers').value;
  const unchanged = replayDefaults && replayDefaults.id === id &&
    replayDefaults.method === currentReplayMethod &&
    replayDefaults.body === currentReplayBody &&
    replayDefaults.headers === currentReplayHeaders;
  const options = unchanged ? undefined : {
    method: currentReplayMethod,
    headers: replayHeaders,
    body: currentReplayBody,
  };
  chrome.runtime.sendMessage({ type: 'REPLAY_REQUEST', data: { id, options } }, (res) => {
    btn.textContent = '重放';
    btn.disabled = false;

    // 切换到重放结果 tab
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelector('.tab[data-tab="tab-replay-result"]').classList.add('active');
    document.getElementById('tab-replay-result').classList.add('active');

    if (chrome.runtime.lastError || !res) {
      document.getElementById('replay-output').innerHTML =
        `<div class="replay-error">❌ 错误: ${escapeHtml(chrome.runtime.lastError?.message || '扩展后台无响应')}</div>`;
    } else if (res.error) {
      document.getElementById('replay-output').innerHTML =
        `<div class="replay-error">❌ 错误: ${escapeHtml(res.error)}</div>`;
    } else {
      let html = '<div class="replay-result">';
      html += `<div class="replay-status ${getStatusClass(res.status)}">${res.status} ${escapeHtml(res.statusText)}</div>`;
      html += '<div class="header-section-title">响应头</div>';
      html += '<table class="header-table">';
      Object.entries(res.headers || {}).forEach(([k, v]) => {
        html += `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`;
      });
      html += '</table>';
      html += '<div class="header-section-title">响应体</div>';
      html += `<div class="body-content">${formatBody(res.body)}</div>`;
      html += '</div>';
      document.getElementById('replay-output').innerHTML = html;
    }
  });
}

// ============ 渲染 HTTP 请求列表 ============

const EMPTY_HTTP_HTML = `
  <div class="empty-state" id="empty-state">
    <div class="empty-symbol" aria-hidden="true">◈</div>
    <div class="empty-title">暂无匹配的请求</div>
    <div class="empty-hint">1. 在页面上刷新或触发接口调用<br>2. 确认捕获未暂停（右上角「捕获中」）<br>3. 若只看当前标签页，可切到「全部标签页」</div>
    <div class="empty-kbd">Ctrl/⌘ + 点击可多选对比 · ↑↓ 切换 · Esc 关闭</div>
  </div>`;

function requestRowHash(r) {
  return [
    r.method, r.type, r.url, r.status, r.statusText || '',
    Math.round(r.duration || 0), r.size || 0,
    r.starred ? 1 : 0, r.isMocked ? 1 : 0, r.graphql ? 1 : 0,
    (r.tags || []).join(','),
  ].join('|');
}

function getFilterKey() {
  return [
    groupByDomain,
    captureScope,
    document.getElementById('filter-url')?.value || '',
    document.getElementById('filter-method')?.value || '',
    document.getElementById('filter-status')?.value || '',
    document.getElementById('filter-type')?.value || '',
    document.getElementById('filter-sort')?.value || '',
    document.getElementById('filter-tags')?.value || '',
    document.getElementById('filter-starred')?.checked ? 1 : 0,
  ].join('|');
}

let listFilterKey = '';
const rowHashMap = new Map();

function renderRequests(options = {}) {
  const list = document.getElementById('request-list');
  if (!list) return;
  const filtered = filterAndSortRequests(allRequests);
  document.getElementById('http-count').textContent = allRequests.length;

  if (filtered.length === 0) {
    list.innerHTML = EMPTY_HTTP_HTML;
    listFilterKey = getFilterKey() + '|empty';
    rowHashMap.clear();
    return;
  }

  const filterKey = getFilterKey();
  const idOrder = filtered.map(r => r.id).join(',');
  const canPatch = options.incremental === true
    && !groupByDomain
    && filterKey === listFilterKey
    && list.querySelector('.request-item');

  if (canPatch) {
    const liveIds = new Set(filtered.map(r => r.id));
    list.querySelectorAll('.request-item').forEach(el => {
      const id = parseInt(el.dataset.id, 10);
      if (!liveIds.has(id)) {
        el.remove();
        rowHashMap.delete(id);
      }
    });

    const currentOrder = Array.from(list.querySelectorAll('.request-item')).map(el => parseInt(el.dataset.id, 10));
    if (currentOrder.join(',') === idOrder) {
      filtered.forEach(r => {
        const hash = requestRowHash(r);
        if (rowHashMap.get(r.id) === hash) return;
        const el = list.querySelector(`.request-item[data-id="${r.id}"]`);
        if (!el) return;
        const tmp = document.createElement('div');
        tmp.innerHTML = renderRequestRow(r);
        const next = tmp.firstElementChild;
        if (next) {
          el.replaceWith(next);
          rowHashMap.set(r.id, hash);
        }
      });
      refreshTagOptions();
      if (autoScroll) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
      return;
    }
  }

  listFilterKey = filterKey;
  rowHashMap.clear();
  if (groupByDomain) {
    renderGroupedRequests(list, filtered);
  } else {
    renderFlatRequests(list, filtered);
    filtered.forEach(r => rowHashMap.set(r.id, requestRowHash(r)));
  }
  refreshTagOptions();
  if (autoScroll) {
    requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }
}

function getTypeInfo(type) {
  const map = {
    fetch: { label: 'FETCH', cls: 'type-fetch' },
    xhr: { label: 'XHR', cls: 'type-xhr' },
    eventsource: { label: 'SSE', cls: 'type-sse' },
    beacon: { label: 'BEACON', cls: 'type-beacon' },
    network: { label: 'NET', cls: 'type-network' },
    curl: { label: 'CURL', cls: 'type-curl' },
  };
  return map[type] || { label: String(type || 'OTHER').slice(0, 6).toUpperCase(), cls: 'type-other' };
}

function renderTypeBadge(type) {
  const info = getTypeInfo(type);
  return `<span class="req-type ${info.cls}" title="${escapeHtml(info.label)}">${info.label}</span>`;
}

function renderRequestFlags(r) {
  const flags = [];
  if (r.starred) flags.push('<span class="flag-chip flag-star" title="已收藏">★</span>');
  if (r.isMocked) flags.push('<span class="flag-chip flag-mock" title="Mock 响应">MOCK</span>');
  if (r.graphql) flags.push('<span class="flag-chip flag-gql" title="GraphQL">GQL</span>');
  if (!flags.length) return '';
  return `<span class="req-flags">${flags.join('')}</span>`;
}

function renderRequestRow(r, options = {}) {
  const selected = selectedIds.has(r.id) ? ' selected' : '';
  const showSize = options.showSize !== false;
  return `<div class="request-item${selected}" data-id="${r.id}">
    <span class="req-method ${getMethodClass(r.method)}">${escapeHtml(r.method)}</span>
    ${renderTypeBadge(r.type)}
    <span class="req-url" title="${escapeHtml(r.url)}">${escapeHtml(getShortUrl(r.url))}${renderRequestFlags(r)}</span>
    <span class="req-status ${r.status ? getStatusClass(r.status) : 'status-0'}">${r.status || '---'}</span>
    <span class="req-duration">${r.duration ? Math.round(r.duration) + 'ms' : '...'}</span>
    ${showSize ? `<span class="req-size">${r.size ? formatSize(r.size) : '...'}</span>` : ''}
  </div>`;
}

function renderFlatRequests(list, requests) {
  list.innerHTML = requests.map(r => renderRequestRow(r)).join('');
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
      html += renderRequestRow(r);
    });
    html += '</div></div>';
  });

  list.innerHTML = html;

  // 分组折叠由事件委托处理
}

function findRequestById(id) {
  return allRequests.find(r => r.id === id);
}

function getRequestTooltipExtras(request) {
  const extras = [];
  if (request.graphql?.operationName) extras.push(['GraphQL', escapeHtml(request.graphql.operationName)]);
  if (request.tags?.length) extras.push(['标签', escapeHtml(request.tags.join(', '))]);
  if (request.isMocked) extras.push(['Mock', '已拦截', 'status-3xx']);
  return extras;
}

function onRequestListClick(e) {
  const header = e.target.closest('.group-header');
  if (header) {
    const items = header.nextElementSibling;
    const toggle = header.querySelector('.group-toggle');
    if (!items || !toggle) return;
    const isOpen = items.style.display !== 'none';
    items.style.display = isOpen ? 'none' : 'block';
    toggle.textContent = isOpen ? '▶' : '▼';
    return;
  }

  const item = e.target.closest('.request-item');
  if (!item) return;
  const id = parseInt(item.dataset.id, 10);
  hideHoverTooltip();
  hideContextMenu();

  if (e.ctrlKey || e.metaKey) {
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
    item.classList.toggle('selected');
    if (selectedIds.size >= 2) showCompare();
    return;
  }

  selectedIds.clear();
  selectedIds.add(id);
  document.querySelectorAll('#request-list .request-item').forEach(i => i.classList.remove('selected'));
  item.classList.add('selected');
  showDetail(id);
}

function onRequestListMouseOver(e) {
  const item = e.target.closest('.request-item');
  if (!item) {
    if (!e.relatedTarget || !e.relatedTarget.closest?.('.request-item')) hideHoverTooltip();
    return;
  }
  if (item === onRequestListMouseOver._last) return;
  onRequestListMouseOver._last = item;
  const request = findRequestById(parseInt(item.dataset.id, 10));
  if (request) scheduleRequestRowTooltip(request, e, getRequestTooltipExtras(request));
}

function onRequestListMouseMove(e) {
  const item = e.target.closest('.request-item');
  if (!item || document.getElementById('hover-tooltip')?.hidden) return;
  positionHoverTooltip(e);
}

function onRequestListMouseOut(e) {
  const from = e.target.closest?.('.request-item');
  const to = e.relatedTarget?.closest?.('.request-item');
  if (from && from !== to) {
    onRequestListMouseOver._last = null;
    hideHoverTooltip();
  }
}

function bindRequestListEvents() {
  const list = document.getElementById('request-list');
  if (!list || list.dataset.bound === '1') return;
  list.dataset.bound = '1';
  list.addEventListener('click', onRequestListClick);
  list.addEventListener('mouseover', onRequestListMouseOver);
  list.addEventListener('mousemove', onRequestListMouseMove);
  list.addEventListener('mouseout', onRequestListMouseOut);
  list.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.request-item');
    if (!item) return;
    e.preventDefault();
    openRequestContextMenu(parseInt(item.dataset.id, 10), e.clientX, e.clientY);
  });
}

// ============ 请求对比 ============

let compareTab = 'overview';

function flattenJsonPaths(value, prefix = '', out = {}) {
  if (value === null || typeof value !== 'object') {
    out[prefix || '$'] = value;
    return out;
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
  if (!entries.length) {
    out[prefix || '$'] = Array.isArray(value) ? [] : {};
    return out;
  }
  entries.forEach(([k, v]) => {
    flattenJsonPaths(v, prefix ? `${prefix}.${k}` : String(k), out);
  });
  return out;
}

function parseJsonSafe(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function buildHeaderDiff(r1, r2) {
  const keys = new Set([
    ...Object.keys(r1.requestHeaders || {}),
    ...Object.keys(r2.requestHeaders || {}),
    ...Object.keys(r1.responseHeaders || {}),
    ...Object.keys(r2.responseHeaders || {}),
  ]);
  const rows = [];
  keys.forEach(k => {
    const aReq = r1.requestHeaders?.[k];
    const bReq = r2.requestHeaders?.[k];
    const aRes = r1.responseHeaders?.[k];
    const bRes = r2.responseHeaders?.[k];
    const reqChanged = String(aReq ?? '') !== String(bReq ?? '');
    const resChanged = String(aRes ?? '') !== String(bRes ?? '');
    if (!reqChanged && !resChanged) return;
    rows.push(`<tr>
      <td>${escapeHtml(k)}</td>
      <td>REQ ${escapeHtml(aReq ?? '—')} → ${escapeHtml(bReq ?? '—')}</td>
      <td>RES ${escapeHtml(aRes ?? '—')} → ${escapeHtml(bRes ?? '—')}</td>
    </tr>`);
  });
  if (!rows.length) return '<div class="no-data">Headers 无差异</div>';
  return `<table class="header-table"><tr><td>Header</td><td>请求</td><td>响应</td></tr>${rows.join('')}</table>`;
}

function buildJsonPathDiff(r1, r2) {
  const j1 = parseJsonSafe(r1.responseBody);
  const j2 = parseJsonSafe(r2.responseBody);
  if (!j1 || !j2) return '<div class="no-data">响应体不是合法 JSON，无法做路径对比</div>';
  const f1 = flattenJsonPaths(j1);
  const f2 = flattenJsonPaths(j2);
  const keys = Array.from(new Set([...Object.keys(f1), ...Object.keys(f2)])).sort();
  const rows = [];
  keys.forEach(k => {
    const x = f1[k];
    const y = f2[k];
    const sx = x === undefined ? '∅' : JSON.stringify(x);
    const sy = y === undefined ? '∅' : JSON.stringify(y);
    if (sx === sy) return;
    rows.push(`<tr><td>${escapeHtml(k)}</td><td colspan="2">${escapeHtml(sx)} → ${escapeHtml(sy)}</td></tr>`);
  });
  if (!rows.length) return '<div class="no-data">JSON 路径无差异</div>';
  return `<table class="header-table"><tr><td>路径</td><td colspan="2">变化</td></tr>${rows.join('')}</table>`;
}

function showCompare() {
  const ids = Array.from(selectedIds);
  const items = ids.map(id => allRequests.find(r => r.id === id)).filter(Boolean);
  if (items.length < 2) return;
  const r1 = items[0];
  const r2 = items[1];

  const tabs = [
    ['overview', '概览'],
    ['headers', 'Headers'],
    ['json', 'JSON 路径'],
    ['text', '文本 Diff'],
  ];

  let body = '';
  if (compareTab === 'headers') body = buildHeaderDiff(r1, r2);
  else if (compareTab === 'json') body = buildJsonPathDiff(r1, r2);
  else if (compareTab === 'text') {
    body = (r1.responseBody && r2.responseBody)
      ? `<div class="diff-content">${generateDiff(r1.responseBody, r2.responseBody)}</div>`
      : '<div class="no-data">缺少响应体</div>';
  } else {
    body = `
      <div class="compare-cards">
        <div class="compare-col">
          <div class="compare-col-header">请求 A · ${escapeHtml(r1.method)} ${r1.status || '---'}</div>
          ${buildCompareCard(r1)}
        </div>
        <div class="compare-col">
          <div class="compare-col-header">请求 B · ${escapeHtml(r2.method)} ${r2.status || '---'}</div>
          ${buildCompareCard(r2)}
        </div>
      </div>
      <div class="compare-extra">已选 ${items.length} 条，当前对比前两条</div>
      <div class="header-section-title">主要差异</div>
      <table class="header-table">
        <tr><td>URL</td><td>${r1.url !== r2.url ? '不同' : '相同'}</td></tr>
        <tr><td>方法</td><td>${r1.method !== r2.method ? '不同' : '相同'}</td></tr>
        <tr><td>状态码</td><td>${r1.status !== r2.status ? `${r1.status || '---'} vs ${r2.status || '---'}` : '相同'}</td></tr>
        <tr><td>耗时</td><td>${Math.round(r1.duration || 0)}ms vs ${Math.round(r2.duration || 0)}ms</td></tr>
        <tr><td>大小</td><td>${formatSize(r1.size || 0)} vs ${formatSize(r2.size || 0)}</td></tr>
      </table>`;
  }

  document.getElementById('compare-content').innerHTML = `
    <div class="compare-toolbar">
      <div class="compare-tabs">
        ${tabs.map(([key, label]) => `<button class="compare-tab ${compareTab === key ? 'active' : ''}" data-ctab="${key}">${label}</button>`).join('')}
      </div>
      <div class="compare-meta">已选 ${items.length} 条</div>
    </div>
    <div class="compare-body">${body}</div>`;

  document.querySelectorAll('#compare-content .compare-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      compareTab = btn.dataset.ctab;
      showCompare();
    });
  });

  document.getElementById('compare-overlay').style.display = 'flex';
}

function buildCompareCard(r) {
  return `<table class="header-table">
    <tr><td>URL</td><td class="compare-url">${escapeHtml(getShortUrl(r.url))}</td></tr>
    <tr><td>方法</td><td>${escapeHtml(r.method)}</td></tr>
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

// ============ 悬停摘要 ============

let hoverTipTimer = null;

function hideHoverTooltip() {
  const tip = document.getElementById('hover-tooltip');
  if (tip) tip.hidden = true;
  if (hoverTipTimer) {
    clearTimeout(hoverTipTimer);
    hoverTipTimer = null;
  }
}

// 保持旧名，避免散落调用遗漏
const hideTimelineTooltip = hideHoverTooltip;

function positionHoverTooltip(event) {
  const tip = document.getElementById('hover-tooltip');
  if (!tip) return;
  const pad = 12;
  const box = tip.getBoundingClientRect();
  let x = event.clientX + 14;
  let y = event.clientY + 14;
  if (x + box.width > window.innerWidth - pad) x = event.clientX - box.width - 14;
  if (y + box.height > window.innerHeight - pad) y = event.clientY - box.height - 14;
  tip.style.left = `${Math.max(pad, x)}px`;
  tip.style.top = `${Math.max(pad, y)}px`;
}

function showHoverTooltip(html, event) {
  const tip = document.getElementById('hover-tooltip');
  if (!tip) return;
  tip.innerHTML = html;
  tip.hidden = false;
  positionHoverTooltip(event);
}

function buildRequestTooltipRows(r, extras = []) {
  const statusClass = r.status ? getStatusClass(r.status) : 'status-0';
  const rows = [
    `<span class="tt-key">状态</span><span class="tt-val ${statusClass}">${r.status || '---'} ${escapeHtml(r.statusText || '')}</span>`,
    `<span class="tt-key">耗时</span><span class="tt-val">${r.duration ? Math.round(r.duration) + 'ms' : '...'}</span>`,
    `<span class="tt-key">大小</span><span class="tt-val">${r.size ? formatSize(r.size) : '...'}</span>`,
    `<span class="tt-key">类型</span><span class="tt-val">${escapeHtml(getTypeInfo(r.type).label)}</span>`,
  ];
  extras.forEach(([key, val, cls = '']) => {
    rows.push(`<span class="tt-key">${escapeHtml(key)}</span><span class="tt-val ${cls}">${val}</span>`);
  });
  return `
    <div class="tt-title">${escapeHtml(r.method)} ${escapeHtml(getShortUrl(r.url))}</div>
    <div class="tt-grid">${rows.join('')}</div>`;
}

function showRequestRowTooltip(r, event, extras) {
  if (!r || document.getElementById('detail-overlay')?.style.display === 'flex') return;
  showHoverTooltip(buildRequestTooltipRows(r, extras), event);
}

function scheduleRequestRowTooltip(r, event, extras) {
  if (hoverTipTimer) clearTimeout(hoverTipTimer);
  hoverTipTimer = setTimeout(() => showRequestRowTooltip(r, event, extras), 120);
}

// ============ 时间线视图 ============

function analyzeTimelineRequests(requests) {
  const items = requests.map(r => ({
    id: r.id,
    start: r.startTime,
    end: r.endTime,
    duration: Math.max(0, (r.endTime || r.startTime) - r.startTime),
    request: r,
    concurrentIds: new Set(),
  })).sort((a, b) => a.start - b.start || a.end - b.end);

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      if (b.start >= a.end) break;
      a.concurrentIds.add(b.id);
      b.concurrentIds.add(a.id);
    }
  }

  // 关键路径：按开始时间推进，优先延长“水位线”的请求
  let frontier = items.length ? items[0].start : 0;
  items.forEach(item => {
    item.isCritical = item.start >= frontier - 1;
    if (item.isCritical) frontier = Math.max(frontier, item.end);
  });

  let longest = items[0] || null;
  items.forEach(item => {
    if (!longest || item.duration > longest.duration) longest = item;
  });

  items.forEach(item => {
    item.isSerial = item.concurrentIds.size === 0;
    item.isLongest = !!longest && item.id === longest.id;
  });

  let peakConcurrent = 0;
  const events = [];
  items.forEach(item => {
    events.push({ t: item.start, delta: 1 });
    events.push({ t: item.end, delta: -1 });
  });
  events.sort((a, b) => a.t - b.t || a.delta - b.delta);
  let depth = 0;
  events.forEach(ev => {
    depth += ev.delta;
    peakConcurrent = Math.max(peakConcurrent, depth);
  });

  return {
    items,
    byId: new Map(items.map(item => [item.id, item])),
    peakConcurrent,
    serialCount: items.filter(item => item.isSerial).length,
    criticalCount: items.filter(item => item.isCritical).length,
    longest,
  };
}

function renderTimelineSummary(analysis, totalDuration) {
  const summary = document.getElementById('timeline-summary');
  if (!summary) return;
  const longest = analysis.longest;
  summary.innerHTML = `
    <span class="stat"><b>${Math.round(totalDuration)}ms</b><span>总时长</span></span>
    <span class="stat ok"><b>${analysis.peakConcurrent}</b><span>峰值并发</span></span>
    <span class="stat warn"><b>${analysis.serialCount}</b><span>串行</span></span>
    <span class="stat"><b>${analysis.criticalCount}</b><span>关键路径</span></span>
    <span class="stat time"><span>最长</span><b>${longest ? Math.round(longest.duration) + 'ms' : '-'}</b></span>
    <span class="timeline-legend">
      <span class="legend-item"><i class="legend-swatch critical"></i>关键路径</span>
      <span class="legend-item"><i class="legend-swatch serial"></i>串行</span>
      <span class="legend-item"><i class="legend-swatch longest"></i>最长</span>
    </span>`;
}

function highlightTimelineConcurrency(analysis, focusId) {
  const container = document.getElementById('timeline-container');
  if (!container) return;
  const focus = analysis.byId.get(focusId);
  container.querySelectorAll('.timeline-row').forEach(row => {
    const id = parseInt(row.dataset.id, 10);
    row.classList.remove('is-focus', 'is-concurrent', 'is-dimmed');
    if (!focus) return;
    if (id === focusId) {
      row.classList.add('is-focus');
      return;
    }
    if (focus.concurrentIds.has(id)) row.classList.add('is-concurrent');
    else row.classList.add('is-dimmed');
  });
}

function clearTimelineConcurrencyHighlight() {
  const container = document.getElementById('timeline-container');
  if (!container) return;
  container.querySelectorAll('.timeline-row').forEach(row => {
    row.classList.remove('is-focus', 'is-concurrent', 'is-dimmed');
  });
}

function showTimelineTooltip(r, event, extras) {
  if (!r || document.getElementById('detail-overlay')?.style.display === 'flex') return;
  showHoverTooltip(buildRequestTooltipRows(r, extras), event);
}

function renderTimeline() {
  const filtered = filterAndSortRequests(allRequests).filter(r => r.endTime);
  const container = document.getElementById('timeline-container');
  const summary = document.getElementById('timeline-summary');
  hideHoverTooltip();

  if (filtered.length === 0) {
    if (summary) summary.innerHTML = '';
    container.innerHTML = '<div class="empty-state"><div class="empty-symbol" aria-hidden="true">≡</div><div class="empty-title">暂无已完成的请求</div><div class="empty-hint">等待请求完成或刷新页面后查看瀑布图</div></div>';
    return;
  }

  const minTime = Math.min(...filtered.map(r => r.startTime));
  const maxTime = Math.max(...filtered.map(r => r.endTime));
  const totalDuration = maxTime - minTime || 1;
  const analysis = analyzeTimelineRequests(filtered);
  renderTimelineSummary(analysis, totalDuration);

  const tip = document.getElementById('hover-tooltip');
  if (tip) tip.dataset.minTime = String(minTime);

  let html = '<div class="timeline-header">';
  html += `<span class="timeline-label">0ms</span>`;
  html += `<span class="timeline-label">${Math.round(totalDuration)}ms</span>`;
  html += '</div>';
  html += '<div class="timeline-rows">';

  filtered.forEach((r) => {
    const startPct = ((r.startTime - minTime) / totalDuration) * 100;
    const widthPct = r.duration ? Math.max(((r.duration) / totalDuration) * 100, 1) : 2;
    const statusClass = r.status ? getStatusClass(r.status) : 'status-0';
    const shortUrl = getShortUrl(r.url);
    const typeInfo = getTypeInfo(r.type);
    const meta = analysis.byId.get(r.id);
    const rowClasses = ['timeline-row'];
    if (meta?.isCritical) rowClasses.push('is-critical');
    if (meta?.isSerial) rowClasses.push('is-serial');
    if (meta?.isLongest) rowClasses.push('is-longest');
    const metaLabel = meta?.isSerial ? '串行' : typeInfo.label;

    html += `<div class="${rowClasses.join(' ')}" data-id="${r.id}">
      <div class="timeline-label" title="${escapeHtml(r.url)}">${escapeHtml(shortUrl.slice(0, 26))}</div>
      <div class="timeline-bar-container">
        <div class="timeline-bar ${statusClass}" style="left:${startPct}%;width:${widthPct}%"></div>
      </div>
      <div class="timeline-meta">${metaLabel}</div>
    </div>`;
  });

  html += '</div>';
  container.innerHTML = html;

  container.querySelectorAll('.timeline-row').forEach(row => {
    const request = filtered.find(r => r.id === parseInt(row.dataset.id, 10));
    const meta = analysis.byId.get(request?.id);
    const extras = [];
    if (meta) {
      const offset = Math.max(0, Math.round(request.startTime - minTime));
      extras.push(['偏移', `+${offset}ms`]);
      extras.push([
        '并行',
        meta.isSerial ? '无（串行）' : `${meta.concurrentIds.size} 个`,
        meta.isSerial ? '' : 'status-2xx',
      ]);
      if (meta.isCritical) extras.push(['路径', '关键路径', 'status-2xx']);
      if (meta.isLongest) extras.push(['标记', '本段最长', 'status-3xx']);
    }

    row.addEventListener('mouseenter', (event) => {
      highlightTimelineConcurrency(analysis, request.id);
      showTimelineTooltip(request, event, extras);
    });
    row.addEventListener('mousemove', (event) => {
      showTimelineTooltip(request, event, extras);
    });
    row.addEventListener('mouseleave', () => {
      clearTimelineConcurrencyHighlight();
      hideHoverTooltip();
    });
    row.addEventListener('click', () => {
      clearTimelineConcurrencyHighlight();
      hideHoverTooltip();
      const id = parseInt(row.dataset.id, 10);
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
    list.innerHTML = '<div class="empty-state"><div class="empty-symbol" aria-hidden="true">◎</div><div class="empty-title">暂无 Mock 规则</div><div class="empty-hint">点击「新建规则」拦截匹配请求并返回自定义响应</div></div>';
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
        <span class="mock-pattern">${rule.isRegex ? '🔤' : '📝'} ${escapeHtml(rule.method || '*')} ${escapeHtml(rule.pattern)}</span>
        <span class="mock-status">${rule.action === 'error' ? '错误' : rule.status} · P${rule.priority || 0}</span>
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

function refreshTagOptions() {
  const datalist = document.getElementById('tag-options');
  if (!datalist) return;
  const tags = new Set();
  allRequests.forEach(r => (r.tags || []).forEach(tag => tags.add(tag)));
  datalist.innerHTML = Array.from(tags).sort().map(tag => `<option value="${escapeHtml(tag)}"></option>`).join('');
}

function openMockEditorFromRequest(request) {
  let path = request.url;
  try {
    const u = new URL(request.url);
    path = u.pathname;
  } catch {}
  openMockEditor({
    name: `Mock ${request.method} ${getShortUrl(request.url)}`,
    pattern: path,
    isRegex: false,
    method: request.method,
    status: request.status && request.status >= 200 && request.status < 300 ? request.status : 200,
    priority: 10,
    action: 'respond',
    delay: 0,
    headers: request.responseHeaders || { 'content-type': 'application/json' },
    body: request.responseBody || '{"code":0,"data":{}}',
    matchQuery: {},
    matchHeaders: {},
    matchBody: '',
    error: 'Mock Network Error',
  });
  document.getElementById('mock-edit-title').textContent = '从当前请求创建 Mock';
  showToast('已按当前请求预填 Mock，请确认后保存');
}

function showBatchReplayResults(results) {
  const failed = results.filter(item => item.error).length;
  const passed = results.length - failed;
  let html = `<div class="batch-summary">
    <span class="stat ok"><b>${passed}</b><span>成功</span></span>
    <span class="stat err"><b>${failed}</b><span>失败</span></span>
    <span class="stat"><b>${results.length}</b><span>合计</span></span>
  </div>`;
  html += results.map(item => {
    const statusClass = item.error ? 'status-0' : getStatusClass(item.status);
    const statusText = item.error ? '失败' : (item.status || '---');
    return `<div class="batch-item">
      <span class="batch-status ${statusClass}">${statusText}</span>
      <span class="batch-url" title="${escapeHtml(item.url || '')}">${escapeHtml(getShortUrl(item.url || ''))}</span>
      <span class="batch-detail">${item.error ? escapeHtml(item.error) : escapeHtml(item.statusText || '')}</span>
    </div>`;
  }).join('') || '<div class="no-data">没有可展示的结果</div>';
  document.getElementById('batch-replay-content').innerHTML = html;
  document.getElementById('batch-replay-overlay').style.display = 'flex';
  showToast(`批量重放完成：成功 ${passed}，失败 ${failed}`);
}

// ============ 请求右键菜单 ============

function hideContextMenu() {
  const menu = document.getElementById('context-menu');
  if (menu) menu.hidden = true;
}

function bindContextMenu() {
  const menu = document.getElementById('context-menu');
  if (!menu) return;
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target)) hideContextMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideContextMenu();
  });
  window.addEventListener('blur', hideContextMenu);
}

function openRequestContextMenu(id, x, y) {
  const request = findRequestById(id);
  const menu = document.getElementById('context-menu');
  if (!request || !menu) return;

  if (!selectedIds.has(id)) {
    selectedIds.clear();
    selectedIds.add(id);
    document.querySelectorAll('#request-list .request-item').forEach(i => {
      i.classList.toggle('selected', parseInt(i.dataset.id, 10) === id);
    });
  }

  let domain = '';
  try { domain = new URL(request.url).hostname; } catch {}

  menu.innerHTML = `
    <button data-act="detail">打开详情</button>
    <button data-act="curl">复制 cURL</button>
    <button data-act="url">复制 URL</button>
    <button data-act="star">${request.starred ? '取消收藏' : '收藏'}</button>
    <button data-act="mock">Mock 此请求</button>
    <button data-act="filter-domain" ${domain ? '' : 'disabled'}>过滤同域名${domain ? `（${escapeHtml(domain)}）` : ''}</button>
    <button data-act="toggle-select">多选 / 取消多选</button>
    <button data-act="compare">对比所选（≥2）</button>
  `;

  menu.hidden = false;
  const pad = 8;
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - pad);
  const top = Math.min(y, window.innerHeight - rect.height - pad);
  menu.style.left = `${Math.max(pad, left)}px`;
  menu.style.top = `${Math.max(pad, top)}px`;

  menu.onclick = (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    hideContextMenu();
    if (act === 'detail') showDetail(id);
    else if (act === 'curl') {
      const curl = generateCurl(request);
      navigator.clipboard.writeText(curl).then(() => showToast('已复制 cURL'));
    } else if (act === 'url') {
      navigator.clipboard.writeText(request.url).then(() => showToast('已复制 URL'));
    } else if (act === 'star') {
      chrome.runtime.sendMessage({ type: 'TOGGLE_STAR', data: { id } }, () => {
        const local = findRequestById(id);
        if (local) local.starred = !local.starred;
        renderRequests({ incremental: true });
        showToast(local?.starred ? '已收藏' : '已取消收藏');
      });
    } else if (act === 'mock') {
      currentView = 'mock';
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'mock'));
      updateViewVisibility();
      renderMockRules();
      openMockEditorFromRequest(request);
    } else if (act === 'filter-domain' && domain) {
      document.getElementById('filter-url').value = domain;
      renderRequests();
      showToast(`已过滤：${domain}`);
    } else if (act === 'toggle-select') {
      if (selectedIds.has(id)) selectedIds.delete(id);
      else selectedIds.add(id);
      renderRequests({ incremental: true });
      if (selectedIds.size >= 2) showCompare();
    } else if (act === 'compare') {
      if (!selectedIds.has(id)) selectedIds.add(id);
      renderRequests({ incremental: true });
      if (selectedIds.size >= 2) showCompare();
      else showToast('请再 Ctrl/⌘ 选择至少 1 条');
    }
  };
}

// ============ 场景结果 ============

function bindScenarioResultEvents() {
  const close = document.getElementById('btn-close-scenario');
  const overlay = document.getElementById('scenario-overlay');
  if (!close || !overlay) return;
  close.addEventListener('click', () => { overlay.style.display = 'none'; });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.style.display = 'none';
  });
}

function showScenarioResults(results, scenarioId) {
  const passed = results.filter(item => item.passed).length;
  const failed = results.length - passed;
  let html = `<div class="batch-summary">
    <span class="stat ok"><b>${passed}</b><span>通过</span></span>
    <span class="stat err"><b>${failed}</b><span>失败</span></span>
    <span class="stat"><b>${results.length}</b><span>步骤</span></span>
  </div>`;
  html += results.map((item, index) => {
    const failures = (item.failures || []).join('；') || (item.passed ? '全部断言通过' : '未通过');
    return `<div class="batch-item ${item.passed ? 'is-pass' : 'is-fail'}">
      <span class="batch-status ${item.passed ? 'status-2xx' : 'status-5xx'}">${item.passed ? 'PASS' : 'FAIL'}</span>
      <span class="batch-url" title="${escapeHtml(item.url || '')}">${index + 1}. ${escapeHtml(getShortUrl(item.url || `#${item.id}`))}</span>
      <span class="batch-detail">${escapeHtml(failures)}</span>
    </div>`;
  }).join('') || '<div class="no-data">没有步骤结果</div>';
  document.getElementById('scenario-content').innerHTML = html;
  document.getElementById('scenario-overlay').style.display = 'flex';
  showToast(`场景完成：${passed}/${results.length} 通过`);
}

// ============ Mock 导入导出 ============

function bindMockTransferEvents() {
  document.getElementById('btn-export-mocks')?.addEventListener('click', () => {
    if (currentRuleTab !== 'mock') {
      const rules = advancedRules[currentRuleTab] || [];
      downloadFile(JSON.stringify({ version: 1, kind: currentRuleTab, rules }, null, 2), 'application/json',
        `netcatcher-${currentRuleTab}-rules.json`);
      showToast(`已导出 ${rules.length} 条规则`);
      return;
    }
    chrome.runtime.sendMessage({ type: 'GET_MOCK_RULES' }, res => {
      const rules = res?.rules || mockRules || [];
      downloadFile(JSON.stringify({ version: 1, rules }, null, 2), 'application/json',
        `netcatcher-mocks-${new Date().toISOString().slice(0, 10)}.json`);
      showToast(`已导出 ${rules.length} 条 Mock 规则`);
    });
  });
  document.getElementById('btn-import-mocks')?.addEventListener('click', () => {
    document.getElementById('mock-file-input')?.click();
  });
  document.getElementById('mock-file-input')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const rules = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.rules) ? parsed.rules : []);
      if (!rules.length) { showToast('文件中没有规则'); return; }
      if (currentRuleTab === 'mock' || !parsed.kind) {
        chrome.runtime.sendMessage({ type: 'IMPORT_MOCK_RULES', data: { rules } }, res => {
          if (res?.error) { showToast(res.error); return; }
          loadRequests();
          showToast(`已导入 ${res?.count || rules.length} 条 Mock 规则`);
        });
        return;
      }
      let done = 0;
      rules.forEach(rule => {
        chrome.runtime.sendMessage({ type: 'ADD_ADVANCED_RULE', data: { ...rule, kind: currentRuleTab } }, () => {
          done += 1;
          if (done === rules.length) {
            loadAdvancedRules().then(renderAdvancedRules);
            showToast(`已导入 ${done} 条规则`);
          }
        });
      });
    } catch {
      showToast('规则文件格式无效');
    }
  });
}

// ============ 高级规则（改写/映射/限速/断点/环境/脚本） ============

const RULE_META = {
  mock: { title: 'Mock', hint: '匹配的请求直接返回自定义响应', create: true },
  rewrite: { title: '改写', hint: '修改请求 URL/方法/头/体后再发出', create: true },
  mapLocal: { title: '本地映射', hint: '像本地文件一样返回固定响应体', create: true },
  throttle: { title: '限速', hint: '注入延迟或按概率失败', create: true },
  breakpoint: { title: '断点', hint: '命中后暂停，可改写或中止', create: true },
  hostMap: { title: '环境映射', hint: '将请求主机映射到测试环境', create: true },
  script: { title: '脚本', hint: '用 JS 改写响应 body（body 为入参，可改写后 return）', create: true },
  pending: { title: '挂起断点', hint: '正在等待放行的请求', create: false },
};

function loadAdvancedRules() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'GET_ADVANCED_RULES' }, res => {
      if (res && !res.error) {
        advancedRules = {
          rewrite: res.rewriteRules || [],
          mapLocal: res.mapLocalRules || [],
          throttle: res.throttleRules || [],
          breakpoint: res.breakpointRules || [],
          hostMap: res.hostMapRules || [],
          script: res.scriptRules || [],
          pending: res.pendingBreakpoints || [],
        };
        const badge = document.getElementById('pending-count');
        if (badge) badge.textContent = String(advancedRules.pending.length);
      }
      resolve();
    });
  });
}

function bindAdvancedRulesUI() {
  document.querySelectorAll('.rules-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      currentRuleTab = btn.dataset.ruleTab;
      document.querySelectorAll('.rules-tab').forEach(b => b.classList.toggle('active', b === btn));
      const meta = RULE_META[currentRuleTab];
      const hint = document.getElementById('rules-hint');
      const addBtn = document.getElementById('btn-add-mock');
      if (hint) hint.textContent = meta.hint;
      if (addBtn) {
        addBtn.style.display = meta.create ? '' : 'none';
        addBtn.textContent = currentRuleTab === 'mock' ? '新建规则' : `新建${meta.title}`;
      }
      if (currentRuleTab === 'mock') renderMockRules();
      else {
        loadAdvancedRules().then(renderAdvancedRules);
      }
    });
  });

  document.getElementById('btn-add-mock').addEventListener('click', () => {
    if (currentRuleTab === 'mock') openMockEditor();
    else openAdvancedRuleEditor(currentRuleTab);
  });
}

function renderAdvancedRules() {
  const list = document.getElementById('mock-list');
  if (!list) return;
  if (currentRuleTab === 'pending') {
    if (!advancedRules.pending.length) {
      list.innerHTML = '<div class="empty-state"><div class="empty-symbol">⏸</div><div class="empty-title">暂无挂起请求</div><div class="empty-hint">命中「断点」规则后会出现在这里</div></div>';
      return;
    }
    list.innerHTML = advancedRules.pending.map(item => `
      <div class="mock-item" data-id="${escapeHtml(item.id)}">
        <div class="mock-item-header">
          <span class="mock-name">${escapeHtml(item.snapshot?.method || 'GET')} ${escapeHtml(getShortUrl(item.snapshot?.url || ''))}</span>
          <div class="mock-actions">
            <button class="btn btn-small btn-green bp-resume" data-id="${escapeHtml(item.id)}">继续</button>
            <button class="btn btn-small btn-red bp-abort" data-id="${escapeHtml(item.id)}">中止</button>
          </div>
        </div>
        <div class="mock-item-detail">
          <span class="mock-pattern">${escapeHtml(item.snapshot?.url || '')}</span>
          <span class="mock-status">${new Date(item.createdAt).toLocaleTimeString()}</span>
        </div>
      </div>`).join('');
    list.querySelectorAll('.bp-resume').forEach(btn => btn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'RESUME_BREAKPOINT', data: { id: btn.dataset.id, action: 'continue' } }, () => {
        loadAdvancedRules().then(renderAdvancedRules);
        showToast('已放行');
      });
    }));
    list.querySelectorAll('.bp-abort').forEach(btn => btn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'RESUME_BREAKPOINT', data: { id: btn.dataset.id, action: 'abort' } }, () => {
        loadAdvancedRules().then(renderAdvancedRules);
        showToast('已中止');
      });
    }));
    return;
  }

  const rules = advancedRules[currentRuleTab] || [];
  if (!rules.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-symbol">◎</div><div class="empty-title">暂无${RULE_META[currentRuleTab]?.title || ''}规则</div><div class="empty-hint">${RULE_META[currentRuleTab]?.hint || ''}</div></div>`;
    return;
  }

  list.innerHTML = rules.map(rule => {
    const detail = currentRuleTab === 'rewrite'
      ? `→ ${escapeHtml(rule.replaceUrl || '(仅改写头/体)')}`
      : currentRuleTab === 'mapLocal'
        ? `${rule.status} · ${String(rule.body || '').slice(0, 40)}`
        : currentRuleTab === 'throttle'
          ? `延迟 ${rule.delayMs || 0}ms · 失败率 ${Math.round((rule.errorRate || 0) * 100)}%`
          : currentRuleTab === 'hostMap'
            ? `→ ${escapeHtml(rule.toHost || '')}`
            : currentRuleTab === 'script'
              ? escapeHtml(String(rule.script || '').slice(0, 60))
              : `${escapeHtml(rule.method || '*')} ${escapeHtml(rule.pattern || '')}`;
    return `<div class="mock-item" data-id="${rule.id}">
      <div class="mock-item-header">
        <label class="mock-toggle">
          <input type="checkbox" ${rule.enabled ? 'checked' : ''} data-id="${rule.id}">
          <span class="mock-name">${escapeHtml(rule.name || rule.pattern || '规则')}</span>
        </label>
        <div class="mock-actions">
          <button class="btn btn-small adv-edit" data-id="${rule.id}">编辑</button>
          <button class="btn btn-small btn-red adv-del" data-id="${rule.id}">删除</button>
        </div>
      </div>
      <div class="mock-item-detail">
        <span class="mock-pattern">${detail}</span>
        <span class="mock-status">P${rule.priority || 0}</span>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.mock-toggle input').forEach(input => {
    input.addEventListener('change', () => {
      chrome.runtime.sendMessage({ type: 'TOGGLE_ADVANCED_RULE', data: { kind: currentRuleTab, id: Number(input.dataset.id) } }, () => {
        loadAdvancedRules().then(renderAdvancedRules);
      });
    });
  });
  list.querySelectorAll('.adv-edit').forEach(btn => btn.addEventListener('click', () => {
    const rule = (advancedRules[currentRuleTab] || []).find(r => r.id === Number(btn.dataset.id));
    if (rule) openAdvancedRuleEditor(currentRuleTab, rule);
  }));
  list.querySelectorAll('.adv-del').forEach(btn => btn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'DELETE_ADVANCED_RULE', data: { kind: currentRuleTab, id: Number(btn.dataset.id) } }, () => {
      loadAdvancedRules().then(renderAdvancedRules);
      showToast('规则已删除');
    });
  }));
}

function openAdvancedRuleEditor(kind, rule = null) {
  const title = `${rule ? '编辑' : '新建'}${RULE_META[kind]?.title || '规则'}`;
  let extra = '';
  if (kind === 'rewrite') {
    extra = `
      <div class="form-row"><label>替换 URL</label><input id="adv-replace-url" class="control" value="${escapeHtml(rule?.replaceUrl || '')}" placeholder="可选，支持正则捕获"></div>
      <div class="form-row"><label>覆盖方法</label>
        <select id="adv-method-override" class="control">
          <option value="*">不改</option>
          ${['GET','POST','PUT','PATCH','DELETE'].map(m => `<option ${rule?.methodOverride === m ? 'selected' : ''}>${m}</option>`).join('')}
        </select>
      </div>
      <div class="form-row"><label>Header 操作 JSON</label>
        <textarea id="adv-header-ops" class="control textarea" rows="3" placeholder='[{"op":"set","name":"x-debug","value":"1"}]'>${escapeHtml(JSON.stringify(rule?.headerOps || [], null, 2))}</textarea>
      </div>
      <div class="form-row"><label>Body 替换 JSON</label>
        <textarea id="adv-body-ops" class="control textarea" rows="3" placeholder='[{"find":"a","replace":"b"}]'>${escapeHtml(JSON.stringify(rule?.bodyReplacements || [], null, 2))}</textarea>
      </div>`;
  } else if (kind === 'mapLocal') {
    extra = `
      <div class="form-row"><label>状态码</label><input id="adv-status" type="number" class="control" value="${rule?.status || 200}"></div>
      <div class="form-row"><label>响应头 JSON</label><input id="adv-headers" class="control" value="${escapeHtml(JSON.stringify(rule?.headers || { 'content-type': 'application/json' }))}"></div>
      <div class="form-row"><label>响应体</label><textarea id="adv-body" class="control textarea" rows="5">${escapeHtml(rule?.body || '{"code":0}')}</textarea></div>
      <div class="form-row"><label>延迟 ms</label><input id="adv-delay" type="number" class="control" value="${rule?.delay || 0}"></div>`;
  } else if (kind === 'throttle') {
    extra = `
      <div class="form-row"><label>延迟 ms</label><input id="adv-delay-ms" type="number" class="control" value="${rule?.delayMs || 800}"></div>
      <div class="form-row"><label>失败率 0-1</label><input id="adv-error-rate" type="number" step="0.1" min="0" max="1" class="control" value="${rule?.errorRate || 0}"></div>
      <div class="form-row"><label>失败文案</label><input id="adv-error-msg" class="control" value="${escapeHtml(rule?.errorMessage || 'Throttled network error')}"></div>`;
  } else if (kind === 'hostMap') {
    extra = `<div class="form-row"><label>目标主机</label><input id="adv-to-host" class="control" value="${escapeHtml(rule?.toHost || '')}" placeholder="api.test.com 或 https://api.test.com"></div>`;
  } else if (kind === 'script') {
    extra = `<div class="form-row"><label>响应脚本（body 入参）</label>
      <textarea id="adv-script" class="control textarea" rows="6" placeholder="if (body.includes('\"code\":1')) body = body.replace('\"code\":1','\"code\":0');">${escapeHtml(rule?.script || '')}</textarea></div>`;
  }

  const overlay = document.createElement('div');
  overlay.className = 'detail-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div class="detail-panel save-filter-panel" style="max-height:520px">
      <div class="detail-header">
        <span class="detail-title">${title}</span>
        <div class="detail-actions">
          <button class="btn btn-primary" id="adv-save">保存</button>
          <button class="btn-close" id="adv-close">✕</button>
        </div>
      </div>
      <div class="mock-edit-form">
        <div class="form-row"><label>名称</label><input id="adv-name" class="control" value="${escapeHtml(rule?.name || '')}"></div>
        <div class="form-row"><label>URL 匹配</label><input id="adv-pattern" class="control" value="${escapeHtml(rule?.pattern || '')}" placeholder="片段或正则"></div>
        <div class="form-row form-row-inline"><label><input type="checkbox" id="adv-regex" ${rule?.isRegex ? 'checked' : ''}> 正则</label></div>
        <div class="form-grid">
          <div class="form-row"><label>方法</label>
            <select id="adv-method" class="control">
              <option value="*">全部</option>
              ${['GET','POST','PUT','PATCH','DELETE'].map(m => `<option ${rule?.method === m ? 'selected' : ''}>${m}</option>`).join('')}
            </select>
          </div>
          <div class="form-row"><label>优先级</label><input id="adv-priority" type="number" class="control" value="${rule?.priority || 0}"></div>
        </div>
        ${extra}
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#adv-close').onclick = close;
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('#adv-save').onclick = () => {
    const payload = {
      kind,
      id: rule?.id,
      name: overlay.querySelector('#adv-name').value,
      pattern: overlay.querySelector('#adv-pattern').value,
      isRegex: overlay.querySelector('#adv-regex').checked,
      method: overlay.querySelector('#adv-method').value,
      priority: overlay.querySelector('#adv-priority').value,
      enabled: rule ? rule.enabled : true,
    };
    try {
      if (kind === 'rewrite') {
        payload.replaceUrl = overlay.querySelector('#adv-replace-url').value;
        payload.methodOverride = overlay.querySelector('#adv-method-override').value;
        payload.headerOps = JSON.parse(overlay.querySelector('#adv-header-ops').value || '[]');
        payload.bodyReplacements = JSON.parse(overlay.querySelector('#adv-body-ops').value || '[]');
      } else if (kind === 'mapLocal') {
        payload.status = overlay.querySelector('#adv-status').value;
        payload.headers = JSON.parse(overlay.querySelector('#adv-headers').value || '{}');
        payload.body = overlay.querySelector('#adv-body').value;
        payload.delay = overlay.querySelector('#adv-delay').value;
      } else if (kind === 'throttle') {
        payload.delayMs = overlay.querySelector('#adv-delay-ms').value;
        payload.errorRate = overlay.querySelector('#adv-error-rate').value;
        payload.errorMessage = overlay.querySelector('#adv-error-msg').value;
      } else if (kind === 'hostMap') {
        payload.toHost = overlay.querySelector('#adv-to-host').value;
      } else if (kind === 'script') {
        payload.script = overlay.querySelector('#adv-script').value;
      }
    } catch {
      showToast('JSON 配置格式无效');
      return;
    }
    const type = rule ? 'UPDATE_ADVANCED_RULE' : 'ADD_ADVANCED_RULE';
    chrome.runtime.sendMessage({ type, data: payload }, res => {
      if (res?.error) { showToast(res.error); return; }
      close();
      loadAdvancedRules().then(renderAdvancedRules);
      showToast('规则已保存');
    });
  };
}

// ============ 统计 / 基线 / 会话包 / 快捷键 ============

function bindStatsAndBaseline() {
  const statsOverlay = document.getElementById('stats-overlay');
  const baselineOverlay = document.getElementById('baseline-overlay');
  document.getElementById('btn-show-stats')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'GET_STATS' }, res => {
      const s = res?.stats;
      if (!s) return;
      document.getElementById('stats-content').innerHTML = `
        <div class="batch-summary">
          <span class="stat"><b>${s.total}</b><span>请求</span></span>
          <span class="stat err"><b>${s.errors}</b><span>异常</span></span>
          <span class="stat time"><span>均耗时</span><b>${s.avgDuration}ms</b></span>
        </div>
        <div class="header-section-title">Top 主机</div>
        ${s.topHosts.map(([k, v]) => `<div class="batch-item"><span class="batch-status">${v}</span><span class="batch-url">${escapeHtml(k)}</span><span></span></div>`).join('')}
        <div class="header-section-title">Top 路径</div>
        ${s.topPaths.map(([k, v]) => `<div class="batch-item"><span class="batch-status">${v}</span><span class="batch-url">${escapeHtml(k)}</span><span></span></div>`).join('')}
        <div class="header-section-title">最慢请求</div>
        ${s.slowest.map(item => `<div class="batch-item"><span class="batch-status">${Math.round(item.duration)}ms</span><span class="batch-url">${escapeHtml(item.method)} ${escapeHtml(getShortUrl(item.url))}</span><span class="batch-detail">${item.status || '---'}</span></div>`).join('')}
      `;
      statsOverlay.style.display = 'flex';
    });
  });
  document.getElementById('btn-close-stats')?.addEventListener('click', () => { statsOverlay.style.display = 'none'; });
  statsOverlay?.addEventListener('click', e => { if (e.target === statsOverlay) statsOverlay.style.display = 'none'; });

  document.getElementById('btn-pin-baseline')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'PIN_BASELINE', data: { ids: selectedIds.size ? Array.from(selectedIds) : null } }, res => {
      if (res?.ok) showToast(`已钉住基线 ${res.count} 条`);
    });
  });
  document.getElementById('btn-compare-baseline')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'COMPARE_BASELINE' }, res => {
      if (res?.error) { showToast(res.error); return; }
      document.getElementById('baseline-content').innerHTML = `
        <div class="batch-summary">
          <span class="stat"><b>${res.baselineCount}</b><span>基线</span></span>
          <span class="stat warn"><b>${res.diffs?.length || 0}</b><span>差异</span></span>
        </div>
        ${(res.diffs || []).map(d => `<div class="batch-item">
          <span class="batch-status ${d.type === 'added' ? 'status-3xx' : 'status-4xx'}">${d.type === 'added' ? 'NEW' : 'Δ'}</span>
          <span class="batch-url">${escapeHtml(d.key)}</span>
          <span class="batch-detail">${d.statusChanged ? `${d.baseStatus}→${d.status}` : (d.bodyChanged ? 'body 变化' : '')}</span>
        </div>`).join('') || '<div class="no-data">无差异</div>'}
      `;
      baselineOverlay.style.display = 'flex';
    });
  });
  document.getElementById('btn-close-baseline')?.addEventListener('click', () => { baselineOverlay.style.display = 'none'; });
  baselineOverlay?.addEventListener('click', e => { if (e.target === baselineOverlay) baselineOverlay.style.display = 'none'; });
}

function bindSessionPackage() {
  document.getElementById('btn-export-session')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'EXPORT_SESSION_PACKAGE' }, res => {
      if (!res?.package) return;
      downloadFile(JSON.stringify(res.package, null, 2), 'application/json',
        `netcatcher-session-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`);
      showToast('会话包已导出');
    });
  });
  document.getElementById('btn-import-session')?.addEventListener('click', () => {
    document.getElementById('session-file-input')?.click();
  });
  document.getElementById('session-file-input')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const pack = JSON.parse(await file.text());
      chrome.runtime.sendMessage({ type: 'IMPORT_SESSION_PACKAGE', data: { package: pack } }, res => {
        if (res?.error) { showToast(res.error); return; }
        loadRequests();
        showToast(`会话包已导入（${res?.count || 0} 条请求）`);
      });
    } catch {
      showToast('会话包格式无效');
    }
  });
}

function bindShortcutsHelp() {
  const overlay = document.getElementById('shortcuts-overlay');
  document.getElementById('btn-shortcuts')?.addEventListener('click', () => {
    overlay.style.display = 'flex';
  });
  document.getElementById('btn-close-shortcuts')?.addEventListener('click', () => {
    overlay.style.display = 'none';
  });
  overlay?.addEventListener('click', e => {
    if (e.target === overlay) overlay.style.display = 'none';
  });
}

function openMockEditor(rule) {
  document.getElementById('mock-edit-title').textContent = rule ? '编辑 Mock 规则' : '添加 Mock 规则';
  document.getElementById('mock-name').value = rule?.name || '';
  document.getElementById('mock-pattern').value = rule?.pattern || '';
  document.getElementById('mock-is-regex').checked = rule?.isRegex || false;
  document.getElementById('mock-method').value = rule?.method || '*';
  document.getElementById('mock-priority').value = rule?.priority || 0;
  document.getElementById('mock-action').value = rule?.action || 'respond';
  document.getElementById('mock-error').value = rule?.error || 'Mock Network Error';
  document.getElementById('mock-match-query').value = JSON.stringify(rule?.matchQuery || {});
  document.getElementById('mock-match-headers').value = JSON.stringify(rule?.matchHeaders || {});
  document.getElementById('mock-match-body').value = rule?.matchBody || '';
  document.getElementById('mock-delay').value = rule?.delay || 0;
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
  let matchQuery = {};
  let matchHeaders = {};
  try { matchQuery = JSON.parse(document.getElementById('mock-match-query').value || '{}'); } catch {}
  try { matchHeaders = JSON.parse(document.getElementById('mock-match-headers').value || '{}'); } catch {}

  const data = {
    name: document.getElementById('mock-name').value.trim(),
    pattern,
    isRegex: document.getElementById('mock-is-regex').checked,
    method: document.getElementById('mock-method').value,
    priority: parseInt(document.getElementById('mock-priority').value, 10) || 0,
    action: document.getElementById('mock-action').value,
    error: document.getElementById('mock-error').value.trim(),
    matchQuery,
    matchHeaders,
    matchBody: document.getElementById('mock-match-body').value,
    delay: Math.max(0, parseInt(document.getElementById('mock-delay').value, 10) || 0),
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

  const statusEl = document.getElementById('detail-status');
  if (statusEl) {
    const statusClass = r.status ? getStatusClass(r.status) : 'status-0';
    statusEl.textContent = r.status || '---';
    statusEl.className = `overview-val ${statusClass}`;
  }
  const durationEl = document.getElementById('detail-duration');
  if (durationEl) durationEl.textContent = r.duration ? `${Math.round(r.duration)}ms` : '—';
  const sizeEl = document.getElementById('detail-size');
  if (sizeEl) sizeEl.textContent = r.size ? formatSize(r.size) : '—';
  const typeEl = document.getElementById('detail-type');
  if (typeEl) {
    const typeInfo = getTypeInfo(r.type);
    typeEl.innerHTML = `<span class="req-type ${typeInfo.cls}">${typeInfo.label}</span>`;
  }
  const urlBox = document.getElementById('detail-url-box');
  if (urlBox) {
    urlBox.textContent = r.url;
    urlBox.title = r.url;
  }

  let headersHtml = '';
  if (r.graphql) {
    headersHtml += `<div class="header-section-title">GraphQL</div><table class="header-table">
      <tr><td>操作名</td><td>${escapeHtml(r.graphql.operationName || '匿名操作')}</td></tr>
      <tr><td>Query</td><td><pre class="graphql-query">${escapeHtml(r.graphql.query)}</pre></td></tr>
    </table>`;
  }

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

  document.getElementById('tab-headers').innerHTML = headersHtml || '<div class="no-data">暂无 Header 信息</div>';
  document.getElementById('tab-request').innerHTML = r.requestBody ?
    `<div class="body-content">${formatBody(r.requestBody)}</div>` : '<div class="no-data">无请求体</div>';
  document.getElementById('tab-response').innerHTML = r.responseBody ?
    `<div class="body-content">${formatBody(r.responseBody)}</div>` : '<div class="no-data">无响应体</div>';

  // 响应预览
  renderPreview(r);
  document.getElementById('detail-tags').value = (r.tags || []).join(', ');
  document.getElementById('detail-tags').onchange = event => {
    const tags = event.target.value.split(',').map(tag => tag.trim()).filter(Boolean);
    chrome.runtime.sendMessage({ type: 'UPDATE_TAGS', data: { id: r.id, tags } });
  };
  const assertions = r.assertions || {};
  document.getElementById('assert-status').value = assertions.status ?? '';
  document.getElementById('assert-duration').value = assertions.maxDurationMs ?? '';
  document.getElementById('assert-json').value = (assertions.jsonChecks || [])
    .map(check => `${check.path}=${check.expected}`).join('\n');
  document.getElementById('btn-star').textContent = r.starred ? '已收藏' : '收藏';
  document.getElementById('btn-star').classList.toggle('active', !!r.starred);

  const replayMethod = document.getElementById('replay-method');
  replayMethod.innerHTML = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']
    .map(method => `<option ${method === r.method ? 'selected' : ''}>${method}</option>`).join('');
  document.getElementById('replay-headers').value = JSON.stringify(r.requestHeaders || {}, null, 2);
  document.getElementById('replay-body').value = r.requestBody || '';
  replayDefaults = {
    id: r.id,
    method: replayMethod.value,
    headers: document.getElementById('replay-headers').value,
    body: document.getElementById('replay-body').value,
  };
  document.getElementById('replay-output').innerHTML = '<div class="no-data">点击「重放」测试请求，结果会显示在这里</div>';

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
    preview.innerHTML = `<div class="preview-json"><div class="json-tree">${formatJsonTree(r.responseBody)}</div><div class="body-content">${formatBody(r.responseBody)}</div></div>`;
    return;
  }

  // HTML 预览
  if (contentType.includes('html')) {
    preview.innerHTML = `<div class="preview-html"><iframe srcdoc="${escapeHtml(r.responseBody)}" sandbox="allow-same-origin"></iframe></div>`;
    return;
  }

  // 图片预览
  if (contentType.includes('image')) {
    if (r.bodyEncoding === 'base64' && r.responseBody) {
      const mimeType = r.bodyMimeType || r.responseHeaders?.['content-type']?.split(';', 1)[0] || 'image/*';
      preview.innerHTML = `<div class="preview-image"><img src="data:${escapeHtml(mimeType)};base64,${escapeHtml(r.responseBody)}" alt="预览"><div class="no-data" style="display:none">图片加载失败</div></div>`;
      const image = preview.querySelector('img');
      image.addEventListener('error', () => {
        image.style.display = 'none';
        image.nextElementSibling.style.display = 'block';
      });
    } else {
      preview.innerHTML = '<div class="no-data">图片响应未保留在捕获大小限制内</div>';
    }
    return;
  }

  // 文本预览
  preview.innerHTML = `<div class="body-content">${escapeHtml(r.responseBody)}</div>`;
}

// ============ WebSocket ============

const EMPTY_WS_HTML = `
  <div class="empty-state" id="ws-empty-state">
    <div class="empty-symbol" aria-hidden="true">⬡</div>
    <div class="empty-title">等待 WebSocket 连接</div>
    <div class="empty-hint">页面建立 WS 连接后可查看收发消息并重放</div>
  </div>`;

function renderWsConnections() {
  const list = document.getElementById('ws-list');
  document.getElementById('ws-count').textContent = allWsConnections.length;
  const query = document.getElementById('ws-filter').value.toLowerCase();
  const connections = allWsConnections.filter(conn => !query || conn.url.toLowerCase().includes(query) ||
    (conn.messages || []).some(message => String(message.data).toLowerCase().includes(query)));

  if (connections.length === 0) {
    list.innerHTML = EMPTY_WS_HTML;
    return;
  }

  list.innerHTML = connections.map(conn => {
    const statusClass = conn.status === 'open' ? 'ws-open' : (conn.status === 'error' ? 'ws-error' : (conn.status === 'connecting' ? 'ws-connecting' : 'ws-closed'));
    const msgCount = conn.messageCount ? (conn.messageCount.send + conn.messageCount.receive) : (conn.messages || []).length;
    return `<div class="ws-item" data-id="${escapeHtml(conn.id)}">
      <span class="ws-status ${statusClass}">${conn.status === 'open' ? '已连接' : (conn.status === 'connecting' ? '连接中' : (conn.status === 'error' ? '错误' : '已关闭'))}</span>
      <span class="ws-url" title="${escapeHtml(conn.url)}">${escapeHtml(getShortUrl(conn.url))}</span>
      <span class="ws-messages">📨 ${msgCount}</span>
      <span class="ws-duration">${conn.duration ? formatDuration(conn.duration) : (conn.status === 'open' ? '运行中' : '...')}</span>
    </div>`;
  }).join('');

  list.querySelectorAll('.ws-item').forEach(item => {
    item.addEventListener('click', () => {
      showWsDetail(item.dataset.id);
    });
  });
}

function showWsDetail(id) {
  const conn = allWsConnections.find(c => String(c.id) === String(id));
  if (!conn) return;
  selectedWsId = conn.id;

  document.getElementById('ws-detail-title').textContent = `WebSocket: ${getShortUrl(conn.url)}`;

  let infoHtml = '<table class="header-table">';
  infoHtml += `<tr><td>URL</td><td>${escapeHtml(conn.url)}</td></tr>`;
  infoHtml += `<tr><td>状态</td><td><span class="ws-status ${conn.status === 'open' ? 'ws-open' : 'ws-closed'}">${conn.status}</span></td></tr>`;
  if (conn.protocols) infoHtml += `<tr><td>协议</td><td>${escapeHtml(conn.protocols)}</td></tr>`;
  if (conn.closeCode) infoHtml += `<tr><td>关闭代码</td><td>${conn.closeCode}</td></tr>`;
  if (conn.closeReason) infoHtml += `<tr><td>关闭原因</td><td>${escapeHtml(conn.closeReason)}</td></tr>`;
  const messageCount = conn.messageCount || { send: 0, receive: 0 };
  infoHtml += `<tr><td>消息数</td><td>发送: ${messageCount.send}, 接收: ${messageCount.receive}</td></tr>`;
  infoHtml += '</table>';
  document.getElementById('ws-info').innerHTML = infoHtml;

  const query = document.getElementById('ws-filter').value.toLowerCase();
  const direction = document.getElementById('ws-direction').value;
  const messages = (conn.messages || []).filter(message =>
    (!direction || message.direction === direction) && (!query || String(message.data).toLowerCase().includes(query))
  );
  renderWsMessageTimeline(messages, conn);
  document.getElementById('ws-messages').innerHTML = messages.length === 0 ?
    '<div class="ws-no-messages">暂无消息</div>' :
    messages.map((msg, index) => {
      const dirClass = msg.direction === 'send' ? 'ws-msg-send' : 'ws-msg-receive';
      let data = msg.data;
      if (msg.encoding === 'base64') {
        data = `[Base64 ${msg.size || '?'} bytes]\n${msg.data}`;
        if (msg.hex) data += `\n\nHex: ${msg.hex}`;
      } else {
        try { data = JSON.stringify(JSON.parse(msg.data), null, 2); } catch {}
      }
      return `<div class="ws-message ${dirClass}" data-msg-index="${index}">
        <div class="ws-msg-header">
          <span class="ws-msg-dir">${msg.direction === 'send' ? '↑ 发送' : '↓ 接收'}</span>
          <span class="ws-msg-type">${escapeHtml(msg.type)}</span>
          <span class="ws-msg-time">${formatTimestamp(msg.timestamp)}</span>
        </div>
        <div class="ws-msg-data"><pre>${escapeHtml(data)}</pre></div>
      </div>`;
    }).join('');

  document.getElementById('ws-detail-overlay').style.display = 'flex';
  const container = document.getElementById('ws-messages');
  container.scrollTop = container.scrollHeight;
}

function renderWsMessageTimeline(messages, conn) {
  const root = document.getElementById('ws-timeline');
  if (!root) return;
  if (!messages.length) {
    root.hidden = true;
    root.innerHTML = '';
    return;
  }

  const start = Math.min(...messages.map(m => Number(m.timestamp) || 0), conn.startTime || messages[0].timestamp || 0);
  const end = Math.max(...messages.map(m => Number(m.timestamp) || 0), conn.endTime || start);
  const span = Math.max(1, end - start);

  const makeMarker = (msg, index) => {
    const t = Number(msg.timestamp) || start;
    const left = Math.max(0, Math.min(100, ((t - start) / span) * 100));
    const dir = msg.direction === 'send' ? 'send' : 'receive';
    const preview = String(msg.data || '').replace(/\s+/g, ' ').slice(0, 80);
    return `<button class="ws-tl-marker ${dir}" data-msg-index="${index}" style="left:${left}%"
      title="${escapeHtml(`${msg.direction === 'send' ? '发送' : '接收'} +${Math.round(t - start)}ms · ${preview}`)}"></button>`;
  };
  const sendMarkers = messages.map((msg, index) => msg.direction === 'send' ? makeMarker(msg, index) : '').join('');
  const recvMarkers = messages.map((msg, index) => msg.direction !== 'send' ? makeMarker(msg, index) : '').join('');

  root.hidden = false;
  root.innerHTML = `
    <div class="ws-tl-summary">
      <span class="stat"><b>${messages.length}</b><span>消息</span></span>
      <span class="stat ok"><b>${messages.filter(m => m.direction === 'receive').length}</b><span>接收</span></span>
      <span class="stat"><b>${messages.filter(m => m.direction === 'send').length}</b><span>发送</span></span>
      <span class="stat time"><span>跨度</span><b>${formatDuration(span)}</b></span>
    </div>
    <div class="ws-tl-lanes">
      <div class="ws-tl-row">
        <div class="ws-tl-lane-label">发送</div>
        <div class="ws-tl-lane send">${sendMarkers}</div>
      </div>
      <div class="ws-tl-row">
        <div class="ws-tl-lane-label">接收</div>
        <div class="ws-tl-lane receive">${recvMarkers}</div>
      </div>
    </div>
    <div class="ws-tl-axis">
      <span>+0ms</span>
      <span>+${Math.round(span / 2)}ms</span>
      <span>+${Math.round(span)}ms</span>
    </div>`;

  root.querySelectorAll('.ws-tl-marker').forEach(btn => {
    btn.addEventListener('click', () => {
      const index = btn.dataset.msgIndex;
      root.querySelectorAll('.ws-tl-marker').forEach(m => m.classList.toggle('is-active', m.dataset.msgIndex === index));
      document.getElementById('ws-messages').querySelectorAll('.ws-message').forEach(el => {
        el.classList.toggle('is-highlight', el.dataset.msgIndex === index);
        if (el.dataset.msgIndex === index) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    });
  });
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
      encoding: m.encoding || null, size: m.size || null, hex: m.hex || null,
      time: new Date(m.timestamp).toISOString(),
    })),
  }, null, 2), 'application/json', `ws-${Date.now()}.json`);
  showToast('WebSocket 消息已导出');
}

// ============ 工具函数 ============

function closeDetail() {
  hideTimelineTooltip();
  document.getElementById('detail-overlay').style.display = 'none';
}

function updateCounts() {
  document.getElementById('http-count').textContent = allRequests.length;
  document.getElementById('ws-count').textContent = allWsConnections.length;
}

function updateToggleButton() {
  const btn = document.getElementById('btn-toggle');
  const label = document.getElementById('capture-label');
  const dot = document.getElementById('capture-dot');
  const statusDot = document.getElementById('status-capture-dot');
  const statusLive = document.getElementById('status-live');
  const statusLiveText = document.getElementById('status-live-text');

  if (label) label.textContent = isCapturing ? '捕获中' : '已暂停';
  if (dot) {
    dot.classList.toggle('live', isCapturing);
    dot.classList.toggle('paused', !isCapturing);
  }
  if (statusDot) {
    statusDot.classList.toggle('live', isCapturing);
    statusDot.classList.toggle('paused', !isCapturing);
  }
  if (statusLive) statusLive.classList.toggle('paused', !isCapturing);
  if (statusLiveText) statusLiveText.textContent = isCapturing ? '采集中' : '已暂停';
  if (btn) {
    btn.className = 'btn btn-ghost capture-toggle';
    btn.title = isCapturing ? '暂停捕获' : '恢复捕获';
  }
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
  const starredOnly = document.getElementById('filter-starred').checked;
  const tagFilter = (document.getElementById('filter-tags')?.value || '').trim().toLowerCase();

  return requests.filter(r => {
    if (urlFilter && !r.url.toLowerCase().includes(urlFilter)) return false;
    if (methodFilter && r.method !== methodFilter) return false;
    if (typeFilter && r.type !== typeFilter) return false;
    if (starredOnly && !r.starred) return false;
    if (tagFilter && !(r.tags || []).some(tag => String(tag).toLowerCase().includes(tagFilter))) return false;
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
  let parts = [`curl -X ${r.method} ${shellQuote(r.url)}`];
  if (r.requestHeaders) {
    Object.entries(r.requestHeaders).forEach(([k, v]) => {
      if (!['host', 'connection', 'origin', 'referer'].includes(k.toLowerCase()) && !String(v).includes('[REDACTED]')) {
        parts.push(`-H ${shellQuote(`${k}: ${v}`)}`);
      }
    });
  }
  if (r.requestBody && !r.requestBody.includes('[REDACTED]') && !['GET', 'HEAD'].includes(r.method)) {
    parts.push(`-d ${shellQuote(r.requestBody)}`);
  }
  return parts.join(' \\\n  ');
}

function parseCurl(command) {
  const tokens = [];
  String(command).replace(/(?:[^\s"']+|"(?:\\.|[^"])*"|'[^']*')+/g, token => {
    let value = token;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    tokens.push(value.replace(/\\([\\"'])/g, '$1'));
    return token;
  });
  let url = '';
  let method = '';
  let body = null;
  const headers = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === 'curl') continue;
    if (token === '-X' || token === '--request') { method = tokens[++i] || ''; continue; }
    if (token === '-H' || token === '--header') {
      const header = tokens[++i] || '';
      const index = header.indexOf(':');
      if (index > 0) headers[header.slice(0, index).trim()] = header.slice(index + 1).trim();
      continue;
    }
    if (['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode'].includes(token)) {
      body = tokens[++i] || '';
      if (!method) method = 'POST';
      continue;
    }
    if (token === '--url') { url = tokens[++i] || ''; continue; }
    if (/^https?:\/\//i.test(token) || /^wss?:\/\//i.test(token)) url = token;
  }
  if (!url) return null;
  return {
    url,
    method: (method || (body === null ? 'GET' : 'POST')).toUpperCase(),
    requestHeaders: headers,
    requestBody: body,
    startTime: Date.now(),
    type: 'curl',
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function formatBody(body) {
  if (!body) return '<span class="no-data">无数据</span>';
  try { return syntaxHighlight(JSON.stringify(JSON.parse(body), null, 2)); }
  catch { return escapeHtml(body); }
}

function formatJsonTree(body) {
  let value;
  try { value = JSON.parse(body); } catch { return ''; }
  const render = (item, key, depth) => {
    const label = key === null ? '' : `<span class="json-tree-key">${escapeHtml(String(key))}</span>: `;
    if (item === null || typeof item !== 'object') {
      return `<div class="json-tree-row" style="--depth:${Math.min(depth, 8)}"><span>${label}${escapeHtml(JSON.stringify(item))}</span></div>`;
    }
    const entries = Object.entries(item);
    return `<details class="json-tree-node" ${depth < 2 ? 'open' : ''} style="--depth:${Math.min(depth, 8)}">
      <summary>${label}${Array.isArray(item) ? `[${entries.length}]` : `{${entries.length}}`}</summary>
      ${entries.map(([childKey, child]) => render(child, childKey, depth + 1)).join('')}
    </details>`;
  };
  return render(value, null, 0);
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

function getMethodClass(method) {
  const safeMethod = /^[A-Z]+$/.test(method || '') ? method : 'OTHER';
  return `method-${safeMethod}`;
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
