// OneBot 路由环境变量覆盖（src/onebot-route.js）的回归测试。
//
// 要钉住的三件事：
//   1. 不设变量时什么都不变（生产行为不变）；
//   2. 设了变量时，桥接与 MCP 都走变量指定的地址，且桥接**不会**改写 config.json；
//   3. 变量不完整 / 指向非本机地址时，进程启动失败，而不是半覆盖地跑起来。
//
// 第 2 点用真实进程验证：在临时目录里放一份桥接代码，配一个假的 SnowLuma 主目录，
// 让 token 自愈真的有东西可"发现"。对照组（不设变量）必须真的写了 config.json，
// 否则实验组的"没写"说明不了任何问题。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ONEBOT_ROUTE_ENV, readOneBotRouteOverride, applyOneBotRouteOverride } from '../src/onebot-route.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WS = ONEBOT_ROUTE_ENV.wsUrl;
const HTTP = ONEBOT_ROUTE_ENV.httpUrl;
const DEAD = 'http://127.0.0.1:1';

// ── 1. 纯函数 ──────────────────────────────────────────────────────────────

test('no variables (or blank ones) means no override', () => {
  assert.equal(readOneBotRouteOverride({}), null);
  assert.equal(readOneBotRouteOverride({ [WS]: '', [HTTP]: '  ' }), null);
  // 不认旧的 / 别的变量名
  assert.equal(readOneBotRouteOverride({ SNOWLUMA_HTTP_URL: 'http://127.0.0.1:3010', QQ_BRIDGE_ONEBOT_TOKEN: 'x' }), null);
});

test('a complete loopback override is accepted, trailing slashes trimmed, no auth', () => {
  assert.deepEqual(
    readOneBotRouteOverride({ [WS]: 'ws://127.0.0.1:3011/', [HTTP]: ' http://localhost:3010/ ' }),
    { wsUrl: 'ws://127.0.0.1:3011', httpUrl: 'http://localhost:3010', accessToken: '' }
  );
  assert.equal(readOneBotRouteOverride({ [WS]: 'ws://[::1]:3011', [HTTP]: 'http://[::1]:3010' }).httpUrl, 'http://[::1]:3010');
});

test('a partial override is rejected (receive and send would hit different gateways)', () => {
  assert.throws(() => readOneBotRouteOverride({ [WS]: 'ws://127.0.0.1:3011' }), /同时设置/);
  assert.throws(() => readOneBotRouteOverride({ [HTTP]: 'http://127.0.0.1:3010' }), /同时设置/);
});

test('non-loopback hosts, wrong schemes and embedded credentials are rejected', () => {
  const bad = [
    ['ws://192.168.1.2:3011', 'http://127.0.0.1:3010'],
    ['ws://127.0.0.1:3011', 'http://example.com:3010'],
    ['ws://127.0.0.1.example.com:3011', 'http://127.0.0.1:3010'],
    ['http://127.0.0.1:3011', 'http://127.0.0.1:3010'],
    ['ws://127.0.0.1:3011', 'ws://127.0.0.1:3010'],
    ['wss://127.0.0.1:3011', 'http://127.0.0.1:3010'],
    ['ws://127.0.0.1:3011', 'http://u:p@127.0.0.1:3010'],
    ['not a url', 'http://127.0.0.1:3010'],
  ];
  for (const [ws, h] of bad) {
    assert.throws(() => readOneBotRouteOverride({ [WS]: ws, [HTTP]: h }), Error, `${ws} / ${h}`);
  }
});

