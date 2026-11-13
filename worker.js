const cache = new Map();
const MAX_PAGES_DEFAULT = 10;
const CACHE_SECONDS_DEFAULT = 10;
const WORKER_VERSION = '2.0.0';
const AUTH_KV_KEY = 'sapo-auth-current';
const AUTH_KV_TTL_SECONDS = 60 * 60 * 24 * 60;

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

function jwtExpiryMs(token) {
  const value = String(token || '').replace(/^Bearer\s+/i, '').trim();
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  try {
    const payloadText = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(payloadText.padEnd(Math.ceil(payloadText.length / 4) * 4, '=')));
    const exp = Number(payload.exp);
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch (_) {
    return null;
  }
}

function usableToken(token) {
  const value = String(token || '').trim();
  if (!value) return false;
  const expiry = jwtExpiryMs(value);
  return expiry === null || expiry > Date.now() + 30000;
}

async function readSyncedAuth(env) {
  if (!env.SAPO_AUTH_KV) return null;
  try {
    return await env.SAPO_AUTH_KV.get(AUTH_KV_KEY, 'json');
  } catch (_) {
    return null;
  }
}

async function getSapoConfig(env) {
  const origin = String(env.SAPO_ORIGIN || 'https://market-place.sapoapps.vn').trim();
  let parsed;
  try { parsed = new URL(origin); } catch { throw new Error('SAPO_ORIGIN không hợp lệ.'); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'market-place.sapoapps.vn') {
    throw new Error('SAPO_ORIGIN phải dùng HTTPS và trỏ tới market-place.sapoapps.vn.');
  }

  const synced = await readSyncedAuth(env);
  const syncedAuthorization = usableToken(synced?.authorization) ? String(synced.authorization).trim() : '';
  const syncedMarketToken = usableToken(synced?.xMarketToken) ? String(synced.xMarketToken).trim() : '';
  const hasUsableSynced = Boolean(syncedAuthorization || syncedMarketToken);

  const envAuthorization = usableToken(env.SAPO_AUTHORIZATION) ? String(env.SAPO_AUTHORIZATION).trim() : '';
  const envMarketToken = usableToken(env.SAPO_MARKET_TOKEN) ? String(env.SAPO_MARKET_TOKEN).trim() : '';
  // Merge từng header độc lập: KV có thể cập nhật X-Market-Token trước,
  // trong khi Authorization vẫn đang hợp lệ từ cấu hình Secret (hoặc ngược lại).
  const authorization = syncedAuthorization || envAuthorization;
  const marketToken = syncedMarketToken || envMarketToken;
  const accountId = String(synced?.xMarketAccountId || env.SAPO_MARKET_ACCOUNT_ID || '').trim();

  const headers = { Accept: 'application/json' };
  if (authorization) headers.Authorization = authorization;
  if (marketToken) headers['X-Market-Token'] = marketToken;
  if (accountId) headers['X-Market-Account-Id'] = accountId;

  if (!authorization && !marketToken) {
    const hasAnySaved = Boolean(
      String(synced?.authorization || '').trim() ||
      String(synced?.xMarketToken || '').trim() ||
      String(env.SAPO_AUTHORIZATION || '').trim() ||
      String(env.SAPO_MARKET_TOKEN || '').trim()
    );
    if (hasAnySaved) {
      throw new Error('Token Sapo đã hết hạn hoặc sắp hết hạn. Mở Sapo trên Edge, tải lại danh sách đơn để extension đồng bộ token mới, rồi thử lại.');
    }
    throw new Error('Chưa có token Sapo. Mở Sapo trên Edge, tải danh sách đơn để extension bắt token và đồng bộ lên Worker.');
  }
  return {
    origin: parsed.origin,
    headers,
    source: hasUsableSynced ? 'extension-kv' : 'cloudflare-secret',
    syncedAt: hasUsableSynced ? Number(synced?.capturedAt || 0) : 0,
    query: {
      channelType: String(synced?.channelType || env.SAPO_CHANNEL_TYPE || ''),
      connectionIds: String(synced?.connectionIds || env.SAPO_CONNECTION_IDS || ''),
      sortBy: String(synced?.sortBy || env.SAPO_SORT_BY || 'ISSUED_AT'),
      orderBy: String(synced?.orderBy || env.SAPO_ORDER_BY || 'desc'),
      channelOrderStatus: String(env.SAPO_CHANNEL_ORDER_STATUS || 'READY_TO_SHIP,RETRY_SHIP')
    }
  };
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
    return { name: String(name), variant: variant && String(variant) !== String(name) ? String(variant) : '', quantity: Number.isFinite(qty) ? qty : 0, sku: item.sku || product.sku || '', unitPrice: firstNumber(item.unit_price, item.price, item.sale_price, item.price_after_discount), lineTotal: firstNumber(item.line_total, item.total_price, item.final_amount, item.amount) };
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

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' || typeof value === 'number') {
      const text = String(value).trim();
      if (text) return text;
    }
  }
  return '';
}

function firstNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function getPrintFields(o) {
  const customer = o.customer || o.buyer || {};
  const shipping = o.shipping_address || o.delivery_address || o.receiver_address || o.shippingAddress || {};
  const payment = o.payment_info || o.payment || o.payment_summary || {};
  const totals = o.price_summary || o.amounts || o.financial || {};
  const customerName = firstText(
    o.receiver_name, o.customer_name, o.recipient_name, o.ship_to_name,
    shipping.receiver_name, shipping.full_name, shipping.name,
    customer.full_name, customer.name, customer.customer_name
  );
  const phone = firstText(
    o.receiver_phone, o.customer_phone, o.phone_number, o.phone, o.recipient_phone,
    shipping.phone_number, shipping.phone, shipping.receiver_phone,
    customer.phone_number, customer.phone, customer.mobile
  );
  const totalAmount = firstNumber(o.total_amount, o.total_price, o.grand_total, o.order_total, o.total,
    totals.total_amount, totals.total_price, totals.grand_total, payment.total_amount);
  const shippingFee = firstNumber(o.shipping_fee, o.shipping_fee_amount, o.delivery_fee, o.shipping_price,
    o.total_shipping_fee, totals.shipping_fee, totals.delivery_fee);
  const discountAmount = firstNumber(o.discount_amount, o.total_discount, o.discount, totals.discount_amount, totals.discount);
  const codAmount = firstNumber(o.cod_amount, o.amount_to_collect, o.collect_amount, o.cash_on_delivery, payment.cod_amount);
  const paymentMethod = firstText(o.payment_method_name, o.payment_method, payment.method_name, payment.method, payment.name);
  return { customerName, phone, totalAmount, shippingFee, discountAmount, codAmount, paymentMethod };
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
    ...getPrintFields(o),
    items: getItems(o),
    status: String(o.channel_order_status || o.status_name || o.status || '')
  };
}

