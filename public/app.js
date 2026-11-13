const $ = (id) => document.getElementById(id);
const searchPanel = $('search-panel');
const resultsSection = $('results-section');
const statusEl = $('status');
let searchTimer = null;
let activeController = null;
let lastQuery = '';
const currentOrders = new Map();

function setStatus(text = '', kind = '') {
  statusEl.textContent = text;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function fmtDate(value) {
  if (!value) return 'Không có thời gian';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('vi-VN', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }).format(date);
}
function renderOrders(data) {
  $('result-count').textContent = `${data.count} đơn`;
  $('result-subtitle').textContent = `Từ khóa “${data.query || ''}” · Đã kiểm tra ${data.scanned} đơn`;
  $('partial-warning').classList.toggle('hidden', !data.partial);
  const results = $('results');
  currentOrders.clear();
  if (!data.orders.length) {
    results.innerHTML = `<div class="empty-state"><div class="empty-icon">⌕</div><strong>Chưa tìm thấy đơn phù hợp</strong><br>Thử mã đơn, mã vận đơn hoặc một đoạn địa chỉ có trong dữ liệu Sapo.</div>`;
    return;
  }
  results.innerHTML = data.orders.map(order => {
    const key = String(order.id || order.code);
    currentOrders.set(key, order);
    const carrierUnknown = !order.carrier || order.carrier === 'Chưa xác định';
    const items = order.items && order.items.length
      ? order.items.map(item => `<div class="product-row"><div class="product-main"><div class="sku-line"><span class="product-sku">${item.sku ? escapeHtml(item.sku) : 'Chưa có SKU'}</span><span class="qty">× ${Number(item.quantity) || 0}</span></div><div class="product-name">${escapeHtml(item.name)}${item.variant ? ` · ${escapeHtml(item.variant)}` : ''}</div></div></div>`).join('')
      : `<div class="empty-products">API chưa trả về chi tiết sản phẩm cho đơn này.</div>`;
    return `<article class="order-card">
      <div class="order-top"><div><div class="order-code">${escapeHtml(order.code)}</div><div class="order-date">${escapeHtml(fmtDate(order.createdAt))}</div></div><span class="carrier ${carrierUnknown ? 'unknown' : ''}">${escapeHtml(order.carrier || 'Chưa xác định')}</span></div>
      ${order.trackingCode ? `<div class="tracking-code">Mã vận đơn: ${escapeHtml(order.trackingCode)}</div>` : ''}
      ${order.address ? `<div class="order-address">${escapeHtml(order.address)}</div>` : ''}
      ${items}
      <div class="order-actions"><button type="button" class="print-button" data-print-order="${escapeHtml(key)}">▣ In bill</button><button type="button" class="print-original-button" data-print-original="${escapeHtml(key)}">▤ In vận đơn Sapo</button></div>
    </article>`;
  }).join('');
}

async function updatePrinterStatus() {
  const indicator = $('printer-status');
  try {
    const response = await fetch('/api/print/status', { credentials: 'same-origin', cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    const connected = response.ok && Boolean(data.connected);
    const bridgeConnected = response.ok && Boolean(data.bridgeConnected);
    indicator.className = `printer-status ${connected && bridgeConnected ? 'online' : 'offline'}`;
    indicator.innerHTML = `<span class="printer-dot"></span>${connected ? 'Máy in đã kết nối' : 'Máy in chưa kết nối'} · ${bridgeConnected ? 'Sapo Bridge đã kết nối' : 'Sapo Bridge chưa kết nối'}`;
  } catch (_) {
    indicator.className = 'printer-status offline';
    indicator.innerHTML = '<span class="printer-dot"></span>Không kiểm tra được kết nối máy in';
  }
}

async function printOrder(orderKey, button) {
  const order = currentOrders.get(String(orderKey));
  if (!order) { setStatus('Không tìm thấy dữ liệu đơn để in. Hãy tra cứu lại.', 'error'); return; }
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = 'Đang gửi lệnh…';
  setStatus(`Đang gửi bill ${order.code} đến máy in…`);
  try {
    const response = await fetch('/api/print', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ order })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || data.message || `Không in được (${response.status}).`);
    setStatus(`Đã gửi lệnh in ${order.code} đến ${data.printerName || 'máy in'}. ${data.message || ''}`, 'success');
    button.textContent = 'Đã gửi in';
  } catch (error) {
    setStatus(error.message, 'error');
    button.textContent = originalText;
    button.disabled = false;
    updatePrinterStatus();
  }
}


