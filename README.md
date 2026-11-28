# Termix ADB plugin

An Android `adb shell` tab for [Termix](https://github.com/Termix-SSH/Termix), as a plugin. The stock Docker image is enough: Termix speaks the ADB protocol itself over TCP, with RSA authentication, `shell_v2` with a PTY and live resize, and a fallback to the old shell for devices without `shell_v2`.

Android 11+ devices with Wireless debugging are supported too (pairing by code, then ADB over TLS).

The plugin also has a file manager for the device ("ADB Files"), built on the ADB sync protocol: browse, upload and download files and folders (folders as a streamed `.zip`), edit text files, change permissions, copy and move, search, install APKs, and reboot or power off the device. See [docs/index.md](docs/index.md) for device setup and use.

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

- `build.bat` runs the whole pipeline: install dependencies with `npm ci` (it never rewrites `package-lock.json`), typecheck, tests, build, validate, pack. It stops at the first failure and makes no package until the problem is fixed. The result is `adb-<version>.tmxplug` in the project folder.
- `set-version.bat` asks for a new plugin version (and, if you want, `engine.termix` and `engine.api`). An empty answer keeps the current value. It writes the version into `manifest.json`, `package.json`, `package-lock.json` and the file name in this README, and adds an empty section to `CHANGELOG.md`. Replace its `TODO` line before building: `validate` requires a changelog entry for the manifest version.

The version in `manifest.json` is the one Termix shows. Keep the newest `CHANGELOG.md` section equal to it.

## Build (any system)

```bash
npm install
npm run typecheck
npm test           # protocol tests against a fake adbd, route tests, terminal and frame tests
npm run build
npm run validate
npm run pack       # writes adb-<version>.tmxplug
node scripts/set-version.mjs 1.0.2   # what set-version.bat runs
```

The plugin SDK must be version 2 or newer: the frame and sandbox tests do not exist in SDK 1. CI installs with `npm ci`, so keep `package-lock.json` in sync with `package.json` (run `npm install` after changing a dependency and commit the lock).

## Release and the community registry

The repository follows the Termix plugin template: `.github/workflows/release.yml` and `ci.yml` call the shared Termix-Registry workflows. Run the Release workflow from a `dev-X.Y.Z` branch (stable) or as a beta. It publishes `adb-<version>.tmxplug` as a GitHub release and prints the version and `sha256` in the run summary. That `sha256` is the one to submit to the community registry (a pull request to Termix-SSH/Termix-Registry adding `community/plugins/adb.json`).

`build.bat` also prints the SHA-256 of the file it packed and writes it next to the package as `adb-<version>.tmxplug.sha256`. Use it to check a local build, not for the registry: the registry checks the file the workflow built.

## Layout

| Path                                                            | What it is                                                                  |
| --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `manifest.json`                                                 | Id, version, capabilities, settings, tab and protocol                       |
| `authz.json`                                                    | The route table for the plugin's WebSocket, checked by Termix's authz tests |
| `src/backend/adb-codec.ts`, `adb-connection.ts`, `adb-shell.ts` | The ADB wire protocol, the connection (RSA auth, TLS) and the shell client  |
| `src/backend/pairing.ts`, `spake2.ts`, `x509.ts`                | Wireless debugging pairing (SPAKE2) and its certificate                     |
| `src/backend/adb-sync.ts`                                       | The sync service: list, stat, pull, push and shell commands for files       |
| `src/backend/files-route.ts`                                    | The `/files` WebSocket route and the one time download link                 |
| `src/backend/zip-stream.ts`                                     | Streaming ZIP writer for folder downloads                                   |
| `src/backend/adb-key.ts`                                        | The RSA key and Android public key encoding                                 |
| `src/backend/index.ts`                                          | The `/shell` and `/pair` WebSocket routes, access checks, status port       |
| `src/frontend/`                                                 | The terminal tab, the file manager and editor, the plugin registration      |
| `locales/`                                                      | Texts                                                                       |
| `tests/`                                                        | Backend tests against a fake device, frontend and frame tests               |
| `scripts/set-version.mjs`                                       | Used by `set-version.bat`                                                   |

## Acknowledgements

The file manager (`src/frontend/filemanager`) is based on the frontend of the [Termix File Manager](https://github.com/Termix-SSH/Plugin-File-Manager) plugin, licensed under the Apache License 2.0 (see `LICENSE`). It was changed to talk to a device over ADB: the SFTP, FTP, WebDAV, SMB, transfer, local pane and external editor parts were removed or replaced, the trash was moved to a folder on the device, and APK install, the device status line and the port fix were added. The UI uses components from `@termix-ssh/plugin-sdk`.
