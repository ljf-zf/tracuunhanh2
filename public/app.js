const $ = (id) => document.getElementById(id);
const searchPanel = $('search-panel');
const resultsSection = $('results-section');
const statusEl = $('status');
let searchTimer = null;
let activeController = null;
let lastQuery = '';

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
  if (!data.orders.length) {
    results.innerHTML = `<div class="empty-state"><div class="empty-icon">⌕</div><strong>Chưa tìm thấy đơn phù hợp</strong><br>Thử mã đơn, mã vận đơn hoặc một đoạn địa chỉ có trong dữ liệu Sapo.</div>`;
    return;
  }
  results.innerHTML = data.orders.map(order => {
    const carrierUnknown = !order.carrier || order.carrier === 'Chưa xác định';
    const items = order.items && order.items.length
      ? order.items.map(item => `<div class="product-row"><div class="product-main"><div class="sku-line"><span class="product-sku">${item.sku ? escapeHtml(item.sku) : 'Chưa có SKU'}</span><span class="qty">× ${Number(item.quantity) || 0}</span></div><div class="product-name">${escapeHtml(item.name)}${item.variant ? ` · ${escapeHtml(item.variant)}` : ''}</div></div></div>`).join('')
      : `<div class="empty-products">API chưa trả về chi tiết sản phẩm cho đơn này.</div>`;
    return `<article class="order-card">
      <div class="order-top"><div><div class="order-code">${escapeHtml(order.code)}</div><div class="order-date">${escapeHtml(fmtDate(order.createdAt))}</div></div><span class="carrier ${carrierUnknown ? 'unknown' : ''}">${escapeHtml(order.carrier || 'Chưa xác định')}</span></div>
      ${order.trackingCode ? `<div class="tracking-code">Mã vận đơn: ${escapeHtml(order.trackingCode)}</div>` : ''}
      ${order.address ? `<div class="order-address">${escapeHtml(order.address)}</div>` : ''}
      ${items}
    </article>`;
  }).join('');
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
(function init() { searchPanel.classList.remove('hidden'); setStatus('Sẵn sàng tra cứu đơn hàng.'); })();
