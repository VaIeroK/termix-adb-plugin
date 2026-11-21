ADB opens an Android shell in a Termix tab, with a real terminal: colors, arrow keys, `vim`, `top`, and window resize.

Termix speaks the ADB protocol itself over TCP, so the server needs no `adb` binary and the plugin works on the stock Docker image. It needs Termix 26.11.2 or newer.

## Prepare the device

ADB must listen on TCP. Connect the device by USB once and run:

```
adb tcpip 5555
```

It listens on port 5555 until the device restarts. Android 11+ "Wireless debugging" is not supported: it uses TLS and a random port with pairing. Use `adb tcpip` instead.

If the device shows a "Wireless debugging" screen with an IP, a port such as 33235 and a pairing code (Android 11 and newer, including Xiaomi HyperOS), that port does not speak the plain ADB this plugin uses, so the connection ends with "The device did not answer in time". Connect the device by USB once, run `adb tcpip 5555`, and use port 5555.

## Android 11+ Wireless debugging (Xiaomi, Pixel and others)

Phones with **Developer options → Wireless debugging** do not use `adb tcpip`. They have two ports:

1. The **connect port** (the one under the IP address on the Wireless debugging screen, it changes on every restart). Put it in the host's ADB port.
2. The **pairing port**, shown only on the "Pair device with pairing code" screen, with a 6-digit code.

Steps: add the host with the phone's IP and the connect port, open the ADB tab and connect. The phone does not know the server yet, so the tab shows a form. On the phone open "Pair device with pairing code", enter the pairing port and the code in the form, and press Pair. The tab then reconnects by itself. Keep the pairing screen open on the phone until you press Pair. Pairing is done once per server and phone; the phone remembers the key. If the phone is on the same Wi-Fi only, the Termix server must be on that network too.

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
- Host, ADB and ADB port.

## Access

Anyone with the Open ADB sessions permission and connect access to the host can open a shell. Every open is written to the audit log.
