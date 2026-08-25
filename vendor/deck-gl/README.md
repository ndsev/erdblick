# Temporary deck.gl target-navigation packages

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
