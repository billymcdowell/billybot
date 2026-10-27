# billybot

A small macOS desktop agent harness built with Tauri, React and TypeScript. Pick a workspace folder, chat with a model through [OpenRouter](https://openrouter.ai), and let it list, read, edit and write files and run commands in your projects, under permission rules you control.

## Features

- **Agent loop in the app.** Send the conversation to the model; if it calls a tool, check permission, run it, append the result and repeat until it answers in plain text.
- **Any tool-capable OpenRouter model**, chosen from a searchable list.
- **Project-scoped tools:** `list_dir`, `read_file`, `write_file`, `edit_file` and `run_command`, implemented in Rust and confined to the open project folder. Commands can be cancelled.
- **Workspace and subagents:** the agent can list, open, create and close projects inside one workspace folder and delegate tasks to subagents.
- **Permissions and diffs:** file changes are shown as diffs and need your approval according to your settings.
- **Project instructions:** each open project's `CLAUDE.md` is loaded into the agent's instructions.
- **Context meter** with a per-category usage breakdown.
- **Markdown replies** (links open externally, images are blocked).
- **Local dictation** with Whisper (optional, see below).
- **UI** built with shadcn/ui.

## Requirements

- macOS (Keychain is used for the API key; dictation uses Metal)
- [Node.js](https://nodejs.org) and npm
- [Rust](https://rustup.rs) and the [Tauri prerequisites](https://tauri.app/start/prerequisites/)
- An [OpenRouter API key](https://openrouter.ai/keys)

## Run it

```bash
npm install
npm run tauri dev
```

On first launch, paste your OpenRouter API key. It is stored in the macOS Keychain, never in the repo or on disk in plain text.

To build a release bundle:

```bash
npm run tauri build
```

## Dictation (optional)

Speech-to-text runs locally with [whisper.cpp](https://github.com/ggml-org/whisper.cpp). Download `ggml-base.en.bin` from [ggerganov/whisper.cpp on Hugging Face](https://huggingface.co/ggerganov/whisper.cpp) and place it at:

```
~/Library/Application Support/uk.billymcdowell.billybot/models/ggml-base.en.bin
```

Change the model by editing `MODEL_FILE` in `src-tauri/src/stt.rs`.

## Security notes

This app lets a language model read and write files and run shell commands on your machine. Review permission prompts before approving them, and only open projects you are comfortable giving the model access to. The app's webview runs with a restrictive Content Security Policy that only allows network access to `openrouter.ai`.

## Project layout

- `src/` – React UI and the agent loop (`agent.ts`, `permissions.ts`, `instructions.ts`)
- `src-tauri/src/` – Rust commands for file access, shell, Keychain and Whisper

## License

[MIT](LICENSE)
