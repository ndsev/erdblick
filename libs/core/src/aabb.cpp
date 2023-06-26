#include "aabb.h"

namespace erdblick
{

namespace
{

inline glm::dvec3 vec(Wgs84Point const& p)
{
    return {p.x, p.y, p.z};
}

inline Wgs84Point point(glm::dvec3 const& p)
{
    return {p.x, p.y, p.z};
}

float fastAtan2(float y, float x)
{
    if (x == 0.0 && y == 0.0) {
        return 0.0;  // handle the case when both x and y are zero
    }

    float abs_x = std::abs(x);
    float abs_y = std::abs(y);

    float a = std::min(abs_x, abs_y) / std::max(abs_x, abs_y);
    float s = a * a;

    float r = ((-0.0464964749f * s + 0.15931422f) * s - 0.327622764f) * s * a + a;

    if (abs_y > abs_x) {
        r = 1.57079637f - r;
    }
    if (x < 0.0) {
        r = 3.14159274f - r;
    }
    if (y < 0.0) {
        r = -r;
    }

    return r;
}

}  // namespace

Wgs84AABB::Wgs84AABB(const Wgs84Point& sw, glm::dvec2 size) : sw_(sw.x, sw.y), size_(size)
{
    if (!valid())
        return;

    auto excessHeight = 90. - sw_.y - size_.y;
    if (excessHeight < 0)
        size_.y += excessHeight;
}

Wgs84AABB::Wgs84AABB(const TileId& tileId)
    : Wgs84AABB(tileId.sw(), glm::abs(vec(tileId.sw()) - vec(tileId.ne())))
{
}

Wgs84AABB
Wgs84AABB::fromCenterAndTileLimit(const Wgs84Point& center, uint32_t softLimit, uint16_t level)
{
    constexpr auto targetAspectRatio = .7;  // approx. height / width
    auto tileWidth = 180. / static_cast<double>(1u << level);
    auto targetSize = glm::sqrt(softLimit) * tileWidth;
    auto targetSizeVec =
        typename glm::dvec3{targetSize / targetAspectRatio, targetSize * targetAspectRatio, .0};
    return Wgs84AABB(point(vec(center) - targetSizeVec * .5), targetSizeVec);
}

bool Wgs84AABB::valid() const
{
    return size_.x >= 0 && size_.y >= 0 && size_.x <= 360. && size_.y <= 180.;
}
Wgs84Point Wgs84AABB::sw() const
{
    return {sw_.x, sw_.y, .0};
}

Wgs84Point Wgs84AABB::ne() const
{
    return point({sw_ + size_, .0});
}

Wgs84Point Wgs84AABB::nw() const
{
    return point({sw_ + vec2_t{.0, size_.y}, .0});
}

Wgs84Point Wgs84AABB::se() const
{
    return point({sw_ + vec2_t{size_.x, .0}, .0});
}

std::vector<Wgs84Point> Wgs84AABB::vertices() const
{
    return {sw(), se(), ne(), nw()};
}

bool Wgs84AABB::containsAntiMeridian() const
{
    return sw_.x + size_.x > 180.;
}

Wgs84Point Wgs84AABB::center() const
{
    return point({sw_ + size_ * .5, .0});
}

std::pair<Wgs84AABB, Wgs84AABB> Wgs84AABB::splitOverAntiMeridian() const
{
    auto widthAfterAM = sw_.x + size_.x - 180.;
    if (widthAfterAM > 0) {
        auto widthBeforeAM = size_.x - widthAfterAM;
        return {
            Wgs84AABB{{sw_.x, sw_.y, .0}, {widthBeforeAM, size_.y}},
            Wgs84AABB{{-180., sw_.y, .0}, {widthAfterAM, size_.y}},
        };
    }
    else
        std::cerr << "Attempt to split AABB over anti-meridian which does not contain it."
                  << std::endl;
    return {};
}

double Wgs84AABB::avgMercatorStretch()
{
    auto latTop = glm::radians(sw_.y + size_.y);
    auto latBottom = glm::radians(sw_.y);
    auto radToMercatorLat = [](double wgs84Lat)
    {
        return atanh(sin(wgs84Lat - M_PI_2));
    };
    return (radToMercatorLat(latTop) - radToMercatorLat(latBottom)) / glm::radians(size_.y);
}

uint32_t Wgs84AABB::numTileIds(uint32_t lv) const
{
    double tileWidth = 180. / static_cast<float>(1u << lv);
    auto const tilesPerDim = glm::ceil(size_ / tileWidth);
    return static_cast<uint32_t>(tilesPerDim.x * tilesPerDim.y);
}

uint8_t Wgs84AABB::tileLevel(uint32_t minNumTiles) const
{
    for (uint8_t resultTileLevel = 0; resultTileLevel <= 15; ++resultTileLevel) {
        if (numTileIds(resultTileLevel) >= minNumTiles)
            return resultTileLevel;
    }
    return 15;
}

bool Wgs84AABB::contains(const Wgs84Point& point) const
{
    return point.x >= sw_.x && point.x <= sw_.x + size_.x && point.y >= sw_.y &&
        point.y <= sw_.y + size_.y;
}

bool Wgs84AABB::intersects(const Wgs84AABB& other) const
{
    return contains(other.sw()) || contains(other.ne()) || contains(other.se()) ||
        contains(other.nw()) || other.intersects(*this);
}

void Wgs84AABB::tileIds(uint16_t level, std::vector<TileId>& tileIdsResult) const
{
    if (containsAntiMeridian()) {
        auto normalizedViewports = splitOverAntiMeridian();
        assert(
            !normalizedViewports.first.containsAntiMeridian() &&
            !normalizedViewports.second.containsAntiMeridian());
        normalizedViewports.first.tileIds(level, tileIdsResult);
        normalizedViewports.second.tileIds(level, tileIdsResult);
    }

    auto const tileWidth = 180. / static_cast<double>(1 << level);
    auto const epsilon = 180. / static_cast<double>(1 << 24);
    auto minPoint = sw_;
    auto maxPoint = ne();
    auto remainingCapacity = tileIdsResult.capacity() - tileIdsResult.size();
    if (std::fmod(minPoint.x, tileWidth) == 0)
        minPoint.x += epsilon;
    if (std::fmod(minPoint.y, tileWidth) == 0)
        minPoint.y += epsilon;

    double x = minPoint.x;
    while (x <= maxPoint.x && remainingCapacity > 0) {
        double y = minPoint.y;
        while (y <= maxPoint.y && remainingCapacity > 0) {
            auto tid = TileId::fromWgs84(x, y, level);
            tileIdsResult.emplace_back(tid);
            remainingCapacity -= 1;
            y += glm::min(tileWidth, glm::max(maxPoint.y - y, epsilon));
        }
        x += glm::min(tileWidth, glm::max(maxPoint.x - x, epsilon));
    }
}

TilePriorityFn Wgs84AABB::radialDistancePrioFn(glm::vec2 camPos, float orientation)
{
    return [camPos, orientation](TileId const& tid)
    {
        auto center = tid.center();
        float xDiff = center.x - camPos.x;
        float yDiff = center.y - camPos.y;
        auto angle = glm::atan(yDiff, xDiff);  // Angle to east (x axis) direction. glm::atan is atan2.

        angle -= orientation +
            M_PI_2;  // Difference w/ compass direction normalized from North to East
        angle = glm::abs(glm::mod(angle, (float)M_2_PI));  // Map angle to circle
        if (angle > M_PI)
            angle = M_2_PI - angle;

        auto distance = yDiff + xDiff;  // eventually use manhattan distance to avoid comp overhead?
        return yDiff + xDiff + angle * distance;
    };
}

}  // namespace erdblick