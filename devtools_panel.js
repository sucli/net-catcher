// NetCatcher - DevTools panel
const state = {
  requests: [],
  scope: 'current',
  search: '',
  status: '',
  selected: new Set(),
  detailId: null,
  compareTab: 'overview',
  detailTab: 'headers',
};

const tabId = chrome.devtools?.inspectedWindow?.tabId ?? null;

function $(id) { return document.getElementById(id); }

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getShortUrl(url) {
  try { const u = new URL(url); return u.pathname + u.search; } catch { return url; }
}

function statusClass(status) {
  if (!status) return 's-0';
  if (status >= 500) return 's-5xx';
  if (status >= 400) return 's-4xx';
  if (status >= 300) return 's-3xx';
  if (status >= 200) return 's-2xx';
  return 's-0';
}

function methodClass(method) {
  const m = String(method || '').toUpperCase();
  return ['GET', 'POST', 'PUT', 'DELETE'].includes(m) ? `m-${m}` : 'm-other';
}

function formatSize(b) {
  if (!b && b !== 0) return '...';
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

function filtered() {
  return state.requests.filter(r => {
    if (state.search && !r.url.toLowerCase().includes(state.search)) return false;
    if (state.status === '0' && r.status) return false;
    if (state.status === '2xx' && !(r.status >= 200 && r.status < 300)) return false;
    if (state.status === '4xx' && !(r.status >= 400 && r.status < 500)) return false;
    if (state.status === '5xx' && !(r.status >= 500)) return false;
    return true;
  });
}

function load() {
  const data = state.scope === 'current' && Number.isInteger(tabId) ? { tabId } : {};
  chrome.runtime.sendMessage({ type: 'GET_REQUESTS', data }, res => {
    if (chrome.runtime.lastError || !res) return;
    state.requests = res.requests || [];
    renderList();
  });
}

function renderList() {
  const rows = filtered();
  $('dt-count').textContent = String(rows.length);
  const list = $('dt-list');
  if (!rows.length) {
    list.innerHTML = '<div class="dt-empty">暂无请求。刷新页面或切换「全部」范围。</div>';
    return;
  }
  list.innerHTML = rows.map(r => `
    <div class="dt-row ${state.selected.has(r.id) ? 'selected' : ''}" data-id="${r.id}">
      <span class="c-method ${methodClass(r.method)}">${escapeHtml(r.method)}</span>
      <span class="c-url" title="${escapeHtml(r.url)}">${escapeHtml(getShortUrl(r.url))}</span>
      <span class="${statusClass(r.status)}">${r.status || '---'}</span>
      <span class="c-dur">${r.duration ? Math.round(r.duration) + 'ms' : '...'}</span>
      <span class="c-size">${r.size ? formatSize(r.size) : '...'}</span>
    </div>`).join('');
}

function flattenJson(value, prefix = '', out = {}) {
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
    const key = prefix ? `${prefix}.${k}` : String(k);
    flattenJson(v, key, out);
  });
  return out;
}

