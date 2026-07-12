# netHub

轻量、可恢复的 DOI PDF 批量下载 CLI。后台运行，遇到验证码时才弹出浏览器，并支持多个下载源自动切换。

A lightweight, resilient CLI for batch-downloading DOI PDFs. It stays in the background, opens a browser only when verification is required, and automatically falls back between download sources.

[中文](#中文) · [English](#english)

> 请只下载你有权访问的资料，并遵守下载源的服务条款及当地法律。
>
> Download only material you are authorized to access, and follow the source service's terms and applicable law.

## 中文

### 功能特点

- 默认使用无头 Chromium 在后台下载。
- 检测到 CAPTCHA 或浏览器验证时，自动弹出一个可见窗口；完成验证后继续后台任务。
- 自适应使用 2–4 个并发页面：默认从 3 个开始，稳定时升到 4 个，遇到限流、验证或导航超时降到 2 个。
- 支持多个下载源，当前源异常时自动尝试下一个。
- 支持命令行 DOI、DOI URL、TXT、CSV 和混合文本输入。
- 可指定下载目录，自动跳过已有 PDF，也可以强制覆盖。
- 写入 JSON 结果摘要和失败 DOI 清单，方便继续处理。
- 内置 `nethub update` 在线升级。
- 未配置下载源时自动从标准 `https://doi.org` 解析 DOI。
- 自动识别主页面或网络响应中已经打开的 PDF，无需额外人工确认。
- 明确显示“论文尚未收录/数据库中不可用”的页面会立即标记为来源缺失，不触发人工确认。
- 多个 PDF 候选会按可信度逐个验证，某个链接返回 HTML 时继续尝试下一个。
- 需要人工确认的 DOI 会先挂起，不占用后台下载 worker；普通任务完成后再串行处理。
- 进度条原地刷新；失败或人工队列消息会先清除进度行并独占一整行，避免日志粘连。
- 只有明确的 CAPTCHA、机器人验证或登录表单才触发人工窗口；普通无 PDF 页面直接判定来源缺失。

### 环境要求

- Node.js 20 或更高版本
- 可以访问 GitHub
- 一个或多个你有权使用、并能通过 DOI 页面提供 PDF 链接的下载源

### 安装

```sh
npm install --global github:iihciyekub/nethub
npx playwright install chromium
```

确认安装：

```sh
nethub --help
```

### 配置下载源（可选）

不创建配置也可以直接使用，netHub 会默认从 `https://doi.org` 解析 DOI。需要指定备用源、下载目录或并发数时，再创建配置文件。配置查找顺序为 `--config`、`NETHUB_CONFIG`、当前目录的 `nethub.config.json`、`~/.config/nethub/config.json`：

复制示例配置到当前工作目录：

```sh
cp nethub.config.example.json nethub.config.json
```

希望所有目录共用一份配置时，可以放在全局位置：

```sh
mkdir -p ~/.config/nethub
cp nethub.config.example.json ~/.config/nethub/config.json
```

也可以指定现有文件：

```sh
export NETHUB_CONFIG=/absolute/path/to/nethub.config.json
```

编辑 `nethub.config.json`：

```json
{
  "downloadDir": "./downloads",
  "concurrency": 4,
  "retries": 0,
  "timeout": 8000,
  "linkTimeout": 2500,
  "downloadTimeout": 60000,
  "sources": [
    { "name": "primary", "baseUrl": "https://service-a.example" },
    { "name": "backup", "baseUrl": "https://service-b.example" }
  ]
}
```

下载源按照配置顺序尝试。可用 `"enabled": false` 暂时停用某个源，或用 `--source backup` 将指定源临时移到第一位。旧版单个 `baseUrl` 配置仍然兼容。

### 使用

```sh
# 下载一个或多个 DOI
nethub download "10.1000/example" "10.1000/another"

# 从文件中提取 DOI
nethub download --input dois.txt --input records.csv

# 指定目录和并发数
nethub download --download-dir ~/Downloads/papers --concurrency 4 10.1000/example

# 临时使用单个下载源
nethub download --base-url https://service.example 10.1000/example

# 优先使用某个已配置的源，失败后仍会自动使用其他源
nethub download --source backup --input dois.txt

# 默认使用分阶段自适应等待，不额外重试
nethub download --json "10.1000/example"
```

通常不需要 `--show`。netHub 会保持后台运行；只有明确检测到 CAPTCHA、机器人验证或登录表单时，才将任务移入独立人工队列。普通 HTML 页面没有 PDF、数据库明确未收录、或者候选链接全部不是 PDF 时，会直接标记当前源失败，不打扰用户。真正需要人工处理的任务会在普通队列完成后逐个弹窗；完成验证后，netHub 会持续检测整个验证窗口中的所有标签页、PDF 响应和 PDF Viewer，并自动继续后台下载，无需回到终端。即使原验证标签仍然打开，只要新标签已经出现 PDF 也会自动识别。也可以随时按 Enter 手动继续。验证状态以及窗口中已打开的 PDF 会同步回后台。

```sh
nethub download --show --profile-dir ~/.nethub-profile 10.1000/example
```

DOI 中包含括号、星号等 shell 特殊字符时，请始终加引号，例如：

```sh
nethub download --show "10.1016/S0022-4073(02)00352-7"
```

### 升级

```sh
# 只检查新版本
nethub update --check

# 安装最新 GitHub Release
nethub update
```

`--check` 只检查最新 GitHub Release，不修改本机。`nethub update` 会把新版本安装到当前正在运行的 `nethub` 所属全局目录；即使系统同时存在多套 Node/npm，也不会再出现提示更新成功、终端却继续执行旧版本的情况。

### 输出文件

下载目录中除了 PDF，还会生成：

- `download-results.json`：请求、结果、实际下载源、失败原因和有效配置。
- `failed-dois.txt`：每行一个失败 DOI，便于重新下载。

默认使用分阶段自适应等待：网页导航最多 8 秒，动态 PDF 链接最多额外探测 2.5 秒；一旦链接出现就立即继续。确认 PDF 链接后，文件传输最多允许 60 秒，避免慢速网络把可下载文献误判为失败。每个下载源仍只尝试一次，明确的页面不存在、找不到 PDF 链接或返回内容不是 PDF 时不会重复尝试；所有来源均失败后，JSON 结果使用 `"status": "source_not_found"`。只有暂时性问题才允许通过 `--retries 1` 再试，额外重试轮数最多为 2。批量任务只在单行进度中显示人工队列数量 `Manual N`，不会为每个待验证 DOI 重复刷屏；最后一个任务完成后会关闭浏览器、释放终端输入并立即退出。

## English

### Highlights

- Runs headless Chromium in the background by default.
- Opens one visible window only when a CAPTCHA or browser challenge is detected, then returns to background downloading.
- Adapts between 2 and 4 pages: starts at 3, rises to 4 after stable successes, and drops to 2 under rate limits, verification, or navigation timeouts.
- Automatically tries the next configured source when the current source fails.
- Accepts DOI arguments, DOI URLs, TXT, CSV, and mixed-text input files.
- Supports a custom output directory, existing-file skipping, and forced replacement.
- Produces a JSON run summary and a retry-friendly failed DOI list.
- Includes self-update commands through `nethub update`.
- Resolves through standard `https://doi.org` when no source is configured.
- Detects PDFs already opened as the main page or observed in network responses without unnecessary manual confirmation.
- Treats explicit paper-unavailable/database-missing pages as source misses immediately without manual review.
- Validates multiple PDF candidates in score order instead of failing on the first HTML response.
- Defers manual-review DOI values without consuming background workers, then handles them serially after the normal queue.
- Keeps progress on one refreshable row while failure and manual-queue messages print as separate full lines.
- Opens manual review only for positive CAPTCHA, robot-check, or login evidence; ordinary no-PDF pages fail without prompting.

### Requirements

- Node.js 20 or newer
- GitHub access
- One or more authorized services that expose a PDF link from a DOI page

### Install

```sh
npm install --global github:iihciyekub/nethub
npx playwright install chromium
nethub --help
```

### Configure sources (optional)

netHub works without a config file by resolving through `https://doi.org`. Config lookup order is `--config`, `NETHUB_CONFIG`, `./nethub.config.json`, then `~/.config/nethub/config.json`. To add fallback services or persistent defaults, copy `nethub.config.example.json` to `nethub.config.json`, then edit the ordered source list:

```json
{
  "downloadDir": "./downloads",
  "concurrency": 4,
  "retries": 0,
  "timeout": 8000,
  "linkTimeout": 2500,
  "downloadTimeout": 60000,
  "sources": [
    { "name": "primary", "baseUrl": "https://service-a.example" },
    { "name": "backup", "baseUrl": "https://service-b.example" }
  ]
}
```

Sources are tried in order. Set `"enabled": false` to keep a source configured but inactive. Use `--source backup` to try a named source first while retaining the remaining fallbacks. The legacy single `baseUrl` setting remains supported.

### Usage

```sh
nethub download "10.1000/example" "10.1000/another"
nethub download --input dois.txt --input records.csv
nethub download --download-dir ~/Downloads/papers --concurrency 4 10.1000/example
nethub download --base-url https://service.example 10.1000/example
nethub download --source backup --input dois.txt
nethub download --json "10.1000/example"
```

The browser remains hidden unless positive CAPTCHA, robot-check, or login evidence requires manual review. Ordinary HTML pages with no PDF, explicit database misses, and exhausted non-PDF candidates fail without prompting. Genuine manual tasks are parked without consuming workers, then handled one at a time after the normal queue. After verification, netHub monitors every tab, PDF response, and PDF viewer in the verification window and continues automatically—even if the original challenge tab remains open while the PDF opens elsewhere. Pressing Enter remains available as a manual fallback. Browser state and any opened PDF are passed back before completion.

Always quote a DOI containing shell metacharacters such as parentheses or asterisks:

```sh
nethub download --show "10.1016/S0022-4073(02)00352-7"
```

### Update

```sh
nethub update --check
nethub update
```

`--check` reports the latest GitHub Release without changing the installation. `nethub update` installs that tagged release through npm into the same global prefix as the currently running `nethub`, so systems with multiple Node/npm installations do not report a successful update while continuing to execute an older copy.

### Output

- `download-results.json` contains requested values, per-item status, selected source, errors, and effective settings.
- `failed-dois.txt` contains one failed DOI per line for easy retries.

The default mode uses staged adaptive limits: up to 8 seconds for page navigation and 2.5 seconds for a dynamically inserted PDF link, continuing immediately as soon as the link exists. Once a PDF link is confirmed, file transfer may take up to 60 seconds so a slow network does not turn an available document into a false failure. Each source is still attempted once. Definitive missing-page, missing-link, and non-PDF failures are not retried; exhausted results use `"status": "source_not_found"`. Extra retry rounds remain opt-in and capped at 2. Batch mode reports deferred verification only as `Manual N` in the single progress row instead of printing one queue message per DOI. After the final item it closes browsers, releases terminal input, and exits immediately.

## Development

```sh
npm install
npx playwright install chromium
npm test
npm run check
```

Tests use local fixtures and do not contact a real download source.

## License

[MIT](LICENSE)
