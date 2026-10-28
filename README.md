# billybot

A small desktop agent harness built with Tauri, React and TypeScript. Pick a workspace folder, chat with a model through [OpenRouter](https://openrouter.ai), and let it list, read, edit and write files and run commands in your projects, under permission rules you control.

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

- macOS 11+, Windows 10/11 or Linux (see platform notes below)
- [Node.js](https://nodejs.org) and npm
- [Rust](https://rustup.rs) and the [Tauri prerequisites](https://tauri.app/start/prerequisites/)
- An [OpenRouter API key](https://openrouter.ai/keys)

## Run it

```bash
npm install
npm run tauri dev
```

On first launch, paste your OpenRouter API key. It is stored in your system's credential store (macOS Keychain, Windows Credential Manager, or the Linux Secret Service), never in the repo or on disk in plain text.

To build a release bundle:

```bash
npm run tauri build
```

## Dictation (optional)

Speech-to-text runs locally with [whisper.cpp](https://github.com/ggml-org/whisper.cpp). Download `ggml-base.en.bin` from [ggerganov/whisper.cpp on Hugging Face](https://huggingface.co/ggerganov/whisper.cpp) and place it in the app's `models` folder:

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/uk.billymcdowell.billybot/models/ggml-base.en.bin` |
| Windows | `%APPDATA%\uk.billymcdowell.billybot\models\ggml-base.en.bin` |
| Linux | `~/.local/share/uk.billymcdowell.billybot/models/ggml-base.en.bin` |

Change the model by editing `MODEL_FILE` in `src-tauri/src/stt.rs`.

## Platform notes

- **Shell tool:** commands run in zsh on macOS, bash (or `sh`) on Linux, and Windows PowerShell on Windows. The model is told which on Windows.
- **API key storage:** on Linux this needs a running Secret Service provider (GNOME Keyring or KWallet). Without one the app shows an error instead of saving the key.
- **Dictation:** macOS uses Metal; Windows and Linux run whisper.cpp on the CPU. On Windows, allow microphone access for desktop apps in Settings > Privacy & security > Microphone. On Linux, WebKitGTK needs the GStreamer plugins (`gst-plugins-good` and `gst-plugins-bad`) to record audio.
- **Linux builds** need `libwebkit2gtk-4.1`; releases are built on Ubuntu 22.04, so very old distributions may not run them.
- **Release CPU baseline:** Linux and Windows releases are built with `GGML_NATIVE=OFF` so they run on any CPU with AVX2 (about 2013 or newer). A local `cargo build` optimises for your own CPU.
- Installers are unsigned, so Windows SmartScreen and macOS Gatekeeper will warn on first launch.

## Security notes

This app lets a language model read and write files and run shell commands on your machine. Review permission prompts before approving them, and only open projects you are comfortable giving the model access to. The app's webview runs with a restrictive Content Security Policy that only allows network access to `openrouter.ai`.

## Project layout

- `src/` – React UI and the agent loop (`agent.ts`, `permissions.ts`, `instructions.ts`)
- `src-tauri/src/` – Rust commands for file access, shell, credential storage and Whisper

## License

[MIT](LICENSE)
