#pragma once

#include "glm/glm.hpp"
#include "mapget/model/tileid.h"

#include <iostream>
#include <list>

namespace erdblick
{

/** Function which returns a priority penalty value for a tile */
using TileId = mapget::TileId;
using TilePriorityFn = std::function<double(TileId const&)>;
using Wgs84Point = mapget::Point;

/**
 * Wgs84AABB Wgs84 axis-aligned bounding box.
 */
class Wgs84AABB
{
public:
    static TilePriorityFn radialDistancePrioFn(glm::vec2 camPos, float orientation);

    using vec2_t = glm::dvec2;

    Wgs84AABB() = default;
    Wgs84AABB(Wgs84AABB const& other) = default;

    /** Construct an AABB from a position and a size. */
    Wgs84AABB(Wgs84Point const& sw, vec2_t size);

    /** Construct an AABB from a TileId. */
    explicit Wgs84AABB(TileId const& tileId);

    /** Construct the AABB from a center position, a tile count limit, and a tile level */
    static Wgs84AABB
    fromCenterAndTileLimit(Wgs84Point const& center, uint32_t softLimit, uint16_t level);

    /** Determine, whether the AABBs size is within reasonable bounds. */
    bool valid() const;

    /** Obtain the South-West corner of this AABB. */
    Wgs84Point sw() const;

    /** Obtain the North-East corner of this AABB. */
    Wgs84Point ne() const;

    /** Obtain the North-West corner of this AABB. */
    Wgs84Point nw() const;

    /** Obtain the South-East corner of this AABB. */
    Wgs84Point se() const;

    /** Obtain all four vertices, one for each corner of the AABB. */
    std::vector<Wgs84Point> vertices() const;

    /** Obtain the size of this bounding box. */
    vec2_t const& size() const { return size_; }

    /** Determine whether the horizontal extent of this bounding rect
     *  crosses the anti-meridian (lon == +/- 180°).
     */
    bool containsAntiMeridian() const;

    /** Obtain the center coordinate of this AABB. */
    Wgs84Point center() const;

    /** Note: Only call if containsAntiMeridian() is true.
     *  If this bounding rect crosses the anti-meridian, obtain two normalized bounding
     *  rects, one to the right and one to the left.
     */
    std::pair<Wgs84AABB, Wgs84AABB> splitOverAntiMeridian() const;

    /** Calculate the mercator-projection vertical stretch factor. */
    double avgMercatorStretch();

    /** Obtain the number of tiles for the given level contained in this AABB.
     *  Note: The number returned is approximate; the actual tile count returned
     *  by tileIdsWithPriority might still be a bit higher if the viewport is slightly
     *  shifted (one additional row/column + 1 corner).
     */
    uint32_t numTileIds(uint32_t lv) const;

    /** Obtain the first tile level for this bounding box, for which
     *  a certain minimum number of tiles would be contained.
     */
    uint8_t tileLevel(uint32_t minNumTiles = 8) const;

    /** Determine whether this bounding rect contains the given point */
    bool contains(Wgs84Point const& point) const;

    /** Determine whether this bounding rect has an intersection with another bounding rect. */
    bool intersects(Wgs84AABB const& other) const;

    /** Obtain TileIds for a given tile level.
     */
    void tileIds(uint16_t level, std::vector<TileId> &result) const;

    /** Same as tileIdsWithPriority, but strips the priority values
     *  and converts the linked list to a vector.
     */
    std::vector<TileId> tileIds(
        uint16_t level,
        std::function<double(TileId const&)> const& tilePenaltyFun,
        size_t limit) const;

private:
    vec2_t sw_{.0, .0};
    vec2_t size_{.0, .0};
};

}  // namespace erdblick