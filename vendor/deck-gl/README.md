# Temporary deck.gl target-navigation packages

## Current snapshot: rebased beta.4 with numeric hardening

The five dependencies in `package.json` now select
`9.4.0-beta.4-target-navigation-2ab86ce8`. They were built from the
`codex/target-navigation` checkout at `3978aab2cd099b8076912fb86993a0a5b9fa381f`
plus the R1–R3 working-tree follow-up: dense finite numeric tuples and reuse of
the existing projection-matrix clip extraction. This includes the committed
shared Map/Globe lifecycle and Terrain accepted-pose handoff, rebased on
upstream `b28503d8742e3551a37372b9cb911aa1cc9b6706`.

The source/manifest digest is
`2ab86ce81d5d89994b10fca83c2def6544bdb04d93a9dde93f544dca4929e99a`.
It hashes all files under the five modules' `src/` directories and their five
source `package.json` files (296 files), sorted by repository-relative path:
for each file, feed UTF-8 path, NUL, raw bytes, NUL into SHA-256. This identifies
the exact build-time source snapshot; inherited upstream manifest `gitHead`
fields are not its provenance. The later fork commit
`a8a6bebb4323e5667bf63354c6ac851c531c99e0` records those follow-up changes.
Its 296-file source/manifest digest was rechecked and matches the archives'
recorded digest; no repackaging was needed for that commit.

Build: Node 22.22.0 / Corepack Yarn 1.22.19, canonical `yarn build` (also rerun
by `yarn test-website`). Pack: npm 10.9.4 from isolated copies of the five built
module directories using `npm pack`. Only the internal `@deck.gl/*` satellite
peer ranges are normalized to exact `9.4.0-beta.4` in those packaging copies;
the tracked fork manifests and genuine luma production ranges are unchanged.
Archives include source, declarations, standard and `visgl:webgl-only` output,
and the unchanged MIT license.

Use ordinary `npm ci`; no sibling checkout, npm link, GitHub credentials or
manual build step is needed. All five archives must be upgraded together.
The older alpha archives below remain available for rollback. The patched
loaders.gl textures archive and security overrides remain independent of
this snapshot and must be checked after fresh dependency resolution.

```text
2f7664dc36c3f05c50a29cfa200367b28843fa233bafd5d1ba56642e7a9bd7eb  deck.gl-core-9.4.0-beta.4-target-navigation-2ab86ce8.tgz
46ab8fd17927a58eaf875ef179b0aeebf29d1e859531bf21d5b82d67db5db745  deck.gl-extensions-9.4.0-beta.4-target-navigation-2ab86ce8.tgz
ea23faa8d199a57aaf0ba30fc536286e8dd7876cfa0133cd32eaf64277c97649  deck.gl-geo-layers-9.4.0-beta.4-target-navigation-2ab86ce8.tgz
4838fe0de9e85c1ba1e1d45428529ca0402f4de8a698cdadc42025ddbd61fea0  deck.gl-layers-9.4.0-beta.4-target-navigation-2ab86ce8.tgz
94daaa0b54a1b96392c295fb580f7750b724afb3c4a65341bf73935a8052186c  deck.gl-mesh-layers-9.4.0-beta.4-target-navigation-2ab86ce8.tgz
```

## Retained rollback snapshot: alpha.2

These packages are a temporary, vendored CI snapshot of
[`Klebert-Engineering/deck.gl`](https://github.com/Klebert-Engineering/deck.gl)
on branch `codex/target-navigation`, based on commit
`2aec3cb24870adce6a14314116618b7627fd0d21`. This commit includes the target
navigation controller, planar target panning, target-distance clearance, and
the follow-up zoom corrections; no uncommitted deck.gl source patch is part of
the snapshot.

The snapshot contains the complete deck.gl package set consumed by Erdblick:

- `@deck.gl/core`
- `@deck.gl/extensions`
- `@deck.gl/geo-layers`
- `@deck.gl/layers`
- `@deck.gl/mesh-layers`

The deck.gl tree was built with Node.js 22.22.0 using its canonical
`corepack yarn build`; the resulting package directories were packed with npm
11.16.0 under Node.js 24.11.0. During packaging only, stale internal
`@deck.gl/*` peer ranges in the four satellite manifests were replaced with the
exact snapshot version `9.4.0-alpha.2`. This keeps strict `npm ci` resolution
coherent without changing the fork's tracked source.

The tarballs are intentionally referenced with `file:` dependencies so that
`npm ci` is deterministic and needs no package-registry credentials. Replace
all five dependencies together when the pkg.pr.new preview packages become
available; mixing this snapshot with deck.gl 9.3 packages is unsupported.

## SHA-256

```text
b78922a4faa563ca58a04c33a59c50d3cc28ec327464524af91ab47ac6a61f4f  deck.gl-core-9.4.0-alpha.2-target-navigation-2aec3cb2.tgz
76c193e0ba33d33864776d12ab0c4ac6a0e2af830af8ec940903244aafebe8d1  deck.gl-extensions-9.4.0-alpha.2-target-navigation-2aec3cb2.tgz
0024d15ca7d4987c17db262b8e22169d7a4c70bee6b72257eb0ce5ae5febeb40  deck.gl-geo-layers-9.4.0-alpha.2-target-navigation-2aec3cb2.tgz
a4fb4e051b704c6738a1655da267c1c67cc9d6bb119d9f9bd737b0b286ba3087  deck.gl-layers-9.4.0-alpha.2-target-navigation-2aec3cb2.tgz
600c68e7f0dfa3c7fc0691272cda866bf4385345aff11b2019f5d55bfa5b275f  deck.gl-mesh-layers-9.4.0-alpha.2-target-navigation-2aec3cb2.tgz
```
