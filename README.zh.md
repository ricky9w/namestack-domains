# namestack-domains

[English](README.md) | 简体中文

通过 Cloudflare Registrar API 查询一个名字能否注册为域名、价格是多少。工具只做查询，不购买、注册、续费或转移域名。

一个命令同时服务两类用户，底层共用同一套查询逻辑：给人用的命令行工具，以及给 Agent 用的 MCP 服务器 `namestack-domains mcp`。

## 快速上手

### 安装

需要 Node.js 22.18 或更新版本。

```sh
npm install --global @namestack/domains            # 安装 namestack-domains 命令
npx -y @namestack/domains check --name=yourbrand   # 或者不安装直接运行
```

也可以从仓库克隆后自行构建安装：

```sh
bun install --frozen-lockfile
bun run build
npm pack
npm install --global ./namestack-domains-*.tgz
```

安装后的命令只需要 Node，不需要 Bun；Bun 仅用于构建。

### 认证

执行 `namestack-domains auth login`，按提示选择认证方式。凭据会保存下来，之后的命令不必再带参数。加上 `--method=oauth` 或 `--method=api-token` 可以跳过选择。

#### 方式 A：通过 OAuth 授权

工具内置了一个已注册的 Cloudflare OAuth client，不需要你先去创建。选择 OAuth 后在浏览器里完成授权即可。

工具会先打印授权 URL 再询问是否打开浏览器，所以浏览器起不来时复制这个地址照样能完成。授权页面上由你选择本次授权覆盖哪些账号。

请求三个 scope：`registrar-domains.read` 执行查询，`offline_access` 换取 refresh token 以便自动续期，`account-settings.read` 是可选项，仅用于列出你的账号供登录时选择——拒绝它也能用，只是需要手动输入账号 ID。

#### 方式 B：通过 API token 授权

