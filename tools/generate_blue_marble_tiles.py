#!/usr/bin/env python3
"""Generate the bundled Blue Marble XYZ tile pyramid for erdblick."""

from __future__ import annotations

import math
import shutil
from pathlib import Path

from PIL import Image


TILE_SIZE = 256
MAX_ZOOM = 5
REPO_ROOT = Path(__file__).resolve().parent.parent
SOURCE_IMAGE_PATH = REPO_ROOT / "images" / "blue_marble_200407_21600x10800.jpg"

# Keep the historical output path stable so existing bundled URLs and persisted
# background ids keep working after switching the built-in imagery source.
OUTPUT_ROOT = REPO_ROOT / "images" / "backgrounds" / "world-overview"

# The bundled Blue Marble source is intentionally large enough to support one
# additional zoom level over the previous fallback background.
Image.MAX_IMAGE_PIXELS = None


def mercator_source_row(source_height: int, world_size: int, output_row: int) -> float:
    """Map one Web Mercator world pixel row to the corresponding equirectangular source row."""
    normalized_mercator_y = (output_row + 0.5) / world_size
    latitude = math.atan(math.sinh(math.pi * (1.0 - 2.0 * normalized_mercator_y)))
    return ((0.5 - (latitude / math.pi)) * source_height) - 0.5


def build_mercator_master(source_image: Image.Image, world_size: int) -> Image.Image:
    """Reproject the Blue Marble source image into one square Web Mercator world raster."""
    prepared_source = source_image.convert("RGB").resize((world_size, source_image.height), Image.Resampling.LANCZOS)
    output_image = Image.new("RGB", (world_size, world_size))
    max_source_row = prepared_source.height - 1

    for output_row in range(world_size):
        source_row = max(0.0, min(float(max_source_row), mercator_source_row(prepared_source.height, world_size, output_row)))
        lower_row = int(math.floor(source_row))
        upper_row = min(max_source_row, lower_row + 1)
        blend_factor = source_row - lower_row

        lower_slice = prepared_source.crop((0, lower_row, world_size, lower_row + 1))
        if upper_row == lower_row or blend_factor <= 1e-6:
            blended_slice = lower_slice
        else:
            upper_slice = prepared_source.crop((0, upper_row, world_size, upper_row + 1))
            blended_slice = Image.blend(lower_slice, upper_slice, blend_factor)
        output_image.paste(blended_slice, (0, output_row))

    return output_image


def write_xyz_tiles(mercator_master: Image.Image, output_root: Path) -> None:
    """Cut the Web Mercator master raster into the bundled `z/x/y` tile pyramid."""
    if output_root.exists():
        shutil.rmtree(output_root)
    output_root.mkdir(parents=True, exist_ok=True)

    for zoom_level in range(MAX_ZOOM + 1):
        world_size = TILE_SIZE << zoom_level
        zoom_image = mercator_master if world_size == mercator_master.width else mercator_master.resize(
            (world_size, world_size),
            Image.Resampling.LANCZOS
        )
        for tile_x in range(1 << zoom_level):
            tile_column_directory = output_root / str(zoom_level) / str(tile_x)
            tile_column_directory.mkdir(parents=True, exist_ok=True)
            for tile_y in range(1 << zoom_level):
                tile = zoom_image.crop((
                    tile_x * TILE_SIZE,
                    tile_y * TILE_SIZE,
                    (tile_x + 1) * TILE_SIZE,
                    (tile_y + 1) * TILE_SIZE
                ))
                tile.save(tile_column_directory / f"{tile_y}.jpg", "JPEG", quality=90, optimize=True)


def main() -> None:
    """Generate the bundled overview tiles from the repository Blue Marble raster."""
    source_image = Image.open(SOURCE_IMAGE_PATH)
    mercator_master = build_mercator_master(source_image, TILE_SIZE << MAX_ZOOM)
    write_xyz_tiles(mercator_master, OUTPUT_ROOT)


if __name__ == "__main__":
    main()
