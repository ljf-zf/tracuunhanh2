(() => {
  const MARK = '__SAPO_PRINT_BRIDGE_EVENT__';
  const COMMAND = '__SAPO_PRINT_BRIDGE_COMMAND__';
  chrome.runtime.sendMessage({ type: 'GET_SAPO_CONTEXT' }, context => {
    if (context) window.postMessage({ source: COMMAND, restoreContext: context }, location.origin);
  });
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== MARK) return;
    if (event.data.context) {
      chrome.runtime.sendMessage({ type: 'SAPO_CONTEXT', context: event.data.context }).catch(() => {});
    }
    if (event.data.event) {
      const payload = event.data.event;
      if (payload.type === 'PRINT_ORDER' && payload.status === 'SUCCESS') {
        chrome.runtime.sendMessage({ type: 'SAPO_PRINT_EVENT', event: payload }).catch(() => {});
      }
    }
    if (event.data.triggerError) chrome.runtime.sendMessage({ type: 'SAPO_TRIGGER_ERROR', ...event.data.triggerError }).catch(() => {});
  });
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'TRIGGER_SAPO_PRINT') {
      window.postMessage({ source: COMMAND, command: message.command }, location.origin);
    }
  });
})();