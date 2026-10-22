const cache = new Map();
const MAX_PAGES_DEFAULT = 10;
const CACHE_SECONDS_DEFAULT = 20;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    }
  });
}

function getSapoConfig(env) {
  const origin = env.SAPO_ORIGIN || 'https://market-place.sapoapps.vn';
  let parsed;
  try { parsed = new URL(origin); } catch { throw new Error('SAPO_ORIGIN không hợp lệ.'); }
  if (parsed.protocol !== 'https:') throw new Error('SAPO_ORIGIN phải dùng HTTPS.');
  const headers = { Accept: 'application/json' };
  if (env.SAPO_AUTHORIZATION) headers.Authorization = env.SAPO_AUTHORIZATION;
  if (env.SAPO_MARKET_ACCOUNT_ID) headers['X-Market-Account-Id'] = env.SAPO_MARKET_ACCOUNT_ID;
  if (env.SAPO_MARKET_TOKEN) headers['X-Market-Token'] = env.SAPO_MARKET_TOKEN;
  if (!headers.Authorization && !headers['X-Market-Token']) throw new Error('Máy chủ chưa cấu hình thông tin xác thực Sapo.');
  return { origin: parsed.origin, headers };
}
function orderCodeCandidates(o) {
  return [o.channel_order_number, o.sapo_order_code, o.order_code, o.code, o.order_number, o.orderNumber, o.name, o.tracking_code]
    .filter(v => v !== undefined && v !== null && String(v).trim() !== '').map(String);
}
function getOrderDate(o) {
  const raw = o.created_at || o.createdAt || o.order_created_at || o.updated_at || o.updatedAt || '';
  const t = Date.parse(raw); return Number.isFinite(t) ? t : 0;
}
function getCarrier(o) {
  const candidates = [o.shipping_provider_name, o.shipping_provider, o.shipping_carrier, o.carrier_name, o.carrier,
    o.delivery_partner, o.shipping_company, o.transport_name, o.shipper_name, o.fulfillment_provider,
    o.shipping && (o.shipping.provider_name || o.shipping.carrier || o.shipping.name),
    o.shipping_info && (o.shipping_info.provider_name || o.shipping_info.carrier_name || o.shipping_info.name),
    o.shipping_method && (o.shipping_method.name || o.shipping_method.title),
    o.shipping_package && (o.shipping_package.shipping_provider_name || o.shipping_package.carrier_name)];
  for (const v of candidates) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (v && typeof v === 'object') { const name = v.name || v.title || v.code || v.provider_name; if (name) return String(name); }
  }
  const raw = JSON.stringify(o).toLowerCase();
  const known = [['green sm','Green SM'],['greensm','Green SM'],['grab','Grab'],['be delivery','be'],['befood','be'],['spx','SPX'],['shopee express','SPX'],['ahamove','Ahamove'],['lalamove','Lalamove'],['giao hang nhanh','GHN'],['ghn','GHN'],['giao hang tiet kiem','GHTK'],['ghtk','GHTK'],['viettel post','Viettel Post'],['j&t','J&T'],['jt express','J&T']];
  for (const [needle, label] of known) if (raw.includes(needle)) return label;
  return 'Chưa xác định';
}
function getItems(o) {
  const arr = o.items || o.line_items || o.order_items || o.products || o.details || (o.order && (o.order.items || o.order.line_items)) || [];
  if (!Array.isArray(arr)) return [];
  return arr.map(item => {
    const product = item.product || item.variant || {};
    const name = item.item_name || item.product_name || item.name || item.title || item.variation_name || product.name || product.title || product.item_name || 'Sản phẩm chưa có tên';
    const variant = item.variation_name || item.variant_name || item.variant_title || '';
    const qty = Number(item.quantity ?? item.qty ?? item.amount ?? item.ordered_quantity ?? 0);
    return { name: String(name), variant: variant && String(variant) !== String(name) ? String(variant) : '', quantity: Number.isFinite(qty) ? qty : 0, sku: item.sku || product.sku || '' };
  });
}
function mapOrder(o) {
  const codes = orderCodeCandidates(o);
  const fullCode = String(o.channel_order_number || o.sapo_order_code || o.order_code || o.code || o.order_number || codes[0] || 'Không rõ mã');
  return { id: String(o.id || o.order_id || fullCode), code: fullCode, trackingCode: String(o.tracking_code || o.tracking_number || ''), createdAt: o.created_at || o.createdAt || o.order_created_at || '', createdTs: getOrderDate(o), carrier: getCarrier(o), items: getItems(o), status: String(o.channel_order_status || o.status_name || o.status || '') };
}
async function fetchOrdersPage(config, env, page) {
  const url = new URL('/v2/orders', config.origin);
  const params = {
    channelType: env.SAPO_CHANNEL_TYPE,
    connectionIds: env.SAPO_CONNECTION_IDS,
    sortBy: env.SAPO_SORT_BY || 'ISSUED_AT',
    orderBy: env.SAPO_ORDER_BY || 'desc',
    channelOrderStatus: env.SAPO_CHANNEL_ORDER_STATUS || 'READY_TO_SHIP,RETRY_SHIP'
  };
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  url.searchParams.set('page', String(page)); url.searchParams.set('limit', '100');
  let resp;
  try {
    resp = await fetch(url, { headers: config.headers, signal: AbortSignal.timeout(12000) });
  } catch (e) {
    if (e && e.name === 'TimeoutError') throw new Error('Sapo phản hồi quá chậm (hết 12 giây). Thử lại sau.');
    throw new Error('Không kết nối được Sapo API. Kiểm tra mạng hoặc cấu hình xác thực.');
  }
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) throw new Error('Sapo từ chối xác thực (401/403). Hãy cập nhật thông tin xác thực ở Cloudflare.');
    throw new Error(`Sapo API trả lỗi HTTP ${resp.status}.`);
  }
  const text = await resp.text();
  if (!text.trim()) throw new Error('Sapo trả về nội dung rỗng. Kiểm tra token và cấu hình API.');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Sapo trả dữ liệu không phải JSON hợp lệ. Kiểm tra token hoặc phản hồi API.'); }
  return { orders: Array.isArray(data.orders) ? data.orders : [], total: Number(data.metadata && data.metadata.total) || 0 };
}
async function searchOrders(request, env) {
  const url = new URL(request.url);
  const query = String(url.searchParams.get('q') || url.searchParams.get('last4') || '').normalize('NFC').trim().toLocaleLowerCase('vi-VN');
  if (query.length < 2) return json({ error: 'Nhập ít nhất 2 ký tự của mã đơn hoặc mã vận đơn.' }, 400);
  if (query.length > 100) return json({ error: 'Từ khóa quá dài.' }, 400);
  const now = Date.now();
  const cached = cache.get(query);
  if (cached && cached.expires > now) return json({ ...cached.data, cached: true });
  try {
    const config = getSapoConfig(env);
    const maxPages = Math.max(1, Math.min(60, Number(env.MAX_PAGES || MAX_PAGES_DEFAULT)));
    const first = await fetchOrdersPage(config, env, 1);
    const all = [...first.orders];
    const totalPages = Math.min(maxPages, Math.ceil(Math.max(first.total, all.length) / 100));
    for (let page = 2; page <= totalPages; page++) {
      const result = await fetchOrdersPage(config, env, page);
      if (!result.orders.length) break;
      all.push(...result.orders);
      if (all.length >= first.total && first.total > 0) break;
    }
    const matches = all.map(mapOrder).filter(o => [o.code, o.trackingCode].filter(Boolean).some(code => String(code).normalize('NFC').toLocaleLowerCase('vi-VN').includes(query))).sort((a,b) => b.createdTs-a.createdTs);
    const data = { query, count: matches.length, orders: matches, scanned: all.length, partial: totalPages >= maxPages && all.length < first.total, checkedAt: new Date().toISOString() };
    const cacheSeconds = Math.max(0, Number(env.CACHE_SECONDS ?? CACHE_SECONDS_DEFAULT));
    if (cacheSeconds > 0) cache.set(query, { expires: now + cacheSeconds * 1000, data });
    return json(data);
  } catch (error) {
    return json({ error: error && error.message ? error.message : 'Không thể kết nối Sapo.' }, 502);
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/search') return searchOrders(request, env);
    if (url.pathname.startsWith('/api/')) return json({ error: 'Không tìm thấy API.' }, 404);
    // Static assets are served by the Workers Static Assets binding configured in wrangler.jsonc.
    return env.ASSETS.fetch(request);
  }
};
