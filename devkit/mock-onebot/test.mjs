// 虚拟网关自测：只用 Node 自带的 WebSocket 客户端和 fetch，不依赖 qq-bridge。
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { startMockOneBot } from './server.mjs';

async function withMock(fn, opts = {}) {
  const m = await startMockOneBot({ httpPort: 0, wsPort: 0, heartbeatMs: 0, ...opts });
  try {
    return await fn(m);
  } finally {
    await m.close();
  }
}

/** 连上 WS，收集所有收到的 JSON；提供 request(action, params) 按 echo 等回包。 */
async function connect(m) {
  const ws = new WebSocket(`ws://127.0.0.1:${m.wsPort}/?access_token=ignored`);
  const received = [];
  const waiters = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    received.push(msg);
    for (const w of [...waiters]) if (w.match(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const next = (match, timeoutMs = 3000) => {
    const hit = received.find(match);
    if (hit) { received.splice(received.indexOf(hit), 1); return Promise.resolve(hit); }
    return new Promise((resolve, reject) => {
      const w = { match, resolve: (msg) => { clearTimeout(t); received.splice(received.indexOf(msg), 1); resolve(msg); } };
      const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error('timed out')); }, timeoutMs);
      waiters.push(w);
    });
  };
  let n = 0;
  const request = (action, params = {}) => {
    const echo = `t${++n}`;
    ws.send(JSON.stringify({ action, params, echo }));
    return next((msg) => msg.echo === echo);
  };
  const closed = new Promise((resolve) => ws.addEventListener('close', (e) => resolve(e.code)));
  return { ws, next, request, closed, close: () => ws.close() };
}

const control = (m, route, body) => fetch(`http://127.0.0.1:${m.httpPort}/__mock/${route}`, {
  method: body ? 'POST' : 'GET',
  headers: body ? { 'content-type': 'application/json' } : {},
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: await r.json() }));

const action = (m, name, params) => fetch(`http://127.0.0.1:${m.httpPort}/${name}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params ?? {}),
}).then((r) => r.json());

test('WS handshake, lifecycle event, and echo-matched action responses', () => withMock(async (m) => {
  const c = await connect(m);
  const life = await c.next((msg) => msg.post_type === 'meta_event');
  assert.equal(life.meta_event_type, 'lifecycle');
  assert.equal(life.self_id, 10001);
  const r = await c.request('get_login_info');
  assert.deepEqual(r, { status: 'ok', retcode: 0, data: { user_id: 10001, nickname: '测试机器人' }, echo: 't1' });
  c.close();
}));

test('injected group message arrives as a OneBot event; bot reply shows up in out and get_msg', () => withMock(async (m) => {
  const c = await connect(m);
  const inj = await control(m, 'send', { key: 'group:999001', text: '你好', userId: 20001, nickname: '小明', atSelf: true });
  assert.equal(inj.status, 200);
  assert.equal(inj.body.delivered, 1);
  const ev = await c.next((msg) => msg.post_type === 'message');
  assert.equal(ev.message_type, 'group');
  assert.equal(ev.group_id, 999001);
  assert.equal(ev.user_id, 20001);
  assert.equal(ev.self_id, 10001);
  assert.equal(ev.message_id, inj.body.message_id);
  assert.deepEqual(ev.message.map((s) => s.type), ['at', 'text', 'text']);
  assert.equal(ev.message[0].data.qq, '10001');
  assert.equal(ev.sender.nickname, '小明');
  assert.match(ev.raw_message, /^\[CQ:at,qq=10001\] 你好$/);

  // 桥接两条发送路径：WS 上的 SDK 调用、HTTP 直发
  const viaWs = await c.request('send_group_msg', { group_id: 999001, message: { type: 'text', data: { text: '收到' } } });
  assert.equal(viaWs.status, 'ok');
  const viaHttp = await action(m, 'send_group_msg', {
    group_id: 999001, message: [{ type: 'reply', data: { id: String(ev.message_id) } }, { type: 'text', data: { text: '再说一遍' } }]
  });
  assert.equal(viaHttp.status, 'ok');
  const out = (await control(m, 'out')).body;
  assert.deepEqual(out.map((e) => [e.action, e.target, e.text]), [
    ['send_group_msg', 'group:999001', '收到'],
    ['send_group_msg', 'group:999001', `[回复 #${ev.message_id}]再说一遍`],
  ]);
  const got = await action(m, 'get_msg', { message_id: viaHttp.data.message_id });
  assert.equal(got.data.sender.user_id, 10001);
  const hist = await action(m, 'get_group_msg_history', { group_id: 999001 });
  assert.equal(hist.data.messages.length, 3);
  // 成员在发言后自动加入
  const members = await action(m, 'get_group_member_list', { group_id: 999001 });
  assert.deepEqual(members.data.map((x) => x.user_id).sort(), [10001, 20001]);
  c.close();
}));

