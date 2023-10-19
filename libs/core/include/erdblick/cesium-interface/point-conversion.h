#pragma once

#include "CesiumGeospatial/Ellipsoid.h"
#include "mapget/model/featurelayer.h"


namespace nlohmann {
template <>
/**
 * We add JSON adapter for points, so we can convert Points
 * seamlessly to nlohmann JSON objects just as we can seamlessly
 * convert them to native JS objects (see call to em::value_object
 * in bindings.cpp).
 */
struct adl_serializer<mapget::Point> {
    static void to_json(json& j, const mapget::Point& p) {
        j = json{{"x", p.x}, {"y", p.y}, {"z", p.z}};
    }

    static void from_json(const json& j, mapget::Point& p) {
        j.at("x").get_to(p.x);
        j.at("y").get_to(p.y);
        j.at("z").get_to(p.z);
    }
};
}

namespace erdblick
{

/**
 * Convert a WGS84 point to Cesium cartesian coordinates,
 * with altitude indicated in meters.
 */
template <typename ResultVec = glm::vec3>
ResultVec wgsToCartesian(mapget::Point const& wgsPoint, glm::dvec3 const& origin = glm::dvec3{.0, .0, .0})
{
    namespace geo = CesiumGeospatial;
    auto& wgs84Elli = geo::Ellipsoid::WGS84;
    auto cartoCoords = geo::Cartographic::fromDegrees(wgsPoint.x, wgsPoint.y, wgsPoint.z);
    auto cartesian = wgs84Elli.cartographicToCartesian(cartoCoords);
    return {
        cartesian.x - origin.x,
        cartesian.y - origin.y,
        cartesian.z - origin.z};
}

}