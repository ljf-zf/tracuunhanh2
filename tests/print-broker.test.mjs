import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { PrintBroker } from '../worker.js';

function request(path, init = {}) {
  return new Request(`https://unit.test${path}`, init);
}

test('Print Broker báo offline ngay, không giữ lệnh', async () => {
  const broker = new PrintBroker({ getWebSockets: () => [] }, {});
  const response = await broker.fetch(request('/dispatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ order: { code: 'TEST-1', items: [] } })
  }));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /chưa kết nối/i);
});

test('Print Broker chuyển lệnh trực tiếp và nhận phản hồi Agent', async () => {
  let broker;
  const socket = {
    send(raw) {
      const message = JSON.parse(raw);
      if (message.type === 'print') {
        setTimeout(() => broker.webSocketMessage(socket, JSON.stringify({
          type: 'print-result', requestId: message.requestId, ok: true,
          message: 'Windows đã nhận lệnh', printerName: 'Xprinter'
        })), 5);
      }
    },
    deserializeAttachment: () => ({ lastSeen: Date.now() }),
    serializeAttachment: () => {}
  };
  broker = new PrintBroker({ getWebSockets: () => [socket] }, {});
  const response = await broker.fetch(request('/dispatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ order: { code: 'TEST-2', items: [] } })
  }));
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.printerName, 'Xprinter');
});

test('API in không còn chặn bằng PIN', async () => {
  const response = await worker.fetch(request('/api/print', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ order: { code: 'TEST-3', items: [] } })
  }), {});
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /Print Broker/i);
});


test('Sapo Print Bridge từ chối event khi thiếu bridge token', async () => {
  const response = await worker.fetch(request('/api/sapo/print-event', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: { type: 'PRINT_ORDER', status: 'SUCCESS', order_bills: [] } })
  }), {});
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /SAPO_BRIDGE_TOKEN/i);
});

test('Sapo Print Bridge từ chối bridge token sai', async () => {
  const response = await worker.fetch(request('/api/sapo/print-event', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Sapo-Bridge-Key': 'wrong' },
    body: JSON.stringify({ event: { type: 'PRINT_ORDER', status: 'SUCCESS', order_bills: [] } })
  }), { SAPO_BRIDGE_TOKEN: 'a'.repeat(40) });
  assert.equal(response.status, 401);
});

test('API chuẩn bị PDF gốc hoạt động và yêu cầu Print Broker', async () => {
  const response = await worker.fetch(request('/api/print-original/prepare', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ order: { id: '1061994503', code: '261112581WM3V8' } })
  }), {});
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /Print Broker/i);
});

test('API in vận đơn gốc không còn chặn bằng PIN', async () => {
  const response = await worker.fetch(request('/api/print-original', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ order: { id: '1061994503', code: '261112581WM3V8' } })
  }), {});
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /Print Broker/i);
});


test('Sapo Print Bridge chỉ nhận URL PDF đúng host và thư mục Sapo', async () => {
  let forwarded = null;
  const fakeNamespace = {
    idFromName: () => 'printer',
    get: () => ({ fetch: async (_url, init) => {
      forwarded = JSON.parse(init.body);
      return new Response(JSON.stringify({ ok: true, saved: forwarded.records.length }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }})
  };
  const good = {
    type: 'PRINT_ORDER', status: 'SUCCESS',
    order_bills: [
      { order_id: 123, sapo_order_code: 'S-123', success: true,
        data_to_print: 'https://social.dktcdn.net/shopee/61837/prints_orders/test.pdf' },
      { order_id: 124, sapo_order_code: 'S-124', success: true,
        data_to_print: 'https://evil.example/shopee/61837/prints_orders/fake.pdf' }
    ]
  };
  const response = await worker.fetch(request('/api/sapo/print-event', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Sapo-Bridge-Key': 'b'.repeat(40) },
    body: JSON.stringify({ event: good })
  }), { SAPO_BRIDGE_TOKEN: 'b'.repeat(40), PRINT_BROKER: fakeNamespace });
  assert.equal(response.status, 200);
  assert.equal(forwarded.records.length, 1);
  assert.equal(forwarded.records[0].orderId, '123');
});

test('API in vận đơn gốc chuyển đúng orderId/orderCode tới Print Broker', async () => {
  let forwarded = null;
  const fakeNamespace = {
    idFromName: () => 'printer',
    get: () => ({ fetch: async (_url, init) => {
      forwarded = JSON.parse(init.body);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }})
  };
  const response = await worker.fetch(request('/api/print-original', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Print-Pin': 'correct-pin' },
    body: JSON.stringify({ order: { id: '1061994503', code: '261112581WM3V8' } })
  }), { PRINT_WEB_PIN: 'correct-pin', PRINT_BROKER: fakeNamespace });
  assert.equal(response.status, 200);
  assert.deepEqual(forwarded, { orderId: '1061994503', orderCode: '261112581WM3V8' });
});


test('Print Broker yêu cầu Bridge kích hoạt Sapo rồi chuyển PDF gốc tới Agent', async () => {
  const store = new Map();
  let broker;
  const makeSocket = role => ({
    attachment: { role, lastSeen: Date.now() },
    send(raw) {
      const message = JSON.parse(raw);
      if (role === 'bridge' && message.type === 'trigger-sapo-print') {
        setTimeout(() => broker.fetch(request('/event', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ records: [{
            orderId: message.orderId, orderCode: message.orderCode,
            pdfUrl: 'https://social.dktcdn.net/shopee/61837/prints_orders/test.pdf'
          }] })
        })), 0);
      }
      if (role === 'agent' && message.type === 'print-original') {
        setTimeout(() => broker.webSocketMessage(agent, JSON.stringify({
          type: 'print-original-result', requestId: message.requestId, ok: true,
          message: 'PDF gốc đã gửi tới máy in', printerName: 'Xprinter'
        })), 0);
      }
    },
    deserializeAttachment() { return this.attachment; },
    serializeAttachment(value) { this.attachment = value; },
    close() {}
  });
  const agent = makeSocket('agent');
  const bridge = makeSocket('bridge');
  broker = new PrintBroker({
    getWebSockets: () => [agent, bridge],
    storage: {
      async put(k,v) { store.set(k,v); },
      async get(k) { return store.get(k); },
      async delete(k) { store.delete(k); }
    }
  }, {});
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(Buffer.from('%PDF-1.7 test-pdf'), {
    status: 200, headers: { 'content-type': 'application/pdf' }
  });
  try {
    const response = await broker.fetch(request('/request-original', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orderId: '1061994503', orderCode: '261112581WM3V8' })
    }));
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.ok, true);
    assert.equal(result.printerName, 'Xprinter');
  } finally { globalThis.fetch = originalFetch; }
});
