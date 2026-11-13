'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
// Original Sapo labels are rasterized to 599 x 800 px at 203 DPI for 75 x 100 mm stock.

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PRINT_SCRIPT = path.join(ROOT, 'print.ps1');
const VERSION = '2.2.0';
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
    pdfViewerPath: String(config.pdfViewerPath || '').trim(),
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


function findSumatra() {
  const candidates = [
    config.pdfViewerPath,
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'SumatraPDF', 'SumatraPDF.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'SumatraPDF', 'SumatraPDF.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'SumatraPDF', 'SumatraPDF.exe')
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || '';
}

async function runOriginalPdf(message) {
  const raw = String(message.pdfBase64 || '');
  if (!raw || raw.length > 16 * 1024 * 1024) throw new Error('Dữ liệu PDF trống hoặc vượt giới hạn 12 MB.');
  const pdf = Buffer.from(raw, 'base64');
  if (pdf.length < 8 || pdf.length > 12 * 1024 * 1024 || pdf.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('File nhận được không phải PDF hợp lệ.');
  }

  // Render the original Sapo PDF into a white 599 x 800 px label canvas at 203 DPI.
  // The image is printed through Windows GDI; SumatraPDF is intentionally bypassed.
  const { createCanvas, DOMMatrix, ImageData, Path2D } = require('@napi-rs/canvas');
  globalThis.DOMMatrix ||= DOMMatrix;
  globalThis.ImageData ||= ImageData;
  globalThis.Path2D ||= Path2D;
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdf),
    useSystemFonts: true,
    isEvalSupported: false,
    stopAtErrors: true,
    verbosity: 0
  });
  const pdfDoc = await loadingTask.promise;
  if (!pdfDoc.numPages || pdfDoc.numPages > 30) {
    await loadingTask.destroy();
    throw new Error('PDF không có trang hoặc có quá 30 trang; đã dừng để tránh in nhầm.');
  }

  const safeName = String(message.fileName || `sapo-${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sapo-raster-'));
  const imagePaths = [];
  try {
    for (let pageNo = 1; pageNo <= pdfDoc.numPages; pageNo++) {
      const page = await pdfDoc.getPage(pageNo);
      // Render at 2x working resolution, then crop the actual printed label content.
      // Sapo PDFs can place a small label in one corner of a much larger page canvas.
      const baseViewport = page.getViewport({ scale: 2 });
      const sourceCanvas = createCanvas(Math.ceil(baseViewport.width), Math.ceil(baseViewport.height));
      const sourceCtx = sourceCanvas.getContext('2d');
      sourceCtx.fillStyle = '#ffffff';
      sourceCtx.fillRect(0, 0, sourceCanvas.width, sourceCanvas.height);
      await page.render({
        canvasContext: sourceCtx,
        viewport: baseViewport,
        background: 'rgb(255,255,255)'
      }).promise;

      const pixels = sourceCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height).data;
      let minX = sourceCanvas.width, minY = sourceCanvas.height, maxX = -1, maxY = -1;
      // Ignore near-white antialiasing noise; include black text, borders, barcodes and QR modules.
      for (let y = 0; y < sourceCanvas.height; y++) {
        for (let x = 0; x < sourceCanvas.width; x++) {
          const i = (y * sourceCanvas.width + x) * 4;
          const luminance = (pixels[i] * 299 + pixels[i + 1] * 587 + pixels[i + 2] * 114) / 1000;
          if (luminance < 247) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < minX || maxY < minY) throw new Error(`Trang ${pageNo} không tìm thấy nội dung vận đơn để cắt.`);

      const contentW = maxX - minX + 1;
      const contentH = maxY - minY + 1;
      const padX = Math.max(8, Math.round(contentW * 0.025));
      const padY = Math.max(8, Math.round(contentH * 0.025));
      minX = Math.max(0, minX - padX);
      minY = Math.max(0, minY - padY);
      maxX = Math.min(sourceCanvas.width - 1, maxX + padX);
      maxY = Math.min(sourceCanvas.height - 1, maxY + padY);

      const cropW = maxX - minX + 1;
      const cropH = maxY - minY + 1;
      const output = createCanvas(599, 800);
      const outCtx = output.getContext('2d');
      outCtx.fillStyle = '#ffffff';
      outCtx.fillRect(0, 0, 599, 800);
      const fit = Math.min(599 / cropW, 800 / cropH);
      const drawW = cropW * fit;
      const drawH = cropH * fit;
      const dx = (599 - drawW) / 2;
      const dy = (800 - drawH) / 2;
      outCtx.drawImage(sourceCanvas, minX, minY, cropW, cropH, dx, dy, drawW, drawH);

      log(`PDF trang ${pageNo}: crop nội dung ${cropW}x${cropH} px, xuất nhãn 599x800 px.`);
      const imagePath = path.join(tempDir, `${safeName}-${String(pageNo).padStart(3, '0')}.png`);
      fs.writeFileSync(imagePath, await output.encode('png'));
      imagePaths.push(imagePath);
      page.cleanup();
    }
  } catch (error) {
    await loadingTask.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw new Error(`Không chuyển được PDF sang ảnh: ${error.message}`);
  }
  await loadingTask.destroy();

  const payloadPath = path.join(tempDir, 'print-payload.json');
  fs.writeFileSync(payloadPath, JSON.stringify({
    printerName: config.printerName,
    imagePaths
  }), 'utf8');

  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(ROOT, 'print-raster.ps1'),
        '-PayloadPath', payloadPath
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.on('error', error => reject(new Error(`Không chạy được Windows GDI: ${error.message}`)));
      child.on('close', code => {
        if (code !== 0) return reject(new Error((stderr || stdout || `PowerShell kết thúc mã ${code}`).trim().slice(0, 1200)));
        try {
          const line = stdout.trim().split(/\\r?\\n/).filter(Boolean).at(-1) || '{}';
          const response = JSON.parse(line);
          if (!response.ok) reject(new Error(response.error || 'Windows không tiếp nhận lệnh in ảnh.'));
          else resolve(response);
        } catch (error) {
          reject(new Error(`Phản hồi Windows GDI không hợp lệ: ${error.message}; ${stdout.slice(0, 500)}`));
        }
      });
    });
    return {
      ok: true,
      message: 'In vận đơn gốc thành công.',
      printerName: result.printerName || config.printerName || 'Máy in mặc định Windows'
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function handleOriginalPrint(message) {
  const requestId = String(message.requestId || '');
  if (!requestId) return;
  if (busy) {
    send({ type: 'print-original-result', requestId, ok: false, error: 'Print Agent đang xử lý một lệnh in khác.' });
    return;
  }
  busy = true;
  const code = String(message.orderCode || 'đơn hàng');
  log(`Nhận PDF vận đơn gốc Sapo ${code}.`);
  try {
    const result = await runOriginalPdf(message);
    log(`Đã gửi PDF gốc ${code} đến máy in ${result.printerName}.`);
    send({ type: 'print-original-result', requestId, ok: true, message: result.message, printerName: result.printerName });
  } catch (error) {
    log(`Lỗi in PDF gốc ${code}: ${error.message}`);
    send({ type: 'print-original-result', requestId, ok: false, error: error.message });
  } finally { busy = false; }
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
    if (message.type === 'print-original') handleOriginalPrint(message);
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

log(`Sapo Direct Print Agent v${VERSION} · PDF gốc Sapo`);
log(`Máy tính: ${os.hostname()} · Hệ điều hành: ${os.platform()}`);
log(config.printerName ? `Máy in chỉ định: ${config.printerName}` : 'Sử dụng máy in mặc định của Windows.');
connect();
