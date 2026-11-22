# Changelog

## 1.2.1

### Added

- Right click menu in the file manager: open or edit, install (for `.apk`), download, copy, cut, paste (also into a folder), rename, permissions, delete. On empty space: paste, new folder, upload, refresh. Ctrl+C, Ctrl+X and Ctrl+V work too; copy and move never overwrite an existing name.
- Installing an APK from the file manager. It goes through a temporary copy in `/data/local/tmp` that is removed afterwards, because Android's package manager can't read `/sdcard`.
- Folders upload to the phone: drag a folder (or several) into the file manager, or use the "Upload folder" button. Subfolders and empty folders are kept; a folder shows as one row with its total progress.
- Drag selected files onto a folder in the list to move them there (hold Ctrl to copy). Dropping files from your computer on a folder row uploads into that folder.
- Click a column header to sort by name, permissions, size or date; click again to reverse. Folders stay on top.
- Search by name in the current folder and everything below it (Ctrl+F or the search field, up to 500 results). Results work like the list: open, edit, download, copy, rename and the rest.
- Toggle for hidden files, and a line under the list with the phone's name, Android version, battery and free space. The battery is left out when the device has none (a TV, a box).
- A "Power" button on the host row: reboot, recovery, bootloader and power off, each after a confirmation.
- When a connection fails on a phone that has connected or paired before, the terminal and the file manager offer a field for the new port. Wireless debugging picks a new port every time it is switched on, and the phone still trusts Termix, so no new pairing is needed.

### Changed

- The Download, Rename, Permissions and Delete buttons moved from the file manager's toolbar to the right click menu.
- Folder upload is supported now (1.2.0 uploaded files only).

### Fixed

- The modified column of the file list cut the time off. Dates are shorter now, and the full date is in the tooltip.

## 1.2.0

### Added

- File manager for the phone: the "ADB Files" tab (host menu and command palette) browses the device over the ADB sync protocol. List folders, upload (button or drag and drop), download, rename, create folders, delete, with progress and cancel. Starts in `/sdcard`. Files and folders download (a folder or several items arrive as one streamed `.zip`); uploading folders isn't supported yet.
- Text editor in the file manager: double click a text file to edit it with line numbers, save (button or Ctrl+S), download and change permissions (chmod). Files up to 2 MB, UTF-8 only; the file keeps its permissions on save.
- The file list shows permissions (`rwxr-xr-x`, octal in the tooltip), and the "Permissions" button changes them for any selected files or folders, binary ones included, with an option to include folder contents.
- Rubber band selection in the file list: hold the left mouse button and drag to select the files under the frame (Ctrl or Shift adds to the selection). The list no longer selects page text.

### Fixed

- CI vulnerability scan failed on `glob` and `minimatch` pulled in by the plugin SDK's dev dependencies. They are now pinned to patched versions with npm `overrides` (build tooling only, not part of the plugin).
- `build.bat` installs with `npm ci` instead of `npm install`. On Windows `npm install` rewrote `package-lock.json` without the optional `@emnapi/*` entries, and CI (`npm ci` on Linux) then failed with "lock file out of sync".

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