function parseJsonSafe(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function buildTextDiff(a, b) {
  const as = String(a || '').split('\n');
  const bs = String(b || '').split('\n');
  const max = Math.max(as.length, bs.length);
  const lines = [];
  for (let i = 0; i < max; i++) {
    const x = as[i] ?? '';
    const y = bs[i] ?? '';
    if (x === y) lines.push(`<div class="diff-line diff-same">  ${escapeHtml(x)}</div>`);
    else {
      if (x) lines.push(`<div class="diff-line diff-del">- ${escapeHtml(x)}</div>`);
      if (y) lines.push(`<div class="diff-line diff-add">+ ${escapeHtml(y)}</div>`);
    }
  }
  return lines.join('') || '<div class="diff-same">无内容</div>';
}

function selectedRequests() {
  return Array.from(state.selected)
    .map(id => state.requests.find(r => r.id === id))
    .filter(Boolean);
}

function renderCompare() {
  const items = selectedRequests();
  if (items.length < 2) {
    $('dt-compare-body').innerHTML = '<div class="dt-empty">请至少选择 2 个请求（Ctrl/⌘+点击）</div>';
    return;
  }
  const [a, b] = items;
  const tab = state.compareTab;
  let html = '';
  if (tab === 'overview') {
    html = `<table class="cmp-table">
      <tr><td>URL</td><td>${escapeHtml(getShortUrl(a.url))}<br>${escapeHtml(getShortUrl(b.url))}</td></tr>
      <tr><td>方法</td><td>${escapeHtml(a.method)} vs ${escapeHtml(b.method)}</td></tr>
      <tr><td>状态</td><td>${a.status || '---'} vs ${b.status || '---'}</td></tr>
      <tr><td>耗时</td><td>${Math.round(a.duration || 0)}ms vs ${Math.round(b.duration || 0)}ms</td></tr>
      <tr><td>大小</td><td>${formatSize(a.size || 0)} vs ${formatSize(b.size || 0)}</td></tr>
      <tr><td>已选</td><td>${items.length} 条（对比前两条）</td></tr>
    </table>`;
  } else if (tab === 'headers') {
    const keys = new Set([
      ...Object.keys(a.requestHeaders || {}),
      ...Object.keys(b.requestHeaders || {}),
      ...Object.keys(a.responseHeaders || {}),
      ...Object.keys(b.responseHeaders || {}),
    ]);
    html = '<table class="cmp-table"><tr><td>Header</td><td>差异</td></tr>';
    keys.forEach(k => {
      const ar = a.requestHeaders?.[k];
      const br = b.requestHeaders?.[k];
      const ares = a.responseHeaders?.[k];
      const bres = b.responseHeaders?.[k];
      const reqDiff = String(ar ?? '') !== String(br ?? '');
      const resDiff = String(ares ?? '') !== String(bres ?? '');
      if (!reqDiff && !resDiff) return;
      html += `<tr><td>${escapeHtml(k)}</td><td>
        <div>REQ: ${escapeHtml(ar ?? '—')} → ${escapeHtml(br ?? '—')}</div>
        <div>RES: ${escapeHtml(ares ?? '—')} → ${escapeHtml(bres ?? '—')}</div>
      </td></tr>`;
    });
    html += '</table>';
  } else if (tab === 'json') {
    const ja = parseJsonSafe(a.responseBody);
    const jb = parseJsonSafe(b.responseBody);
    if (!ja || !jb) {
      html = '<div class="dt-empty">两侧响应体不是合法 JSON</div>';
    } else {
      const fa = flattenJson(ja);
      const fb = flattenJson(jb);
      const keys = Array.from(new Set([...Object.keys(fa), ...Object.keys(fb)])).sort();
      html = '<table class="cmp-table"><tr><td>路径</td><td>值变化</td></tr>';
      keys.forEach(k => {
        const x = fa[k];
        const y = fb[k];
        const sx = x === undefined ? '∅' : JSON.stringify(x);
        const sy = y === undefined ? '∅' : JSON.stringify(y);
        if (sx === sy) return;
        html += `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(sx)} → ${escapeHtml(sy)}</td></tr>`;
      });
      html += '</table>';
    }
  } else {
    html = buildTextDiff(a.responseBody, b.responseBody);
  }
  $('dt-compare-body').innerHTML = html;
}

function renderDetail() {
  const r = state.requests.find(item => item.id === state.detailId);
  if (!r) return;
  $('dt-detail-title').textContent = `${r.method} ${getShortUrl(r.url)}`;
  const tab = state.detailTab;
  let html = '';
  if (tab === 'headers') {
    html = '<div class="dt-kv">';
    html += `<span class="dt-k">URL</span><span>${escapeHtml(r.url)}</span>`;
    html += `<span class="dt-k">状态</span><span>${r.status || '---'} ${escapeHtml(r.statusText || '')}</span>`;
    html += `<span class="dt-k">耗时</span><span>${r.duration ? Math.round(r.duration) + 'ms' : '---'}</span>`;
    Object.entries(r.requestHeaders || {}).forEach(([k, v]) => {
      html += `<span class="dt-k">req · ${escapeHtml(k)}</span><span>${escapeHtml(v)}</span>`;
    });
    Object.entries(r.responseHeaders || {}).forEach(([k, v]) => {
      html += `<span class="dt-k">res · ${escapeHtml(k)}</span><span>${escapeHtml(v)}</span>`;
    });
    html += '</div>';
  } else if (tab === 'req') {
    html = escapeHtml(r.requestBody || '无请求体');
  } else {
    const body = r.responseBody;
    if (!body) html = '无响应体';
    else {
      try { html = JSON.stringify(JSON.parse(body), null, 2); }
      catch { html = body; }
    }
  }
  $('dt-detail-body').textContent = html;
}

function bind() {
  document.querySelectorAll('.dt-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      state.scope = btn.dataset.scope;
      document.querySelectorAll('.dt-tab').forEach(b => b.classList.toggle('active', b === btn));
      load();
    });
  });
  $('dt-search').addEventListener('input', e => {
    state.search = e.target.value.toLowerCase();
    renderList();
  });
  $('dt-status').addEventListener('change', e => {
    state.status = e.target.value;
    renderList();
  });
  $('dt-list').addEventListener('click', e => {
    const row = e.target.closest('.dt-row');
    if (!row) return;
    const id = Number(row.dataset.id);
    if (e.ctrlKey || e.metaKey) {
      if (state.selected.has(id)) state.selected.delete(id);
      else state.selected.add(id);
      renderList();
      return;
    }
    state.selected.clear();
    state.selected.add(id);
    state.detailId = id;
    $('dt-detail').hidden = false;
    renderList();
    renderDetail();
  });
  $('dt-detail-close').addEventListener('click', () => {
    $('dt-detail').hidden = true;
    state.detailId = null;
  });
  document.querySelectorAll('.dtab').forEach(btn => {
    btn.addEventListener('click', () => {
      state.detailTab = btn.dataset.dtab;
      document.querySelectorAll('.dtab').forEach(b => b.classList.toggle('active', b === btn));
      renderDetail();
    });
  });
  $('dt-compare').addEventListener('click', () => {
    $('dt-compare-panel').hidden = false;
    renderCompare();
  });
  $('dt-compare-close').addEventListener('click', () => {
    $('dt-compare-panel').hidden = true;
  });
  document.querySelectorAll('.ctab').forEach(btn => {
    btn.addEventListener('click', () => {
      state.compareTab = btn.dataset.ctab;
      document.querySelectorAll('.ctab').forEach(b => b.classList.toggle('active', b === btn));
      renderCompare();
    });
  });
  $('dt-clear-sel').addEventListener('click', () => {
    state.selected.clear();
    renderList();
  });
  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type === 'REQUESTS_UPDATED') load();
  });
}

bind();
load();
setInterval(load, 2000);