test('private messages and pokes', () => withMock(async (m) => {
  const c = await connect(m);
  await control(m, 'send', { key: 'private:20002', text: '私聊' });
  const ev = await c.next((msg) => msg.post_type === 'message');
  assert.equal(ev.message_type, 'private');
  assert.equal(ev.sub_type, 'friend');
  assert.equal(ev.user_id, 20002);
  await control(m, 'poke', { key: 'group:999001', userId: 20003 });
  const poke = await c.next((msg) => msg.post_type === 'notice');
  assert.deepEqual([poke.notice_type, poke.sub_type, poke.group_id, poke.user_id, poke.target_id], ['notify', 'poke', 999001, 20003, 10001]);
  const back = await c.request('group_poke', { group_id: 999001, user_id: 20003 });
  assert.equal(back.status, 'ok');
  assert.equal((await control(m, 'out')).body.at(-1).action, 'group_poke');
  c.close();
}));

test('images can be injected and fetched back with get_image', () => withMock(async (m) => {
  const c = await connect(m);
  await control(m, 'send', { key: 'group:999001', text: '看图', image: 'sample' });
  const ev = await c.next((msg) => msg.post_type === 'message');
  const img = ev.message.find((s) => s.type === 'image');
  assert.match(img.data.file, /^[0-9A-F]{32}\.png$/);
  const r = await c.request('get_image', { file: img.data.file });
  assert.equal(r.status, 'ok');
  assert.ok(Buffer.from(r.data.base64, 'base64').subarray(1, 4).toString() === 'PNG');
  c.close();
}));

test('errors: unknown group, bad target, missing quote, bot as sender', () => withMock(async (m) => {
  const r = await action(m, 'send_group_msg', { group_id: 123456, message: 'x' });
  assert.equal(r.status, 'failed');
  assert.equal(r.retcode, 1400);
  assert.equal((await control(m, 'send', { key: 'room:1', text: 'x' })).status, 400);
  assert.equal((await control(m, 'send', { key: 'group:999001', text: 'x', replyTo: 999999 })).status, 400);
  assert.equal((await control(m, 'send', { key: 'group:999001', text: 'x', userId: 10001 })).status, 400);
  assert.equal((await control(m, 'send', { key: 'group:999001', text: '' })).status, 400);
  assert.equal((await control(m, 'out')).body.length, 0);
}));

test('unimplemented actions return ok + [] and are flagged in the call log', () => withMock(async (m) => {
  const r = await action(m, 'some_future_action', {});
  assert.deepEqual(r, { status: 'ok', retcode: 0, data: [] });
  const calls = (await control(m, 'calls')).body;
  assert.equal(calls.at(-1).action, 'some_future_action');
  assert.equal(calls.at(-1).unhandled, true);
}));

test('GET actions work (mcp-host-server probes get_login_info with GET)', () => withMock(async (m) => {
  const r = await fetch(`http://127.0.0.1:${m.httpPort}/get_login_info`).then((x) => x.json());
  assert.equal(r.data.user_id, 10001);
}));

