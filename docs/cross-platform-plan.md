# Plan: support Linux and Windows

billybot is macOS-only today. The release workflow (`.github/workflows/release.yml`) builds just the two Mac targets, because the app depends on macOS in several places. This plan lists what to change, in the order to do it, so that tagged releases also ship Linux and Windows installers.

## What is macOS-specific today

| Area | Where | Problem on Linux / Windows |
|---|---|---|
| Whisper GPU backend | `src-tauri/Cargo.toml`: `whisper-rs = { features = ["metal"] }` | `metal` is on for every platform. CMake looks for Apple's Foundation framework and fails (this is the Linux CI error). |
| Shell tool | `src-tauri/src/lib.rs`: `const SHELL = "/bin/zsh"`, args `-l -c` | No zsh on Windows, and not guaranteed on Linux. |
| Process groups | `lib.rs`: `use std::os::unix::process::CommandExt`, `.process_group(0)`, `libc::killpg(pid, SIGKILL)` | Doesn't compile on Windows. These keep a cancelled or timed-out command from leaving children running. |
| API key storage | `lib.rs` (`keyring::Entry`), comments and README say "macOS Keychain" | `keyring` v4 needs a platform store crate. Only `apple-native-keyring-store` is in use now. |
| Symlink test | `lib.rs` tests: `std::os::unix::fs::symlink` | Doesn't compile on Windows. |
| Path safety | `project_root()` and the read/write helpers in `lib.rs` | Must keep keeping the model inside the workspace with Windows paths: backslashes, drive letters, UNC, `\\?\` after canonicalize, case-insensitivity. |
| Dictation | `src/dictation.ts` (`MediaRecorder`, tries `audio/mp4` then `audio/webm`, decodes with `AudioContext`) | WebView2 (Windows) and WebKitGTK (Linux) support different codecs and microphone permission flows. Needs testing. |
| Mic permission | `src-tauri/Info.plist` | macOS only; fine, but Windows and Linux have no equivalent file. |
| CPU flags | whisper.cpp CMake default `-march=native` (seen in the Linux CI log) | A binary built on a CI runner can crash with "illegal instruction" on older CPUs. Release builds need a portable CPU baseline. |
| Docs and UI copy | `README.md`, strings that mention Keychain or macOS, `src-tauri/src/lib.rs` comments | Say macOS only. |

## Steps (in order)

1. **Whisper features per platform.** Move `metal` to a macOS-only dependency table:
   `[target.'cfg(target_os = "macos")'.dependencies] whisper-rs = { version = "0.16", features = ["metal"] }`, and keep a plain `whisper-rs = "0.16"` for the rest. Confirm `cargo check` still works on macOS. Keep `build.rs`'s Clang runtime link macOS-only (it already is).
2. **Portable CPU build for whisper.cpp.** Find out how to turn off `GGML_NATIVE` through `whisper-rs-sys` 0.15 (it uses the `cmake` crate; check `build.rs` for which env vars or defines it forwards). Apply it for Linux and Windows release builds. Don't assume. Verify in the CI log that `-march=native` is gone.
3. **Cross-platform shell.** Replace `SHELL` and the `-l -c` call with a small function that picks, per OS:
   - Unix: the user's `$SHELL` if it exists, else `/bin/sh`, run as a login shell with `-l -c`. macOS should keep behaving as it does now.
   - Windows: PowerShell (or `cmd /C`). Decide, then update the tool description the model sees so it knows which shell syntax to use. Search the TS side and tool definitions for mentions of zsh or Unix assumptions.
4. **Cross-platform process cleanup.** Gate the Unix code with `#[cfg(unix)]`. Add a Windows equivalent that kills the whole process tree, either a Job Object (preferred, `windows-sys`) or `taskkill /T /F /PID`. Keep the existing behaviour: kill leftovers after a normal exit, on timeout and on cancel, and never wait forever on an output pipe held open by a child.
5. **Key storage.** Check how `keyring` 4 selects a store (the platform store crates and `set_default_store` or similar). Use `apple-native-keyring-store` on macOS, the Windows native store on Windows, and a Secret Service or keyutils store on Linux. Handle the Linux case where no keyring daemon is running with a clear error message in the app, not a crash. Update comments and README wording.
6. **Path handling on Windows.** Read every place that checks "is this path inside the workspace" and make sure it still holds with backslashes, `\\?\` prefixes from `canonicalize`, drive letters, and case-insensitive names. Add tests that run on all OSes where possible.
7. **Tests.** Gate the symlink test with `#[cfg(unix)]` and add a Windows-appropriate version, or skip it with a comment. Add a CI workflow (`.github/workflows/ci.yml`) that runs `cargo test` and `npm run build` on macOS, Ubuntu and Windows for pull requests and pushes to `main`. This is the main way to verify Windows and Linux without those machines.
8. **Dictation.** In `src/dictation.ts`, make the recorder pick a MIME type each webview supports and make sure `decodeAudioData` can decode it. Test microphone permission behaviour on WebView2 and WebKitGTK as far as CI and docs allow, and list anything that could not be verified.
9. **Release workflow.** Add back to `.github/workflows/release.yml`:
   - `ubuntu-22.04` with `sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf cmake libclang-dev` plus whatever the Linux key store needs (for example `libdbus-1-dev`).
   - `windows-latest` (MSVC; LLVM is preinstalled for bindgen, confirm).
   - Keep `MACOSX_DEPLOYMENT_TARGET: "11.0"` and the macOS targets.
