# chat-demo

[English](README.en.md) | 简体中文

基于 DeepSeek API 的静态聊天示例。无需应用后端，浏览器直接请求配置的 API 服务。

点击 [在线体验](https://ttgml.github.io/chat-demo/) 即可使用，也可以前往 [Releases](https://github.com/ttgml/chat-demo/releases) 下载压缩包，解压后双击 `index.html` 在本地使用，无需安装或构建。首次使用时，请在设置中填写 API Key。

## 运行

准备 Node.js 22.12+ 和 pnpm：

```sh
git clone https://github.com/ttgml/chat-demo.git
cd chat-demo
pnpm install
pnpm dev
```

打开 http://localhost:8090 。

生成静态产物：

```sh
pnpm build
```

产物位于 `dist/`，可部署到静态服务器，也可直接打开 `dist/index.html`。直接打开时，浏览器和 API 服务需允许 `file://` 页面的存储与跨域请求。

## 功能

- 多会话、自动标题、置顶、重命名与删除；编辑提问、重新生成和切换消息分支。
- 侧边栏搜索对话历史，匹配标题与正文，点击结果直接打开对话。
- 流式回答、深度思考、智能搜索、链接阅读与来源引用；支持停止和符合条件的继续生成。
- 附件上传、粘贴与拖拽，语音输入和回复朗读；移动端录音时输入框首行显示实时频谱。
- Markdown、代码高亮、KaTeX 公式和 Mermaid 图表。
- 简体中文与英文、浅色与深色主题、移动端布局、位置设置、历史导入导出。

## 数据

- **存储**：API Key 与设置存在 localStorage，会话和附件原件存在 IndexedDB，按浏览器用户配置和站点源（origin）隔离。发送消息、上传附件或使用语音时，相应内容会提交给配置的 API 服务。
- **导入导出**：ZIP 格式。导入校验通过后会替换全部本地会话和附件，建议先导出备份；导出含会话和本地图片原件，不含 API Key、设置和非图片附件原件。格式见[历史导入导出](src/services/chat/history/README.md)。
- **删除**：设置 → 数据管理 → 删除所有对话 会清空本地会话、附件原件和草稿，并停止正在生成的回复，但保留 API Key 与设置，也不影响已上传到 API 服务的文件。已登录云同步时删除会同步到服务器；未登录时只清本地，下次登录会从服务器拉回，单独删除的会话也遵循同一规则。

### 云同步（可选）

在 设置 → 云同步 填入服务地址和账号密码，即可跨设备同步会话与图片原件，数据按账号隔离。不启用时应用完全离线可用；启用后其它设备的写入会通过 WebSocket 实时推送，长连接不可用（旧版服务端或代理未放行）时自动退回定时同步，设置页会显示原因。

同步服务可自部署或使用托管实例，两者是同一份代码，排查步骤见 [sync-server](sync-server/README.md)。同步使用无损原生格式，与上面的 ZIP 导入导出互不影响。只保存登录 token，不保存密码；使用 HTTP 地址时密码和对话内容会明文传输，公网部署请启用 HTTPS。

## 开发

| 命令          | 用途                |
| ------------- | ------------------- |
| `pnpm dev`    | 启动开发服务器      |
| `pnpm build`  | 构建到 `dist/`      |
| `pnpm type`   | TypeScript 类型检查 |
| `pnpm lint`   | oxlint 检查         |
| `pnpm format` | oxfmt 格式化        |

[rspack.config.ts](rspack.config.ts) 默认连接 `https://api.deepseek.com`。`createConfig({ apiOrigin, devServer })` 支持自定义 API 地址和开发服务器代理。

聊天默认使用 `deepseek-flash`，通过 Anthropic 兼容的 Messages / Files API 通信；语音使用 ASR / TTS 接口。请求使用搜索、链接阅读、标题和 `latest_reminder` 等扩展，接入服务需支持相应能力。附件实际支持的格式以服务端校验为准。

```text
src/
  app/                 应用布局、主题与全局样式
  components/          聊天、设置、Markdown 等界面组件
  i18n/                中英文文案
  services/
    api/               API 请求、SSE 与协议类型
    chat/              会话、消息分支、本地存储与历史导入导出
    markdown/          Markdown 解析、代码高亮与图表
    speech/            录音与朗读
  utils/               通用工具
```

## 许可证

[MIT](LICENSE)。构建会将许可证复制到 `dist/LICENSE`，分发时请一并保留；第三方依赖遵循各自的许可证。
