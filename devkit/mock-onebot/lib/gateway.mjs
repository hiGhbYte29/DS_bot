// 虚拟 QQ：群、成员、消息库，以及 OneBot v11 动作表与事件构造。
// 不做任何网络 I/O —— 网络层（server.mjs）把收到的动作交给 call()，把 emit() 出来的事件推给 WS 客户端。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// 1×1 透明 PNG，`--image sample` 时用
const SAMPLE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=';
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const LOG_LIMIT = 2000;

export class ActionError extends Error {
  constructor(retcode, wording) {
    super(wording);
    this.retcode = retcode;
    this.wording = wording;
  }
}

/** 'group:999001' / 'private:20001' → { kind, id }。 */
export function parseKey(key) {
  const m = /^(group|private):(\d{1,12})$/.exec(String(key ?? '').trim());
  if (!m) throw new ActionError(1400, `目标格式应为 group:<群号> 或 private:<QQ号>，收到 ${JSON.stringify(key)}`);
  return { kind: m[1], id: Number(m[2]) };
}

function cqEscape(s, inParam = false) {
  const out = String(s).replace(/&/g, '&amp;').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;');
  return inParam ? out.replace(/,/g, '&#44;') : out;
}

/** 消息段 → CQ 码字符串（raw_message）。 */
export function toRawMessage(segments) {
  return segments.map((seg) => {
    if (seg.type === 'text') return cqEscape(seg.data?.text ?? '');
    const params = Object.entries(seg.data ?? {})
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${cqEscape(v, true)}`);
    return `[CQ:${seg.type}${params.length ? ',' + params.join(',') : ''}]`;
  }).join('');
}

/** 消息段 → 便于人看的纯文本（只用于日志 / out 输出）。 */
export function toPlainText(segments) {
  return segments.map((seg) => {
    const d = seg.data ?? {};
    switch (seg.type) {
      case 'text': return d.text ?? '';
      case 'at': return `@${d.qq}`;
      case 'reply': return `[回复 #${d.id}]`;
      case 'image': return '[图片]';
      case 'mface': return '[表情包]';
      case 'face': return `[表情 ${d.id}]`;
      case 'record': return '[语音]';
      case 'video': return '[视频]';
      case 'forward': return '[合并转发]';
      default: return `[${seg.type}]`;
    }
  }).join('');
}

/** 把动作参数里的 message 规范成消息段数组（数组 / 单个段 / 纯字符串都接受）。 */
function normalizeOutgoing(message) {
  if (typeof message === 'string') return [{ type: 'text', data: { text: message } }];
  if (Array.isArray(message)) return message.filter((s) => s && typeof s.type === 'string');
  if (message && typeof message === 'object' && typeof message.type === 'string') return [message];
  throw new ActionError(1400, 'message 不能为空');
}

function requireId(params, name) {
  const n = Number(params?.[name]);
  if (!Number.isSafeInteger(n) || n === 0) throw new ActionError(1400, `缺少或非法的 ${name}`);
  return n;
}

