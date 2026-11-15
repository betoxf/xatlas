# xatlas on the phone, released with the desktop

Status: paused (2026-11-15). What follows was built and worked on ZCode v3.15. Since the move
to v3.18 the phone remote is switched off: upstream replaced the relay protocol, and
`packages/relay` still speaks the old one.

## Built

- **xatlas identity on the desktop:** app id `com.xatlas.desktop` (Preview
  `com.xatlas.desktop.preview`, dev `com.xatlas.desktop.development`), name "xatlas", URL
  scheme `xatlas://`, Electron data in `Application Support/com.xatlas.desktop`. Update checks only run with an explicit
  xatlas feed (`ZCODE_UPDATE_FEED_URL`), and the Z.ai minimum-version check is gone, so a
  packaged xatlas can't be offered or forced onto a ZCode release.
- **Relay:** `packages/relay` speaks the same protocol as the desktop and phone clients
  (register, HMAC challenge, pair status, data) and serves the phone page. Tests pair the
  real desktop and phone transports through it.
- **iOS app:** `packages/ios` (XcodeGen, `com.xatlas.ios`). Pair by scanning the code,
  pasting the link, or opening `xatlas://remote?link=…`; the link (it holds the pairing
  secret) is kept in the Keychain on the device. The remote runs in a web view with a slim
  bar in the page's own color (reload, pair another Mac, forget).
- **Android app:** `com.xatlas.android`, xatlas name and icons, `xatlas://remote?link=…`
  links, the same certificate pinning as iOS.
- **Phone page:** xatlas title and icons, home-screen icon.
- **Local loop:** `pnpm dev:phone` (relay + phone page) and `pnpm dev:desktop:phone`.
  Verified end to end on 2026-10-31, before the switch-off, Mac-hosted over HTTPS: iOS Simulator (pairing, workspace list,
  opening a conversation, reload, relaunch) and the Android emulator (pairing).

## How phones connect: through your own Mac

No accounts and no xatlas servers. Each desktop app runs the relay and serves the phone
page itself (`desktopPhoneRemoteHost.ts`), starting when Mobile remote control opens:

- Phones connect over HTTPS/WSS on port 47120 (any free port if it's taken) at the Mac's
  network address. The certificate is self-signed and created on first use; the pairing
  link carries its SHA-256 (`fp`), and the iOS and Android apps accept only that
  certificate for that address. The pairing secret and all traffic stay encrypted on the
  network.
- The desktop's own connection stays on a loopback-only listener.
- Away from home, the phone reaches the Mac through the user's own network tools, for
  example Tailscale (100.64.0.0/10 addresses are allowed), or any VPN.
- The page is built into the app (`pnpm build:phone-remote`, about 61 MB, packaged as
  `resources/phone-remote`). Pairings survive restarts (`phone-remote/devices.json` in the
  app's data folder).
- The `ZCODE_WEB_REMOTE_CONTROL_*` overrides still point a dev build at the hot-reloading
  loop (`pnpm dev:phone` + `pnpm dev:desktop:phone`).

## Next

1. **App data folder:** settings, login and conversation databases still live in
   `~/.zcode`, shared with an installed ZCode; about 50 places hardcode it. Move xatlas to
   its own folder before shipping packaged builds next to ZCode.
2. **Push notifications:** with no xatlas server, push has to come from the user's side
   (their own APNs key, or the phone polling while the app is open). Decide before building.
3. **Release pipeline:** TestFlight and Play builds, with the phone page build in the
   desktop package.
4. **Z.ai browser sign-in:** its callback now targets `xatlas://`. The account sign-in
   still completes by polling; check whether Z.ai's page accepts the new scheme for the
   model-provider sign-in.
5. **Plain browsers** (no app) show a certificate warning for the Mac's self-signed
   certificate; the apps are the supported way in.

## One release for everything (planned)

None of this exists yet. The plan: one version in the root `package.json` → release-it tag → GitHub Actions (macOS runner):

1. Desktop DMG (arm64 + x64), signed and notarized, update manifest on xatlas's own feed,
   GitHub Release.
2. Web remote build packaged into the desktop app.
3. iOS: Xcode project generated from `packages/ios/project.yml`, version from the root, archive,
   TestFlight.
4. Android AAB to the Play internal track.

The phone loads the page its Mac serves, so UI changes ship without App Store review while the
handshake stays compatible.

## Licensing

ZCode is Apache-2.0: keep `LICENSE`, `NOTICE.md` and `THIRD-PARTY-NOTICES.md`, and stay off the
ZCode and Z.ai names and app id for anything xatlas ships (Apache grants no trademark rights).
xatlas still fetches the provider catalog and plugin list from Z.ai's servers, as the README's
privacy section says; using Z.ai's hosted services beyond that is a matter of their service
terms.