async function fetchOrdersPage(config, env, page) {
  const url = new URL('/v2/orders', config.origin);
  const params = {
    channelType: config.query?.channelType || env.SAPO_CHANNEL_TYPE,
    connectionIds: config.query?.connectionIds || env.SAPO_CONNECTION_IDS,
    sortBy: config.query?.sortBy || env.SAPO_SORT_BY || 'ISSUED_AT',
    orderBy: config.query?.orderBy || env.SAPO_ORDER_BY || 'desc',
    channelOrderStatus: config.query?.channelOrderStatus || env.SAPO_CHANNEL_ORDER_STATUS || 'READY_TO_SHIP,RETRY_SHIP'
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
    if (response.status === 401 || response.status === 403) throw new Error('Sapo từ chối xác thực (401/403). Mở Sapo trên Edge, tải lại danh sách đơn để extension bắt và đồng bộ token mới; nếu phiên đã hết hạn, hãy đăng nhập lại.');
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

async function configHealth(env) {
  const synced = await readSyncedAuth(env);
  const config = await getSapoConfig(env).catch(() => null);
  const hasStaticAuthorization = Boolean(String(env.SAPO_AUTHORIZATION || '').trim());
  const hasStaticMarketToken = Boolean(String(env.SAPO_MARKET_TOKEN || '').trim());
  const hasSyncedAuthorization = Boolean(String(synced?.authorization || '').trim());
  const hasSyncedMarketToken = Boolean(String(synced?.xMarketToken || '').trim());
  const capturedAt = Number(synced?.capturedAt || 0);
  return {
    ok: true,
    workerVersion: WORKER_VERSION,
    auth: {
      authorizationConfigured: Boolean(config?.headers?.Authorization),
      marketTokenConfigured: Boolean(config?.headers?.['X-Market-Token']),
      hasAnyCredential: Boolean(config),
      accountIdConfigured: Boolean(config?.headers?.['X-Market-Account-Id'] || env.SAPO_MARKET_ACCOUNT_ID),
      source: config?.source || (hasSyncedAuthorization || hasSyncedMarketToken ? 'expired-or-invalid' : 'missing'),
      syncedCredentialAvailable: hasSyncedAuthorization || hasSyncedMarketToken,
      capturedAt: capturedAt ? new Date(capturedAt).toISOString() : null,
      staticSecretConfigured: hasStaticAuthorization || hasStaticMarketToken
    },
    sync: {
      endpointReady: Boolean(String(env.SAPO_SYNC_SECRET || '').trim()),
      kvBindingReady: Boolean(env.SAPO_AUTH_KV)
    },
    printing: {
      brokerConfigured: Boolean(env.PRINT_BROKER),
      agentTokenConfigured: Boolean(String(env.PRINT_AGENT_TOKEN || '').trim()),
      webPinConfigured: Boolean(String(env.PRINT_WEB_PIN || '').trim()),
      sapoBridgeConfigured: Boolean(String(env.SAPO_BRIDGE_TOKEN || '').trim())
    },
    query: {
      originConfigured: Boolean(String(env.SAPO_ORIGIN || '').trim()),
      connectionIdsConfigured: Boolean(String(env.SAPO_CONNECTION_IDS || '').trim()),
      statusFilterConfigured: Boolean(String(env.SAPO_CHANNEL_ORDER_STATUS || '').trim()),
      maxPages: Math.max(1, Math.min(60, Number(env.MAX_PAGES || MAX_PAGES_DEFAULT)))
    },
    note: 'Chỉ hiển thị trạng thái, không trả về giá trị token hoặc khóa đồng bộ.'
  };
}

function constantTimeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left || !right || left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return mismatch === 0;
}

async function syncSapoAuth(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);
  if (!env.SAPO_AUTH_KV) {
    return json({ ok: false, error: 'Worker chưa được gắn KV namespace SAPO_AUTH_KV. Hãy thêm KV binding rồi deploy lại.' }, 503);
  }
  const expectedKey = String(env.SAPO_SYNC_SECRET || '');
  const suppliedKey = String(request.headers.get('X-Sapo-Sync-Key') || '');
  if (!expectedKey) return json({ ok: false, error: 'Worker chưa cấu hình Secret SAPO_SYNC_SECRET.' }, 503);
  if (!constantTimeEqual(suppliedKey, expectedKey)) return json({ ok: false, error: 'Khóa đồng bộ không đúng.' }, 401);

  const length = Number(request.headers.get('content-length') || 0);
  if (length > 20000) return json({ ok: false, error: 'Payload quá lớn.' }, 413);
  let payload;
  try { payload = await request.json(); }
  catch (_) { return json({ ok: false, error: 'JSON không hợp lệ.' }, 400); }

  const authorization = String(payload?.authorization || '').trim();
  const xMarketToken = String(payload?.xMarketToken || '').trim();
  const xMarketAccountId = String(payload?.xMarketAccountId || '').trim();
  if (!authorization && !xMarketToken) return json({ ok: false, error: 'Payload không có thông tin xác thực Sapo.' }, 400);
  if (authorization.length > 8192 || xMarketToken.length > 8192 || xMarketAccountId.length > 512) {
    return json({ ok: false, error: 'Trường xác thực vượt quá giới hạn cho phép.' }, 400);
  }
  const usableAuthorization = usableToken(authorization) ? authorization : '';
  const usableMarketToken = usableToken(xMarketToken) ? xMarketToken : '';
  if (!usableAuthorization && !usableMarketToken) {
    return json({ ok: false, error: 'Token đã hết hạn hoặc sắp hết hạn; hãy tải lại danh sách đơn Sapo để bắt token mới.' }, 400);
  }

  const record = {
    authorization: usableAuthorization,
    xMarketToken: usableMarketToken,
    xMarketAccountId,
    origin: 'https://market-place.sapoapps.vn',
    capturedAt: Number(payload?.capturedAt) > 0 ? Number(payload.capturedAt) : Date.now(),
    savedAt: Date.now(),
    source: 'edge-extension',
    connectionIds: String(payload?.connectionIds || '').slice(0, 4000),
    channelType: String(payload?.channelType || '').slice(0, 200),
    sortBy: String(payload?.sortBy || '').slice(0, 100),
    orderBy: String(payload?.orderBy || '').slice(0, 100)
  };
  try {
    await env.SAPO_AUTH_KV.put(AUTH_KV_KEY, JSON.stringify(record), { expirationTtl: AUTH_KV_TTL_SECONDS });
    cache.clear();
  } catch (_) {
    return json({ ok: false, error: 'Không thể lưu token vào Cloudflare KV. Kiểm tra quyền ghi của binding SAPO_AUTH_KV.' }, 500);
  }
  return json({
    ok: true,
    message: 'Đã đồng bộ thông tin xác thực và tham số kết nối Sapo.',
    capturedAt: new Date(record.capturedAt).toISOString(),
    storedAt: new Date(record.savedAt).toISOString(),
    recordTtlDays: 60
  });
}