在 [API Tokens 页面](https://dash.cloudflare.com/profile/api-tokens)选择 **Create Token → Create Custom Token**，授予 **Account → Registrar Domains → Read**，并限制到你要查询的账号。本工具的全部查询只需要 Read 权限。

执行 `auth login` 选择 API token 并粘贴。只授予 Registrar 权限的 token 无法列出账号，工具会请你输入 32 位账号 ID，它出现在 Cloudflare 控制台的地址栏里。若同时授予 **Account Settings → Read**，工具就能列出账号供你选择。

#### 凭据存放位置

| 路径 | 内容 |
| --- | --- |
| `~/.config/namestack/domains/credentials.json` | 保存的 token 或 OAuth 凭据，文件权限 `0600`，内容未加密。 |
| `~/.config/namestack/domains/config.json` | 可选的非密默认值：`accountId`、`clientId`、`scopes`、`redirectUri`。 |

`XDG_CONFIG_HOME` 整体移动这棵目录树，`NAMESTACK_CONFIG_DIR` 替换 `namestack` 这一层，`NAMESTACK_DOMAINS_CONFIG_DIR` 直接指定本工具的绝对路径。

环境变量 `CLOUDFLARE_API_TOKEN` 优先于保存的凭据，适合 CI 使用；`CLOUDFLARE_ACCOUNT_ID` 用于指定账号；不设置时，环境变量中的 token 沿用已保存登录的账号。`auth logout` 删除本地凭据，OAuth 凭据会同时请求 Cloudflare 吊销，API token 则需要你自行到控制台删除。

### 开始使用

先确认配置可用，再查询名字：

```sh
namestack-domains doctor --online
namestack-domains check --name=yourbrand
```

`doctor --online` 通过查询 `example.com` 验证线上访问权限，不加 `--online` 时只报告本地配置。`check --name=yourbrand` 会用 12 个默认后缀检查这个名字：`com`、`io`、`ai`、`app`、`dev`、`co`、`net`、`shop`、`store`、`online`、`site`、`info`。用 `--extensions=` 可以自选后缀；无论多少个都合并成一次请求发出。域名不可注册属于正常结果，不代表执行失败。

如果要在 Claude Code 或其他 MCP 宿主中查询，请看 [MCP 服务器](#mcp-服务器)。

## 命令参考

先写完整命令路径，再写参数。每条命令都支持 `--help`。

| 命令 | 作用 | 用法 |
| --- | --- | --- |
| `check` | 向注册局实时查询确切的域名。 | `--domains=brand.com,brand.dev`，或 `--name=brand --extensions=com,co.uk`。 |
| `search` | 基于 Cloudflare 的缓存数据推荐名字。 | `--query="coffee studio" --limit=10`，再用 `check` 确认候选。 |
| `extensions` | 列出一页 API 支持的域名后缀。 | `--limit=50`，把返回的 cursor 填入 `--cursor="NEXT"` 继续。 |
| `doctor` | 报告本地认证状态，加 `--online` 验证线上访问。 | 查询出问题时先跑它。 |
| `auth login` | 保存 API token 或 OAuth 凭据。 | 需要交互式终端，`--method=` 可跳过方式选择。 |
| `auth status` | 显示凭据来源、认证方式和存放路径，不显示任何秘密。 | 纯本地检查，不发起网络请求。 |
| `auth logout` | 删除保存的凭据，OAuth 凭据同时请求吊销。 | 加 `--local` 跳过吊销。 |
| `schema` | 打印全部输入和结果的 JSON Schema。 | 不需要凭据。 |
| `mcp` | 通过 stdio 向 MCP 宿主提供查询工具。 | 由宿主启动，详见 [MCP 服务器](#mcp-服务器)。 |

`check` 要求 `--domains` 和 `--name` 二选一，最多 100 个域名，且 `--extensions` 只能与 `--name` 搭配。`search` 接受 1–100 个字符，`--limit` 范围 1–50。`extensions` 的 `--limit` 范围 1–50，最后一页返回 `cursor: null`。

### 通用参数与默认值

| 参数 | 作用 |
| --- | --- |
| `--account-id=ID` | 指定账号，登录时可据此跳过账号选择。 |
| `--format=auto\|json\|human` | `auto` 在 stdout 为终端且非 CI 时输出人类可读结果，其余情况输出 JSON。只有 `schema` 始终输出 JSON。 |
| `--no-input` | 禁用交互和浏览器登录。查询命令本身从不主动发起登录。 |
| `--quiet`、`--no-color` | 分别抑制进度显示和禁用颜色。非空的 `NO_COLOR` 与 `TERM=dumb` 同样禁用颜色。 |
| `--timeout=SECONDS` | 总期限，范围 1–600。查询默认 30 秒，登录默认 180 秒。 |
| `--env-file=PATH` | 为本次调用加载 dotenv 文件，已存在的环境变量优先。 |

退出码：`0` 表示成功，包括域名不可注册的情况；`1` 表示操作失败；`2` 表示参数或配置用法错误；`124` 表示超时；`130` 和 `143` 表示被中断。

## 解读结果

- `registrable: true` 表示 Cloudflare 认为该域名可注册。搜索结果仍需用 `check` 实时确认。
- `registrable: false` 要结合 `reason` 理解，它区分已被注册、premium 价位、不支持的后缀和注册局限制。
- `registrable: null` 表示本次查询没有得出结论，请查看该条记录的 `error`。部分失败会保留其余结果并返回 `PARTIAL_FAILURE`。
- `pricing` 给出币种、首年价格和每年续费价格，金额是十进制字符串。没有价格不等于免费。
- 每条结果都带有 `operation`、`source`、`checkedAt`、`count`、`cursor` 和 `truncated`；`authoritative` 和 `cache` 区分实时查询与缓存建议。

可注册性只是查询那一刻的快照，既不预留域名，也不代表通过商标查重。

## 配合 AI Agent 和脚本使用

### 脚本

数据类命令只向 stdout 写入一条以换行结尾的结果，诊断信息走 stderr：

```json
{"schemaVersion":1,"ok":true,"data":{}}
{"schemaVersion":1,"ok":false,"error":{"code":"AUTH_REQUIRED","message":"No saved credentials were found.","retryable":false}}
```

脚本调用时请显式选择 JSON 并禁用交互：

```sh
namestack-domains check --name=yourbrand --format=json --no-input
namestack-domains schema --format=json
```

JSON 模式下不会出现 spinner，也不会启动浏览器登录；缺少凭据会立即失败而不是弹出提示。

### Agent skill

随包提供的 [skill](skills/namestack-domains/SKILL.md) 指导 Agent 通过 CLI 控制查询范围并解读结果。请先安装 CLI；skill 既不会安装可执行文件，也不会代为认证。

### MCP 服务器

`namestack-domains mcp` 通过 stdio 向 MCP 宿主提供查询工具。进程由宿主启动和关闭，不需要你手动运行。

#### 在 Claude Code 中配置

1. 在终端里认证一次：执行 `namestack-domains auth login`，没有全局安装时执行 `npx -y @namestack/domains auth login`。也可以跳过这一步，改为直接传入 token，见[凭据](#凭据)。
2. 注册服务器。`--scope user` 让它在你的所有项目中可用：

   ```sh
   claude mcp add namestack-domains --scope user -- namestack-domains mcp
   ```

3. 运行 `claude mcp list`，确认显示 `✔ Connected`。在会话中执行 `/mcp` 可以看到三个工具。用 `/permissions` 添加规则 `mcp__namestack-domains`，即可一次放行这三个工具，不再逐次确认。

其他宿主在各自的 JSON 配置中填写同样的命令。如果宿主找不到该命令，请改用 `command -v namestack-domains` 给出的绝对路径。

```json
{
  "mcpServers": {
    "namestack-domains": { "command": "namestack-domains", "args": ["mcp"] }
  }
}
```

#### 启动命令

| 命令 | 行为 |
| --- | --- |
| `namestack-domains mcp` | 运行全局安装的版本，启动时不访问 npm。升级请执行 `npm install --global @namestack/domains@latest`。 |
| `npx -y @namestack/domains mcp` | 无需安装，并会自动用上新版本，因为 npx 每次启动都会向 registry 校验。断网时 npx 会先重试约 70 秒才改用缓存，超过了 Claude Code 30 秒的启动时限。 |
| `npx -y --prefer-offline @namestack/domains mcp` | 跳过 registry 校验，断网也能启动，但不会检查新版本。 |

首次通过 npx 启动时需要下载包。第 1 步如果用 npx 完成认证，包已提前缓存；否则可以用 `MCP_TIMEOUT=60000 claude` 放宽启动时限。

#### 凭据

服务器在每次调用时按与 CLI 完全相同的规则解析凭据，从不弹出提示：先看 `CLOUDFLARE_API_TOKEN`，再看已保存的登录。OAuth 登录会自动续期；宿主运行期间完成的登录，从下一次调用起生效。

宿主不一定会把你的 shell 环境变量传给服务器，所以使用 token 时请显式传入，并同时提供账号 ID：

```sh
claude mcp add namestack-domains --scope user \
  -e CLOUDFLARE_API_TOKEN=<token> \
  -e CLOUDFLARE_ACCOUNT_ID=<account-id> \
  -- namestack-domains mcp
```

Claude Code 会把这些值以明文保存在 `~/.claude.json`，这条命令也会让 token 留在 shell 历史记录里。如果你移动过凭据目录，请用同样的方式传入 `XDG_CONFIG_HOME` 或 `NAMESTACK_DOMAINS_CONFIG_DIR`。

团队共享时，`--scope project` 会生成可提交到仓库的 `.mcp.json`。文件中不要写入 token，由每位成员在自己的机器上完成认证：

```json
{
  "mcpServers": {
    "namestack-domains": { "command": "npx", "args": ["-y", "@namestack/domains", "mcp"] }
  }
}
```

如果所有成员都使用 token，请在 `env` 块中用 `"${CLOUDFLARE_API_TOKEN}"` 和 `"${CLOUDFLARE_ACCOUNT_ID}"` 引用环境变量，而不是写入具体的值。

#### 工具

| 工具 | 输入 |
| --- | --- |
| `domains_check` | 接受 `domains`（1–100 个完整域名），或者 `name` 加可选的 `extensions`；省略 `extensions` 时使用[开始使用](#开始使用)中列出的 12 个默认后缀。 |
| `domains_search` | 接受 `query`，以及可选的 `extensions` 和 `limit`（1–50，默认 20）。推荐结果需要再用 `domains_check` 确认。 |
| `domains_extensions` | 接受可选的 `limit`（1–50，默认 50）和上一页返回的 `cursor`。 |

三个工具都标注为只读，并声明了严格的输入和输出 schema。结果以 `structuredContent` 返回[脚本](#脚本)一节所示的 envelope。操作失败时（包括缺少凭据）返回带同样 envelope 的 `isError`，服务器继续运行。

## 开发

```sh
bun install --frozen-lockfile
bun run dev -- check --name=example   # 从源码运行 CLI
bun run typecheck                     # tsc --noEmit
bun run lint                          # biome
bun run test                          # node:test
bun run build                         # tsdown，产出 dist/cli.mjs
```

目录按职责划分：`core/` 持有领域操作和结果契约，`providers/` 负责 Cloudflare 请求与响应归一化，`auth/` 负责凭据存储与解析，`cli/` 和 `mcp/` 只是把同一批 core 操作适配到各自的传输方式。终端输出、交互提示和进程退出不要写进 `core/`，上游返回格式的变化要收敛在 `providers/` 内部。

测试使用固定样本和模拟传输，不会真实访问 Cloudflare。

## 许可证

[MIT](LICENSE)
