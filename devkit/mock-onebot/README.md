# mock-onebot：虚拟 QQ 网关

开发用。在本机顶替 SnowLuma，让桥接不接真实 QQ 号也能跑通「消息进来 → 唤醒 → 模型 → 工具发送 → 消息出去」。

- **零依赖**，Node ≥ 22.13，不需要 `npm install`
- **与项目隔离**：不引用 `qq-bridge` 的任何代码；双方只通过 OneBot v11 协议和两个路由环境变量交互
- **不进生产**：生产部署只执行 `qq-bridge` 里的代码，不会运行这里的任何东西
- 只监听本机，不做鉴权

## 快速开始

第一次用之前，先按 [testing.md §4.2](../../docs/Development/testing.md) 准备好测试 DSH（`~/.dsh-test`，端口 3180）和测试桥接的 `config.json`。**不要直接用日常的 `~/.dsh`**：它的 MCP 工具可能指向另一份代码，消息会被交给别的桥接。

下面的命令都在 `devkit/mock-onebot/` 下执行，DSH 和桥接各占一个终端。

**① 虚拟网关**（后台运行）

```bash
node chain.mjs up          # HTTP 3010 / WS 3011
```

**② 测试 DSH**（MCP 工具是 DSH 拉起的子进程，变量必须设在 DSH 上，否则工具仍会连 `config.json` 里的网关）

```bash
DSH_HOME=~/.dsh-test node chain.mjs exec -- dsh web --host 127.0.0.1 --port 3180 --no-open
```

最后一行打印的 `http://127.0.0.1:3180/?token=…` 是 DSH 网页的登录链接。

**③ 测试桥接**

```bash
DSH_HOME=~/.dsh-test node chain.mjs exec -- node ../../qq-bridge/src/bridge.js
```

桥接日志里应依次出现：

```
⚠️ OneBot 路由已被环境变量覆盖：WS ws://127.0.0.1:3011，HTTP http://127.0.0.1:3010 …
SnowLuma 已连接：ws://127.0.0.1:3011
机器人昵称: 测试机器人
DSH 已就绪（模式: reserved2）
```

**模拟聊天：用浏览器**

打开 <http://127.0.0.1:3010>（或 `node chain.mjs ui`），像聊天软件一样用：

- 左边是会话列表，「新会话」可以加群或私聊；底部能切换机器人账号的在线 / 收消息状态，或断开桥接测重连
- 群里可以切换「身份」扮演不同成员，勾「@机器人」最容易叫醒它
- 鼠标移到消息上点「回复」可以引用；图片可以点按钮选，也可以直接粘贴
- 机器人的回复实时出现，等待时会显示「正在思考…」

页面只能从本机打开；别的网站不能借你的浏览器往虚拟网关发消息（控制接口校验 Host / Origin，只收 JSON）。

**模拟聊天：用命令行**

```bash
node chain.mjs send group:999001 "@一下你" --at-self      # 群里有人 @ 机器人
node chain.mjs send private:20001 "你好"                  # 私聊
node chain.mjs out -f                                     # 持续看机器人回了什么
```

用完：`Ctrl+C` 停掉 DSH 和桥接，`node chain.mjs down` 停虚拟网关。之后**不带** `exec` 正常启动，就回到真实 QQ。

## 桥接配置要求

路由变量只替换网关地址，桥接的其余配置仍读 `qq-bridge/config.json`。白名单里要有虚拟网关用到的号码，否则消息进来也不会唤醒：

```json
"allow": { "private": ["20001"], "groups": ["999001"] }
```

默认号码：机器人 `10001`，预置群 `999001`，`send` 不指定 `--user` 时发送者是 `20001`。

**数据在哪**：桥接的会话、记忆、表情库写进它所在那份代码的 `qq-bridge/state/`，DSH 的会话写进 `~/.dsh-test`。日常 DSH（`~/.dsh`）不受影响。

## 命令

| 命令 | 作用 |
| --- | --- |
| `up [选项]` | 后台启动。选项：`--http-port` `--ws-port` `--self-id` `--nickname` `--group 群号:群名`（可重复）`--heartbeat-ms` |
| `down` / `status` / `logs [-f]` | 停止 / 状态 / 日志（日志在 `.run/mock.log`） |
| `ui` | 在浏览器里打开聊天界面 |
| `env` | 打印路由变量，可 `eval "$(node chain.mjs env)"` |
| `exec -- <命令>` | 带上路由变量运行命令 |
| `send <目标> <文本>` | 模拟收到消息。`--user` `--nick` `--card` `--at-self` `--at <QQ>` `--reply <消息ID>` `--image <路径\|sample>` |
| `poke <目标>` | 模拟拍一拍（默认拍机器人）。`--user` `--target` |
| `set-status --online/--good true\|false` | 改账号状态并立即推送心跳，用来测桥接的健康告警 |
| `drop [--close]` | 断开桥接的 WS（默认模拟崩溃），用来测自动重连 |
| `out [-f] [--since N]` | 机器人发出的消息 |
| `calls [--unhandled]` | 桥接调用过的动作；`--unhandled` 只看虚拟网关还没实现的 |

目标格式：`group:<群号>` 或 `private:<QQ号>`。

## 行为说明

- **WS**（3011）：连上先推 `lifecycle`，之后每 30 秒推心跳；也接受带 `echo` 的动作调用（SDK 的 `getLoginInfo`、`sendGroupMessage` 等走这条）。
- **HTTP**（3010）：`POST`/`GET /<动作名>`。桥接直发消息、MCP 工具都走这条。往 HTTP 端口发 WS 握手会得到 426，和 SnowLuma 一样。
- **已实现的动作**：登录信息、状态、群/成员/好友列表、收发消息、`get_msg`、消息历史、`get_image`、拍一拍、表情相关（返回空）等，见 [lib/gateway.mjs](lib/gateway.mjs) 的 `actions`。
- **未实现的动作**返回 `{status:'ok', retcode:0, data:[]}`，并在 `calls` 里标出来。看到新的未实现动作，说明桥接用到了新接口，按需补上。
- 机器人往一个虚拟网关不认识的群发消息会失败（retcode 1400），和真实 QQ 不在群里时一样。群会在第一次 `send` 时自动创建。
- 状态只在内存里，重启虚拟网关就清空。

## 控制接口（脚本化用）

`chain.mjs` 就是这些接口的封装，都在 HTTP 端口上：

| 接口 | 说明 |
| --- | --- |
| `POST /__mock/send` | `{key, text, userId?, nickname?, card?, atSelf?, at?, replyTo?, image?}` → `{message_id, delivered}` |
| `POST /__mock/poke` | `{key, userId?, target?}` |
| `POST /__mock/status` | `{online?, good?}` |
| `POST /__mock/drop` | `{mode: 'terminate' \| 'close'}` |
| `GET /__mock/out?since=N` | 机器人发出的消息 |
| `GET /__mock/wait-out?since=N&timeout=ms` | 长轮询：有新消息立刻返回 |
| `GET /__mock/calls?since=N` | 动作调用记录 |
| `GET /__mock/health` | 运行状态 |
| `GET /__mock/conversations` · `POST` 同路径 | 会话列表 / 新建会话 `{key, name?}` |
| `GET /__mock/messages?key=` | 某个会话的消息（双向） |
| `GET /__mock/stream` | SSE 实时推送：`message` `poke` `recall` `status` `conversation` |
| `GET /__mock/image/<文件名>` | 注入的图片 |

控制接口的 `POST` 必须带 `content-type: application/json`。

## 自测

```bash
npm test
```