10. **Docs and copy.** Update `README.md` (platform support, model location per OS, where the key is stored) and any UI strings that say macOS or Keychain.

## Known risks

- Windows and Linux can't be run locally here. Verification is the new CI workflow plus a draft release from a test tag.
- Windows and Linux builds of `whisper-rs-sys` may need extra tools (CMake, libclang). Fix from the CI log, not by guessing.
- Linux installers rely on the system WebKitGTK; users on older distros may not be able to run them.
- Builds stay unsigned on all platforms (Windows SmartScreen and macOS Gatekeeper warnings). Signing is out of scope.
- Don't weaken the approval prompt or the workspace-escape checks while porting. Those are the app's safety boundary.

## Done when

- `cargo test` and `npm run build` pass on macOS, Ubuntu and Windows in CI.
- Pushing a `v*` tag produces a draft release with `.dmg` (Apple Silicon and Intel), Windows `.msi`/`.exe`, and Linux `.deb`/`.AppImage`.
- macOS behaviour is unchanged.

---

## Prompt to kick off the agent

Copy everything below into a new session.

```text
Work in the billybot repo (Tauri 2 + React desktop AI agent harness, Rust backend in src-tauri/src/lib.rs and stt.rs, frontend in src/). It currently only builds and runs on macOS. I want it to build, pass tests and ship installers for Linux and Windows as well, without changing macOS behaviour.

Read docs/cross-platform-plan.md first. It lists every macOS-specific part of the code and a 10-step plan. Follow it, but verify each claim in the code yourself before changing things, and tell me where the plan is wrong.

Context:
- .github/workflows/release.yml builds only the two Mac targets right now. It builds on a pushed v* tag and makes a draft GitHub release with tauri-apps/tauri-action. Linux and Windows jobs were removed because of two real failures: whisper-rs has the `metal` feature enabled on every platform (CMake can't find Apple's Foundation framework), and lib.rs uses Unix-only APIs (std::os::unix process_group, libc::killpg, a /bin/zsh shell, a unix symlink test).
- src-tauri/build.rs links Clang's runtime on macOS for a Metal linker issue. Keep that macOS-only.
- The identifier is uk.billymcdowell.billybot and the macOS minimum is 11.0. Don't change either.

Rules:
- macOS behaviour must stay the same. Run `cargo test` in src-tauri and `npm run build` after each step on this Mac.
- I can't run Windows or Linux locally, so add .github/workflows/ci.yml (cargo test and npm run build on macOS, Ubuntu, Windows) and treat that as the verification. Push nothing; commit locally on a new branch in small commits, one per plan step, and tell me what to push.
- Don't weaken the shell tool's approval flow or the workspace-escape checks (project_root, the symlink handling). Port them carefully, with tests.
- Don't guess how whisper-rs-sys 0.15 or keyring 4 work. Read their source in ~/.cargo/registry or their docs. In particular find out how to disable GGML_NATIVE for release builds and how keyring 4 selects a per-platform store.
- Don't add signing or auto-update. Keep scope to what the plan says.

When done, report: what changed per step, what you verified locally, what can only be verified by CI or a test tag, and any risk left over (for example dictation codecs on WebKitGTK and WebView2).
```
