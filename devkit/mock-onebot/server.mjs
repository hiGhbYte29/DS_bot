#!/usr/bin/env node
// 虚拟 OneBot v11 网关：在本机顶替 SnowLuma，让桥接不接真实 QQ 也能跑通收发链路。
//
//   HTTP（默认 3010）：OneBot 动作 POST/GET /<action>，以及控制接口 /__mock/*
//   WS  （默认 3011）：推事件（心跳 / 消息 / 拍一拍），也接受带 echo 的动作调用
//
// 只监听本机，不做鉴权。与 qq-bridge 之间只通过 OneBot 协议通信，不引用它的任何代码。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptUpgrade } from './lib/ws.mjs';
import { createGateway, ActionError } from './lib/gateway.mjs';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const MAX_BODY = 1024 * 1024;
const MAX_UPLOAD_BODY = 12 * 1024 * 1024; // 聊天界面发图（base64）
const UI_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui', 'index.html');
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };

/** Host 必须是本机名：防 DNS 重绑定（别的网站把自己的域名解析到 127.0.0.1 来调这里）。 */
function isLoopbackHost(hostHeader) {
  if (!hostHeader) return true;
  try {
    return LOOPBACK.has(new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, ''));
  } catch {
    return false;
  }
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new ActionError(1400, '请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readParams(req, url, limit = MAX_BODY) {
  const params = Object.fromEntries(url.searchParams);
  if (req.method !== 'POST') return params;
  const text = await readBody(req, limit);
  if (!text.trim()) return params;
  const type = String(req.headers['content-type'] ?? '');
  if (type.includes('application/x-www-form-urlencoded')) return { ...params, ...Object.fromEntries(new URLSearchParams(text)) };
  try {
    const body = JSON.parse(text);
    return body && typeof body === 'object' && !Array.isArray(body) ? { ...params, ...body } : params;
  } catch {
    throw new ActionError(1400, '请求体不是合法 JSON');
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/**
 * 启动虚拟网关。返回 { gateway, httpPort, wsPort, close() }。
 * 端口传 0 表示随机可用端口（测试用）。
 */
export async function startMockOneBot({
  host = '127.0.0.1', httpPort = 3010, wsPort = 3011, selfId = 10001, nickname = '测试机器人',
  heartbeatMs = 30000, groups = [{ id: 999001, name: '测试群' }], log = () => {}
} = {}) {
  if (!LOOPBACK.has(host)) throw new Error(`只允许监听本机地址（127.0.0.1 / localhost / ::1），收到 ${host}`);
  const gateway = createGateway({ selfId, nickname });
  // 预置的群里只有机器人自己；其他成员在第一次发言（send）时自动加入
  for (const g of groups) gateway.ensureGroup(g.id, g.name);

  const clients = new Set();
  const broadcast = (event) => {
    const text = JSON.stringify(event);
    for (const c of clients) c.send(text);
  };
  gateway.onEvent(broadcast);

  // 聊天界面的实时推送（Server-Sent Events）
  const streams = new Set();
  const pushStream = (type, data) => {
    const chunk = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of streams) res.write(chunk);
  };
  const statusSnapshot = () => ({ wsClients: clients.size, selfId, nickname, ...gateway.status() });
  gateway.onTimeline((entry) => pushStream(entry.type, entry));
  const keepAlive = setInterval(() => { for (const res of streams) res.write(': keep-alive\n\n'); }, 15000);
  keepAlive.unref?.();
  const waiters = new Set(); // /__mock/wait-out 的长轮询

  // 机器人发出的每条消息都打一行，并唤醒长轮询
  let lastOutSeq = 0;
  const flushOut = () => {
    const fresh = gateway.out(lastOutSeq);
    if (!fresh.length) return;
    lastOutSeq = fresh[fresh.length - 1].seq;
    for (const e of fresh) log(`← 机器人 ${e.action} ${e.target}: ${e.text}`);
    for (const w of waiters) w();
  };

  const runAction = (action, params, via) => {
    const r = gateway.call(action, params, via);
    const last = gateway.calls().at(-1);
    if (last?.unhandled) log(`⚠️ 未实现的动作 ${action}（${via}），已按空结果返回`);
    else if (r.status !== 'ok') log(`动作 ${action} 失败（${via}）：${r.wording}`);
    flushOut();
    return r;
  };

  async function handleControl(req, res, url) {
    const route = url.pathname.slice('/__mock/'.length);
    const since = Number(url.searchParams.get('since')) || 0;
    if (req.method === 'GET' && route === 'health') {
      sendJson(res, 200, { ok: true, selfId, nickname, wsClients: clients.size, ...gateway.status() });
      return;
    }
    if (req.method === 'GET' && route === 'out') { sendJson(res, 200, gateway.out(since)); return; }
    if (req.method === 'GET' && route === 'conversations') { sendJson(res, 200, gateway.conversations()); return; }
    if (req.method === 'GET' && route === 'messages') {
      sendJson(res, 200, gateway.messagesOf(url.searchParams.get('key'), url.searchParams.get('limit')));
      return;
    }
    if (req.method === 'GET' && route.startsWith('image/')) {
      const img = gateway.image(decodeURIComponent(route.slice('image/'.length)));
      if (!img) { sendJson(res, 404, { ok: false, error: '图片不存在' }); return; }
      const buf = Buffer.from(img.base64, 'base64');
      res.writeHead(200, { 'content-type': IMAGE_MIME[img.ext] ?? 'application/octet-stream', 'content-length': buf.length, 'cache-control': 'max-age=3600' });
      res.end(buf);
      return;
    }
    if (req.method === 'GET' && route === 'stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`event: status\ndata: ${JSON.stringify(statusSnapshot())}\n\n`);
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }
    if (req.method === 'GET' && route === 'ui') { serveUi(res); return; }
    if (req.method === 'GET' && route === 'calls') { sendJson(res, 200, gateway.calls(since)); return; }
    if (req.method === 'GET' && route === 'wait-out') {
      // 长轮询：有新的发出消息就立刻返回，否则等到超时返回空数组
      const timeoutMs = Math.min(600000, Math.max(0, Number(url.searchParams.get('timeout')) || 30000));
      const ready = gateway.out(since);
      if (ready.length) { sendJson(res, 200, ready); return; }
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); waiters.delete(done); resolve(); };
        const timer = setTimeout(done, timeoutMs);
        waiters.add(done);
        req.on('close', done);
      });
      if (!res.writableEnded) sendJson(res, 200, gateway.out(since));
      return;
    }
    if (req.method !== 'POST') { sendJson(res, 404, { ok: false, error: `未知的控制接口 ${url.pathname}` }); return; }
    // 控制接口只收同源的 JSON：浏览器里别的网页发不了带 JSON 类型的跨域请求（会先预检，这里不放行）
    const origin = req.headers.origin;
    if (origin && !isLoopbackHost(origin.replace(/^https?:\/\//, ''))) { sendJson(res, 403, { ok: false, error: '拒绝跨站请求' }); return; }
    if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
      sendJson(res, 415, { ok: false, error: '控制接口只接受 application/json' });
      return;
    }
    const body = await readParams(req, url, route === 'send' ? MAX_UPLOAD_BODY : MAX_BODY);
    if (route === 'conversations') {
      const c = gateway.createConversation(body);
      log(`新建会话 ${c.key}（${c.name}）`);
      pushStream('conversation', c);
      sendJson(res, 200, { ok: true, conversation: c });
      return;
    }
    if (route === 'send') {
      const r = gateway.injectMessage({ ...body, imageBaseDir: body.imageBaseDir });
      log(`→ 注入 ${body.key} 来自 ${r.event.user_id}: ${r.event.raw_message}`);
      sendJson(res, 200, { ok: true, message_id: r.message_id, delivered: clients.size });
      return;
    }
    if (route === 'poke') {
      const r = gateway.injectPoke(body);
      log(`→ 注入拍一拍 ${body.key} ${r.event.user_id} → ${r.event.target_id}`);
      sendJson(res, 200, { ok: true, delivered: clients.size });
      return;
    }
    if (route === 'status') {
      const s = gateway.setStatus({
        online: body.online === undefined ? undefined : body.online === true || body.online === 'true',
        good: body.good === undefined ? undefined : body.good === true || body.good === 'true'
      });
      broadcast(gateway.heartbeat(heartbeatMs)); // 立刻推一次心跳，桥接不用等 30 秒
      log(`状态已改为 online=${s.online} good=${s.good}`);
      pushStream('status', statusSnapshot());
      sendJson(res, 200, { ok: true, ...s });
      return;
    }
    if (route === 'drop') {
      const n = clients.size;
      for (const c of [...clients]) (body.mode === 'close' ? c.close(1001, 'mock drop') : c.terminate());
      log(`已断开 ${n} 个 WS 连接（${body.mode === 'close' ? '正常关闭' : '模拟崩溃'}）`);
      sendJson(res, 200, { ok: true, dropped: n });
      return;
    }
    sendJson(res, 404, { ok: false, error: `未知的控制接口 ${url.pathname}` });
  }

  function serveUi(res) {
    fs.readFile(UI_FILE, (error, html) => {
      if (error) { sendJson(res, 500, { ok: false, error: '找不到 ui/index.html' }); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' });
      res.end(html);
    });
  }

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    if (!isLoopbackHost(req.headers.host)) { sendJson(res, 403, { ok: false, error: 'Host 必须是本机地址' }); return; }
    // 浏览器直接打开 HTTP 端口时给聊天界面；OneBot 客户端不会 GET /
    if (req.method === 'GET' && url.pathname === '/' && String(req.headers.accept ?? '').includes('text/html')) { serveUi(res); return; }
    try {
      if (url.pathname.startsWith('/__mock/')) { await handleControl(req, res, url); return; }
      const action = url.pathname.replace(/^\/+|\/+$/g, '');
      if (!action) { sendJson(res, 200, { ok: true, hint: 'OneBot 动作：POST /<action>；控制接口见 /__mock/health' }); return; }
      const params = await readParams(req, url);
      sendJson(res, 200, runAction(action, params, 'http'));
    } catch (error) {
      const status = error instanceof ActionError ? 400 : 500;
      if (url.pathname.startsWith('/__mock/')) sendJson(res, status, { ok: false, error: error.message });
      else sendJson(res, 200, { status: 'failed', retcode: error.retcode ?? 1500, data: null, message: error.message, wording: error.message });
    }
  });
  // HTTP 端口收到 WS 握手：和 SnowLuma 一样回 426，桥接会据此提示"httpUrl 填成了 WS 端口"之类的配置错误
  httpServer.on('upgrade', (req, socket) => socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));

  const wsServer = http.createServer((req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('这是 WebSocket 端口；HTTP 动作请发到 HTTP 端口');
  });
  wsServer.on('upgrade', (req, socket, head) => {
    const conn = acceptUpgrade(req, socket, head);
    if (!conn) return;
    clients.add(conn);
    log(`WS 客户端已连接（共 ${clients.size} 个）`);
    pushStream('status', statusSnapshot());
    conn.send(JSON.stringify(gateway.lifecycle()));
    conn.on('message', (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (!msg || typeof msg.action !== 'string') return;
      const r = runAction(msg.action, msg.params ?? {}, 'ws');
      conn.send(JSON.stringify(msg.echo === undefined ? r : { ...r, echo: msg.echo }));
    });
    conn.on('close', ({ code }) => {
      clients.delete(conn);
      log(`WS 客户端已断开（code=${code}，剩 ${clients.size} 个）`);
      pushStream('status', statusSnapshot());
    });
  });

  const listen = (server, port) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(server.address().port); });
  });
  const boundHttp = await listen(httpServer, httpPort);
  let boundWs;
  try {
    boundWs = await listen(wsServer, wsPort);
  } catch (error) {
    httpServer.close();
    throw error;
  }
  const timer = heartbeatMs > 0 ? setInterval(() => broadcast(gateway.heartbeat(heartbeatMs)), heartbeatMs) : null;
  timer?.unref?.();

  return {
    gateway, httpPort: boundHttp, wsPort: boundWs, clients,
    async close() {
      if (timer) clearInterval(timer);
      clearInterval(keepAlive);
      for (const r of streams) r.end();
      for (const w of waiters) w();
      for (const c of [...clients]) c.terminate();
      await Promise.all([httpServer, wsServer].map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); })));
    }
  };
}