async function searchOrders(request, env) {
  const url = new URL(request.url);
  const query = String(url.searchParams.get('q') || url.searchParams.get('last4') || '').normalize('NFC').trim();
  const normalizedQuery = normalizeSearch(query);
  if (normalizedQuery.length < 2) return json({ error: 'Nhập ít nhất 2 ký tự của mã đơn, mã vận đơn hoặc địa chỉ giao hàng.' }, 400);
  if (query.length > 100) return json({ error: 'Từ khóa quá dài.' }, 400);
  const cacheKey = normalizedQuery;
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > now) return json({ ...cached.data, cached: true });

  try {
    let config;
    try { config = await getSapoConfig(env); }
    catch (authError) {
      return json({ error: authError?.message || 'Chưa có token Sapo hợp lệ.', hint: '/api/health/config' }, 503);
    }
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


function validSapoPdfUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' &&
      url.hostname === 'social.dktcdn.net' &&
      url.pathname.startsWith('/shopee/') &&
      url.pathname.includes('/prints_orders/') &&
      url.pathname.toLowerCase().endsWith('.pdf') &&
      !url.username && !url.password;
  } catch (_) { return false; }
}

async function handleSapoPrintEvent(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);
  const expected = String(env.SAPO_BRIDGE_TOKEN || '');
  const supplied = String(request.headers.get('X-Sapo-Bridge-Key') || '');
  if (!expected) return json({ ok: false, error: 'Chưa cấu hình Secret SAPO_BRIDGE_TOKEN trên Cloudflare.' }, 503);
  if (!constantTimeEqual(supplied, expected)) return json({ ok: false, error: 'Bridge token không đúng.' }, 401);
  const text = await request.text();
  if (text.length > 50000) return json({ ok: false, error: 'Thông báo Sapo quá lớn.' }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ ok: false, error: 'Dữ liệu sự kiện không hợp lệ.' }, 400); }
  const event = body?.event || body;
  if (event?.type !== 'PRINT_ORDER' || event?.status !== 'SUCCESS' || !Array.isArray(event?.order_bills)) {
    return json({ ok: false, error: 'Không phải sự kiện PRINT_ORDER thành công.' }, 400);
  }
  const records = [];
  for (const bill of event.order_bills.slice(0, 100)) {
    const pdfUrl = String(bill?.data_to_print || '');
    const orderId = String(bill?.order_id || '').trim();
    const orderCode = String(bill?.sapo_order_code || bill?.channel_order_number || '').trim();
    if (!bill?.success || !orderId || !validSapoPdfUrl(pdfUrl)) continue;
    records.push({ orderId, orderCode, pdfUrl, tenantId: String(event.tenant_id || ''), channelType: Number(event.channel_type || 0), createdAt: Date.now() });
  }
  if (!records.length) return json({ ok: false, error: 'Sự kiện không có PDF Sapo hợp lệ.' }, 422);
  if (!env.PRINT_BROKER) return json({ ok: false, error: 'Print Broker chưa được cấu hình.' }, 503);
  const id = env.PRINT_BROKER.idFromName('store-printer');
  const result = await env.PRINT_BROKER.get(id).fetch('https://print-broker/event', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ records })
  });
  return result;
}

