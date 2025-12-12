#pragma once

#include "CesiumGeospatial/Ellipsoid.h"
#include "mapget/model/featurelayer.h"
#include <iostream>
#include "glm/glm.hpp"

namespace nlohmann {
/**
 * We add JSON adapter for points, so we can convert Points
 * seamlessly to nlohmann JSON objects just as we can seamlessly
 * convert them to native JS objects (see call to em::value_object
 * in bindings.cpp).
 */
template <>
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
template <>
struct adl_serializer<glm::dvec3> {
    static void to_json(json& j, const glm::dvec3& p) {
        j = json{{"x", p.x}, {"y", p.y}, {"z", p.z}};
    }

    static void from_json(const json& j, glm::dvec3& p) {
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
ResultVec wgsToCartesian(mapget::Point const& wgsPoint, glm::dvec3 const& offset = {.0, .0, .0})
{
    namespace geo = CesiumGeospatial;
    auto& wgs84Elli = geo::Ellipsoid::WGS84;
    auto cartoCoords =
        geo::Cartographic::fromDegrees(
            wgsPoint.x + offset.x,
            wgsPoint.y + offset.y,
            wgsPoint.z + offset.z);
    return wgs84Elli.cartographicToCartesian(cartoCoords);
}

/**
 * Convert Cesium cartesian coordinates to WGS84.
 */
template <typename ResultVec = glm::vec3>
ResultVec cartesianToWgs(glm::dvec3 const& cart)
{
    namespace geo = CesiumGeospatial;
    auto& wgs84Elli = geo::Ellipsoid::WGS84;
    if (auto cartesian = wgs84Elli.cartesianToCartographic(cart)) {
        return {glm::degrees(cartesian->longitude), glm::degrees(cartesian->latitude), cartesian->height};
    }
    std::cout << "cartesianToWgs failed for " << cart.x << ":" << cart.y << ":" << cart.z << "!"
              << std::endl;
    return {.0, .0, .0};
}

}