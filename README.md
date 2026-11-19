# Termix ADB plugin

An Android `adb shell` tab for [Termix](https://github.com/Termix-SSH/Termix), as a plugin. The stock Docker image is enough: Termix speaks the ADB protocol itself over TCP, with RSA authentication, `shell_v2` with a PTY and live resize, and a fallback to the old shell for devices without `shell_v2`.

See [docs/index.md](docs/index.md) for device setup and use.

## Compatibility

This is a plugin API 2 plugin (`engine.api` `^2.0.0`) and needs Termix 26.11.2 or newer. Its backend runs in a separate plugin process (`network:sockets`) and its terminal in a sandboxed frame. For Termix 26.11.1 and older, use plugin 1.0.0 (API 1).

## Install

1. In Termix, open Settings, General and turn on Plugin developer mode.
2. Open Plugins, Install from file, and pick `adb-<version>.tmxplug` (see Build below).
3. Open a host, turn on ADB, set the device IP and the ADB port, and connect.

The plugin is stored with the rest of the Termix data, so keep the data volume of your Compose file and it survives image updates.

If you use the desktop app linked to a server, it mirrors the server's plugins. Raise the plugin version for every new build and restart the desktop app, otherwise it can keep running the older copy with the same version.

## Build (Windows)

You need Node.js 22.12 or newer.

- `build.bat` runs the whole pipeline: install dependencies, typecheck, tests, build, validate, pack. It stops at the first failure and makes no package until the problem is fixed. The result is `adb-<version>.tmxplug` in the project folder.
- `set-version.bat` asks for a new plugin version (and, if you want, `engine.termix` and `engine.api`). An empty answer keeps the current value. It writes the version into `manifest.json`, `package.json`, `package-lock.json` and the file name in this README, and adds an empty section to `CHANGELOG.md`. Replace its `TODO` line before building: `validate` requires a changelog entry for the manifest version.

The version in `manifest.json` is the one Termix shows. Keep the newest `CHANGELOG.md` section equal to it.

## Build (any system)

```bash
npm install --legacy-peer-deps
npm run typecheck
npm test           # protocol tests against a fake adbd, route tests, terminal and frame tests
npm run build
npm run validate
npm run pack       # writes adb-<version>.tmxplug
node scripts/set-version.mjs 1.0.2   # what set-version.bat runs
```

`--legacy-peer-deps` is needed because the SDK lists its peers loosely. The plugin SDK must be version 2 or newer: the frame and sandbox tests do not exist in SDK 1.

## Layout

| Path | What it is |
| --- | --- |
| `manifest.json` | Id, version, capabilities, settings, tab and protocol |
| `authz.json` | The route table for the plugin's WebSocket, checked by Termix's authz tests |
| `src/backend/adb-protocol.ts` | The ADB wire protocol and shell client |
| `src/backend/adb-key.ts` | The RSA key and Android public key encoding |
| `src/backend/index.ts` | The `/shell` WebSocket route, access checks, status port, session count |
| `src/frontend/` | The terminal tab and the plugin registration |
| `locales/` | Texts |
| `tests/` | Backend tests against a fake device, frontend and frame tests |
| `scripts/set-version.mjs` | Used by `set-version.bat` |
