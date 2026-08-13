# Temporary deck.gl target-navigation packages

These packages are a temporary, vendored CI snapshot of
[`Klebert-Engineering/deck.gl`](https://github.com/Klebert-Engineering/deck.gl)
at commit `1adb58c3f919d280ad56bb115e80e7602a2c750a` on branch
`codex/target-navigation`.

The snapshot contains the complete deck.gl package set consumed by Erdblick:

- `@deck.gl/core`
- `@deck.gl/extensions`
- `@deck.gl/geo-layers`
- `@deck.gl/layers`
- `@deck.gl/mesh-layers`

All packages were produced with Node.js 22.22.0 and deck.gl's canonical
`corepack yarn build`, then packed with npm. The core package also includes the
source-level declaration fix in
`modules/core/src/shaderlib/picking/picking.ts` that preserves its new uniform
types as shader-type literals for external TypeScript consumers. This fix is
currently an uncommitted change on top of the source commit and must be included
when publishing the pkg.pr.new replacement.

The source branch currently has stale deck.gl peer ranges in its alpha package
manifests, so the staged package manifests were adjusted to require the matching
`9.4.0-alpha.2` snapshot.

The tarballs are intentionally referenced with `file:` dependencies so that
`npm ci` is deterministic and needs no package-registry credentials. Replace
all five dependencies together when the pkg.pr.new preview packages become
available; mixing this snapshot with deck.gl 9.3 packages is unsupported.

## SHA-256

```text
aaf59bf5f879d9545f81a74bcee797f30decc3e6a3c93fe997ff9d0c7b692292  deck.gl-core-9.4.0-alpha.2-target-navigation-1adb58c3.tgz
7021839150a86d83ac48ec05d49efdd63f68a2a4485bb9212144dd66e21591e8  deck.gl-extensions-9.4.0-alpha.2-target-navigation-1adb58c3.tgz
cdf1952ccde5d17afc3ddb581583f1d6cc59744f9b71797bb144b1957b685f7f  deck.gl-geo-layers-9.4.0-alpha.2-target-navigation-1adb58c3.tgz
efd5e33c4b310168cc687e7a744ab0a0ea8981e2387881f429f7f9e6394ebb4a  deck.gl-layers-9.4.0-alpha.2-target-navigation-1adb58c3.tgz
d3e395e72826f5c69ab030b904d209834f21595092e9a30bbe272c28bd940584  deck.gl-mesh-layers-9.4.0-alpha.2-target-navigation-1adb58c3.tgz
```
