# Aevum

Aevum is a private, local voice-to-text app for Windows. Hold a global shortcut, speak, and release it to insert the transcription into the app you are using.

Transcription runs locally with Whisper models through Transformers.js. Audio stays on the computer. A selected model is downloaded once from Hugging Face, cached locally, and kept ready while Aevum is running.

## Features

- Global hold-to-talk and hands-free shortcuts
- Automatic insertion into the active Windows app
- Whisper Tiny, Base, and Small model choices
- Automatic GPU acceleration with explicit GPU and CPU choices
- Windows-language default plus common spoken-language presets
- Local transcript history and configurable cleanup
- System tray and optional launch-at-login behavior

## Install

Release builds provide two 64-bit Windows packages:

- `Aevum_*_x64-setup.exe` — recommended, installs for the current user without administrator access
- `Aevum_*_x64_en-US.msi` — useful for managed Windows deployment

The installer is intentionally small. It downloads Microsoft WebView2 only when it is missing. The first model download requires an internet connection; transcription works offline afterward.

## Develop

Requirements:

- Windows 10 or 11
- Node.js 22 or newer
- Rust stable with the MSVC toolchain
- Microsoft C++ Build Tools and Windows SDK

```powershell
npm ci
npm run tauri -- dev
```

Run all local checks:

```powershell
npm run check
cargo check --locked --manifest-path src-tauri/Cargo.toml
```

Build both Windows installers:

```powershell
npm run bundle
```

The packages are written to `src-tauri/target/release/bundle/nsis` and `src-tauri/target/release/bundle/msi`.

## Releases

Keep the version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` in sync. `npm run check:version` verifies this automatically.

Push a matching tag such as `v0.1.2` to build the NSIS and MSI packages in GitHub Actions. The workflow creates a draft GitHub release so its notes and installers can be reviewed before publication.

Release installers are unsigned until an Authenticode certificate is configured. Windows may show an unknown-publisher warning for unsigned builds.

## Privacy

Recordings are processed in the app and are not uploaded to a transcription service. Model files are fetched from Hugging Face and stored in the local WebView cache. Completely quitting Aevum unloads the model; hiding it to the tray keeps the current model available.

## Credits and license

Aevum is an independent Windows adaptation inspired by [Handy](https://github.com/cjpais/Handy) and based on ideas from [Hex by Kit Langton](https://github.com/kitlangton/hex). It is not affiliated with those projects.

Licensed under the [MIT License](LICENSE). See the license file for original and adaptation copyright notices.