const originalPreparePromises = new Map();

function prepareOriginalOrder(orderKey) {
  const key = String(orderKey);
  if (originalPreparePromises.has(key)) return originalPreparePromises.get(key);
  const order = currentOrders.get(key);
  if (!order) return Promise.resolve(false);
  const promise = fetch('/api/print-original/prepare', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ order: { id: order.id, code: order.code } })
  }).then(async response => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok || !data.prepared) throw new Error(data.error || 'Chưa chuẩn bị được PDF.');
    return true;
  }).catch(() => {
    originalPreparePromises.delete(key);
    return false;
  });
  originalPreparePromises.set(key, promise);
  return promise;
}

async function printOriginalOrder(orderKey, button) {
  const order = currentOrders.get(String(orderKey));
  if (!order) { setStatus('Không tìm thấy đơn hàng. Hãy tra cứu lại.', 'error'); return; }
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = 'Đang lấy PDF Sapo…';
  setStatus(`Đang tìm PDF vận đơn gốc của ${order.code}…`);
  try {
    const preparing = originalPreparePromises.get(String(orderKey));
    if (preparing) await preparing;
    const response = await fetch('/api/print-original', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ order: { id: order.id, code: order.code } })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || `Không in được vận đơn (${response.status}).`);
    setStatus(`Đã gửi vận đơn Sapo của ${order.code} đến ${data.printerName || 'máy in'}. ${data.message || ''}`, 'success');
    button.textContent = 'Đã gửi vận đơn';
  } catch (error) {
    setStatus(error.message, 'error');
    button.textContent = originalText;
    button.disabled = false;
    updatePrinterStatus();
  }
}

async function search(query, { force = false } = {}) {
  query = String(query || '').trim();
  if (query.length < 2) { setStatus('Nhập ít nhất 2 ký tự để tra cứu.', 'error'); return; }
  if (!force && query === lastQuery) return;
  lastQuery = query;
  if (activeController) activeController.abort();
  activeController = new AbortController();
  $('search-button').disabled = true;
  $('search-button').textContent = 'Đang tìm…';
  resultsSection.classList.remove('hidden');
  $('results').innerHTML = `<div class="empty-state">Đang tìm các đơn mới nhất…</div>`;
  setStatus('Đang kết nối Sapo…');
  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { credentials:'same-origin', signal:activeController.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Không tìm được đơn hàng (${response.status}).`);
    renderOrders(data);
    setStatus(data.cached ? 'Kết quả vừa được lưu tạm trong thời gian ngắn.' : 'Đã cập nhật từ Sapo.');
  } catch (error) {
    if (error.name !== 'AbortError') {
      $('results').innerHTML = `<div class="empty-state"><strong>Không tra cứu được</strong><br>${escapeHtml(error.message)}</div>`;
      setStatus(error.message, 'error');
    }
  } finally {
    $('search-button').disabled = false;
    $('search-button').textContent = 'Tra cứu';
  }
}
$('search-form').addEventListener('submit', event => { event.preventDefault(); search($('last4').value.trim(), { force:true }); });
$('last4').addEventListener('input', event => {
  clearTimeout(searchTimer);
  const value = event.target.value.trim();
  if (value.length >= 2) searchTimer = setTimeout(() => search(value), 550);
  else { lastQuery = ''; if (activeController) activeController.abort(); }
});
$('clear').addEventListener('click', () => {
  $('last4').value = '';
  lastQuery = '';
  if (activeController) activeController.abort();
  $('last4').focus();
  resultsSection.classList.add('hidden');
  setStatus('');
});
$('results').addEventListener('pointerover', event => {
  const button = event.target.closest('[data-print-original]');
  if (!button || button.contains(event.relatedTarget)) return;
  prepareOriginalOrder(button.dataset.printOriginal);
});
$('results').addEventListener('pointerdown', event => {
  const button = event.target.closest('[data-print-original]');
  if (button) prepareOriginalOrder(button.dataset.printOriginal);
});
$('results').addEventListener('click', event => {
  const originalButton = event.target.closest('[data-print-original]');
  if (originalButton) { printOriginalOrder(originalButton.dataset.printOriginal, originalButton); return; }
  const button = event.target.closest('[data-print-order]');
  if (button) printOrder(button.dataset.printOrder, button);
});
(function init() { searchPanel.classList.remove('hidden'); setStatus('Sẵn sàng tra cứu đơn hàng.'); updatePrinterStatus(); setInterval(updatePrinterStatus, 30000); })();