export function createGateway({ selfId = 10001, nickname = '测试机器人', now = () => Date.now() } = {}) {
  const st = {
    online: true,
    good: true,
    nextMessageId: 1000,
    seq: 0,
    messages: new Map(),   // message_id → 消息记录
    groups: new Map(),     // group_id → { group_id, group_name, members: Map }
    friends: new Map(),    // user_id → { user_id, nickname }
    images: new Map(),     // file → base64
    out: [],               // 机器人发出去的（发消息、拍一拍）
    calls: [],             // 所有动作调用（含未实现的）
  };
  const listeners = new Set();   // OneBot 事件（推给桥接）
  const timeline = new Set();    // 聊天界面用的时间线（双向消息、拍一拍、撤回）
  const ts = () => Math.floor(now() / 1000);
  const notify = (entry) => { for (const fn of timeline) fn(entry); };
  const push = (list, entry) => {
    list.push({ seq: ++st.seq, time: ts(), ...entry });
    if (list.length > LOG_LIMIT) list.splice(0, list.length - LOG_LIMIT);
  };
  const emit = (event) => { for (const fn of listeners) fn(event); };

  function ensureGroup(groupId, name) {
    let g = st.groups.get(groupId);
    if (!g) {
      g = { group_id: groupId, group_name: name || `测试群${groupId}`, members: new Map() };
      st.groups.set(groupId, g);
      ensureMember(g, selfId, nickname, '', 'owner');
    } else if (name) {
      g.group_name = name;
    }
    return g;
  }

  function ensureMember(group, userId, nick, card, role) {
    let m = group.members.get(userId);
    if (!m) {
      m = { group_id: group.group_id, user_id: userId, nickname: nick || `用户${userId}`, card: card ?? '', role: role || 'member', title: '', join_time: ts(), last_sent_time: 0 };
      group.members.set(userId, m);
    } else {
      if (nick) m.nickname = nick;
      if (card !== undefined && card !== null) m.card = card;
    }
    return m;
  }

  function ensureFriend(userId, nick) {
    let f = st.friends.get(userId);
    if (!f) {
      f = { user_id: userId, nickname: nick || `用户${userId}`, remark: '' };
      st.friends.set(userId, f);
    } else if (nick) {
      f.nickname = nick;
    }
    return f;
  }

  function storeMessage(rec) {
    const message_id = st.nextMessageId++;
    const full = { ...rec, message_id, time: ts(), raw_message: toRawMessage(rec.message) };
    st.messages.set(message_id, full);
    notify({ type: 'message', message: uiView(full) });
    return full;
  }

  const keyOf = (m) => (m.message_type === 'group' ? `group:${m.group_id}` : `private:${m.peer_id}`);

  function uiView(m) {
    // 聊天界面用的形状：带会话 key、是否机器人发的、纯文本
    return { message_id: m.message_id, time: m.time, key: keyOf(m), self: m.self, sender: m.sender, segments: m.message, text: toPlainText(m.message) };
  }

  function messageView(m) {
    // get_msg / 历史记录返回的形状
    return {
      time: m.time, message_type: m.message_type, message_id: m.message_id, real_id: m.message_id,
      message_seq: m.message_id, sender: m.sender, message: m.message, raw_message: m.raw_message,
      ...(m.group_id ? { group_id: m.group_id } : {}), user_id: m.sender.user_id, font: 0
    };
  }

  function sendMessage(kind, id, message) {
    const segments = normalizeOutgoing(message);
    if (segments.length === 0) throw new ActionError(1400, 'message 不能为空');
    if (kind === 'group') {
      const g = st.groups.get(id);
      if (!g) throw new ActionError(1400, `机器人不在群 ${id} 里（先用 send 往这个群发一条消息，虚拟网关才会认识它）`);
      const self = g.members.get(selfId);
      const rec = storeMessage({ message_type: 'group', group_id: id, message: segments, self: true,
        sender: { user_id: selfId, nickname, card: self?.card ?? '', role: self?.role ?? 'member' } });
      push(st.out, { action: 'send_group_msg', target: `group:${id}`, message_id: rec.message_id, text: toPlainText(segments), message: segments });
      return { message_id: rec.message_id };
    }
    ensureFriend(id);
    const rec = storeMessage({ message_type: 'private', peer_id: id, message: segments, self: true,
      sender: { user_id: selfId, nickname } });
    push(st.out, { action: 'send_private_msg', target: `private:${id}`, message_id: rec.message_id, text: toPlainText(segments), message: segments });
    return { message_id: rec.message_id };
  }

  function history(filter, params) {
    const count = Math.min(200, Math.max(1, Number(params?.count) || 20));
    const before = Number(params?.message_seq ?? params?.message_id) || Infinity;
    const list = [...st.messages.values()].filter(filter).filter((m) => m.message_id <= before);
    return { messages: list.slice(-count).map(messageView) };
  }

  const actions = {
    get_login_info: () => ({ user_id: selfId, nickname }),
    get_status: () => ({ online: st.online, good: st.good, stat: {} }),
    get_version_info: () => ({ app_name: 'mock-onebot', app_version: '0.1.0', protocol_version: 'v11' }),
    can_send_image: () => ({ yes: true }),
    can_send_record: () => ({ yes: true }),

    get_friend_list: () => [...st.friends.values()],
    get_stranger_info: (p) => {
      const uid = requireId(p, 'user_id');
      return { user_id: uid, nickname: st.friends.get(uid)?.nickname ?? `用户${uid}`, sex: 'unknown', age: 0 };
    },
    get_group_list: () => [...st.groups.values()].map((g) => ({
      group_id: g.group_id, group_name: g.group_name, member_count: g.members.size, max_member_count: 500
    })),
    get_group_info: (p) => {
      const g = st.groups.get(requireId(p, 'group_id'));
      if (!g) throw new ActionError(1400, '群不存在');
      return { group_id: g.group_id, group_name: g.group_name, member_count: g.members.size, max_member_count: 500 };
    },
    get_group_member_list: (p) => {
      const g = st.groups.get(requireId(p, 'group_id'));
      if (!g) throw new ActionError(1400, '群不存在');
      return [...g.members.values()];
    },
    get_group_member_info: (p) => {
      const g = st.groups.get(requireId(p, 'group_id'));
      const m = g?.members.get(requireId(p, 'user_id'));
      if (!m) throw new ActionError(1400, '群成员不存在');
      return m;
    },

    send_group_msg: (p) => sendMessage('group', requireId(p, 'group_id'), p?.message),
    send_private_msg: (p) => sendMessage('private', requireId(p, 'user_id'), p?.message),
    send_msg: (p) => {
      const kind = p?.message_type === 'group' || (p?.message_type !== 'private' && p?.group_id) ? 'group' : 'private';
      return sendMessage(kind, requireId(p, kind === 'group' ? 'group_id' : 'user_id'), p?.message);
    },
    get_msg: (p) => {
      const m = st.messages.get(Number(p?.message_id));
      if (!m) throw new ActionError(1400, '消息不存在');
      return messageView(m);
    },
    delete_msg: (p) => {
      const m = st.messages.get(Number(p?.message_id));
      if (!m) throw new ActionError(1400, '消息不存在');
      st.messages.delete(m.message_id);
      notify({ type: 'recall', key: keyOf(m), message_id: m.message_id });
      return null;
    },
    get_group_msg_history: (p) => {
      const gid = requireId(p, 'group_id');
      return history((m) => m.group_id === gid, p);
    },
    get_friend_msg_history: (p) => {
      const uid = requireId(p, 'user_id');
      return history((m) => m.message_type === 'private' && (m.peer_id === uid || m.sender.user_id === uid), p);
    },
    get_forward_msg: () => ({ messages: [] }),

    get_image: (p) => {
      const file = String(p?.file ?? '');
      const base64 = st.images.get(file);
      if (!base64) throw new ActionError(1400, '图片不存在');
      return { file, file_size: Math.floor(base64.length * 3 / 4), base64 };
    },
    fetch_custom_face_detail: () => [],
    fetch_face_entity: () => null,
    fetch_ptt_text: () => ({ text: '' }),

    group_poke: (p) => {
      const gid = requireId(p, 'group_id');
      const uid = requireId(p, 'user_id');
      push(st.out, { action: 'group_poke', target: `group:${gid}`, text: `[拍一拍 ${uid}]` });
      notify({ type: 'poke', key: `group:${gid}`, from: selfId, to: uid, time: ts() });
      return null;
    },
    friend_poke: (p) => {
      const uid = requireId(p, 'user_id');
      push(st.out, { action: 'friend_poke', target: `private:${uid}`, text: '[拍一拍]' });
      notify({ type: 'poke', key: `private:${uid}`, from: selfId, to: uid, time: ts() });
      return null;
    },
    send_poke: (p) => (p?.group_id ? actions.group_poke(p) : actions.friend_poke(p)),

    set_msg_emoji_like: () => null,
    mark_msg_as_read: () => null,
    mark_group_msg_as_read: () => null,
    mark_private_msg_as_read: () => null,
  };

  /**
   * 执行一个 OneBot 动作，返回响应信封（不含 echo）。
   * 未实现的动作按约定返回 ok + 空数组，并在调用日志里标 unhandled，方便发现漏掉的动作。
   */
  function call(action, params = {}, via = 'http') {
    const fn = Object.prototype.hasOwnProperty.call(actions, action) ? actions[action] : null;
    if (!fn) {
      push(st.calls, { via, action, ok: true, unhandled: true });
      return { status: 'ok', retcode: 0, data: [] };
    }
    try {
      const data = fn(params ?? {});
      push(st.calls, { via, action, ok: true });
      return { status: 'ok', retcode: 0, data: data ?? null };
    } catch (error) {
      const retcode = error instanceof ActionError ? error.retcode : 1500;
      const wording = error?.wording ?? error?.message ?? String(error);
      push(st.calls, { via, action, ok: false, wording });
      return { status: 'failed', retcode, data: null, message: wording, wording };
    }
  }

  function loadImage(image, baseDir) {
    let base64;
    let ext = '.png';
    if (image === 'sample' || image === true) {
      base64 = SAMPLE_PNG;
    } else if (image && typeof image === 'object') {
      // 聊天界面上传：{ data: base64, name: 'a.jpg' }
      ext = path.extname(String(image.name ?? '')).toLowerCase() || '.png';
      if (!IMAGE_EXT.has(ext)) throw new ActionError(1400, `只支持图片文件：${[...IMAGE_EXT].join(' ')}`);
      base64 = String(image.data ?? '').replace(/^data:[^,]*,/, '').replace(/\s/g, '');
      if (!base64 || !/^[A-Za-z0-9+/]+=*$/.test(base64)) throw new ActionError(1400, '图片数据不是合法的 base64');
      if (base64.length * 3 / 4 > 8 * 1024 * 1024) throw new ActionError(1400, '图片超过 8MB');
    } else {
      const file = path.resolve(baseDir ?? process.cwd(), String(image));
      ext = path.extname(file).toLowerCase();
      if (!IMAGE_EXT.has(ext)) throw new ActionError(1400, `只支持图片文件：${[...IMAGE_EXT].join(' ')}`);
      const buf = fs.readFileSync(file);
      if (buf.length > 8 * 1024 * 1024) throw new ActionError(1400, '图片超过 8MB');
      base64 = buf.toString('base64');
    }
    const name = crypto.createHash('md5').update(base64).digest('hex').toUpperCase() + ext;
    st.images.set(name, base64);
    return { type: 'image', data: { file: name, url: '', summary: '', sub_type: 0, file_size: String(Math.floor(base64.length * 3 / 4)) } };
  }

  /** 模拟有人发消息。返回 { message_id, event }。 */
  function injectMessage({ key, text = '', userId, nickname: nick, card, atSelf = false, at, replyTo, image, groupName, imageBaseDir } = {}) {
    const { kind, id } = parseKey(key);
    const uid = Number(userId ?? (kind === 'private' ? id : 20001));
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new ActionError(1400, 'userId 非法');
    if (uid === selfId) throw new ActionError(1400, 'userId 不能是机器人自己（桥接会把它当成自己发的消息忽略掉）');
    if (kind === 'private' && uid !== id) throw new ActionError(1400, '私聊的发送者就是目标 QQ，不要另传 userId');

    const segments = [];
    if (replyTo !== undefined && replyTo !== null && replyTo !== '') {
      if (!st.messages.has(Number(replyTo))) throw new ActionError(1400, `要引用的消息 #${replyTo} 不存在`);
      segments.push({ type: 'reply', data: { id: String(replyTo) } });
    }
    if (atSelf) segments.push({ type: 'at', data: { qq: String(selfId) } }, { type: 'text', data: { text: ' ' } });
    if (at !== undefined && at !== null && at !== '') segments.push({ type: 'at', data: { qq: String(at) } }, { type: 'text', data: { text: ' ' } });
    if (text) segments.push({ type: 'text', data: { text: String(text) } });
    if (image) segments.push(loadImage(image, imageBaseDir));
    if (!segments.some((s) => s.type !== 'reply' && !(s.type === 'text' && !s.data.text.trim()))) {
      throw new ActionError(1400, '消息内容为空');
    }

    let sender;
    let rec;
    if (kind === 'group') {
      const g = ensureGroup(id, groupName);
      const m = ensureMember(g, uid, nick, card);
      m.last_sent_time = ts();
      sender = { user_id: uid, nickname: m.nickname, card: m.card, role: m.role };
      rec = storeMessage({ message_type: 'group', group_id: id, message: segments, self: false, sender });
    } else {
      const f = ensureFriend(uid, nick);
      sender = { user_id: uid, nickname: f.nickname };
      rec = storeMessage({ message_type: 'private', peer_id: uid, message: segments, self: false, sender });
    }
    const event = {
      time: rec.time, self_id: selfId, post_type: 'message', message_type: kind,
      sub_type: kind === 'group' ? 'normal' : 'friend', message_id: rec.message_id,
      ...(kind === 'group' ? { group_id: id, anonymous: null } : { target_id: selfId }),
      user_id: uid, message: segments, raw_message: rec.raw_message, font: 0, sender, message_format: 'array'
    };
    emit(event);
    return { message_id: rec.message_id, event };
  }

  /** 模拟有人拍一拍。target 默认是机器人自己。 */
  function injectPoke({ key, userId, target } = {}) {
    const { kind, id } = parseKey(key);
    const uid = Number(userId ?? (kind === 'private' ? id : 20001));
    if (!Number.isSafeInteger(uid) || uid <= 0 || uid === selfId) throw new ActionError(1400, 'userId 非法');
    const targetId = Number(target ?? selfId);
    if (kind === 'group') ensureMember(ensureGroup(id), uid);
    else ensureFriend(uid);
    const event = {
      time: ts(), self_id: selfId, post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
      ...(kind === 'group' ? { group_id: id } : {}), user_id: uid, sender_id: uid, target_id: targetId
    };
    emit(event);
    notify({ type: 'poke', key: kind === 'group' ? `group:${id}` : `private:${uid}`, from: uid, to: targetId, time: event.time });
    return { event };
  }

  /** 聊天界面的会话列表：群 + 私聊好友，按最后一条消息时间倒序。 */
  function conversations() {
    const last = new Map();
    for (const m of st.messages.values()) last.set(keyOf(m), m);
    const list = [
      ...[...st.groups.values()].map((g) => ({
        key: `group:${g.group_id}`, kind: 'group', id: g.group_id, name: g.group_name,
        members: [...g.members.values()].filter((m) => m.user_id !== selfId).map(({ user_id, nickname: n, card }) => ({ user_id, nickname: n, card }))
      })),
      ...[...st.friends.values()].map((f) => ({ key: `private:${f.user_id}`, kind: 'private', id: f.user_id, name: f.nickname })),
    ];
    for (const c of list) {
      const m = last.get(c.key);
      c.last = m ? { time: m.time, text: toPlainText(m.message), self: m.self, sender: m.sender.card || m.sender.nickname } : null;
    }
    return list.sort((a, b) => (b.last?.time ?? 0) - (a.last?.time ?? 0) || a.key.localeCompare(b.key));
  }

  function messagesOf(key, limit = 200) {
    parseKey(key);
    const list = [...st.messages.values()].filter((m) => keyOf(m) === key);
    return list.slice(-Math.min(1000, Math.max(1, Number(limit) || 200))).map(uiView);
  }

  /** 新建会话（群或私聊好友）。群号 / QQ 号不能是机器人自己。 */
  function createConversation({ key, name } = {}) {
    const { kind, id } = parseKey(key);
    if (id === selfId) throw new ActionError(1400, '不能和机器人自己建会话');
    if (kind === 'group') ensureGroup(id, name);
    else ensureFriend(id, name);
    return conversations().find((c) => c.key === `${kind}:${id}`);
  }

  function image(file) {
    const base64 = st.images.get(String(file));
    return base64 ? { base64, ext: path.extname(String(file)).toLowerCase() } : null;
  }

  function heartbeat(interval) {
    return { time: ts(), self_id: selfId, post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online: st.online, good: st.good }, interval };
  }

  function lifecycle() {
    return { time: ts(), self_id: selfId, post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect' };
  }

  function setStatus({ online, good } = {}) {
    if (typeof online === 'boolean') st.online = online;
    if (typeof good === 'boolean') st.good = good;
    return { online: st.online, good: st.good };
  }

  return {
    selfId, nickname,
    call, injectMessage, injectPoke, setStatus, heartbeat, lifecycle, ensureGroup, ensureFriend,
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    onTimeline(fn) { timeline.add(fn); return () => timeline.delete(fn); },
    conversations, messagesOf, createConversation, image,
    out(since = 0) { return st.out.filter((e) => e.seq > since); },
    calls(since = 0) { return st.calls.filter((e) => e.seq > since); },
    status() { return { online: st.online, good: st.good, groups: st.groups.size, friends: st.friends.size, messages: st.messages.size }; },
  };
}
