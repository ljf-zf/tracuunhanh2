'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PRINT_SCRIPT = path.join(ROOT, 'print.ps1');
const VERSION = '1.0.0';
let socket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let busy = false;
let stopping = false;

function log(message) {
  const stamp = new Date().toLocaleString('vi-VN');
  process.stdout.write(`[${stamp}] ${message}\n`);
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error('Chưa có config.json. Hãy sao chép config.example.json thành config.json và điền workerUrl, agentToken.');
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const workerUrl = String(config.workerUrl || '').trim().replace(/\/$/, '');
  const agentToken = String(config.agentToken || '').trim();
  if (!/^https:\/\//i.test(workerUrl)) throw new Error('workerUrl phải là địa chỉ HTTPS của Cloudflare Worker.');
  if (agentToken.length < 24) throw new Error('agentToken chưa hợp lệ hoặc quá ngắn.');
  if (!fs.existsSync(PRINT_SCRIPT)) throw new Error('Không tìm thấy print.ps1.');
  return {
    ...config,
    workerUrl,
    agentToken,
    printerName: String(config.printerName || '').trim(),
    heartbeatSeconds: Math.max(10, Math.min(60, Number(config.heartbeatSeconds) || 25))
  };
}

const config = loadConfig();
const wsUrl = new URL('/api/print-agent/connect', config.workerUrl);
wsUrl.protocol = 'wss:';

function send(data) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
    return true;
  }
  return false;
}

function runPrint(order) {
  return new Promise((resolve, reject) => {
    const tempFile = path.join(os.tmpdir(), `sapo-print-${Date.now()}-${process.pid}.json`);
    const payload = {
      order,
      settings: {
        printerName: config.printerName,
        shopName: String(config.shopName || '').trim(),
        // Leave paper dimensions under the installed Windows driver until the exact stock is configured.
        useDriverPaperSize: true
      }
    };
    fs.writeFileSync(tempFile, JSON.stringify(payload), { encoding: 'utf8', flag: 'wx' });

    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', PRINT_SCRIPT,
      '-PayloadPath', tempFile
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      try { fs.unlinkSync(tempFile); } catch (_) {}
      reject(new Error(`Không chạy được Windows PowerShell: ${error.message}`));
    });
    child.on('close', code => {
      try { fs.unlinkSync(tempFile); } catch (_) {}
      if (code !== 0) {
        reject(new Error((stderr || stdout || `PowerShell kết thúc với mã ${code}.`).trim().slice(0, 1200)));
        return;
      }
      try {
        const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || '{}';
        const result = JSON.parse(line);
        if (!result.ok) reject(new Error(result.error || 'Windows không gửi được lệnh in.'));
        else resolve(result);
      } catch (error) {
        reject(new Error(`Phản hồi từ chương trình in không hợp lệ: ${error.message}; ${stdout.slice(0, 500)}`));
      }
    });
  });
}

async function handlePrint(message) {
  const requestId = String(message.requestId || '');
  if (!requestId) return;
  if (busy) {
    send({ type: 'print-result', requestId, ok: false, error: 'Print Agent đang xử lý một lệnh in khác.' });
    return;
  }
  busy = true;
  const code = String(message.order?.code || 'đơn hàng');
  log(`Nhận yêu cầu in ${code}.`);
  try {
    const result = await runPrint(message.order || {});
    log(`Đã gửi ${code} đến Windows Print Spooler (${result.printerName || 'máy in mặc định'}).`);
    send({ type: 'print-result', requestId, ok: true, message: 'Windows đã tiếp nhận lệnh in.', printerName: result.printerName || '' });
  } catch (error) {
    log(`Lỗi in ${code}: ${error.message}`);
    send({ type: 'print-result', requestId, ok: false, error: error.message });
  } finally {
    busy = false;
  }
}

function scheduleReconnect() {
  if (stopping || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 4000);
}

function connect() {
  if (stopping) return;
  log(`Đang kết nối ${wsUrl.origin}…`);
  const next = new WebSocket(wsUrl, {
    headers: { Authorization: `Bearer ${config.agentToken}` },
    handshakeTimeout: 15000,
    perMessageDeflate: false
  });
  socket = next;

  next.on('open', () => {
    log('Đã kết nối Cloudflare Print Broker. Sẵn sàng nhận lệnh in.');
    send({ type: 'hello', agentVersion: VERSION });
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => send({ type: 'ping', agentVersion: VERSION }), config.heartbeatSeconds * 1000);
  });
  next.on('message', raw => {
    let message;
    try { message = JSON.parse(raw.toString('utf8')); } catch (_) { return; }
    if (message.type === 'connected') log(message.message || 'Kết nối đã sẵn sàng.');
    if (message.type === 'print') handlePrint(message);
  });
  next.on('close', (code, reason) => {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (socket === next) socket = null;
    log(`Mất kết nối (${code}${reason?.length ? `: ${reason.toString()}` : ''}). Sẽ thử kết nối lại.`);
    scheduleReconnect();
  });
  next.on('error', error => log(`Lỗi kết nối: ${error.message}`));
}

function shutdown() {
  stopping = true;
  clearTimeout(reconnectTimer);
  clearInterval(heartbeatTimer);
  if (socket) socket.close(1000, 'Agent stopping');
  log('Print Agent đã dừng.');
}

process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });

log(`Sapo Direct Print Agent v${VERSION}`);
log(`Máy tính: ${os.hostname()} · Hệ điều hành: ${os.platform()}`);
log(config.printerName ? `Máy in chỉ định: ${config.printerName}` : 'Sử dụng máy in mặc định của Windows.');
connect();