async function handleOriginalPrintRequest(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);
  const expectedPin = String(env.PRINT_WEB_PIN || '');
  const suppliedPin = String(request.headers.get('X-Print-Pin') || '');
  if (!expectedPin) return json({ ok: false, error: 'Chưa cấu hình Secret PRINT_WEB_PIN trên Cloudflare.' }, 503);
  if (!constantTimeEqual(suppliedPin, expectedPin)) return json({ ok: false, error: 'Mã PIN in không đúng.' }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Dữ liệu yêu cầu không hợp lệ.' }, 400); }
  const orderId = String(body?.order?.id || body?.orderId || '').trim();
  const orderCode = String(body?.order?.code || body?.orderCode || '').trim();
  if (!orderId && !orderCode) return json({ ok: false, error: 'Thiếu mã đơn hoặc ID đơn hàng.' }, 400);
  if (!env.PRINT_BROKER) return json({ ok: false, error: 'Print Broker chưa được cấu hình.' }, 503);
  const id = env.PRINT_BROKER.idFromName('store-printer');
  return env.PRINT_BROKER.get(id).fetch('https://print-broker/request-original', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderId, orderCode })
  });
}

async function handlePrintRequest(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);
  const expectedPin = String(env.PRINT_WEB_PIN || '');
  const suppliedPin = String(request.headers.get('X-Print-Pin') || '');
  if (!expectedPin) return json({ ok: false, error: 'Chưa cấu hình Secret PRINT_WEB_PIN trên Cloudflare.' }, 503);
  if (!constantTimeEqual(suppliedPin, expectedPin)) return json({ ok: false, error: 'Mã PIN in không đúng.' }, 401);
  const bodyText = await request.text();
  if (bodyText.length > 30000) return json({ ok: false, error: 'Dữ liệu bill quá lớn.' }, 413);
  let payload;
  try { payload = JSON.parse(bodyText); } catch { return json({ ok: false, error: 'Dữ liệu bill không hợp lệ.' }, 400); }
  const order = payload?.order;
  if (!order || typeof order !== 'object' || !String(order.code || '').trim()) {
    return json({ ok: false, error: 'Thiếu thông tin đơn hàng để in.' }, 400);
  }
  if (!Array.isArray(order.items) || order.items.length > 200) return json({ ok: false, error: 'Danh sách sản phẩm không hợp lệ.' }, 400);
  if (!env.PRINT_BROKER) return json({ ok: false, error: 'Print Broker chưa được cấu hình trên Cloudflare.' }, 503);
  const id = env.PRINT_BROKER.idFromName('store-printer');
  const stub = env.PRINT_BROKER.get(id);
  return stub.fetch('https://print-broker/dispatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ order })
  });
}

async function printAgentStatus(env) {
  if (!env.PRINT_BROKER) return json({ ok: true, connected: false, error: 'Print Broker chưa được cấu hình.' });
  const id = env.PRINT_BROKER.idFromName('store-printer');
  return env.PRINT_BROKER.get(id).fetch('https://print-broker/status');
}

