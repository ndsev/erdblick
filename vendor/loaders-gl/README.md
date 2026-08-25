# Vendored loaders.gl package

This directory contains a temporary security repack of the published
`@loaders.gl/textures@4.4.5` package. Erdblick pins the tarball with a `file:`
dependency so clean CI installs do not install the unused Node-only
`texture-compressor` tool and its vulnerable `image-size` dependency.

The registry source package has integrity
`sha512-zB9xMIKiU3tQN6q5/A6yaXw/DbodA+bqMDTVu7pzk4lw4zcBwWiGtD5LV0QjgtlTj2ZnwV8cCd1rYk9bwiX2Bw==`
and SHA-256
`9c28678e57d255a5f5e2e6f47402ad70f6257d19c331c19c1dd80d95690a4855`.
All source, compiled output, types, workers, WASM files, and license text are
unchanged. Only `package.json` is adjusted:

```diff
   "dependencies": {
-    "texture-compressor": "^1.0.2"
   },
   "peerDependencies": {
+    "texture-compressor": "^1.0.2"
+  },
+  "peerDependenciesMeta": {
+    "texture-compressor": {
+      "optional": true
+    }
   }
```

This is the same dependency boundary used by the current loaders.gl 5
development tree. Erdblick uses the texture and GLTF readers but does not use
`CompressedTextureWriter`, which is the only loaders.gl path that invokes the
external compressor. Code that needs that offline Node encoder must install and
security-review `texture-compressor` separately; it is intentionally not part
of the Erdblick dependency graph.

The package retains name and version `@loaders.gl/textures@4.4.5` because
`@loaders.gl/gltf@4.4.5` requires that exact version. The local path and
lockfile integrity distinguish this repack from the registry artifact.

Remove the repack and direct dependency when Erdblick adopts a compatible
loaders.gl release that makes `texture-compressor` optional.

## SHA-256

```text
43d999ade1d0f46df62a239922cdd8255f62a2ace4c23b811a3b4704b72f9154  loaders.gl-textures-4.4.5-erdblick-no-texture-compressor.tgz
```

