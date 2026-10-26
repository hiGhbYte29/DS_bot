# SnowLuma 外部组件

本文为 AI 辅助整理的连接说明。本目录不包含 SnowLuma 本体、配置、QQ 登录数据、二进制文件、镜像、下载脚本或自动部署脚本。

请从 [SnowLuma 官方 GitHub 仓库](https://github.com/SnowLuma/SnowLuma) 阅读官方说明、许可与使用要求，并通过 [官方 Releases](https://github.com/SnowLuma/SnowLuma/releases) 自行选择、安装和启动适合系统的版本。本项目不重新分发 SnowLuma，也不替使用者接受其协议。

连接流程：

1. 在本机启动 QQ 并完成登录。
2. 按 SnowLuma 官方说明独立启动它，在其进程面板选择本机 QQ 主进程，手动点击“加载”。需要的系统权限按官方说明配置。
3. 在 SnowLuma 中配置 OneBot HTTP 和正向 WebSocket，限定本机回环监听并启用鉴权。常见示例地址为 `http://127.0.0.1:3000` 与 `ws://127.0.0.1:3001`，以实际设置为准。
4. 在私有的 `qq-bridge/config.json` 中，将 HTTP 地址填入 `snowluma.httpUrl`、WebSocket 地址填入 `snowluma.wsUrl`，将 HTTP 令牌填入 `snowluma.accessToken`。HTTP 与 WebSocket 令牌不同时，将 `snowluma.homeDir` 设为 SnowLuma 的数据目录，该目录下应包含 `config/onebot_*.json`，供桥接自动发现 WebSocket 令牌；配置没有单独的 WebSocket 令牌字段，不要把它填入 HTTP 令牌位置。只开放需要的 QQ 私聊或群白名单。
5. 启动 DSH 与 qq-bridge，运行 `node ops/status.mjs` 检查连接，再自行测试消息链路。

SnowLuma 面板和 bot 控制台是不同服务。QQ 进程重启后，旧进程上的加载状态不会自动迁移，需重新检查并手动加载。此公开示例只提供连接方式，不保证第三方 QQ 版本和 SnowLuma 版本之间始终兼容。
