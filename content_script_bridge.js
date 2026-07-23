// NetCatcher - Content Script Bridge (ISOLATED world)
// Only capture events may cross from the page into the extension.

(function() {
  'use strict';

  const CAPTURE_TYPES = new Set([
    'NET_REQUEST', 'NET_RESPONSE', 'NET_RESPONSE_BODY', 'NET_ERROR',
    'WS_OPEN', 'WS_READY', 'WS_MESSAGE', 'WS_CLOSE', 'WS_ERROR',
  ]);

  function publishCaptureConfig(config) {
    window.postMessage({
      __netCatcherConfig: true,
      hasActiveMockRules: !!config?.hasActiveMockRules,
    }, '*');
  }

  if (chrome.runtime.onMessage?.addListener) {
    chrome.runtime.sendMessage({ type: 'GET_CAPTURE_CONFIG' })
      .then(publishCaptureConfig)
      .catch(() => publishCaptureConfig(null));

    chrome.runtime.onMessage.addListener(message => {
      if (message?.type === 'CAPTURE_CONFIG_UPDATED') publishCaptureConfig(message);
    });
  }

  window.addEventListener('message', async function(event) {
    if (event.source !== window || !event.data?.__netCatcher) return;

    const { messageId, type, data } = event.data;
    if (!CAPTURE_TYPES.has(type) || !data || typeof data !== 'object') return;

    let response = null;
    try {
      response = await chrome.runtime.sendMessage({ type, data });
    } catch {}

    if (messageId) {
      window.postMessage({
        __netCatcherResponse: true,
        messageId,
        response,
      }, '*');
    }
  });
})();
