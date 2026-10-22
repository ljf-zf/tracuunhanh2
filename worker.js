const cache = new Map();
const MAX_PAGES_DEFAULT = 10;
const CACHE_SECONDS_DEFAULT = 10;
const WORKER_VERSION = '1.1.0';

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
  const origin = String(env.SAPO_ORIGIN || 'https://market-place.sapoapps.vn').trim();
  let parsed;
  try { parsed = new URL(origin); } catch { throw new Error('SAPO_ORIGIN không hợp lệ.'); }
  if (parsed.protocol !== 'https:') throw new Error('SAPO_ORIGIN phải dùng HTTPS.');

  const authorization = String(env.SAPO_AUTHORIZATION || '').trim();
  const marketToken = String(env.SAPO_MARKET_TOKEN || '').trim();
  const accountId = String(env.SAPO_MARKET_ACCOUNT_ID || '').trim();
  const headers = { Accept: 'application/json' };
  if (authorization) headers.Authorization = authorization;
  if (marketToken) headers['X-Market-Token'] = marketToken;
  if (accountId) headers['X-Market-Account-Id'] = accountId;

  if (!authorization && !marketToken) {
    throw new Error('Worker chưa nhận được Secret SAPO_AUTHORIZATION hoặc SAPO_MARKET_TOKEN. Hãy tạo chúng dưới dạng Secret trong đúng Worker tracuunhanh-worker, môi trường Production; không tạo dạng Text/Variable.');
  }
  return { origin: parsed.origin, headers };
}

function normalizeSearch(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'd')
    .toLocaleLowerCase('vi-VN')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().replace(/\s+/g, ' ');
}

function orderCodeCandidates(o) {
  return [o.channel_order_number, o.sapo_order_code, o.order_code, o.code, o.order_number, o.orderNumber, o.name, o.tracking_code, o.tracking_number]
    .filter(v => v !== undefined && v !== null && String(v).trim() !== '').map(String);
}

function getOrderDate(o) {
  const raw = o.created_at || o.createdAt || o.order_created_at || o.issued_at || o.updated_at || o.updatedAt || '';
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
}

function getCarrier(o) {
  const candidates = [
    o.shipping_provider_name, o.shipping_provider, o.shipping_carrier, o.carrier_name, o.carrier,
    o.delivery_partner, o.shipping_company, o.transport_name, o.shipper_name, o.fulfillment_provider,
    o.shipping && (o.shipping.provider_name || o.shipping.carrier || o.shipping.name),
    o.shipping_info && (o.shipping_info.provider_name || o.shipping_info.carrier_name || o.shipping_info.name),
    o.shipping_method && (o.shipping_method.name || o.shipping_method.title),
    o.shipping_package && (o.shipping_package.shipping_provider_name || o.shipping_package.carrier_name)
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value === 'object') {
      const name = value.name || value.title || value.code || value.provider_name;
      if (name) return String(name);
    }
  }
  const raw = JSON.stringify(o).toLowerCase();
  const known = [['green sm','Green SM'],['greensm','Green SM'],['grabexpress','GrabExpress'],['grab','Grab'],['be delivery','be'],['bedelivery','be'],['befood','be'],['spx','SPX'],['shopee express','SPX'],['ahamove','Ahamove'],['lalamove','Lalamove'],['giao hang nhanh','GHN'],['ghn','GHN'],['giao hang tiet kiem','GHTK'],['ghtk','GHTK'],['viettel post','Viettel Post'],['j&t','J&T'],['jt express','J&T']];
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

