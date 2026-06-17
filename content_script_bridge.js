// NetCatcher - Content Script (ISOLATED world)
// 接收 MAIN world 发来的 postMessage，通过 chrome.runtime 转发给 background

(function() {
  'use strict';

  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    if (!event.data || !event.data.__netCatcher) return;

    const { type, data } = event.data;

    // 转发所有消息类型，包括 WebSocket 相关
    chrome.runtime.sendMessage({ type, data }).catch(() => {});
  });
})();