test('status changes push a heartbeat immediately', () => withMock(async (m) => {
  const c = await connect(m);
  await control(m, 'status', { good: false });
  const hb = await c.next((msg) => msg.meta_event_type === 'heartbeat');
  assert.deepEqual(hb.status, { online: true, good: false });
  assert.equal((await action(m, 'get_status')).data.good, false);
  c.close();
}));

test('drop disconnects clients; a new connection works afterwards', () => withMock(async (m) => {
  const c = await connect(m);
  await c.next((msg) => msg.post_type === 'meta_event');
  assert.equal((await control(m, 'drop', {})).body.dropped, 1);
  assert.equal(await c.closed, 1006);
  const c2 = await connect(m);
  assert.equal((await c2.request('get_status')).status, 'ok');
  c2.close();
}));

test('large and fragmented frames are reassembled', () => withMock(async (m) => {
  const c = await connect(m);
  const big = 'a'.repeat(70000); // > 65535 → 64 位长度
  const r = await c.request('send_private_msg', { user_id: 20001, message: big });
  assert.equal(r.status, 'ok');
  assert.equal((await control(m, 'out')).body[0].text.length, 70000);
  c.close();

  // 手写两片分片帧（Node 的 WebSocket 不会主动分片）
  const sock = net.connect(m.wsPort, '127.0.0.1');
  await new Promise((r) => sock.once('connect', r));
  sock.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
  let buf = '';
  sock.on('data', (d) => { buf += d.toString('latin1'); });
  const frame = (first, fin, text) => {
    const payload = Buffer.from(text);
    const mask = Buffer.from([1, 2, 3, 4]);
    const masked = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
    return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | (first ? 0x1 : 0x0), 0x80 | payload.length]), mask, masked]);
  };
  const msg = JSON.stringify({ action: 'get_login_info', params: {}, echo: 'frag' });
  sock.write(frame(true, false, msg.slice(0, 10)));
  sock.write(frame(false, true, msg.slice(10)));
  const deadline = Date.now() + 3000;
  while (!buf.includes('"echo":"frag"') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.match(buf, /s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/); // RFC 6455 示例握手的 Accept 值
  assert.match(buf, /"echo":"frag"/);
  sock.destroy();
}));

test('long-poll wait-out returns as soon as the bot sends', () => withMock(async (m) => {
  const pending = control(m, 'wait-out?timeout=5000');
  await new Promise((r) => setTimeout(r, 100));
  await action(m, 'send_private_msg', { user_id: 20001, message: '来了' });
  const r = await pending;
  assert.equal(r.body[0].text, '来了');
}));

test('HTTP port rejects WS upgrades with 426; non-loopback host is refused', async () => {
  await withMock(async (m) => {
    const ws = new WebSocket(`ws://127.0.0.1:${m.httpPort}/`);
    const code = await new Promise((resolve) => ws.addEventListener('close', (e) => resolve(e.code)));
    assert.equal(code, 1006);
  });
  await assert.rejects(startMockOneBot({ host: '0.0.0.0', httpPort: 0, wsPort: 0 }), /只允许监听本机/);
});

// ── 聊天界面用的接口 ───────────────────────────────────────────────────────