export class PrintBroker {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.pending = new Map();
    this.pendingOriginal = new Map();
    this.busy = false;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/connect')) {
      const expected = String(this.env.PRINT_AGENT_TOKEN || '');
      const supplied = String(request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
      if (!expected || !constantTimeEqual(supplied, expected)) return json({ ok: false, error: 'Agent token không đúng.' }, 401);
      if (request.headers.get('Upgrade') !== 'websocket') return json({ ok: false, error: 'Cần kết nối WebSocket.' }, 426);
      for (const existing of this.state.getWebSockets()) {
        const attachment = existing.deserializeAttachment() || {};
        if (attachment.role !== 'bridge') { try { existing.close(4001, 'Replaced by a new Print Agent connection.'); } catch (_) {} }
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.state.acceptWebSocket(server);
      server.serializeAttachment({ role: 'agent', connectedAt: Date.now(), lastSeen: Date.now() });
      server.send(JSON.stringify({ type: 'connected', message: 'Print Agent đã kết nối.' }));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname.endsWith('/bridge-connect')) {
      const expected = String(this.env.SAPO_BRIDGE_TOKEN || '');
      const protocolHeader = String(request.headers.get('Sec-WebSocket-Protocol') || '');
      const suppliedProtocol = protocolHeader.split(',').map(v => v.trim()).find(v => v.startsWith('sapo-bridge.'));
      const supplied = suppliedProtocol ? suppliedProtocol.slice('sapo-bridge.'.length) : '';
      if (!expected || !constantTimeEqual(supplied, expected)) return json({ ok: false, error: 'Bridge token không đúng.' }, 401);
      if (request.headers.get('Upgrade') !== 'websocket') return json({ ok: false, error: 'Cần kết nối WebSocket.' }, 426);
      for (const existing of this.state.getWebSockets()) {
        const attachment = existing.deserializeAttachment() || {};
        if (attachment.role === 'bridge') { try { existing.close(4001, 'Bridge reconnected'); } catch (_) {} }
      }
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ role: 'bridge', connectedAt: Date.now(), lastSeen: Date.now() });
      pair[1].send(JSON.stringify({ type: 'bridge-connected' }));
      return new Response(null, { status: 101, webSocket: pair[0], headers: { 'Sec-WebSocket-Protocol': suppliedProtocol } });
    }

    if (url.pathname.endsWith('/status')) {
      const sockets = this.state.getWebSockets();
      const agents = sockets.filter(socket => (socket.deserializeAttachment() || {}).role !== 'bridge');
      const bridges = sockets.filter(socket => (socket.deserializeAttachment() || {}).role === 'bridge');
      const latest = agents.length ? (agents[0].deserializeAttachment() || {}) : {};
      return json({ ok: true, connected: agents.length > 0, agents: agents.length, bridgeConnected: bridges.length > 0, lastSeen: latest.lastSeen || null, busy: this.busy });
    }

    if (url.pathname.endsWith('/event') && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: 'Sự kiện không hợp lệ.' }, 400); }
      const records = Array.isArray(body.records) ? body.records.slice(0, 100) : [];
      let saved = 0, dispatched = 0;
      for (const record of records) {
        if (!record?.orderId || !validSapoPdfUrl(record.pdfUrl)) continue;
        const safe = { orderId: String(record.orderId), orderCode: String(record.orderCode || ''), pdfUrl: String(record.pdfUrl), createdAt: Date.now() };
        await this.state.storage.put(`sapo-print-id:${safe.orderId}`, safe, { expirationTtl: 60 * 60 * 12 });
        if (safe.orderCode) await this.state.storage.put(`sapo-print-code:${safe.orderCode}`, safe, { expirationTtl: 60 * 60 * 12 });
        saved++;
        const waiting = [...this.pendingOriginal.values()].find(item =>
          (item.orderId && item.orderId === safe.orderId) ||
          (item.orderCode && safe.orderCode && item.orderCode === safe.orderCode)
        );
        if (waiting) {
          clearTimeout(waiting.timer);
          this.pendingOriginal.delete(waiting.requestId);
          const result = await this.dispatchPdfRecord(safe, waiting.requestId);
          waiting.resolve(result);
          if (result.ok) dispatched++;
        }
      }
      return json({ ok: true, saved, dispatched });
    }

    if (url.pathname.endsWith('/request-original') && request.method === 'POST') {
      if (this.busy) return json({ ok: false, error: 'Đang có một lệnh in khác được xử lý. Vui lòng thử lại sau.' }, 409);
      const sockets = this.state.getWebSockets();
      const agent = sockets.find(socket => (socket.deserializeAttachment() || {}).role !== 'bridge');
      const bridge = sockets.find(socket => (socket.deserializeAttachment() || {}).role === 'bridge');
      if (!agent) return json({ ok: false, error: 'Máy tính in chưa kết nối. Hãy bật Windows và Print Agent.' }, 503);
      if (!bridge) return json({ ok: false, error: 'Sapo Print Bridge chưa kết nối. Hãy mở Edge, đăng nhập Sapo và bật extension.' }, 503);
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: 'Dữ liệu yêu cầu không hợp lệ.' }, 400); }
      const orderId = String(body.orderId || '');
      const orderCode = String(body.orderCode || '');
      let record = orderId ? await this.state.storage.get(`sapo-print-id:${orderId}`) : null;
      if (!record && orderCode) record = await this.state.storage.get(`sapo-print-code:${orderCode}`);
      if (record && validSapoPdfUrl(record.pdfUrl)) {
        this.busy = true;
        try {
          const result = await this.dispatchPdfRecord(record, crypto.randomUUID());
          if (result.ok) {
            if (orderId) await this.state.storage.delete(`sapo-print-id:${orderId}`);
            if (record.orderCode) await this.state.storage.delete(`sapo-print-code:${record.orderCode}`);
          }
          return json(result, result.ok ? 200 : 502);
        } finally { this.busy = false; }
      }
      const requestId = crypto.randomUUID();
      this.busy = true;
      try {
        const result = await new Promise(resolve => {
          const timer = setTimeout(() => {
            this.pendingOriginal.delete(requestId);
            resolve({ ok: false, error: 'Sapo không trả PDF trong thời gian chờ. Kiểm tra Edge, phiên đăng nhập Sapo và kết nối Bridge.' });
          }, 45000);
          this.pendingOriginal.set(requestId, { requestId, orderId, orderCode, resolve, timer });
          try {
            bridge.send(JSON.stringify({ type: 'trigger-sapo-print', requestId, orderId, orderCode }));
          } catch (_) {
            clearTimeout(timer); this.pendingOriginal.delete(requestId);
            resolve({ ok: false, error: 'Không gửi được yêu cầu tới Sapo Print Bridge.' });
          }
        });
        if (result.ok) {
          if (orderId) await this.state.storage.delete(`sapo-print-id:${orderId}`);
          if (orderCode) await this.state.storage.delete(`sapo-print-code:${orderCode}`);
        }
        return json(result, result.ok ? 200 : 502);
      } finally { this.busy = false; }
    }

    if (url.pathname.endsWith('/dispatch') && request.method === 'POST') {
      if (this.busy) return json({ ok: false, error: 'Đang có một lệnh in khác được xử lý. Vui lòng thử lại sau.' }, 409);
      const sockets = this.state.getWebSockets().filter(socket => (socket.deserializeAttachment() || {}).role !== 'bridge');
      if (!sockets.length) return json({ ok: false, error: 'Máy tính in chưa kết nối. Hãy bật Windows và Print Agent rồi thử lại.' }, 503);
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: 'Dữ liệu lệnh in không hợp lệ.' }, 400); }
      const requestId = crypto.randomUUID();
      const socket = sockets[0];
      this.busy = true;
      try {
        const result = await new Promise(resolve => {
          const timer = setTimeout(() => {
            this.pending.delete(requestId);
            resolve({ ok: false, error: 'Print Agent không phản hồi kịp thời. Không tự động gửi lại để tránh in trùng.' });
          }, 25000);
          this.pending.set(requestId, { resolve, timer });
          try { socket.send(JSON.stringify({ type: 'print', requestId, order: body.order })); }
          catch (_) {
            clearTimeout(timer); this.pending.delete(requestId);
            resolve({ ok: false, error: 'Kết nối với Print Agent bị gián đoạn.' });
          }
        });
        return json(result, result.ok ? 200 : 502);
      } finally { this.busy = false; }
    }

    return json({ ok: false, error: 'Không tìm thấy endpoint Print Broker.' }, 404);
  }

  async dispatchPdfRecord(record, requestId) {
    const sockets = this.state.getWebSockets();
    const agent = sockets.find(item => (item.deserializeAttachment() || {}).role !== 'bridge');
    if (!agent) return { ok: false, error: 'Print Agent đã ngắt kết nối.' };
    let response;
    try {
      // CDN vận đơn có thể chuyển hướng sang URL lưu trữ PDF khác cùng hệ thống.
      // Cho phép theo redirect nhưng chỉ chấp nhận đích HTTPS thuộc dktcdn.net.
      response = await fetch(record.pdfUrl, {
        headers: { Accept: 'application/pdf' },
        redirect: 'follow'
      });
    } catch (error) {
      const detail = String(error?.message || error || 'fetch failed').slice(0, 180);
      console.warn('[PrintBroker] PDF fetch failed:', detail);
      return { ok: false, error: `Không tải được PDF từ CDN Sapo: ${detail}` };
    }
    try {
      const finalUrl = new URL(response.url || record.pdfUrl);
      if (finalUrl.protocol !== 'https:' ||
          !(finalUrl.hostname === 'dktcdn.net' || finalUrl.hostname.endsWith('.dktcdn.net'))) {
        return { ok: false, error: 'CDN Sapo chuyển hướng tới máy chủ ngoài danh sách an toàn.' };
      }
    } catch (_) {
      return { ok: false, error: 'URL PDF sau chuyển hướng không hợp lệ.' };
    }
    if (!response.ok) return { ok: false, error: `Máy chủ PDF trả về HTTP ${response.status}.` };
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength < 8 || bytes.byteLength > 12 * 1024 * 1024) return { ok: false, error: 'PDF không hợp lệ hoặc vượt giới hạn 12 MB.' };
    if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') return { ok: false, error: 'Tệp Sapo trả về không phải PDF.' };
    const binary = new Uint8Array(bytes);
    let binaryString = '';
    for (let i = 0; i < binary.length; i += 0x8000) binaryString += String.fromCharCode(...binary.subarray(i, i + 0x8000));
    const pdfBase64 = btoa(binaryString);
    return await new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ok: false, error: 'Print Agent không phản hồi. Không tự động gửi lại để tránh in trùng.' });
      }, 45000);
      this.pending.set(requestId, { resolve, timer });
      try {
        agent.send(JSON.stringify({ type: 'print-original', requestId, orderCode: record.orderCode || record.orderId, pdfBase64, fileName: `sapo-${record.orderCode || record.orderId}.pdf` }));
      } catch (_) {
        clearTimeout(timer); this.pending.delete(requestId);
        resolve({ ok: false, error: 'Kết nối với Print Agent bị gián đoạn.' });
      }
    });
  }

  async webSocketMessage(socket, message) {
    let data;
    try { data = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)); }
    catch { return; }
    const attachment = socket.deserializeAttachment() || {};
    socket.serializeAttachment({ ...attachment, lastSeen: Date.now(), agentVersion: String(data.agentVersion || attachment.agentVersion || '') });
    if (data.type === 'ping') {
      try { socket.send(JSON.stringify({ type: 'pong', at: Date.now() })); } catch (_) {}
      return;
    }
    if (data.type === 'bridge-trigger-error' && data.requestId) {
      const entry = this.pendingOriginal.get(String(data.requestId));
      if (entry) {
        clearTimeout(entry.timer); this.pendingOriginal.delete(String(data.requestId));
        entry.resolve({ ok: false, error: String(data.error || 'Không thể kích hoạt thao tác in trong Sapo.') });
      }
      return;
    }
    if ((data.type === 'print-result' || data.type === 'print-original-result') && data.requestId) {
      const entry = this.pending.get(String(data.requestId));
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(String(data.requestId));
      entry.resolve({ ok: Boolean(data.ok), message: String(data.message || ''), error: data.ok ? undefined : String(data.error || 'Không thể gửi lệnh đến máy in.'), printerName: String(data.printerName || '') });
    }
  }

  async webSocketClose(socket) {
    try { socket.close(); } catch (_) {}
  }

  async webSocketError(socket) {
    try { socket.close(); } catch (_) {}
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/health/config') return json(await configHealth(env));
    if (url.pathname === '/api/print-agent/connect' || url.pathname === '/api/sapo/bridge/connect') {
      if (!env.PRINT_BROKER) return json({ ok: false, error: 'Print Broker chưa được cấu hình.' }, 503);
      const id = env.PRINT_BROKER.idFromName('store-printer');
      const target = url.pathname.endsWith('/bridge/connect') ? 'bridge-connect' : 'connect';
      const internal = new Request(`https://print-broker/${target}`, request);
      return env.PRINT_BROKER.get(id).fetch(internal);
    }
    if (request.method === 'GET' && url.pathname === '/api/print/status') return printAgentStatus(env);
    if (url.pathname === '/api/print') return handlePrintRequest(request, env);
    if (url.pathname === '/api/print-original') return handleOriginalPrintRequest(request, env);
    if (url.pathname === '/api/sapo/print-event') return handleSapoPrintEvent(request, env);
    if (url.pathname === '/api/sync-sapo-auth') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: {
          'access-control-allow-origin': request.headers.get('Origin') || '*',
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'Content-Type, X-Sapo-Sync-Key',
          'access-control-max-age': '600',
          'cache-control': 'no-store'
        }});
      }
      const response = await syncSapoAuth(request, env);
      const origin = request.headers.get('Origin') || '';
      if (origin.startsWith('chrome-extension://')) {
        const headers = new Headers(response.headers);
        headers.set('access-control-allow-origin', origin);
        headers.set('vary', 'Origin');
        return new Response(response.body, { status: response.status, headers });
      }
      return response;
    }
    if (request.method === 'GET' && url.pathname === '/api/search') return searchOrders(request, env);
    if (url.pathname.startsWith('/api/')) return json({ error: 'Không tìm thấy API.' }, 404);
    return env.ASSETS.fetch(request);
  }
};
