#pragma once

#include "mapget/model/featurelayer.h"
#include "glm/glm.hpp"
#include "glm/trigonometric.hpp"
#include "glm/exponential.hpp"
#include "glm/common.hpp"
#include <cmath>

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

namespace detail
{
constexpr double WGS84_A = 6378137.0;
constexpr double WGS84_INV_F = 298.257223563;
constexpr double WGS84_F = 1.0 / WGS84_INV_F;
constexpr double WGS84_B = WGS84_A * (1.0 - WGS84_F);
constexpr double WGS84_E2 = WGS84_F * (2.0 - WGS84_F);
constexpr double WGS84_EP2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);
}

/**
 * Convert a WGS84 point to cartesian ECEF coordinates,
 * with altitude indicated in meters.
 */
template <typename ResultVec = glm::vec3>
ResultVec wgsToCartesian(mapget::Point const& wgsPoint, glm::dvec3 const& offset = {.0, .0, .0})
{
    auto const lonRad = glm::radians(wgsPoint.x + offset.x);
    auto const latRad = glm::radians(wgsPoint.y + offset.y);
    auto const height = wgsPoint.z + offset.z;

    auto const sinLat = glm::sin(latRad);
    auto const cosLat = glm::cos(latRad);
    auto const sinLon = glm::sin(lonRad);
    auto const cosLon = glm::cos(lonRad);

    auto const primeVerticalRadius = detail::WGS84_A /
        glm::sqrt(1.0 - detail::WGS84_E2 * sinLat * sinLat);

    auto const x = (primeVerticalRadius + height) * cosLat * cosLon;
    auto const y = (primeVerticalRadius + height) * cosLat * sinLon;
    auto const z = (primeVerticalRadius * (1.0 - detail::WGS84_E2) + height) * sinLat;
    return {x, y, z};
}

/**
 * Convert cartesian ECEF coordinates to WGS84.
 */
template <typename ResultVec = glm::vec3>
ResultVec cartesianToWgs(glm::dvec3 const& cart)
{
    auto const x = cart.x;
    auto const y = cart.y;
    auto const z = cart.z;
    auto const p = glm::sqrt(x * x + y * y);

    if (p < 1e-12) {
        auto const lat = (z >= 0.0) ? 90.0 : -90.0;
        auto const h = glm::abs(z) - detail::WGS84_B;
        return {0.0, lat, h};
    }

    auto const theta = glm::atan(z * detail::WGS84_A, p * detail::WGS84_B);
    auto const sinTheta = glm::sin(theta);
    auto const cosTheta = glm::cos(theta);

    auto const lon = glm::atan(y, x);
    auto const lat = glm::atan(
        z + detail::WGS84_EP2 * detail::WGS84_B * sinTheta * sinTheta * sinTheta,
        p - detail::WGS84_E2 * detail::WGS84_A * cosTheta * cosTheta * cosTheta);

    auto const sinLat = glm::sin(lat);
    auto const primeVerticalRadius = detail::WGS84_A /
        glm::sqrt(1.0 - detail::WGS84_E2 * sinLat * sinLat);
    auto const h = p / glm::cos(lat) - primeVerticalRadius;

    return {glm::degrees(lon), glm::degrees(lat), h};
}

}
