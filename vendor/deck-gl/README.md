# Temporary deck.gl target-navigation packages

These packages are a temporary, vendored CI snapshot of
[`Klebert-Engineering/deck.gl`](https://github.com/Klebert-Engineering/deck.gl)
on branch `codex/target-navigation`, based on commit
`e0a863145b9f116ef8f89e776d63ec0f501e4ab0`. The minimum target-distance
contract is the reviewed local working-tree patch whose package-source diff
has SHA-256
`cbc0934479d029da526bc41a25f636428ffdb8c9488cfdcd06a1d1a9c2707bbd`.
Replace this base-plus-patch identifier with the upstream commit id once the
change is committed.

The snapshot contains the complete deck.gl package set consumed by Erdblick:

- `@deck.gl/core`
- `@deck.gl/extensions`
- `@deck.gl/geo-layers`
- `@deck.gl/layers`
- `@deck.gl/mesh-layers`

All packages were produced with Node.js 24.11.0 and deck.gl's canonical
`corepack yarn build`, then packed with npm. The source patch adds the generic
`minimumTargetDistance` contract to target acquisition, viewport
reconstruction, controller validation, and target-aware transitions. The base
commit already contains the planar-pan implementation, the `picking.ts`
shader-literal declaration fix, and matching alpha dependency ranges in the
five package manifests.

The tarballs are intentionally referenced with `file:` dependencies so that
`npm ci` is deterministic and needs no package-registry credentials. Replace
all five dependencies together when the pkg.pr.new preview packages become
available; mixing this snapshot with deck.gl 9.3 packages is unsupported.

## SHA-256

```text
7aceed7c70e0f5d1d60ca5ffc9e18c800de7d6e188ad9fefe1b272f7eb0697f6  deck.gl-core-9.4.0-alpha.2-target-navigation-clearance-e0a86314.tgz
1eb9e5180b7611ae2ffde76a50d7262f962e402a56a6ea1381303fc7bb6cf9a5  deck.gl-extensions-9.4.0-alpha.2-target-navigation-clearance-e0a86314.tgz
5bb7634139f33207ef7211c43b861a860d52a276dab8e08aa762f9b4dca00732  deck.gl-geo-layers-9.4.0-alpha.2-target-navigation-clearance-e0a86314.tgz
ac81ce8f198d1bf541d1c55fe68536a342ec8d20afc7456104bf94de6e0c8189  deck.gl-layers-9.4.0-alpha.2-target-navigation-clearance-e0a86314.tgz
608c71a5cf7ae63fac676ae9fe125ad24f09c95c3da7bb2e74e30c300328e4d3  deck.gl-mesh-layers-9.4.0-alpha.2-target-navigation-clearance-e0a86314.tgz
```
