# 第三方项目与来源

> 本文件由 AI 辅助整理。许可适用范围以各上游项目的原始许可证为准。

## qq-bridge

- 上游：<https://github.com/Derpyu520/qq-bridge>
- 导入版本：`v0.2.1-r1`
- 基准提交：`a49877f4e58d04e47532d44b803360d0f001160d`
- 原始版权：Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors
- 许可：MIT，完整原始声明保留在 [qq-bridge/LICENSE](qq-bridge/LICENSE)。

`qq-bridge/` 是基于该版本当前源码整理的公开快照，不携带上游 Git 历史。
本仓库保留桥接代码中的 Unicode 安全截断与孤立代理项清理修改；去除实际部署配置、
事件标识和角色卡，并对示例、测试、公开文档做适配。不能把上游代码视为本仓库独立原创。

## 外部运行依赖

| 项目 | 官方 GitHub | 用途 |
| --- | --- | --- |
| DeepSeek Harness | <https://github.com/deepseek-ai/deepseek-harness> | 本地智能体运行时、模型接入、会话与 MCP |
| SnowLuma | <https://github.com/SnowLuma/SnowLuma> | 本机 QQ 接入和 OneBot 网关 |
| Node.js | <https://github.com/nodejs/node> | JavaScript 运行环境 |
| MCP TypeScript SDK | <https://github.com/modelcontextprotocol/typescript-sdk> | MCP 工具服务协议 |
| js-yaml | <https://github.com/nodeca/js-yaml> | YAML 配置解析 |
| Zod | <https://github.com/colinhacks/zod> | 工具参数和数据校验 |
| DeepSeek Schemastery | <https://github.com/deepseek-ai/deepseek-harness/tree/master/vendor/schemastery> | DSH 插件设置 schema |

这些依赖的代码和安装目录不随仓库打包。实际 npm 依赖及锁定版本见
[qq-bridge/package.json](qq-bridge/package.json) 和
[qq-bridge/package-lock.json](qq-bridge/package-lock.json)。

SnowLuma 本体及原生组件适用其自身许可，不因本仓库采用 MIT 而变为 MIT。
仓库不包含其程序、注入模块、第三方工具目录快照、安装包、Docker 镜像或账号数据；
需要使用者按官方说明独立取得和配置。`@snowluma/sdk`、`@snowluma/mcp` 仍作为 npm
依赖声明，使用前应核对其发布版本的许可。上游 `postinstall` 会对本机安装的 npm 包
做 ESM 导入扩展名修补，该行为与分发 SnowLuma 本体不同，详见上游 LICENSE 的说明。

本仓库的 MIT 许可覆盖新增集成代码和文档；第三方作品保留各自版权和许可。