function getAddressCandidates(order) {
  const found = [];
  const seen = new Set();
  const directKeys = /^(address|full_address|address_line|address1|address2|street|street_address|shipping_address|delivery_address|receiver_address|recipient_address|customer_address|province_name|district_name|ward_name|commune_name|city_name|province|district|ward|commune|city|town|location_name)$/i;
  const add = value => {
    if (typeof value === 'string' || typeof value === 'number') {
      const text = String(value).trim();
      if (text.length >= 2 && !seen.has(text)) { seen.add(text); found.push(text); }
    }
  };
  const walk = (value, depth = 0) => {
    if (!value || depth > 7 || found.length >= 80) return;
    if (Array.isArray(value)) { for (const item of value.slice(0, 40)) walk(item, depth + 1); return; }
    if (typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (directKeys.test(key)) {
        if (typeof child === 'string' || typeof child === 'number') add(child);
        else if (child && typeof child === 'object') walk(child, depth + 1);
      }
      if (child && typeof child === 'object' && depth < 7) walk(child, depth + 1);
    }
  };
  walk(order);
  return found;
}

function getAddress(order) {
  const parts = getAddressCandidates(order);
  // Keep the presentation readable and avoid showing many repeated nested fields.
  return parts.slice(0, 12).join(', ');
}

function mapOrder(o) {
  const codes = orderCodeCandidates(o);
  const fullCode = String(o.channel_order_number || o.sapo_order_code || o.order_code || o.code || o.order_number || codes[0] || 'Không rõ mã');
  return {
    id: String(o.id || o.order_id || fullCode),
    code: fullCode,
    trackingCode: String(o.tracking_code || o.tracking_number || ''),
    createdAt: o.created_at || o.createdAt || o.order_created_at || o.issued_at || '',
    createdTs: getOrderDate(o),
    carrier: getCarrier(o),
    address: getAddress(o),
    items: getItems(o),
    status: String(o.channel_order_status || o.status_name || o.status || '')
  };
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
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && String(value).trim() !== '') url.searchParams.set(key, String(value));
  url.searchParams.set('page', String(page));
  url.searchParams.set('limit', '100');

  let response;
  try {
    response = await fetch(url, { headers: config.headers, signal: AbortSignal.timeout(15000) });
  } catch (error) {
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new Error('Sapo phản hồi quá chậm (hết 15 giây). Thử lại sau.');
    throw new Error('Không kết nối được Sapo API. Kiểm tra mạng hoặc cấu hình xác thực.');
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('Sapo từ chối xác thực (401/403). Hãy cập nhật token Sapo còn hạn trong Secrets của Cloudflare.');
    const detail = response.status === 429 ? 'Sapo giới hạn số yêu cầu (429).' : `Sapo API trả lỗi HTTP ${response.status}.`;
    throw new Error(detail);
  }
  const body = await response.text();
  if (!body.trim()) throw new Error('Sapo trả về nội dung rỗng. Kiểm tra token và phản hồi API.');
  let data;
  try { data = JSON.parse(body); } catch { throw new Error('Sapo trả dữ liệu không phải JSON hợp lệ. Kiểm tra token hoặc phản hồi API.'); }
  const orders = Array.isArray(data.orders) ? data.orders : Array.isArray(data.data?.orders) ? data.data.orders : Array.isArray(data.results) ? data.results : [];
  const rawTotal = data.metadata?.total ?? data.meta?.total ?? data.total;
  const total = Number(rawTotal) || 0;
  return { orders, total };
}

function configHealth(env) {
  const auth = Boolean(String(env.SAPO_AUTHORIZATION || '').trim());
  const token = Boolean(String(env.SAPO_MARKET_TOKEN || '').trim());
  return {
    ok: true,
    workerVersion: WORKER_VERSION,
    auth: {
      authorizationConfigured: auth,
      marketTokenConfigured: token,
      hasAnyCredential: auth || token,
      accountIdConfigured: Boolean(String(env.SAPO_MARKET_ACCOUNT_ID || '').trim())
    },
    query: {
      originConfigured: Boolean(String(env.SAPO_ORIGIN || '').trim()),
      connectionIdsConfigured: Boolean(String(env.SAPO_CONNECTION_IDS || '').trim()),
      statusFilterConfigured: Boolean(String(env.SAPO_CHANNEL_ORDER_STATUS || '').trim()),
      maxPages: Math.max(1, Math.min(60, Number(env.MAX_PAGES || MAX_PAGES_DEFAULT)))
    },
    note: 'Chỉ hiển thị trạng thái cấu hình, không trả về giá trị Secret.'
  };
}

