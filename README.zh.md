# dsh-ccsub — 让 DSH 使用 Claude 订阅

[English](README.md) | 中文

注册一条 `LlmAdapter` 路由 **`claude-sub`**，通过官方浏览器 OAuth 流程取得
**Claude Pro/Max 订阅**，再用它向 Anthropic 发模型请求。附带一个设置卡片（显示订阅的
限额窗口）和一个 **出口守卫**，强制这条路由的每次请求都必须走代理。

## 仓库结构

项目分成两半，可以合用，也可以各自单独使用。

| 路径 | 是什么 | 怎么跑 |
|---|---|---|
| 仓库根目录 | **DSH 插件**。`lib/` 是 host 模块和浏览器卡片，`cordis.patch.yml` 是它的 bundle patch。 | 装进 DSH profile |
| [`claude-server/`](claude-server/) | **独立服务端**。持有 Claude 凭据并转发请求，让多台机器共用一个订阅，而它们都拿不到 token。 | 直接跑 Node ≥22，或用自带的 Dockerfile / compose |
| `lib/tunnel.js` | server 模式的客户端半边：把 Anthropic 的 host 改写为服务端地址，并附上通信密钥。 | 属于插件的一部分 |

两者互相独立：插件单靠自己在 `direct` 模式下就能工作；`claude-server` 单独也有用，
任何能出示 bearer 的客户端都能接。让插件连服务端，就是 `claude-server` 模式的用途，
见 [两种部署模式](#两种部署模式)。

## 功能

| 能力 | 实现方式 |
|---|---|
| 浏览器 OAuth（PKCE）登录 | pi-ai 的官方 Anthropic 流程，通过 `ctx.authorization` 驱动 |
| 自动刷新 token | pi-ai 的刷新逻辑，放在 `ctx.credentials.modifyRecord()` 里执行，使「读取—判断—写入」这跨越一次网络往返的过程处于**跨进程有效的锁**下 |
| 配额面板（5 小时 / 每周 + 重置倒计时） | `GET /api/oauth/usage`，同时支持新版 `limits` 数组和旧的 `five_hour`/`seven_day*` 形状 |
| 路由 + 模型目录 | pi-ai 真实的 Anthropic 目录，重新键到 `claude-sub` 上 |
| 出口保护 | 强制代理、可选的出口 IP 白名单、User-Agent 改写 |

## 服务依赖

硬依赖只有 `llm`（`export const inject = ['llm']`）。web server 和 authorization
服务是在 `apply` 里用嵌套 `ctx.inject(...)` 挂上的，因此：

- 在 **headless 或 TUI profile** 里，`claude-sub` 模型路由照样能用 —— 只是没有
  设置卡片，也没有浏览器登录；
- 缺失或挂载较晚的服务不会阻塞激活，各个回调会在对应服务出现后立即执行。

`/status` 的 `loginAvailable` 取自
`authorization.describe(key) !== undefined`，所以一个挂载了但从未收到我们流程的
authorization 服务会被读成**不可用**，而不是给出一个点了会报 `NO_FLOW` 的登录按钮。

## 为什么不复用 `anthropic` 路由，而要新开一条

`dsh-llm-pi-ai` 构造请求头时用的是 `requestHeaders(profile.headers)`，它把
`attributionHeaders()` **最后**合并进来，并过滤掉 profile 中与保留的 attribution
名大小写不敏感同名的头。于是共享的 `anthropic` 路由上，harness 的 User-Agent
永远胜出，订阅身份无法自洽。这个问题没法靠 profile 配置解决，而 `requestHeaders`
是模块私有的（未导出），所以继承 `PiAiAdapter` 也不行。新注册一条自己的路由才是解法。

## ⚠️ 有意偏离 adapter 契约

`LlmAdapter` 的文档写着：

> Every provider HTTP request must include `attributionHeaders()`; prove the
> headers are added in the wire request or library header hook.

**这条路由有意不这么做。** 订阅请求是以 Claude Code 客户端的身份认证的，其首个
system 块是 `You are Claude Code, Anthropic's official CLI for Claude.`。在同一个
请求里再带上 harness 的 attribution，两个身份就会互相矛盾 —— 而这正是本插件要
避免的情形。`lib/egress.js` 在真正发出前把 `user-agent` 改写为
`claude-cli/<version>`，所以线上的身份在设计上就是自洽的。

这是一个明确的、有记录的取舍，不是疏漏。

## 出口保护

三道保证，按优先级：

1. **代理是强制的。** 每次请求都走那唯一配置的代理。没有「回退到直连」的路径：
   代理缺失或不可达时 **请求失败**，而不是泄漏主机真实地址。配额探测同样如此，
   所以一次用量查询永远不会成为那个泄漏点。
2. **出口白名单可选，但一旦配置就强制执行。** `proxy.egressAllow` 非空时，观测到的
   出口 IP 必须匹配，否则拒绝请求。`proxy.requireEgressCheck: true` 还会在完全
   无法验证出口时直接拒绝。
3. **User-Agent 会被恢复**，时机是 socket 写入前一刻、在那个会覆盖它的头合并之下。

> **构造上就存在的注意点：** 登录的浏览器环节跑在*你的*浏览器里，用的是*它*的网络
> 设置。插件无法控制或验证这一跳。守卫覆盖的是插件自己发出的每一次请求。

### 代理必须真的能到 Anthropic

默认值是 `http://127.0.0.1:9077`，即 **Claude 专用**代理。这不是风格选择 ——
与 `9076` 上的通用代理实测对比：

| 目标 | 经 9076 | 经 9077 |
|---|---|---|
| `api.ipify.org`（出口探测） | 200 | 200 |
| `github.com` | 200 | — |
| `api.openai.com` | 401 | — |
| **`api.anthropic.com`** | **ECONNRESET** | 404（HTTP 层） |
| **`claude.ai`** | **ECONNRESET** | — |
| **`platform.claude.com`**（token） | **ECONNRESET** | 400（HTTP 层） |

9076 承载通用流量和出口探测都没问题，但对每一个 Anthropic 主机都会重置连接。
把这条路由指向它，会得到一个**看起来正常**的插件（`/egress` 报得出 IP，`/status`
列得出模型），但**没有任何请求能成功**。如果将来某套环境确实把 Anthropic 走通用
代理，那就改 `proxy.url`；守卫自己检测不到这种情况，因为重置发生在 HTTP 之下。

### 各类请求分别走哪条通道

| 请求 | 传输 | 是否受守卫 |
|---|---|---|
| 模型请求（`/v1/messages`） | 注入 pi-ai transport 的 `fetch` | 是 |
| 配额探测（`/api/oauth/usage`） | 直接 `guard.fetch` | 是 |
| OAuth token 交换与刷新 | pi-ai 自己的裸 `globalThis.fetch`，**仅对 token 端点**被重定向到守卫 | 是，通过 `guardTokenEndpoint()` |
| 浏览器授权页 | 你的浏览器，不是本进程 | **否 —— 管不到** |

第三行最微妙。pi-ai 的 `postJson` 调的是 `globalThis.fetch`，而 `Models.login` 和
`oauth.refresh` 都不接受 transport，所以 token 交换本来会跟着进程碰巧装的任意代理走，
同时跳过强制代理、白名单和身份改写。`guardTokenEndpoint()` 只给全局打**一次**补丁，
仅重定向 `platform.claude.com/v1/oauth/token`，进程内其他所有请求（包括别的插件的）
原样放行，并在销毁时还原。

## 两种部署模式

| | `direct`（默认） | `claude-server` |
|---|---|---|
| 凭据在哪 | 本进程 | ✗ —— 服务端持有 |
| 谁刷新 token | 本进程 | ✗ —— 服务端是唯一刷新者 |
| 与 Anthropic 通信 | ✓ 经强制代理 | ✗ —— 只与服务端通信 |
| 本进程持有的凭据 | 订阅 token | 服务端为这台机器签发的令牌 |
| proxy 配置 | 必需 | 不使用 |
| 配额探测 | 本地 | 由服务端提供 |

`claude-server` 模式的意义是：一台机器持有订阅，其他机器共用。token 永远不离开
服务端 —— 这点很重要，因为 Anthropic 每次刷新都会轮换 refresh token，两个刷新者
会互相作废。传输层是 `lib/tunnel.js`，它把 Anthropic 的 host 改写到服务端地址，
并附上 bearer。

该服务见 [`claude-server/`](claude-server/)：它是一个独立的 Node 程序，自带
Dockerfile 和 compose 文件。

## 配置

```yaml
mode: direct                     # 或：claude-server
claudeServer:                    # 仅当 mode 为 claude-server 时使用
  url: 'http://127.0.0.1:4710'   # 服务端地址
  bearerRecord: 'claude-server'  # 存放 bearer 的凭据记录名
proxy:
  url: 'http://127.0.0.1:9077'   # Claude 专用代理；实际使用中必需
  egressAllow: []                # 留空只关闭比对，不关闭代理
  requireEgressCheck: false
  egressUrl: 'https://api.ipify.org?format=json'
claudeCliVersion: '2.1.283'
refreshSkewMs: 300000
quotaPollMs: 180000
```

bearer 通过 harness 的凭据面存储为 `api-key` 记录，**不写在这份配置文件里**：
明文保存的 bearer 会被复制进每一次设置导出。

## 安装

### 一条命令（推荐）

每次推送到 `main` 都会自动发布。不需要 clone，也不需要本地打包：

```bash
dsh plugin --profile web add \
  https://github.com/wirsbf/dsh-ccsub/releases/latest/download/dsh-ccsub.tgz
```

这个 URL 里没有版本号，每次发布都会重新指向最新版，所以同一条命令也能用来升级。
用 agent 工具时 `target` 直接填这个 URL：

```
plugin_manager → install_bundle
  target = https://github.com/wirsbf/dsh-ccsub/releases/latest/download/dsh-ccsub.tgz
```

要锁定版本就从 release 页取带版本号的文件名：

```bash
dsh plugin --profile web add \
  https://github.com/wirsbf/dsh-ccsub/releases/download/v0.2.3/dsh-ccsub-0.2.3.tgz
```

每个 release 都带 `.sha256`，下载后可核对：`sha256sum -c dsh-ccsub.tgz.sha256`。

重启 host，然后在**设置 → Claude Subscription** 里只填三个字段（`claude-server` 模式
不需要代理，也不需要在本地持有订阅 token）：

| 字段 | 值 |
|---|---|
| Mode（模式） | `claude-server` |
| Server URL（服务器地址） | 部署的 origin，例如 `https://claude.example.com` |
| Client bearer（客户端 bearer） | 在服务端 Users（用户）页签发的令牌 |

先在服务端签发令牌：打开服务端控制台（`<server>/admin`），用管理令牌解锁，在
**Users（用户）** 页添加用户。令牌只在创建时显示一次。环境变量里的
`CLIENT_BEARER` 仍然可用，它是管理员引导凭据；但把管理令牌分发给每个客户端，
就失去了区分角色的意义。

这个模式下，粘贴 bearer 就是全部登录流程：没有浏览器 OAuth 那一步，因为授权
（grant）已经在服务器上，并由服务器负责刷新。粘贴之前先确认服务器就绪：
`GET <server>/healthz` 返回 `{"ok":true,"signedIn":true}` 即可。

两处最容易踩错的地方：

- **不要把配置文件改名复制到另一台机器。** bearer 是以 `api-key` 记录存在那台机器
  自己的凭证库里的，从不在 `cordis.patch.yml` 中，所以复制来的配置不携带任何凭据，
  路由会直接报 `NOT_CONFIGURED`。
- **选 `claude-server`，不是 `direct`。** `direct` 要求本机持有订阅 token 且代理可达；
  客户端机器两样都没有，同样会报 `NOT_CONFIGURED`，于是看起来像是代理块配错了，
  实际是模式选错了。

`claude-server` 模式下 `proxy` 块按设计不生效——Anthropic 看到的出口 IP 是服务器的，
本地再套一层代理不会改变任何可观测结果，只会多一个失败点。

### 服务端镜像

```bash
docker pull ghcr.io/wirsbf/dsh-ccsub-claude-server:latest
```

同时提供 `linux/amd64` 与 `linux/arm64`；固定版本就换成具体 tag。部署见
[`claude-server/`](claude-server/)。

### 从源码目录安装

通过 harness 的插件管理器安装**本包目录**（`plugin_manager` → `install_bundle`，
target 指向这个目录）。管理器负责 profile 的 `package.json` 和 bundle 列表，不要
手工改它们。

**本插件 import 的每一个包都是 peer 依赖。**它的 `dependencies` 是空的，这是刻意的。

这些包 harness 全都自带：`dsh-app-boot` 把从 dsh 清单可达的所有包——`@earendil-works/pi-ai`、
`undici`、`@deepseek-ai/schemastery`、`cordis`、`dsh-llm`、`dsh-llm-pi-ai`、
`dsh-credentials`——放进**安装作用域**，运行时解析器再把插件的裸 import 路由到这些副本上。
把它们写成普通依赖恰好会破坏这一点：pnpm 会在插件内部装一份**私有副本**，Node 在解析器
介入之前就命中了它，于是进程里出现两份同一个模块。

对 pi-ai 来说这不只是浪费，而是致命的。本插件用 `createProvider`/`anthropicProvider`
造出 provider 再交给 harness 的 `PiAiAdapter`，两边必须共享同一个类型契约实例。
插件私有 0.87.1 与 harness 的 1.4.0 并存时，模型请求会在流内部深处失败——这正是插件
在启动和 `/status` 上报 drift 的原因。

第二个影响出现在安装环节：pi-ai 0.87.x 依赖 `@google/genai`，后者又依赖 `protobufjs`，
两者都带构建脚本。pnpm 11 把未批准的构建脚本当作失败（`strict-dep-builds`），安装因此
返回非零码；而 `dsh plugin add` 只在退出码为 0 时才重新注册 bundle，结果就是包装上了、
但**没激活**。零依赖把这个失败模式整个消掉：安装只有一个包，`Packages: +1`，没有构建
脚本，退出码 0。

代价是插件无法自己钉住 pi-ai 版本，老版本 harness 就会提供老的 pi-ai。这一点由
`dependencyReport()` 兜住：它通过运行时解析器取出**实际被加载**的那一份，不满足
`dsh-llm-pi-ai` 要求时在 `/status` 上报 `compatible: false`。

## 发布与 CI/CD

推送到 `main` 就会自动发布，不需要本地打包，也不需要打 tag。GitHub Actions 做四件事：

| 阶段 | 内容 |
|---|---|
| test | 两套测试（插件 69 项 + 服务端 170 项），外加一次不推送的镜像构建 |
| version | 决定版本号；自动 patch 时把 bump 提交回 `main` 并打 tag |
| plugin | `npm pack` → GitHub Release（tarball + SHA256 + 无版本号别名） |
| image | 构建 `linux/amd64` + `linux/arm64` 镜像并推到 GHCR |

### 版本号规则

**patch 位自动递增，minor/major 由人决定。** 规则实现在
[`scripts/release-version.mjs`](scripts/release-version.mjs)：

| `package.json` 的版本 | 结果 |
|---|---|
| 等于最新 tag | 自动 +1（`0.2.3` → `0.2.4`） |
| 高于最新 tag | **按写的发布**（`0.3.0` 就发 `0.3.0`） |
| 低于最新 tag | 从 tag 继续 +1，并警告 |

所以升 minor 只需要改**根目录** `package.json` 的版本号然后推送，别的一律不动。
`claude-server/package.json` 的版本由 workflow 同步写入，不是第二个事实来源——
只改根目录那一份。

### 手动重跑

- 一次运行失败在 `plugin` 或 `image` 阶段：直接 **Re-run all jobs**。workflow 会在
  release commit 里写入 `Release-Run: <id>` 标记，重跑据此认出这已经是同一次发布，
  于是补齐产物而**不会**再发一个新版本。
- tag 存在但产物丢了：`workflow_dispatch` 填 `version` 显式指定，重新推送产物。

注意 `concurrency: release` 不取消进行中的运行：半推完的发布会留下 tag 与 manifest
不一致，这比排队慢更糟。

### 本地打包（仅调试用）

`npm pack` 仍是完整的发布构建：它按 `files` 挑文件，自动补上 `README*`、`LICENSE`
和 `package.json`，并生成 pnpm 需要的 `package/` 前缀。没有构建步骤、没有打包器——
`lib/` 按源码原样发布。

```bash
npm pack                      # → dsh-ccsub-<version>.tgz
sha256sum dsh-ccsub-<version>.tgz > SHA256SUMS
```

`private: true` 只挡 `npm publish`，**不挡** `npm pack`，所以留着这个标记照样能出
发布产物。留着它是防止误发布的安全阀——发布走的是 GitHub Release，不是 npm。

> 交付前先验证：`tar tzf <文件>.tgz | head` 必须只显示一个顶层 `package/` 目录。
> 没有这层前缀时 pnpm 会把文件摊平到安装根目录，`exports` 里的路径就全部 404。
> workflow 的 `Pack` 步骤对此显式检查，不依赖人工记忆。

安装后会作为不可变产物进入 profile 的 store（pnpm 指向 `.pnpm/` 的符号链接，而不是
链回这棵源码树），所以之后在源码目录里的改动不会漏进已安装的发行包。

安装健康的话会打印 `Packages: +1` 并以 0 退出。如果反而报
`[ERR_PNPM_IGNORED_BUILDS]` 并装了上百个包，说明你装的是 0.2.1 之前的构建——那个
构建会拉自己的 pi-ai，而它传递依赖的 `@google/genai`/`protobufjs` 构建脚本正是 pnpm
拒绝执行的东西。请用当前源码重新打包，不要用
`--config.strict-dep-builds=false` 绕过：这样能让 bundle 注册上，但重复的 pi-ai 还在，
请求时照样失败。

如果你是想在 link 目录里直接开发，看上面那节；那里的改动在下次 host 重启时生效。

## 配置接口

| 端点 | 用途 |
|---|---|
| `GET /plugins/dsh-ccsub/status` | 路由、凭据、代理、CLI 版本、模型列表 |
| `GET /plugins/dsh-ccsub/quota` | 限额窗口（需要已有凭据） |
| `GET /plugins/dsh-ccsub/egress` | 经代理实测的出口 IP |
| `POST /plugins/dsh-ccsub/login` | 开始浏览器登录；返回一个轮询视图 |
| `POST /plugins/dsh-ccsub/login/poll` | 取流程的下一条提示或问题 |
| `POST /plugins/dsh-ccsub/login/answer` | 回答流程提出的问题 |
| `POST /plugins/dsh-ccsub/login/cancel` | 取消进行中的登录 |
| `POST /plugins/dsh-ccsub/logout` | 删除已存储的凭据 |
| `POST /plugins/dsh-ccsub/server/bearer` | 写入或清除 claude-server 的通信密钥 |

服务端自己的控制台是一个独立的多页浏览器应用，使用自己的会话 cookie 认证：
页面有概览、账户、用户、用量、模型五页，JSON 接口在 `/admin/api/*` 下，
详见 [`claude-server/`](claude-server/)。它不属于本插件的 HTTP 接口，
插件的令牌打不开它。

## 目录结构

```
lib/
  index.js          host 插件：路由注册 + HTTP 接口
  adapter.js        claude-sub 的 LlmAdapter（PiAiAdapter + 受守卫的传输层）
  egress.js         强制代理守卫、白名单、UA 改写
  tunnel.js         claude-server 传输层：host 改写 + bearer
  auth/
    store.js        基于 ctx.credentials 的 CredentialStore + AuthContext
    claude.js       登录、锁内刷新、用量解析
    flow.js         ctx.authorization 流程（pi-ai 事件 → seam 词汇）
    bridge.js       设置卡片背后的 host 侧登录会话
  client/index.js   浏览器设置卡片

claude-server/      独立的订阅服务端（见它自己的 README）
  src/              身份、凭据、oauth、鉴权、净化、传输、转发、用量统计
  test/             104 项离线检查；不走网络
```

## 致谢

复用 [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai)
来做 Anthropic Messages 转换、订阅请求形状、官方 OAuth 流程和模型目录。用量端点
的响应形状是对照 `dsh-plugin-subscriptions` 核过的。
