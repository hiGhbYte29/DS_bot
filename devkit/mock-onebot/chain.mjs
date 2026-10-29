#!/usr/bin/env node
// 虚拟网关的命令行：起停虚拟网关、把路由环境变量注入到 DSH / 桥接、模拟收消息、看机器人发了什么。
//
// 和 qq-bridge 的唯一约定是两个环境变量（qq-bridge/src/onebot-route.js）：
//   QQ_BRIDGE_ONEBOT_WS_URL / QQ_BRIDGE_ONEBOT_HTTP_URL
// 这里不引用 qq-bridge 的任何代码，也不替你决定怎么启动 DSH 和桥接 —— 用 exec 包一层即可。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_DIR = path.join(HERE, '.run');
const PID_FILE = path.join(RUN_DIR, 'mock.pid');
const INFO_FILE = path.join(RUN_DIR, 'mock.json');
const LOG_FILE = path.join(RUN_DIR, 'mock.log');
const ROUTE_ENV = { ws: 'QQ_BRIDGE_ONEBOT_WS_URL', http: 'QQ_BRIDGE_ONEBOT_HTTP_URL' };

const HELP = `用法: node chain.mjs <命令> [参数]

虚拟网关
  up [server 参数]     后台启动虚拟网关（参数同 server.mjs，如 --http-port 3010 --ws-port 3011）
  down                 停止
  status               是否在运行、WS 客户端数、群/消息数
  logs [-f]            查看虚拟网关日志
  ui                   打开聊天界面（浏览器）

接到链路上
  env                  打印路由环境变量（可 eval "$(node chain.mjs env)"）
  exec -- <命令...>    带上路由环境变量运行一个命令，例如：
                         DSH_HOME=~/.dsh-test node chain.mjs exec -- dsh web --host 127.0.0.1 --port 3180 --no-open
                         node chain.mjs exec -- node ../../qq-bridge/src/bridge.js

模拟 QQ 侧
  send <目标> <文本>   模拟有人发消息。目标：group:<群号> 或 private:<QQ号>
                         --user <QQ号>  --nick <昵称>  --card <群名片>
                         --at-self  --at <QQ号>  --reply <消息ID>  --image <图片路径|sample>
  poke <目标>          模拟拍一拍（默认拍机器人）  --user <QQ号>  --target <QQ号>
  set-status           --online true|false  --good true|false
  drop [--close]       断开桥接的 WS 连接（默认模拟崩溃，--close 为正常关闭）

查看
  out [-f] [--since N] 机器人发出的消息（-f 持续跟随）
  calls [--since N] [--unhandled]  桥接调用过的动作`;

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function readInfo() {
  try { return JSON.parse(fs.readFileSync(INFO_FILE, 'utf8')); } catch { return null; }
}

function urls() {
  const info = readInfo();
  const httpPort = info?.httpPort ?? 3010;
  const wsPort = info?.wsPort ?? 3011;
  return { http: `http://127.0.0.1:${httpPort}`, ws: `ws://127.0.0.1:${wsPort}` };
}

function runningPid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

async function api(route, { method = 'GET', body, query = {} } = {}) {
  const url = new URL(`/__mock/${route}`, urls().http);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    die(`连不上虚拟网关（${urls().http}）。先运行：node chain.mjs up`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) die(`失败：${data?.error ?? res.status}`);
  return data;
}

/** 解析 --flag value / --flag 形式的选项，返回 { flags, rest }。 */
function parseFlags(args, booleans = []) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--') || (a.startsWith('-') && a.length === 2)) {
      const name = a.replace(/^-+/, '');
      if (booleans.includes(name)) flags[name] = true;
      else {
        if (args[i + 1] === undefined) die(`${a} 需要一个值`, 2);
        flags[name] = args[++i];
      }
    } else rest.push(a);
  }
  return { flags, rest };
}

const bool = (v) => (v === undefined ? undefined : v === 'true' || v === '1' || v === 'yes');

