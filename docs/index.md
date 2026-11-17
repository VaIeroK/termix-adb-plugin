ADB opens an Android shell in a Termix tab, with a real terminal: colors, arrow keys, `vim`, `top`, and window resize.

Termix speaks the ADB protocol itself over TCP, so the server needs no `adb` binary and the plugin works on the stock Docker image.

## Prepare the device

ADB must listen on TCP. Connect the device by USB once and run:

```
adb tcpip 5555
```

It listens on port 5555 until the device restarts. Android 11+ "Wireless debugging" is not supported: it uses TLS and a random port with pairing. Use `adb tcpip` instead.

## Add a host

1. Open a host in Manage, or make a new one. Use the device's IP address.
2. In General, turn on ADB and set the port (5555 by default).
3. Save, then pick ADB from the host's menu.

The first time, the device shows "Allow USB debugging?". Tick "Always allow from this computer" and accept. Termix keeps one key for the whole server, so each device asks once.

The Termix server must be able to reach the device's IP and port. From Docker, a device on your LAN works with the default bridge network.

## Access

Anyone with the Open ADB sessions permission and connect access to the host can open a shell. Every open is written to the audit log.
