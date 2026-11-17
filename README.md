# Termix ADB plugin

An Android `adb shell` tab for [Termix](https://github.com/Termix-SSH/Termix), as a plugin. The stock Docker image is enough: Termix speaks the ADB protocol itself over TCP, with RSA authentication, `shell_v2` with a PTY and live resize, and a fallback to the old shell for devices without `shell_v2`.

See [docs/index.md](docs/index.md) for device setup and use.

## Install

1. In Termix, open Settings, General and turn on Plugin developer mode.
2. Open Plugins, Install from file, and pick `adb-1.0.0.tmxplug`.
3. Open a host, turn on ADB, set the device IP and port, and connect.

The plugin is stored with the rest of the Termix data, so keep the data volume of your Compose file and it survives image updates.

## Compatibility

This is a plugin API 1 plugin (`engine.api` `^1.5`), for Termix 26.11.1 and other releases that run API 1 plugins. Termix 26.11.2 moves to plugin API 2, which does not run API 1 plugins at all. Moving over means `engine.api` `^2.0.0`, the `network:sockets` capability, a `sandbox` block and the frame checks in the plugin guide.

## Develop

```bash
npm install --legacy-peer-deps
npm test           # protocol tests against a fake adbd, route tests, frontend registration
npm run typecheck
npm run validate   # after npm run build
npm run pack       # writes adb-1.0.0.tmxplug
```
