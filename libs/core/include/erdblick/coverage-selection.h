#pragma once
#include "mapget/model/coverage.h"
#include <vector>

namespace erdblick
{
/** Geographic viewport plus the camera inputs used to prioritize payload demand. */
struct Viewport {
    double south = 0, west = 0, width = 0, height = 0;
    double camPosLon = 0, camPosLat = 0, orientation = 0;
};

/** Select the best eligible viewport tiles without materializing the full grid. */
std::vector<mapget::TileId> selectCoverageTiles(
    Viewport const& viewport, int level, int limit, mapget::CoverageQuery const* coverage = nullptr);
}
