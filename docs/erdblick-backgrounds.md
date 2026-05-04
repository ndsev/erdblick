# Bundled Backgrounds

`images/backgrounds/world-overview/` contains the bundled Blue Marble XYZ background shipped with erdblick.

- Source image: `images/blue_marble_200407_21600x10800.jpg`
- Source page: `https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-map/`
- Coverage: global
- Pyramid: zoom levels `0..5`
- Tile format: `256x256` JPEG

The source image is equirectangular, so the shipped tile pyramid is reprojected into Web Mercator before it is cut into XYZ tiles.

The tiles are intended as a lightweight built-in fallback background for offline or air-gapped deployments. The bundled sample now uses NASA Blue Marble: Next Generation imagery for a more Earth-like visual baseline than the previous relief-style overview. Higher-detail imagery should still be provided through deployment-specific XYZ or WMS entries in `config.json` when available.

The historical `world-overview` directory name is retained intentionally so existing bundled URLs and persisted background ids remain valid.

Authenticated HTTP backgrounds can add a `headers` object per background entry in `config.json`. Erdblick forwards those headers to XYZ tile requests as well as WMS metadata and image requests, so bearer tokens or similar credentials can stay in the deployment config instead of being hardcoded into URLs.

To regenerate the bundled tiles after refreshing the Blue Marble source image, run:

```bash
curl -L -o images/blue_marble_200407_21600x10800.jpg \
  https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-base/july/world.200407.3x21600x10800.jpg
python3 tools/generate_blue_marble_tiles.py
```
