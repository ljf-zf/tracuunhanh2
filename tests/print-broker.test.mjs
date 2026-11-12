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

test('API in từ chối mã PIN sai', async () => {
  const response = await worker.fetch(request('/api/print', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Print-Pin': 'wrong' },
    body: JSON.stringify({ order: { code: 'TEST-3', items: [] } })
  }), { PRINT_WEB_PIN: 'correct-pin' });
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /PIN/i);
});