/** 读 SSE，直到拿到满足条件的事件。 */
async function readStream(m, until, timeoutMs = 3000) {
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${m.httpPort}/__mock/stream`, { signal: ac.signal });
  const reader = res.body.getReader();
  const events = [];
  let buf = '';
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const ready = { resolve: null };
  const done = (async () => {
    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += Buffer.from(value).toString('utf8');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const type = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (type && data) events.push({ type, data: JSON.parse(data) });
          if (events.length === 1) ready.resolve?.();
          if (until(events)) { ac.abort(); return events; }
        }
      }
    } catch {}
    return events;
  })();
  await new Promise((r) => { ready.resolve = r; setTimeout(r, 500); });
  return { done: done.finally(() => clearTimeout(timer)), events };
}

test('UI: conversations, messages and a live stream of both directions', () => withMock(async (m) => {
  const created = await control(m, 'conversations', { key: 'private:20009', name: '小李' });
  assert.equal(created.body.conversation.name, '小李');
  const stream = await readStream(m, (ev) => ev.filter((e) => e.type === 'message').length >= 2 && ev.some((e) => e.type === 'poke'));
  assert.equal(stream.events[0].type, 'status');
  const inj = await control(m, 'send', { key: 'group:999001', text: '界面里发的', userId: 20001, nickname: '小明' });
  await action(m, 'send_group_msg', { group_id: 999001, message: [{ type: 'reply', data: { id: String(inj.body.message_id) } }, { type: 'text', data: { text: '收到' } }] });
  await control(m, 'poke', { key: 'group:999001', userId: 20001 });
  const events = await stream.done;
  const msgs = events.filter((e) => e.type === 'message').map((e) => e.data.message);
  assert.deepEqual(msgs.map((x) => [x.key, x.self, x.text]), [['group:999001', false, '界面里发的'], ['group:999001', true, `[回复 #${inj.body.message_id}]收到`]]);
  assert.deepEqual(events.find((e) => e.type === 'poke').data, { type: 'poke', key: 'group:999001', from: 20001, to: 10001, time: events.find((e) => e.type === 'poke').data.time });

  const convs = (await control(m, 'conversations')).body;
  assert.deepEqual(convs.map((c) => c.key), ['group:999001', 'private:20009']); // 有消息的排前面
  assert.equal(convs[0].last.text, `[回复 #${inj.body.message_id}]收到`);
  assert.deepEqual(convs[0].members.map((x) => x.user_id), [20001]);
  const history = (await control(m, 'messages?key=group%3A999001')).body;
  assert.equal(history.length, 2);
  assert.equal((await control(m, 'messages?key=bad')).status, 400);
  assert.equal((await control(m, 'conversations', { key: 'group:10001' })).status, 400);
}));

test('UI: uploaded images are stored, served back, and validated', () => withMock(async (m) => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=';
  const r = await control(m, 'send', { key: 'group:999001', text: '', image: { data: `data:image/png;base64,${png}`, name: 'a.png' } });
  assert.equal(r.status, 200);
  const file = (await control(m, 'messages?key=group%3A999001')).body[0].segments[0].data.file;
  const img = await fetch(`http://127.0.0.1:${m.httpPort}/__mock/image/${file}`);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await img.arrayBuffer()).toString('base64'), png);
  assert.equal((await control(m, 'send', { key: 'group:999001', image: { data: png, name: 'a.exe' } })).status, 400);
  assert.equal((await control(m, 'send', { key: 'group:999001', image: { data: 'not base64!', name: 'a.png' } })).status, 400);
}));

test('UI: page is served to browsers; OneBot clients still get JSON at /', () => withMock(async (m) => {
  const page = await fetch(`http://127.0.0.1:${m.httpPort}/`, { headers: { accept: 'text/html' } });
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /虚拟 QQ/);
  const json = await fetch(`http://127.0.0.1:${m.httpPort}/`).then((x) => x.json());
  assert.equal(json.ok, true);
}));

test('cross-site guards: foreign Host, foreign Origin, non-JSON control posts', () => withMock(async (m) => {
  const raw = (headers, body = '{"key":"group:999001","text":"x"}') => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: m.httpPort, path: '/__mock/send', method: 'POST', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.end(body);
  });
  assert.equal(await raw({ host: 'evil.example:3010', 'content-type': 'application/json' }), 403);
  assert.equal(await raw({ origin: 'https://evil.example', 'content-type': 'application/json' }), 403);
  assert.equal(await raw({ origin: 'null', 'content-type': 'application/json' }), 403);
  assert.equal(await raw({ 'content-type': 'text/plain' }), 415);
  assert.equal(await raw({ origin: `http://127.0.0.1:${m.httpPort}`, 'content-type': 'application/json' }), 200);
  assert.equal((await control(m, 'out')).body.length, 0);
}));
