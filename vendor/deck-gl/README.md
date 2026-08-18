# Temporary deck.gl target-navigation packages

These packages are a temporary, vendored CI snapshot of
[`Klebert-Engineering/deck.gl`](https://github.com/Klebert-Engineering/deck.gl)
on branch `codex/target-navigation`, based on commit
`1adb58c3f919d280ad56bb115e80e7602a2c750a`. The planar-pan update is the
reviewed local working-tree patch whose package-source diff has SHA-256
`f8ea6f31e4090e413e9ea87e4dac837b15453173de1ca2f8e695e11618cf7c4b`.
Replace this base-plus-patch identifier with the upstream commit id once the
change is committed.

The snapshot contains the complete deck.gl package set consumed by Erdblick:

- `@deck.gl/core`
- `@deck.gl/extensions`
- `@deck.gl/geo-layers`
- `@deck.gl/layers`
- `@deck.gl/mesh-layers`

All packages were produced with Node.js 24.11.0 and deck.gl's canonical
`corepack yarn build`, then packed with npm. The source patch includes both the
`picking.ts` shader-literal declaration fix and the matching alpha dependency
ranges in the five package manifests; neither fix is now applied only to a
staged tarball.

The tarballs are intentionally referenced with `file:` dependencies so that
`npm ci` is deterministic and needs no package-registry credentials. Replace
all five dependencies together when the pkg.pr.new preview packages become
available; mixing this snapshot with deck.gl 9.3 packages is unsupported.

## SHA-256

```text
d6dcb16e6f82c71b3c5810db8feea26b865c0187353710f4af209e1eb0776d7f  deck.gl-core-9.4.0-alpha.2-target-navigation-planar-pan-1adb58c3.tgz
4cfdb3ca96e90dc11a53e180ab694f127f9ba77e660b5cbb8cea7a72f3c0ed14  deck.gl-extensions-9.4.0-alpha.2-target-navigation-planar-pan-1adb58c3.tgz
61391328a064ffbc072911347023fc5f6b43a0ad1767f329e704e469b7d30131  deck.gl-geo-layers-9.4.0-alpha.2-target-navigation-planar-pan-1adb58c3.tgz
a830e9c0f2872868e0b985ea96083267987f4ad39126d3722a399bd4bb95cb53  deck.gl-layers-9.4.0-alpha.2-target-navigation-planar-pan-1adb58c3.tgz
8013bd161ec1368a53a6770fdebf6cffe061b3f47c69bb830deee10205bdacbd  deck.gl-mesh-layers-9.4.0-alpha.2-target-navigation-planar-pan-1adb58c3.tgz
```
