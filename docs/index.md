ADB opens an Android shell in a Termix tab, with a real terminal: colors, arrow keys, `vim`, `top`, and window resize.

Termix speaks the ADB protocol itself over TCP, so the server needs no `adb` binary and the plugin works on the stock Docker image. It needs Termix 26.11.2 or newer.

## Prepare the device

ADB must listen on TCP. Connect the device by USB once and run:

```
adb tcpip 5555
```

It listens on port 5555 until the device restarts. For Android 11+ "Wireless debugging" (TLS, random port, pairing) see the next section.

If the device shows a "Wireless debugging" screen with an IP, a port such as 33235 and a pairing code (Android 11 and newer, including Xiaomi HyperOS), that port does not speak the plain ADB this plugin uses, so the connection ends with "The device did not answer in time". Connect the device by USB once, run `adb tcpip 5555`, and use port 5555.

## Android 11+ Wireless debugging (Xiaomi, Pixel and others)

Devices with **Developer options → Wireless debugging** do not use `adb tcpip`. They have two ports:

1. The **connect port** (the one under the IP address on the Wireless debugging screen, it changes on every restart). Put it in the host's ADB port.
2. The **pairing port**, shown only on the "Pair device with pairing code" screen, with a 6-digit code.

Steps: add the host with the device's IP and the connect port, open the ADB tab and connect. The device does not know the server yet, so the tab shows a form. On the device open "Pair device with pairing code", enter the pairing port and the code in the form, and press Pair. The tab then reconnects by itself. Keep the pairing screen open on the device until you press Pair. Pairing is done once per server and device; the device remembers the key. If the device is on the same Wi-Fi only, the Termix server must be on that network too.

The port changes every time Wireless debugging is switched off and on. The device still trusts the server then, so no new pairing is needed: when a connection fails on a device that has connected before, the tab shows a field for the new port. Enter it and the plugin saves it to the host and reconnects.

## File manager

Open **ADB Files** from the host's menu (or the command palette). The layout follows the Termix file manager: a sidebar with recent files and a folder tree on the left, the current folder on the right as a grid or a list, and a toolbar with back, forward, up, refresh, a path bar (click it to type a path), search, view, upload, sort and New. It starts at `/sdcard`; type another path in the address bar to go elsewhere (some folders, like `/data`, need root). A line under the list shows the device's name, Android version, battery (left out when there is none) and free space.

- **Select:** click, Ctrl or Shift for several, or hold the left mouse button and drag a frame. Ctrl+A selects all.
- **Open:** double click a folder to enter it, or a text file to edit it. The editor has line numbers, Save (or Ctrl+S), Download and permissions as octal digits like `644`. It opens UTF-8 text up to 2 MB.
- **Right click** a file for the actions: open or edit, install (for an APK), download, copy, cut, paste (also into a folder), rename, permissions, properties, copy path, open in terminal (folders) and delete. On empty space: paste, new folder, new file, open in terminal, copy path, upload, refresh. Ctrl+A, Ctrl+C, Ctrl+X, Ctrl+V, Ctrl+D (copy next to the original), F2 and Delete work too. Copy and move never overwrite an existing name.
- **Properties:** path, type, owner and group, permissions, size, date and SELinux context. A folder's size is counted in the background.
- **Open in terminal:** on a folder (or empty space for the current one); opens a new ADB terminal in that folder.
- **New file:** creates an empty file and opens it in the editor.
- **Permissions** show as a column (`rwxr-xr-x`, octal in the tooltip). The menu entry changes them for any selection, binary files included; for folders you can include the contents.
- **Upload:** the buttons, or drag files and folders into the list. Dropping on a folder row uploads into that folder. Folders keep their structure. If a name already exists you choose Replace, Keep both, Skip or Cancel once for the whole upload.
- **Move:** drag selected rows onto a folder (hold Ctrl to copy).
- **Download:** files, folders or a selection. Several items or a folder arrive as one `.zip`, built on the fly (symbolic links are skipped). The browser saves it to its usual downloads folder: the plugin runs in a sandbox and can't open a "save as" dialog, so turn on "Ask where to save each file" in the browser settings if you want one.
- **Sort:** click a column header; click again to reverse. Folders stay on top.
- **Search:** the search field (or Ctrl+F) looks for names in the current folder and below, up to 500 results. Results behave like the list.
- **Hidden files:** the eye button shows or hides dotfiles.
- **Install an APK:** right click the `.apk`, Install. The plugin copies it to a temporary file in `/data/local/tmp`, installs it and removes the copy, because Android's package manager can't read `/sdcard` directly.

## Power

The **Power** button on the host row (next to ADB and ADB Files) offers Reboot, Recovery, Bootloader and Power off, and asks to confirm before it acts. Both the file manager and power control can be switched off per host in the host editor, ADB tab (on by default); a switched-off feature has no button and the server refuses its requests.

## Add a host

1. Open a host in Manage, or make a new one. Use the device's IP address.
2. In General, turn on ADB. An ADB tab appears in the host editor: set the port there (5555 by default).
3. Save, then pick ADB from the host's menu.

The first time, the device shows "Allow USB debugging?". Tick "Always allow from this computer" and accept. Termix keeps one key for the whole server, so each device asks once.

The Termix server must be able to reach the device's IP and port, because the connection is opened by the server, not by your browser or desktop app. A device outside the server's network is not reachable: put the server and the device on one network (a VPN such as Tailscale or WireGuard works).

## Copy and paste

- Ctrl+V, Cmd+V and Shift+Insert paste. Ctrl+Shift+V pastes from the clipboard.
- Ctrl+C copies while text is selected and sends an interrupt otherwise. Ctrl+Shift+C always copies.
- Right click, or a two-finger tap on a touchpad, copies the selection, or pastes when nothing is selected. A middle click pastes.

## Host status

The host's status dot follows the ADB port, not the SSH port, as long as ADB is the host's connection type. Open ADB sessions count as online and are released when they end.

If the host also has SSH turned off but the overview still shows a red "SSH login" card, that card comes from the SSH Terminal plugin: switch off its Terminal setting for that host (SSH group, Terminal tab).

## Settings

- Admin, Allow devices on private networks (on by default): ADB devices usually sit on a LAN. Turn it off to refuse hosts that resolve to private, loopback or link-local addresses.
- Admin, ADB key: the RSA key the server proves itself to devices with. It is made on first use and stored hidden.
- Host, ADB, ADB port, File manager and Power control (the last two are on by default).

## Access

Anyone with the Open ADB sessions permission and connect access to the host can open a shell. Every open is written to the audit log.
