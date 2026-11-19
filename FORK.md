# Himes fork foundation

Himes is an independently maintained, general-purpose derivative of
[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent).
The initial local branch was copied from the patched Hermes checkout at commit
`1fa8f9ec1a9392908d51c4702b12378c2a10aca3`. This checkout has no Git
remote. The upstream draft PR remains a separate artifact and is not Himes's
release channel.

The inherited agent core and integrations are MIT licensed. Keep the root
`LICENSE` and its Nous Research copyright notice in source and distributed
copies. Bundled components may carry additional notices, including
`plugins/security-guidance/LICENSE`, `plugins/security-guidance/NOTICE`, and
`scripts/whatsapp-bridge/PASSKEY-LICENSE`. Review the complete dependency and
asset license inventory before a public installer.

## Current boundary

`apps/himes-desktop` is a Wails client. Its Windows executable, window class,
WebView2 data directory, and Linux application ID are distinct from Hermes
Desktop. This first client still attaches to a separately installed Hermes CLI
and gateway. It does not yet ship an independently named Himes core runtime.
The app must not be represented as a complete standalone Himes release.

## Path to an independent release

1. Keep the Python core, gateway protocol, provider registry, plugins, and
   skills working. Record baseline behavior for provider setup, model listing,
   switching, inference routing, sessions, and delegation, including providers
   not used by Himes maintainers.
2. Introduce a Himes CLI/runtime entry point and isolated default data home.
   Retain an explicit migration/import flow rather than silently reading or
   modifying `~/.hermes` or `%LOCALAPPDATA%\hermes`.
3. Make the Wails client launch and attach to that Himes runtime. Keep a remote
   Hermes-compatible gateway mode while both clients share the wire contract.
4. Replace inherited app identifiers, installer metadata, update feeds, issue
   links, and release automation with Himes-owned values. Never let a Himes
   update replace a Hermes install or fetch NousResearch releases by default.
5. Build and test independent installers on each supported platform, including
   first install, update, uninstall, and side-by-side operation with Hermes.

The Himes name and `org.himes.Desktop` Linux ID are working identifiers. Review
final publisher, domain ownership, signing, and distribution details before
public release. Nothing in this checkout publishes software or changes the
user's GitHub account.
