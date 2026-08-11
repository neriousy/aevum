# Aevum

Aevum is a local voice-to-text app for Windows. Hold a global shortcut, speak, and release it to insert the transcription into the app you are using.

Transcription runs locally with NVIDIA Parakeet TDT 0.6B V3 by default, with SenseVoiceSmall Q8 available as an optional CJK model. Audio stays on the computer. A selected model is downloaded once and kept ready while Aevum is running.

## Features

- Global hold-to-talk and hands-free shortcuts
- Automatic insertion into the active Windows app
- Native Parakeet TDT 0.6B V3 with automatic support for 25 European languages
- Automatic language detection on every recording, including language changes separated by natural pauses
- Optional SenseVoiceSmall Q8 for Chinese, Cantonese, Japanese, Korean, and English
- Native CPU engines that work without a dedicated GPU and stay loaded between transcriptions
- English, Polish, and Simplified Chinese interface translations
- Local transcript history and configurable cleanup
- System tray and optional launch-at-login behavior
- Signed in-app updates from public GitHub Releases

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
npm run prepare:runtime
npm run tauri -- dev
```

Run all local checks:

```powershell
npm run check
cargo check --locked --manifest-path src-tauri/Cargo.toml
```

Build both Windows installers and their signed update artifacts. The updater signing key is
stored outside the repository and must be provided through the environment:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw "C:\path\to\aevum.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "your-key-password"
npm run bundle
```

The packages are written to `src-tauri/target/release/bundle/nsis` and `src-tauri/target/release/bundle/msi`.

## Releases

Keep the version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` in sync. `npm run check:version` verifies this automatically.

Push a matching tag such as `v0.1.4` to build the NSIS and MSI packages in GitHub Actions. The workflow publishes the signed installers, signatures, and `latest.json` used by Aevum's updater.

Release installers are unsigned until an Authenticode certificate is configured. Windows may show an unknown-publisher warning for unsigned builds.

## Privacy

Recordings are processed in the app and are not uploaded to a transcription service. Model archives are downloaded from Handy's public model mirror, verified with pinned SHA-256 checksums, and stored in Aevum's application-data folder. Completely quitting Aevum unloads the active model; hiding it to the tray keeps it available in memory.

## Credits and license

Aevum is an independent Windows adaptation inspired by [Handy](https://github.com/cjpais/Handy) and based on ideas from [Hex by Kit Langton](https://github.com/kitlangton/hex). It is not affiliated with those projects.

Parakeet TDT 0.6B V3 is provided by NVIDIA under CC BY 4.0. SenseVoiceSmall is provided by FunAudioLLM under Apache 2.0.

Licensed under the [MIT License](LICENSE). See the license file for original and adaptation copyright notices, and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for major model and runtime attributions.
