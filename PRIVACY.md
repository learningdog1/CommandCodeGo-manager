# Privacy Policy / 隐私政策

**Effective date / 生效日期:** 2026-11-03

CommandCodeGo Manager ("this app") is a local reverse-proxy desktop application
published at <https://github.com/learningdog1/CommandCodeGo-manager>. This policy
describes what data the app handles and where it goes.

## Summary

This app runs entirely on your machine. It contains **no telemetry, no
analytics, no crash reporting, no advertising, and no developer-operated
servers**. The developer does not collect, receive, or process any of your data.
The only network requests the app makes go to (1) the upstream subscription
endpoint that *you* configure, and (2) the public npm registry for an anonymous
version check.

## Data stored on your device

All configuration and usage data is stored locally, in the app's local data
directory (`config.json` and a SQLite database `data/ccp.db`). This includes:

- Your subscription/upstream API keys, used to sign proxied requests.
- Client key definitions you create (key names and masked identifiers).
- Request metadata for the dashboard and logs: timestamp, model, status code,
  token counts, and the key name/ID used. **Message contents (prompts and
  completions) and plaintext keys are never written to the database or logs.**
- Daily usage aggregates (token counts per model/key).

Uninstalling the app (or deleting its data directory) removes all of this data.
Nothing persists anywhere else.

## Network requests the app makes

The app makes requests to exactly two kinds of destinations:

1. **The upstream endpoint you configure** (default
   `https://api.commandcode.ai`). This is the core function of the app: your
   model requests (including their content) and your subscription credentials
   are forwarded to that provider, which handles them under its own privacy
   policy. The optional zero-data-retention mode (`CMD_ZDR=1` or per-request
   `x-cmd-zdr: 1`) additionally asks the provider not to retain request data.
2. **`https://registry.npmjs.org/command-code/latest`** — an anonymous,
   periodic `GET` to detect upstream protocol changes. No data is attached to
   this request beyond what any HTTP request inherently carries (e.g. your IP
   address to the registry).

No other outbound connections exist. There is no auto-updater; updates come
from GitHub Releases or your package manager (e.g. WinGet), which are subject
to their own services' policies.

## Web administration interface

The admin web UI is served by the app's local server, which binds to
`127.0.0.1` (localhost) by default, so it is reachable only from your machine.
If you deliberately reconfigure the bind host (e.g. for a Docker deployment),
you are responsible for controlling network access to it.

## Contact

Questions about this policy can be raised at
<https://github.com/learningdog1/CommandCodeGo-manager/issues>.

---

# 隐私政策（中文）

CommandCodeGo Manager（"本应用"）是一个纯本地运行的反向代理桌面应用，
源码仓库为 <https://github.com/learningdog1/CommandCodeGo-manager>。

## 概要

本应用完全运行在你的机器上，**不含遥测、统计、崩溃上报、广告，也没有
开发者运营的服务器**。开发者不收集、不接收、不处理你的任何数据。应用
仅向你配置的上游订阅端点和公共 npm 仓库（匿名版本检查）发起网络请求。

## 存储在本机的数据

所有配置与用量数据都保存在本地（`config.json` 与本地 SQLite 数据库
`data/ccp.db`），包括：

- 你填写的订阅/上游 API 密钥（用于代理请求签名）；
- 你创建的客户端密钥定义（名称与掩码标识）；
- 仪表盘与日志所用的请求元数据：时间、模型、状态码、token 数量、所用
  密钥名称/ID。**消息正文（提示词与回复内容）与明文密钥绝不落库、落日志**；
- 按模型/密钥汇总的每日用量。

卸载应用或删除数据目录即可清除全部数据，不会在其他地方留有任何残留。

## 应用发起的网络请求

仅以下两类：

1. **你配置的上游端点**（默认 `https://api.commandcode.ai`）。这是应用的
   核心功能：模型请求（含其内容）与订阅凭证会被转发至该服务商，由其按
   自身隐私政策处理。可选的零留存模式（`CMD_ZDR=1` 或按请求头
   `x-cmd-zdr: 1`）会额外要求服务商不留存请求数据。
2. **`https://registry.npmjs.org/command-code/latest`** —— 周期性的匿名
   `GET` 请求，用于检测上游协议变化。除任何 HTTP 请求天然携带的信息
   （如你的 IP 地址对注册表可见）外，不附加任何数据。

不存在其他出站连接。应用没有自动更新器；更新来自 GitHub Releases 或
你的包管理器（如 WinGet），受相应服务自身的政策约束。

## Web 管理界面

管理界面由应用的本地服务器提供，默认只监听 `127.0.0.1`（localhost），
仅本机可访问。若你主动修改监听地址（如 Docker 部署），网络访问控制
由你自行负责。

## 联系方式

关于本政策的问题请在
<https://github.com/learningdog1/CommandCodeGo-manager/issues> 提出。
