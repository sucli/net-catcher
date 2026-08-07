// NetCatcher - Content Script Bridge (ISOLATED world)
// Only capture events may cross from the page into the extension.

(function() {
  'use strict';

  const CAPTURE_TYPES = new Set([
    'NET_REQUEST', 'NET_RESPONSE', 'NET_RESPONSE_BODY', 'NET_STREAM_CHUNK', 'NET_ERROR',
    'WS_OPEN', 'WS_READY', 'WS_MESSAGE', 'WS_CLOSE', 'WS_ERROR',
  ]);
  const bridgeNonce = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() :
    `bridge-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  function publishCaptureConfig(config) {
    window.postMessage({
      __netCatcherConfig: true,
      hasActiveMockRules: !!config?.hasActiveMockRules,
      nonce: bridgeNonce,
    }, '*');
  }

  function refreshCaptureConfig() {
    chrome.runtime.sendMessage({ type: 'GET_CAPTURE_CONFIG' })
      .then(publishCaptureConfig)
      .catch(() => publishCaptureConfig(null));
  }

  if (chrome.runtime.onMessage?.addListener) {
    refreshCaptureConfig();

    chrome.runtime.onMessage.addListener(message => {
      if (message?.type === 'CAPTURE_CONFIG_UPDATED') publishCaptureConfig(message);
      if (message?.type === 'WS_REPLAY' && message.data && typeof message.data === 'object') {
        window.postMessage({ __netCatcher: true, type: 'WS_REPLAY', data: message.data, nonce: bridgeNonce }, '*');
      }
    });
  }

  window.addEventListener('message', async function(event) {
    if (event.source !== window || !event.data?.__netCatcher) return;

    if (event.data.__netCatcherHello) {
      window.postMessage({ __netCatcherBridgeReady: true, nonce: bridgeNonce }, '*');
      if (chrome.runtime.onMessage?.addListener) refreshCaptureConfig();
      return;
    }

    const { messageId, type, data, nonce } = event.data;
    if (nonce !== bridgeNonce) return;
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
        nonce: bridgeNonce,
      }, '*');
    }
  });
})();
