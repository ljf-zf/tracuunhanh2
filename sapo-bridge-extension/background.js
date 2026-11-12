let bridgeSocket = null;
let reconnectTimer = null;
let pingTimer = null;
let connecting = false;

async function getConfig() {
  return await chrome.storage.local.get(['workerUrl', 'bridgeToken']);
}
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectBridge(); }, 5000);
}
async function connectBridge() {
  if (connecting || bridgeSocket?.readyState === WebSocket.OPEN) return;
  connecting = true;
  const config = await getConfig();
  const workerUrl = String(config.workerUrl || '').trim().replace(/\/+$/, '');
  const token = String(config.bridgeToken || '').trim();
  if (!workerUrl || !token) { connecting = false; return; }
  try {
    const url = new URL('/api/sapo/bridge/connect', workerUrl);
    url.protocol = 'wss:';
    const socket = new WebSocket(url.href, [`sapo-bridge.${token}`]);
    bridgeSocket = socket;
    socket.onopen = () => {
      connecting = false;
      socket.send(JSON.stringify({ type: 'bridge-hello', version: '1.0.0' }));
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
      }, 20000);
    };
    socket.onmessage = async event => {
      let message;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      if (message.type === 'trigger-sapo-print') {
        const saved = await chrome.storage.local.get(['sapoTabId', 'sapoFrameId']);
        let targetTabId = Number(saved.sapoTabId) || 0;
        let targetFrameId = Number(saved.sapoFrameId) || 0;
        if (!targetTabId) {
          const tabs = await chrome.tabs.query({ url: ['https://market-place.sapoapps.vn/*', 'https://*.mysapogo.com/*'] });
          const tab = tabs.find(item => item.active) || tabs[0];
          if (tab?.id) {
            const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => []);
            const frame = frames.find(item => /market-place\.sapoapps\.vn|mysapogo\.com/i.test(item.url)) || frames[0];
            targetTabId = tab.id; targetFrameId = frame?.frameId || 0;
          }
        }
        if (!targetTabId) {
          socket.send(JSON.stringify({ type: 'bridge-trigger-error', requestId: message.requestId, error: 'Không tìm thấy tab Sapo đang mở trên Edge.' }));
          return;
        }
        chrome.tabs.sendMessage(targetTabId, { type: 'TRIGGER_SAPO_PRINT', command: message }, { frameId: targetFrameId }, response => {
          if (chrome.runtime.lastError || response?.ok === false) {
            socket.send(JSON.stringify({ type: 'bridge-trigger-error', requestId: message.requestId, error: response?.error || 'Không gửi được lệnh tới tab Sapo.' }));
          }
        });
      }
    };
    socket.onclose = () => {
      connecting = false; clearInterval(pingTimer); pingTimer = null;
      if (bridgeSocket === socket) bridgeSocket = null;
      scheduleReconnect();
    };
    socket.onerror = () => { try { socket.close(); } catch (_) {} };
  } catch (_) { connecting = false; scheduleReconnect(); }
}

chrome.runtime.onInstalled.addListener(connectBridge);
chrome.runtime.onStartup.addListener(connectBridge);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.workerUrl || changes.bridgeToken)) {
    try { bridgeSocket?.close(); } catch (_) {}
    connectBridge();
  }
});
connectBridge();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'SAPO_CONTEXT') {
    if (/mysapogo\.com|market-place\.sapoapps\.vn/i.test(sender.url || sender.tab?.url || '')) {
      chrome.storage.local.set({
        sapoTabId: sender.tab?.id || 0, sapoFrameId: sender.frameId || 0,
        sapoClientId: String(message.context?.clientId || ''),
        sapoAccountId: String(message.context?.accountId || '')
      });
    }
  }
  if (message?.type === 'GET_SAPO_CONTEXT') {
    chrome.storage.local.get(['sapoClientId', 'sapoAccountId'], value => sendResponse({
      clientId: value.sapoClientId || '', accountId: value.sapoAccountId || ''
    }));
    return true;
  }
  if (message?.type === 'SAPO_PRINT_EVENT') {
    if (!/mysapogo\.com|market-place\.sapoapps\.vn/i.test(sender.url || sender.tab?.url || '')) return;
    const event = message.event;
    if (!event || event.type !== 'PRINT_ORDER' || event.status !== 'SUCCESS' || !Array.isArray(event.order_bills)) return;
    getConfig().then(async config => {
      const workerUrl = String(config.workerUrl || '').trim().replace(/\/+$/, '');
      const bridgeToken = String(config.bridgeToken || '').trim();
      if (!workerUrl || !bridgeToken) return;
      try {
        const response = await fetch(`${workerUrl}/api/sapo/print-event`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'X-Sapo-Bridge-Key': bridgeToken },
          body: JSON.stringify({ event })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.ok) console.warn('[Sapo Print Bridge] Worker từ chối sự kiện:', result.error || response.status);
        else console.info('[Sapo Print Bridge] Đã đồng bộ PDF vận đơn:', result.saved);
      } catch (error) { console.warn('[Sapo Print Bridge] Không gửi được sự kiện:', error.message); }
    });
  }
  if (message?.type === 'SAPO_TRIGGER_ERROR' && bridgeSocket?.readyState === WebSocket.OPEN) {
    bridgeSocket.send(JSON.stringify({ type: 'bridge-trigger-error', requestId: message.requestId, error: message.error }));
  }
});