// ── 命令行 ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { groups: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 需要一个值`);
      return v;
    };
    if (a === '--host') opts.host = next();
    else if (a === '--http-port') opts.httpPort = Number(next());
    else if (a === '--ws-port') opts.wsPort = Number(next());
    else if (a === '--self-id') opts.selfId = Number(next());
    else if (a === '--nickname') opts.nickname = next();
    else if (a === '--heartbeat-ms') opts.heartbeatMs = Number(next());
    else if (a === '--group') {
      const [id, ...name] = next().split(':');
      opts.groups.push({ id: Number(id), name: name.join(':') || undefined });
    } else if (a === '-h' || a === '--help') opts.help = true;
    else throw new Error(`未知参数 ${a}`);
  }
  if (!opts.groups.length) delete opts.groups;
  return opts;
}

const HELP = `用法: node server.mjs [选项]
  --host <地址>          监听地址，只允许本机（默认 127.0.0.1）
  --http-port <端口>     OneBot HTTP 端口（默认 3010）
  --ws-port <端口>       OneBot WS 端口（默认 3011）
  --self-id <QQ号>       机器人自己的 QQ 号（默认 10001）
  --nickname <昵称>      机器人昵称（默认 测试机器人）
  --group <群号:群名>    预置一个群，可重复（默认 999001:测试群）
  --heartbeat-ms <毫秒>  心跳间隔，0 关闭（默认 30000）`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message + '\n\n' + HELP);
    process.exit(2);
  }
  if (opts.help) { console.log(HELP); process.exit(0); }
  const stamp = () => new Date().toTimeString().slice(0, 8);
  const log = (msg) => console.log(`${stamp()} [mock] ${msg}`);
  try {
    const m = await startMockOneBot({ ...opts, log });
    log(`虚拟网关已启动：HTTP http://127.0.0.1:${m.httpPort}  WS ws://127.0.0.1:${m.wsPort}  机器人 ${m.gateway.selfId}（${m.gateway.nickname}）`);
    const stop = async () => { log('正在退出…'); await m.close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (error) {
    console.error(`[mock] 启动失败：${error.message}`);
    process.exit(1);
  }
}