function printOut(entries) {
  for (const e of entries) {
    const t = new Date(e.time * 1000).toTimeString().slice(0, 8);
    const id = e.message_id ? ` #${e.message_id}` : '';
    console.log(`${t} [${e.seq}] ${e.target}${id}  ${e.text}`);
  }
}

async function cmdUp(args) {
  const pid = runningPid();
  if (pid) {
    console.log(`虚拟网关已在运行（pid ${pid}）：${urls().http}  ${urls().ws}`);
    return;
  }
  const ports = parseFlags(args, ['h', 'help']).flags;
  const httpPort = Number(ports['http-port'] ?? 3010);
  const wsPort = Number(ports['ws-port'] ?? 3011);
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const logFd = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [path.join(HERE, 'server.mjs'), ...args], {
    detached: true, stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  fs.writeFileSync(INFO_FILE, JSON.stringify({ pid: child.pid, httpPort, wsPort }, null, 2));
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (!runningPid()) break;
    try {
      const res = await fetch(`http://127.0.0.1:${httpPort}/__mock/health`);
      if (res.ok) {
        console.log(`虚拟网关已启动（pid ${child.pid}）：HTTP http://127.0.0.1:${httpPort}  WS ws://127.0.0.1:${wsPort}`);
        console.log(`聊天界面：http://127.0.0.1:${httpPort}/`);
        console.log(`日志：${LOG_FILE}`);
        console.log('下一步：用 exec 带上路由变量重启 DSH 和桥接（见 node chain.mjs --help）');
        return;
      }
    } catch {}
  }
  fs.rmSync(PID_FILE, { force: true });
  const tail = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-5).join('\n') : '';
  die(`虚拟网关没能启动。日志末尾：\n${tail}`);
}

async function cmdDown() {
  const pid = runningPid();
  if (!pid) {
    console.log('虚拟网关没有在运行');
    fs.rmSync(PID_FILE, { force: true });
    return;
  }
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 30 && runningPid(); i++) await new Promise((r) => setTimeout(r, 100));
  if (runningPid()) process.kill(pid, 'SIGKILL');
  fs.rmSync(PID_FILE, { force: true });
  console.log(`虚拟网关已停止（pid ${pid}）`);
}

async function cmdStatus() {
  const pid = runningPid();
  if (!pid) { console.log('虚拟网关没有在运行'); process.exitCode = 1; return; }
  const h = await api('health');
  console.log(`运行中（pid ${pid}）：${urls().http}  ${urls().ws}`);
  console.log(`机器人 ${h.selfId}（${h.nickname}）  WS 客户端 ${h.wsClients} 个  群 ${h.groups} 个  消息 ${h.messages} 条  online=${h.online} good=${h.good}`);
  if (h.wsClients === 0) console.log('提示：还没有桥接连上来。桥接要用 exec 带上路由变量启动。');
}

