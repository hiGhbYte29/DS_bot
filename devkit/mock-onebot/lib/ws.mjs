// 最小 WebSocket 服务端（RFC 6455），只做虚拟网关需要的部分：
// 握手、文本帧收发、分片重组、ping/pong、close。不做扩展（permessage-deflate）和子协议。
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xA };

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode；服务端发出的帧不加掩码
  return Buffer.concat([header, payload]);
}

/** 一条已握手的连接。事件：'message'(text)、'close'({code, reason})。 */
export class WsConnection extends EventEmitter {
  constructor(socket, request, head) {
    super();
    this.socket = socket;
    this.request = request;
    this.open = true;
    this.buffer = Buffer.alloc(0);
    this.fragments = null; // 分片中的 { opcode, parts: Buffer[] }
    socket.on('data', (chunk) => this.#onData(chunk));
    // 和握手请求同一个包到达的帧，Node 放在 upgrade 事件的 head 里，不会再走 'data'
    if (head?.length) queueMicrotask(() => this.#onData(head));
    socket.on('close', () => this.#finish(1006, ''));
    socket.on('error', () => this.#finish(1006, ''));
  }

  send(text) {
    if (!this.open) return false;
    this.socket.write(encodeFrame(OP.TEXT, Buffer.from(String(text), 'utf8')));
    return true;
  }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    const r = Buffer.from(String(reason), 'utf8').subarray(0, 120);
    const payload = Buffer.alloc(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
    try { this.socket.write(encodeFrame(OP.CLOSE, payload)); } catch {}
    this.socket.end();
    this.#finish(code, reason);
  }

  /** 不发 close 帧直接断开（模拟网关进程崩溃）。 */
  terminate() {
    this.socket.destroy();
    this.#finish(1006, '');
  }

  #finish(code, reason) {
    if (!this.open) return;
    this.open = false;
    this.emit('close', { code, reason });
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.open) {
      const frame = this.#readFrame();
      if (!frame) return;
      this.#onFrame(frame);
    }
  }

  #readFrame() {
    const b = this.buffer;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(MAX_MESSAGE_BYTES)) { this.close(1009, 'message too big'); return null; }
      len = Number(big);
      offset = 10;
    }
    if (!masked) { this.close(1002, 'client frames must be masked'); return null; }
    if (b.length < offset + 4 + len) return null;
    const mask = b.subarray(offset, offset + 4);
    const payload = Buffer.from(b.subarray(offset + 4, offset + 4 + len));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buffer = b.subarray(offset + 4 + len);
    return { fin, opcode, payload };
  }

  #onFrame({ fin, opcode, payload }) {
    if (opcode === OP.PING) { this.socket.write(encodeFrame(OP.PONG, payload)); return; }
    if (opcode === OP.PONG) return;
    if (opcode === OP.CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      this.close(code === 1005 ? 1000 : code, '');
      return;
    }
    if (opcode === OP.TEXT || opcode === OP.BINARY) {
      if (fin) { this.#deliver(opcode, payload); return; }
      this.fragments = { opcode, parts: [payload], size: payload.length };
      return;
    }
    if (opcode === OP.CONT && this.fragments) {
      this.fragments.parts.push(payload);
      this.fragments.size += payload.length;
      if (this.fragments.size > MAX_MESSAGE_BYTES) { this.close(1009, 'message too big'); return; }
      if (fin) {
        const { opcode: op, parts } = this.fragments;
        this.fragments = null;
        this.#deliver(op, Buffer.concat(parts));
      }
      return;
    }
    this.close(1002, 'unexpected frame');
  }

  #deliver(opcode, payload) {
    // OneBot 只走文本帧；二进制帧也按 UTF-8 尝试解析，宽松一点
    this.emit('message', payload.toString('utf8'), opcode === OP.BINARY);
  }
}

/**
 * 处理 http.Server 的 'upgrade' 事件。握手成功返回 WsConnection，失败返回 null（已回 400）。
 */
export function acceptUpgrade(request, socket, head) {
  const key = request.headers['sec-websocket-key'];
  const upgrade = String(request.headers.upgrade ?? '').toLowerCase();
  if (upgrade !== 'websocket' || !key) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '', ''
  ].join('\r\n'));
  socket.setNoDelay(true);
  return new WsConnection(socket, request, head);
}
