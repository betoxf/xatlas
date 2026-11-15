# xatlas for iPhone and iPad

A native shell for the xatlas phone remote: pair with a Mac by scanning the code from
**Mobile remote control** in the desktop app (or pasting its link), then use the remote in a
web view. The pairing link holds the pairing secret, so it's kept in the Keychain on this
device only.

The phone remote is switched off in the current desktop build (see
[mobile-and-releases.md](../../docs/xatlas/mobile-and-releases.md)), so there is nothing to pair
with until it moves to the new relay.

## Build

Requires Xcode 16 or later (Swift 6) and [XcodeGen](https://github.com/yonaskolb/XcodeGen)
(`brew install xcodegen`). The Xcode project is generated, not committed:

```bash
cd packages/ios
xcodegen
open Xatlas.xcodeproj
```

Pick your team under Signing & Capabilities to run on a device. The bundle id is
`com.xatlas.ios`.

## Pair with a Mac

The desktop app serves the remote itself, on the Mac's network address over HTTPS with a
self-signed certificate. The pairing link carries the certificate's fingerprint, and the
app accepts only that certificate. Open **Mobile remote control** in the desktop app, then
scan the code or copy the link and paste it here. Away from home, connect through your own
network, for example Tailscale.

A link can also be opened directly, which is handy in the Simulator:

```bash
xcrun simctl openurl booted "xatlas://remote?link=<percent-encoded link>"
```

For UI work on the phone page with hot reload, run `pnpm dev:phone` and
`pnpm dev:desktop:phone` from the repository root instead.