test('apply: null override returns the very same object; otherwise a new object, input untouched', () => {
  const sl = { wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000', accessToken: 'real', homeDir: '/opt/sl', silenceWarnMs: 5 };
  const snapshot = structuredClone(sl);
  assert.equal(applyOneBotRouteOverride(sl, null), sl);
  const out = applyOneBotRouteOverride(sl, { wsUrl: 'ws://127.0.0.1:3011', httpUrl: 'http://127.0.0.1:3010', accessToken: '' });
  assert.deepEqual(sl, snapshot);
  assert.deepEqual(out, {
    wsUrl: 'ws://127.0.0.1:3011', httpUrl: 'http://127.0.0.1:3010', accessToken: '',
    homeDir: '', launcherPath: '', followDiscoveredEndpoint: false, silenceWarnMs: 5
  });
});

test('variable names survive DSH\'s env scrub for MCP children', () => {
  // DSH（@deepseek-ai/dsh-subprocess 的 scrubbedParentEnv）会丢掉匹配这个模式的变量。
  // 名字一旦命中，MCP 子进程就收不到覆盖，又会回到 config.json 的地址。
  const DSH_SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i;
  for (const name of Object.values(ONEBOT_ROUTE_ENV)) {
    assert.ok(!DSH_SENSITIVE_ENV_PATTERN.test(name), `${name} would be scrubbed by DSH`);
    assert.ok(!name.toUpperCase().startsWith('DSH_'), `${name} would be scrubbed by DSH`);
  }
});

// ── 测试夹具 ───────────────────────────────────────────────────────────────

/** 假网关：HTTP 动作一律成功；WS 握手一律拒绝（401），以便触发桥接的断线 → 自愈路径。 */
async function startFakeGateway() {
  const seen = { http: [], wsUpgrades: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.http.push({ action: req.url.replace(/^\//, ''), auth: req.headers.authorization ?? '' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 10001, nickname: 'fixture-bot', online: true, good: true } }));
    });
  });
  server.on('upgrade', (req, socket) => {
    seen.wsUpgrades += 1;
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { port, seen, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

async function freePort() {
  const s = http.createServer();
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return port;
}

/** 临时目录里的一份桥接：只复制运行所需，node_modules 用软链接。 */
function makeBridgeCopy(gatewayPort) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-onebot-route-'));
  const bridgeRoot = path.join(temp, 'qq-bridge');
  fs.mkdirSync(bridgeRoot);
  for (const dir of ['src', 'public']) fs.cpSync(path.join(ROOT, dir), path.join(bridgeRoot, dir), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(bridgeRoot, 'package.json'));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(bridgeRoot, 'node_modules'), 'dir');
  // 假 SnowLuma 主目录：自愈会从这里"发现"一个 token，并在假网关上探活成功。
  const slHome = path.join(temp, 'snowluma');
  fs.mkdirSync(path.join(slHome, 'config'), { recursive: true });
  fs.writeFileSync(path.join(slHome, 'config', 'onebot_10001.json'), JSON.stringify({
    networks: {
      httpServers: [{ host: '127.0.0.1', port: gatewayPort, accessToken: 'discovered-token' }],
      wsServers: [{ host: '127.0.0.1', port: gatewayPort, accessToken: 'discovered-ws-token' }]
    }
  }));
  for (const d of ['home', 'dsh-home']) fs.mkdirSync(path.join(temp, d));
  return { temp, bridgeRoot, slHome };
}

async function writeConfig(bridgeRoot) {
  const file = path.join(bridgeRoot, 'config.json');
  fs.writeFileSync(file, JSON.stringify({
    consolePort: await freePort(),
    consoleToken: 'fixture-console-token-0123456789',
    ownerQQ: 10001,
    allow: { private: ['10001'], groups: [] },
    dsh: { baseUrl: DEAD, authToken: 'fixture-only' },
    // 指向死端口：桥接一定连不上 → 触发自愈
    snowluma: { wsUrl: 'ws://127.0.0.1:1', httpUrl: DEAD, accessToken: 'file-token', homeDir: '' },
    slang: { enabled: false }
  }, null, 2) + '\n');
  return file;
}

function childEnv(fx, extra = {}) {
  // 干净环境：不继承开发者终端里的任何 SnowLuma / DSH / 路由变量。
  return {
    PATH: process.env.PATH,
    HOME: path.join(fx.temp, 'home'),
    DSH_HOME: path.join(fx.temp, 'dsh-home'),
    LANG: 'C.UTF-8',
    SNOWLUMA_HOME: fx.slHome,
    ...extra
  };
}

function startBridge(fx, env) {
  const child = spawn(process.execPath, [path.join(fx.bridgeRoot, 'src', 'bridge.js')], {
    cwd: fx.bridgeRoot, env, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, exited, output: () => output };
}

async function waitFor(cond, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function stopBridge(b) {
  if (b.child.exitCode === null) b.child.kill('SIGTERM');
  await Promise.race([b.exited, new Promise((r) => setTimeout(r, 5000))]);
  if (b.child.exitCode === null) b.child.kill('SIGKILL');
}

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// ── 2. 真实桥接进程 ───────────────────────────────────────────────────────

test('bridge process: control run without variables does rewrite config.json via self-heal', { timeout: 30000 }, async () => {
  const gw = await startFakeGateway();
  const fx = makeBridgeCopy(gw.port);
  const cfgFile = await writeConfig(fx.bridgeRoot);
  const before = sha(cfgFile);
  const b = startBridge(fx, childEnv(fx));
  try {
    await waitFor(() => sha(cfgFile) !== before, 20000, 'self-heal to rewrite config.json');
    const written = JSON.parse(fs.readFileSync(cfgFile, 'utf8')).snowluma;
    assert.equal(written.accessToken, 'discovered-token');
    assert.doesNotMatch(b.output(), /OneBot 路由已被环境变量覆盖/);
  } finally {
    await stopBridge(b);
    await gw.close();
    fs.rmSync(fx.temp, { recursive: true, force: true });
  }
});

test('bridge process: with variables it dials the override and never touches config.json', { timeout: 30000 }, async () => {
  const gw = await startFakeGateway();
  const fx = makeBridgeCopy(gw.port);
  const cfgFile = await writeConfig(fx.bridgeRoot);
  const before = sha(cfgFile);
  const b = startBridge(fx, childEnv(fx, {
    [WS]: `ws://127.0.0.1:${gw.port}`,
    [HTTP]: `http://127.0.0.1:${gw.port}`
  }));
  try {
    // 至少被拒两次 = 断线、重连都发生过，自愈有足够的机会去写文件。
    await waitFor(() => gw.seen.wsUpgrades >= 2, 20000, 'bridge to dial the override WS twice');
    await new Promise((r) => setTimeout(r, 2000));
    assert.match(b.output(), /OneBot 路由已被环境变量覆盖/);
    // 只匹配自愈真正执行时才会打的行（警告行里的「token 自愈与 config.json 写回已关闭」不算）
    assert.doesNotMatch(b.output(), /token 自愈失败|token 自愈异常|自愈完成|已写回 config\.json|token 已更新/);
    assert.equal(sha(cfgFile), before, 'config.json must be byte-identical');
    // 自愈没有跑 → 没有用"发现到的" token 去探活
    assert.ok(!gw.seen.http.some((r) => r.auth.includes('discovered')), 'no probe with a discovered token');
    // 控制台状态里能看出路由被覆盖了
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    const res = await fetch(`http://127.0.0.1:${cfg.consolePort}/api/status`, { headers: { 'x-console-token': cfg.consoleToken } });
    assert.equal((await res.json()).snowluma?.routeOverride, true);
  } finally {
    await stopBridge(b);
    await gw.close();
    fs.rmSync(fx.temp, { recursive: true, force: true });
  }
});

test('bridge process: an invalid override refuses to start', { timeout: 15000 }, async () => {
  const fx = makeBridgeCopy(1);
  const cfgFile = await writeConfig(fx.bridgeRoot);
  const before = sha(cfgFile);
  const b = startBridge(fx, childEnv(fx, { [WS]: 'ws://10.0.0.5:3011', [HTTP]: 'http://10.0.0.5:3010' }));
  try {
    const code = await Promise.race([b.exited, new Promise((r) => setTimeout(() => r('still running'), 10000))]);
    assert.notEqual(code, 'still running', 'bridge should exit');
    assert.notEqual(code, 0);
    assert.match(b.output(), /只允许本机地址/);
    assert.equal(sha(cfgFile), before);
  } finally {
    await stopBridge(b);
    fs.rmSync(fx.temp, { recursive: true, force: true });
  }
});

// ── 3. MCP 子进程 ─────────────────────────────────────────────────────────

async function callHostStatus(fx, env) {
  const client = new Client({ name: 'onebot-route-test', version: '0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(fx.bridgeRoot, 'src', 'mcp-host-server.js')],
    cwd: fx.bridgeRoot, env, stderr: 'pipe'
  });
  await client.connect(transport);
  try {
    const r = await client.callTool({ name: 'snowluma_status', arguments: {} });
    return JSON.parse(r.content[0].text);
  } finally {
    await client.close();
  }
}

test('MCP host server: follows the override, otherwise config.json', { timeout: 20000 }, async () => {
  const gw = await startFakeGateway();
  const fx = makeBridgeCopy(gw.port);
  await writeConfig(fx.bridgeRoot); // config.json 指向死端口
  try {
    const plain = await callHostStatus(fx, childEnv(fx));
    assert.equal(plain.reachable, false, 'without variables it uses config.json (dead port)');
    assert.equal(gw.seen.http.length, 0);

    const routed = await callHostStatus(fx, childEnv(fx, { [WS]: `ws://127.0.0.1:${gw.port}`, [HTTP]: `http://127.0.0.1:${gw.port}` }));
    assert.equal(routed.reachable, true);
    assert.equal(routed.nickname, 'fixture-bot');
    assert.deepEqual(gw.seen.http.map((r) => r.action), ['get_login_info']);
    assert.equal(gw.seen.http[0].auth, '', 'override is unauthenticated');
  } finally {
    await gw.close();
    fs.rmSync(fx.temp, { recursive: true, force: true });
  }
});

test('MCP servers: an invalid override refuses to start', { timeout: 20000 }, async () => {
  const fx = makeBridgeCopy(1);
  await writeConfig(fx.bridgeRoot);
  try {
    for (const name of ['mcp-host-server.js', 'mcp-snowluma-safe.js']) {
      const child = spawn(process.execPath, [path.join(fx.bridgeRoot, 'src', name)], {
        cwd: fx.bridgeRoot, env: childEnv(fx, { [WS]: 'ws://127.0.0.1:3011' }), stdio: ['pipe', 'pipe', 'pipe']
      });
      let err = '';
      child.stderr.on('data', (c) => { err += c; });
      const code = await Promise.race([
        new Promise((r) => child.on('exit', r)),
        new Promise((r) => setTimeout(() => r('still running'), 8000))
      ]);
      if (code === 'still running') child.kill('SIGKILL');
      assert.notEqual(code, 'still running', `${name} should exit`);
      assert.notEqual(code, 0, name);
      assert.match(err, /同时设置/, name);
    }
  } finally {
    fs.rmSync(fx.temp, { recursive: true, force: true });
  }
});