function cmdLogs(args) {
  if (!fs.existsSync(LOG_FILE)) die('还没有日志');
  if (!args.includes('-f')) { process.stdout.write(fs.readFileSync(LOG_FILE, 'utf8')); return; }
  const child = spawn('tail', ['-n', '50', '-f', LOG_FILE], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
}

function cmdUi() {
  const url = `${urls().http}/`;
  if (!runningPid()) console.error('⚠️ 虚拟网关没有在运行（先运行 node chain.mjs up）');
  console.log(`聊天界面：${url}`);
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    const child = spawn(opener, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

function cmdEnv() {
  const u = urls();
  console.log(`export ${ROUTE_ENV.ws}=${u.ws}`);
  console.log(`export ${ROUTE_ENV.http}=${u.http}`);
}

function cmdExec(args) {
  const i = args.indexOf('--');
  const cmd = i >= 0 ? args.slice(i + 1) : args;
  if (!cmd.length) die('用法：node chain.mjs exec -- <命令...>', 2);
  if (!runningPid()) console.error('⚠️ 虚拟网关没有在运行，被启动的程序会连不上（先运行 node chain.mjs up）');
  const u = urls();
  const env = { ...process.env, [ROUTE_ENV.ws]: u.ws, [ROUTE_ENV.http]: u.http };
  console.error(`[chain] ${ROUTE_ENV.ws}=${u.ws} ${ROUTE_ENV.http}=${u.http}`);
  const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', env });
  child.on('error', (error) => die(`启动失败：${error.message}`));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

async function cmdSend(args) {
  const { flags, rest } = parseFlags(args, ['at-self']);
  const [key, ...words] = rest;
  if (!key) die('用法：node chain.mjs send <group:群号|private:QQ号> <文本> [选项]', 2);
  let image = flags.image;
  if (image && image !== 'sample') image = path.resolve(image);
  const r = await api('send', {
    method: 'POST',
    body: {
      key, text: words.join(' '), userId: flags.user, nickname: flags.nick, card: flags.card,
      atSelf: flags['at-self'] === true, at: flags.at, replyTo: flags.reply, image,
    },
  });
  console.log(`已注入消息 #${r.message_id}${r.delivered ? '' : '（⚠️ 没有 WS 客户端在线，桥接收不到）'}`);
}

async function cmdPoke(args) {
  const { flags, rest } = parseFlags(args);
  if (!rest[0]) die('用法：node chain.mjs poke <group:群号|private:QQ号> [--user QQ号] [--target QQ号]', 2);
  const r = await api('poke', { method: 'POST', body: { key: rest[0], userId: flags.user, target: flags.target } });
  console.log(`已注入拍一拍${r.delivered ? '' : '（⚠️ 没有 WS 客户端在线，桥接收不到）'}`);
}

async function cmdSetStatus(args) {
  const { flags } = parseFlags(args);
  const r = await api('status', { method: 'POST', body: { online: bool(flags.online), good: bool(flags.good) } });
  console.log(`online=${r.online} good=${r.good}（已立即推送心跳）`);
}

async function cmdDrop(args) {
  const r = await api('drop', { method: 'POST', body: { mode: args.includes('--close') ? 'close' : 'terminate' } });
  console.log(`已断开 ${r.dropped} 个 WS 连接，桥接应自动重连`);
}

async function cmdOut(args) {
  const { flags } = parseFlags(args, ['f', 'follow']);
  let since = Number(flags.since) || 0;
  const entries = await api('out', { query: { since } });
  printOut(entries);
  if (!(flags.f || flags.follow)) {
    if (!entries.length) console.log('（机器人还没有发过消息）');
    return;
  }
  if (entries.length) since = entries.at(-1).seq;
  for (;;) {
    const fresh = await api('wait-out', { query: { since, timeout: 60000 } });
    printOut(fresh);
    if (fresh.length) since = fresh.at(-1).seq;
  }
}

async function cmdCalls(args) {
  const { flags } = parseFlags(args, ['unhandled']);
  let entries = await api('calls', { query: { since: Number(flags.since) || 0 } });
  if (flags.unhandled) entries = entries.filter((e) => e.unhandled);
  for (const e of entries) {
    const t = new Date(e.time * 1000).toTimeString().slice(0, 8);
    const mark = e.unhandled ? '  ⚠️ 未实现' : e.ok ? '' : `  ✗ ${e.wording}`;
    console.log(`${t} [${e.seq}] ${e.via.padEnd(4)} ${e.action}${mark}`);
  }
  if (!entries.length) console.log('（没有记录）');
}

const [command, ...args] = process.argv.slice(2);
const commands = {
  up: cmdUp, down: cmdDown, status: cmdStatus, logs: cmdLogs, ui: cmdUi, env: cmdEnv, exec: cmdExec,
  send: cmdSend, poke: cmdPoke, 'set-status': cmdSetStatus, drop: cmdDrop, out: cmdOut, calls: cmdCalls,
};
if (!command || command === '-h' || command === '--help' || command === 'help') {
  console.log(HELP);
} else if (!commands[command]) {
  die(`未知命令 ${command}\n\n${HELP}`, 2);
} else {
  await commands[command](args);
}
