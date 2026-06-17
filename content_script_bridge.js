// NetCatcher - Content Script (ISOLATED world)
// 接收 MAIN world 发来的 postMessage，通过 chrome.runtime 转发给 background

(function() {
  'use strict';

  console.log('[NetCatcher] Bridge script loaded');

  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    if (!event.data || !event.data.__netCatcher) return;

    const { type, data } = event.data;
    console.log('[NetCatcher BRIDGE] Received:', type, data.url);

    // 直接转发给 background，不等待响应
    chrome.runtime.sendMessage({ type, data }).then(() => {
      console.log('[NetCatcher BRIDGE] Sent to background:', type);
    }).catch(err => {
      console.error('[NetCatcher BRIDGE] Send failed:', err.message);
    });
  });
})();
