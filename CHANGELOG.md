# Changelog

## 1.1.0

### Added

- Android 11+ Wireless debugging. Pair a phone with the pairing code from the ADB tab (pairing port + 6-digit code), then connect on the connect port from the Wireless debugging screen. The pairing protocol (SPAKE2) and the TLS upgrade are implemented in the plugin; the server still needs no adb binary.
- Russian strings for the pairing form.

### Changed

- The host editor no longer has a second "ADB" switch: the protocol switch is the only one. The ADB port has its own "ADB" tab in the host editor, shown without turning on Advanced.

### Fixed

- Copying (Ctrl+C or a tap) drops the selection.

## 1.0.1

### Changed

- Ported to plugin API 2 (Termix 26.11.2 and newer). The backend runs in a plugin process and opens its device sockets through the target guard; the frontend runs in a sandboxed frame. Plugin API 1 is no longer supported.
- Russian translation, including the plugin name and description.
- New admin setting "Allow devices on private networks" (on by default, since ADB devices sit on a LAN).

### Fixed

- Ctrl+V, Cmd+V and Shift+Insert paste exactly once; Ctrl+Shift+V reads the clipboard; Ctrl+C copies while text is selected and interrupts otherwise.
- Clicking the terminal focuses it.
- The ADB port can be set in the host editor (an ADB tab appears once ADB is on).
- Right click and middle click (a two-finger tap on a touchpad) copy the selection, or paste when nothing is selected. When the browser refuses the clipboard read, the terminal says so.
- The host's status dot follows the ADB port when ADB is the host's connection type, and open ADB sessions count as online and are released when they end.

## 1.0.0

### Added

- ADB shell tab for Android devices, over TCP with no adb binary on the server
