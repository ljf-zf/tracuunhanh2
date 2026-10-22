require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_PAGES = Math.max(1, Math.min(60, Number(process.env.MAX_PAGES || 10)));
const CACHE_MS = Math.max(0, Number(process.env.CACHE_SECONDS || 20)) * 1000;

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use(express.json({ limit: "10kb" }));

const cache = new Map();

function getSapoConfig() {
  const origin = process.env.SAPO_ORIGIN || "https://market-place.sapoapps.vn";
  let parsed;
  try { parsed = new URL(origin); } catch { throw new Error("SAPO_ORIGIN không hợp lệ."); }
  if (parsed.protocol !== "https:") throw new Error("SAPO_ORIGIN phải dùng HTTPS.");
  const headers = { Accept: "application/json" };
  if (process.env.SAPO_AUTHORIZATION) headers.Authorization = process.env.SAPO_AUTHORIZATION;
  if (process.env.SAPO_MARKET_ACCOUNT_ID) headers["X-Market-Account-Id"] = process.env.SAPO_MARKET_ACCOUNT_ID;
  if (process.env.SAPO_MARKET_TOKEN) headers["X-Market-Token"] = process.env.SAPO_MARKET_TOKEN;
  if (!headers.Authorization && !headers["X-Market-Token"]) {
    throw new Error("Máy chủ chưa cấu hình thông tin xác thực Sapo.");
  }
  return { origin: parsed.origin, headers };
}
function orderCodeCandidates(o) {
  return [
    o.channel_order_number, o.sapo_order_code, o.order_code, o.code,
    o.order_number, o.orderNumber, o.name, o.tracking_code
  ].filter(v => v !== undefined && v !== null && String(v).trim() !== "").map(String);
}
function getOrderDate(o) {
  const raw = o.created_at || o.createdAt || o.order_created_at || o.updated_at || o.updatedAt || "";
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
}
function getCarrier(o) {
  const candidates = [
    o.shipping_provider_name, o.shipping_provider, o.shipping_carrier,
    o.carrier_name, o.carrier, o.delivery_partner, o.shipping_company,
    o.transport_name, o.shipper_name, o.fulfillment_provider,
    o.shipping && (o.shipping.provider_name || o.shipping.carrier || o.shipping.name),
    o.shipping_info && (o.shipping_info.provider_name || o.shipping_info.carrier_name || o.shipping_info.name),
    o.shipping_method && (o.shipping_method.name || o.shipping_method.title),
    o.shipping_package && (o.shipping_package.shipping_provider_name || o.shipping_package.carrier_name)
  ];
  for (const v of candidates) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (v && typeof v === "object") {
      const name = v.name || v.title || v.code || v.provider_name;
      if (name) return String(name);
    }
  }
  const raw = JSON.stringify(o).toLowerCase();
  const known = [
    ["green sm", "Green SM"], ["greensm", "Green SM"],
    ["grab", "Grab"], ["be delivery", "be"], ["befood", "be"],
    ["spx", "SPX"], ["shopee express", "SPX"],
    ["ahamove", "Ahamove"], ["lalamove", "Lalamove"],
    ["giao hang nhanh", "GHN"], ["ghn", "GHN"],
    ["giao hang tiet kiem", "GHTK"], ["ghtk", "GHTK"],
    ["viettel post", "Viettel Post"], ["j&t", "J&T"], ["jt express", "J&T"]
  ];
  for (const [needle, label] of known) if (raw.includes(needle)) return label;
  return "Chưa xác định";
}
function getItems(o) {
  const arr = o.items || o.line_items || o.order_items || o.products || o.details ||
    (o.order && (o.order.items || o.order.line_items)) || [];
  if (!Array.isArray(arr)) return [];
  return arr.map(item => {
    const product = item.product || item.variant || {};
    const name = item.item_name || item.product_name || item.name ||
      item.title || item.variation_name || product.name || product.title ||
      product.item_name || "Sản phẩm chưa có tên";
    const variant = item.variation_name || item.variant_name || item.variant_title || "";
    const qty = Number(item.quantity ?? item.qty ?? item.amount ?? item.ordered_quantity ?? 0);
    return {
      name: String(name),
      variant: variant && String(variant) !== String(name) ? String(variant) : "",
      quantity: Number.isFinite(qty) ? qty : 0,
      sku: item.sku || product.sku || ""
    };
  });
}
function mapOrder(o) {
  const codes = orderCodeCandidates(o);
  const fullCode = String(o.channel_order_number || o.sapo_order_code || o.order_code || o.code || o.order_number || codes[0] || "Không rõ mã");
  return {
    id: String(o.id || o.order_id || fullCode),
    code: fullCode,
    trackingCode: String(o.tracking_code || o.tracking_number || ""),
    createdAt: o.created_at || o.createdAt || o.order_created_at || "",
    createdTs: getOrderDate(o),
    carrier: getCarrier(o),
    items: getItems(o),
    status: String(o.channel_order_status || o.status_name || o.status || "")
  };
}
async function fetchOrdersPage(config, page) {
  const url = new URL("/v2/orders", config.origin);
  // Match the query shape used by the working Sapo SKU aggregation extension.
  // connectionIds/channelType should be copied from its captured sapoSkuReportAuth
  // when available; the other three fields have safe defaults matching that extension.
  const params = {
    channelType: process.env.SAPO_CHANNEL_TYPE,
    connectionIds: process.env.SAPO_CONNECTION_IDS,
    sortBy: process.env.SAPO_SORT_BY || "ISSUED_AT",
    orderBy: process.env.SAPO_ORDER_BY || "desc",
    channelOrderStatus: process.env.SAPO_CHANNEL_ORDER_STATUS || "READY_TO_SHIP,RETRY_SHIP"
  };
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  url.searchParams.set("page", String(page));
  url.searchParams.set("limit", "100");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const resp = await fetch(url, { headers: config.headers, signal: controller.signal });
    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) throw new Error("Sapo từ chối xác thực (401/403). Hãy cập nhật thông tin xác thực ở máy chủ.");
      throw new Error(`Sapo API trả lỗi HTTP ${resp.status}.`);
    }
    const data = await resp.json();
    return { orders: Array.isArray(data.orders) ? data.orders : [], total: Number(data.metadata && data.metadata.total) || 0 };
  } finally {
    clearTimeout(timeout);
  }
}
app.get("/api/search", async (req, res) => {
  const query = String(req.query.q || req.query.last4 || "").normalize("NFC").trim().toLocaleLowerCase("vi-VN");
  if (query.length < 2) return res.status(400).json({ error: "Nhập ít nhất 2 ký tự của mã đơn hoặc mã vận đơn." });
  if (query.length > 100) return res.status(400).json({ error: "Từ khóa quá dài." });
  const cacheKey = query;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return res.json({ ...cached.data, cached: true });
  try {
    const config = getSapoConfig();
    const first = await fetchOrdersPage(config, 1);
    let all = [...first.orders];
    const totalPages = Math.min(MAX_PAGES, Math.ceil(Math.max(first.total, all.length) / 100));
    for (let page = 2; page <= totalPages; page++) {
      const result = await fetchOrdersPage(config, page);
      if (!result.orders.length) break;
      all.push(...result.orders);
      if (all.length >= first.total && first.total > 0) break;
    }
    const matches = all.map(mapOrder).filter(o => {
      const candidates = [o.code, o.trackingCode].filter(Boolean);
      return candidates.some(code => String(code).normalize("NFC").toLocaleLowerCase("vi-VN").includes(query));
    }).sort((a, b) => b.createdTs - a.createdTs);
    const data = {
      query,
      count: matches.length,
      orders: matches,
      scanned: all.length,
      partial: totalPages >= MAX_PAGES && all.length < first.total,
      checkedAt: new Date().toISOString()
    };
    cache.set(cacheKey, { expires: Date.now() + CACHE_MS, data });
    res.json(data);
  } catch (error) {
    const message = error && error.message ? error.message : "Không thể kết nối Sapo.";
    res.status(502).json({ error: message });
  }
});

app.use(express.static(path.join(__dirname, "public"), { etag: true, maxAge: "1h" }));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`Sapo mobile lookup đang chạy tại cổng ${PORT}`);
});
