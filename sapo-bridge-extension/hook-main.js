(() => {
  if (window.__sapoPrintBridgeHookInstalled) return;
  window.__sapoPrintBridgeHookInstalled = true;
  const MARK = '__SAPO_PRINT_BRIDGE_EVENT__';
  const COMMAND = '__SAPO_PRINT_BRIDGE_COMMAND__';
  const authHeaders = {};
  let lastClientId = '';
  let lastAccountId = '';

  function captureHeaders(headers) {
    try {
      if (headers instanceof Headers) headers.forEach((v,k) => {
        if (/^(authorization|x-market-token|x-market-account-id)$/i.test(k)) authHeaders[k] = v;
      });
      else if (Array.isArray(headers)) headers.forEach(([k,v]) => {
        if (/^(authorization|x-market-token|x-market-account-id)$/i.test(k)) authHeaders[k.toLowerCase()] = String(v);
      });
      else if (headers && typeof headers === 'object') Object.entries(headers).forEach(([k,v]) => {
        if (/^(authorization|x-market-token|x-market-account-id)$/i.test(k)) authHeaders[k.toLowerCase()] = String(v);
      });
    } catch (_) {}
  }
  function captureUrl(url) {
    try {
      const u = new URL(String(url), location.href);
      // Sapo may expose these identifiers on other API requests before the first print.
      const clientCandidate = u.searchParams.get('clientId') || u.searchParams.get('client_id') || '';
      const accountCandidate = u.searchParams.get('accountId') || u.searchParams.get('account_id') || '';
      if (clientCandidate) lastClientId = clientCandidate;
      if (accountCandidate) lastAccountId = accountCandidate;
      if (lastClientId || lastAccountId) {
        window.postMessage({ source: MARK, context: { clientId: lastClientId, accountId: lastAccountId } }, location.origin);
      }
    } catch (_) {}
  }
  function accountIdFromHeader() {
    const raw = authHeaders['x-market-account-id'] || '';
    try { return atob(raw).replace(/\D/g, '') || raw.replace(/\D/g, ''); }
    catch (_) { return raw.replace(/\D/g, ''); }
  }
  function parseSocketPackets(text) {
    if (typeof text !== 'string' || !text.includes('PRINT_ORDER')) return [];
    const found = [];
    let from = 0;
    while (true) {
      const marker = text.indexOf('["notification"', from);
      if (marker < 0) break;
      let depth = 0, quoted = false, escaped = false, end = -1;
      for (let i = marker; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') quoted = false;
          continue;
        }
        if (ch === '"') quoted = true;
        else if (ch === '[' || ch === '{') depth++;
        else if (ch === ']' || ch === '}') {
          depth--;
          if (depth === 0) { end = i + 1; break; }
        }
      }
      if (end > marker) {
        try {
          const packet = JSON.parse(text.slice(marker, end));
          const event = packet?.[1];
          if (event?.type === 'PRINT_ORDER' && event.status === 'SUCCESS' && Array.isArray(event.order_bills)) {
            found.push({
              type: event.type, status: event.status, order_bills: event.order_bills,
              merged_bill: event.merged_bill || '', tenant_id: event.tenant_id,
              channel_type: event.channel_type, connection_id: event.connection_id,
              client_id: event.client_id || '', account_id: lastAccountId,
              time: event.time
            });
          }
        } catch (_) {}
        from = end;
      } else from = marker + 1;
    }
    return found;
  }
  function publish(text) {
    for (const event of parseSocketPackets(text)) window.postMessage({ source: MARK, event }, location.origin);
  }

  const XHR = window.XMLHttpRequest;
  const originalOpen = XHR.prototype.open;
  const originalSend = XHR.prototype.send;
  const originalSetHeader = XHR.prototype.setRequestHeader;
  XHR.prototype.open = function(method, url, ...rest) {
    this.__sapoBridgeUrl = String(url || '');
    captureUrl(url);
    return originalOpen.call(this, method, url, ...rest);
  };
  XHR.prototype.setRequestHeader = function(name, value) {
    if (/^(authorization|x-market-token|x-market-account-id)$/i.test(String(name))) authHeaders[String(name).toLowerCase()] = String(value);
    return originalSetHeader.call(this, name, value);
  };
  XHR.prototype.send = function(...args) {
    if (/notification\/\?EIO=4/.test(this.__sapoBridgeUrl)) {
      this.addEventListener('load', () => {
        try { publish(this.responseType === 'json' ? JSON.stringify(this.response) : this.responseText); } catch (_) {}
      });
    }
    return originalSend.apply(this, args);
  };
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    captureUrl(url);
    captureHeaders(args[0]?.headers);
    captureHeaders(args[1]?.headers);
    const response = await originalFetch.apply(this, args);
    try { if (/notification\/\?EIO=4/.test(url)) response.clone().text().then(publish).catch(() => {}); } catch (_) {}
    return response;
  };

  window.addEventListener('message', async event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== COMMAND) return;
    if (event.data.restoreContext) {
      lastClientId = String(event.data.restoreContext.clientId || lastClientId);
      lastAccountId = String(event.data.restoreContext.accountId || lastAccountId);
      return;
    }
    const command = event.data.command || {};
    const orderId = String(command.orderId || '').trim();
    if (!orderId) return;
    const clientId = lastClientId;
    const accountId = lastAccountId || accountIdFromHeader();
    const headers = {};
    if (authHeaders.authorization) headers.Authorization = authHeaders.authorization;
    if (authHeaders['x-market-token']) headers['X-Market-Token'] = authHeaders['x-market-token'];
    if (authHeaders['x-market-account-id']) headers['X-Market-Account-Id'] = authHeaders['x-market-account-id'];
    if (!clientId || !accountId || (!headers.Authorization && !headers['X-Market-Token'])) {
      window.postMessage({ source: MARK, triggerError: { requestId: command.requestId, error: 'Chưa lấy được phiên xác thực/clientId từ Sapo. Hãy tải lại trang Sapo; nếu đây là lần đầu, thực hiện in thử một đơn ngay trên Sapo để Bridge nhận clientId.' } }, location.origin);
      return;
    }
    try {
      const url = `https://market-place.sapoapps.vn/v2/orders/print?ids=${encodeURIComponent(orderId)}&clientId=${encodeURIComponent(clientId)}&accountId=${encodeURIComponent(accountId)}`;
      const response = await originalFetch.call(window, url, {
        method: 'GET', credentials: 'include', cache: 'no-store',
        headers: { Accept: 'application/json', ...headers }
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.success === false) throw new Error(result.message || `Sapo trả HTTP ${response.status}.`);
      window.postMessage({ source: MARK, triggerStarted: { requestId: command.requestId } }, location.origin);
    } catch (error) {
      window.postMessage({ source: MARK, triggerError: { requestId: command.requestId, error: error.message || 'Không gọi được lệnh in Sapo.' } }, location.origin);
    }
  });
})();