async function searchOrders(request, env) {
  const url = new URL(request.url);
  const query = String(url.searchParams.get('q') || url.searchParams.get('last4') || '').normalize('NFC').trim();
  const normalizedQuery = normalizeSearch(query);
  if (normalizedQuery.length < 2) return json({ error: 'Nhập ít nhất 2 ký tự của mã đơn, mã vận đơn hoặc địa chỉ giao hàng.' }, 400);
  if (query.length > 100) return json({ error: 'Từ khóa quá dài.' }, 400);
  if (!String(env.SAPO_AUTHORIZATION || '').trim() && !String(env.SAPO_MARKET_TOKEN || '').trim()) {
    return json({ error: 'Worker chưa nhận được Secret SAPO_AUTHORIZATION hoặc SAPO_MARKET_TOKEN. Hãy tạo chúng dưới dạng Secret trong đúng Worker tracuunhanh-worker, môi trường Production; không tạo dạng Text/Variable.', hint: '/api/health/config' }, 503);
  }
  const cacheKey = normalizedQuery;
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > now) return json({ ...cached.data, cached: true });

  try {
    const config = getSapoConfig(env);
    const maxPages = Math.max(1, Math.min(60, Number(env.MAX_PAGES || MAX_PAGES_DEFAULT)));
    const first = await fetchOrdersPage(config, env, 1);
    const all = [...first.orders];
    let reachedEnd = first.orders.length === 0;
    let targetPages = first.total > 0 ? Math.ceil(first.total / 100) : maxPages;
    targetPages = Math.max(1, Math.min(maxPages, targetPages));
    for (let page = 2; page <= targetPages; page++) {
      const result = await fetchOrdersPage(config, env, page);
      if (!result.orders.length) { reachedEnd = true; break; }
      all.push(...result.orders);
      if (first.total > 0 && all.length >= first.total) { reachedEnd = true; break; }
      if (first.total === 0 && result.orders.length < 100) { reachedEnd = true; break; }
    }
    const mapped = all.map(mapOrder);
    const matches = mapped.filter(order => {
      const codeMatch = [order.code, order.trackingCode].filter(Boolean).some(value => normalizeSearch(value).includes(normalizedQuery));
      const addressMatch = order.address && normalizeSearch(order.address).includes(normalizedQuery);
      return codeMatch || addressMatch;
    }).map(order => {
      const codeMatch = [order.code, order.trackingCode].filter(Boolean).some(value => normalizeSearch(value).includes(normalizedQuery));
      return { ...order, matchedBy: codeMatch ? 'code' : 'address' };
    }).sort((a, b) => b.createdTs - a.createdTs);
    const partial = !reachedEnd && (all.length >= maxPages * 100 || (first.total > 0 && all.length < first.total));
    const data = {
      query,
      count: matches.length,
      orders: matches,
      scanned: all.length,
      partial,
      checkedAt: new Date().toISOString()
    };
    const cacheSeconds = Math.max(0, Number(env.CACHE_SECONDS ?? CACHE_SECONDS_DEFAULT));
    if (cacheSeconds > 0) cache.set(cacheKey, { expires: now + cacheSeconds * 1000, data });
    // Bound isolate-local cache growth.
    if (cache.size > 150) {
      for (const [key, value] of cache) if (value.expires <= now) cache.delete(key);
      while (cache.size > 150) cache.delete(cache.keys().next().value);
    }
    return json(data);
  } catch (error) {
    return json({ error: error && error.message ? error.message : 'Không thể kết nối Sapo.', hint: '/api/health/config' }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/health/config') return json(configHealth(env));
    if (request.method === 'GET' && url.pathname === '/api/search') return searchOrders(request, env);
    if (url.pathname.startsWith('/api/')) return json({ error: 'Không tìm thấy API.' }, 404);
    return env.ASSETS.fetch(request);
  }
};
