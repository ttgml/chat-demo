# chat-demo

English | [简体中文](README.md)

A static chat demo powered by the DeepSeek API. No application backend is required: the browser connects directly to the configured API service.

You can [try the app online](https://ttgml.github.io/chat-demo/) or download the archive from [Releases](https://github.com/ttgml/chat-demo/releases), extract it, and double-click `index.html` to use it locally without installation or a build. Enter your API key in Settings before your first chat.

## Getting started

Install Node.js 22.12+ and pnpm, then run:

```sh
git clone https://github.com/ttgml/chat-demo.git
cd chat-demo
pnpm install
pnpm dev
```

Open http://localhost:8090.

To build the static site:

```sh
pnpm build
```

The output is written to `dist/`. Deploy it to a static web server or open `dist/index.html` directly. Opening the file directly requires browser support for storage on `file://` pages and an API service that permits their cross-origin requests.

## Features

- Multiple conversations with automatic titles, pinning, renaming, duplication, and deletion; edit prompts, regenerate replies, switch between message branches, and delete any exchange of a prompt and its reply (undoable for 5 seconds).
- Search chat history from the sidebar by title or content, and open a result directly.
- Streaming replies, deep thinking, smart search, link reading, and source citations; stop generation or continue eligible replies.
- Upload, paste, or drag and drop attachments; use voice input and read replies aloud. A live audio spectrum appears in the first row of the input area while recording on mobile.
- Markdown, syntax highlighting, KaTeX math, and Mermaid diagrams.
- Simplified Chinese and English, light and dark themes, mobile layouts, location settings, and chat history import and export.

## Data and storage

- **Storage**: the API key and settings live in localStorage; conversations and original attachments live in IndexedDB, isolated by browser profile and site origin. Sending messages, uploading attachments, or using speech features sends the relevant content to the configured API service.
- **Import / export**: ZIP archives. Importing replaces all local conversations and attachments once validation passes, so export a backup first; exports include conversations and locally available original images, but no API keys, settings, or original non-image attachments. See the [history import/export documentation (Chinese)](src/services/chat/history/README.md) for the archive format.
- **Deleting**: Settings → Data → Delete all chats clears local conversations, original attachments, and unsent drafts, and stops ongoing replies, but keeps your API key and settings and leaves files already uploaded to the API service untouched. Signed in to cloud sync, the deletion also syncs to the server; signed out, it only resets local state and the next sign-in pulls the data back — the same applies to deleting a single conversation.
- **Deleting one exchange**: messages are deleted by exchange — clicking either the prompt or its reply removes both, along with the prompt's other versions and the conversations that follow those versions; what followed the deleted reply (including its hidden versions) attaches to the previous message, so the exchange disappears from both the thread and later requests. An undo bar sits above the input for 5 seconds (undo restores only what was deleted, never overwriting anything sent meanwhile); after that, local attachment originals that no message or conversation references are cleaned up. Deleting only edits conversation content, so cloud sync treats it as an ordinary conversation update.

### Cloud sync (optional)

Settings → Cloud sync takes a server address and a username/password to sync conversations and original images across devices, isolated per account. Without it the app stays fully local; once enabled, writes from other devices arrive over WebSocket, and if a long-lived connection is unavailable (older server, or a proxy blocking upgrades) the settings page shows why and the app falls back to scheduled sync.

Self-host the sync server or use a hosted instance — both run the same code; see [sync-server](sync-server/README.md) for troubleshooting. Sync uses the lossless native format and is independent of the ZIP import/export above. Only the login token is stored, never the password; with an HTTP address, passwords and conversations travel in plaintext, so enable HTTPS for public deployments.

## Development

| Command       | Description                  |
| ------------- | ---------------------------- |
| `pnpm dev`    | Start the development server |
| `pnpm build`  | Build into `dist/`           |
| `pnpm type`   | Run TypeScript type checks   |
| `pnpm lint`   | Lint with oxlint             |
| `pnpm format` | Format with oxfmt            |

[rspack.config.ts](rspack.config.ts) uses `https://api.deepseek.com` by default. Use `createConfig({ apiOrigin, devServer })` to customize the API origin and development server proxy.

Chat uses `deepseek-flash` by default through Anthropic-compatible Messages / Files APIs. Speech features use ASR / TTS endpoints. Requests include extensions for search, link reading, titles, and `latest_reminder`, so the configured service must support the corresponding capabilities. Supported attachment formats are determined by server-side validation.

```text
src/
  app/                 Application layout, themes, and global styles
  components/          Chat, settings, Markdown, and other UI components
  i18n/                English and Chinese translations
  services/
    api/               API requests, SSE, and protocol types
    chat/              Conversations, message branches, storage, and history import/export
    markdown/          Markdown parsing, syntax highlighting, and diagrams
    speech/            Audio recording and read-aloud playback
  utils/               Shared utilities
```

## License

[MIT](LICENSE). The build copies the license to `dist/LICENSE`; include it when distributing the app. Third-party dependencies are subject to their own licenses.
