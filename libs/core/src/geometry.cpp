#include "glm/glm.hpp"

#include "geometry.h"
#include "cesium-interface/point-conversion.h"

Point erdblick::geometryCenter(const model_ptr<Geometry>& g)
{
    if (!g) {
        std::cerr << "Cannot obtain center of null geometry." << std::endl;
        return {};
    }

    // Initialize variables for averaging.
    uint32_t totalPoints = g->numPoints();
    std::vector<mapget::Point> points;
    points.reserve(g->numPoints());

    // Lambda to update totalX, totalY, totalZ, and count.
    auto averageVectorPosition = [](const std::vector<Point>& points)
    {
      Point result{0., 0., 0.};
      for (auto const& p : points) {
          result.x += p.x;
          result.y += p.y;
          result.z += p.z;
      }
      result.x /= static_cast<double>(points.size());
      result.y /= static_cast<double>(points.size());
      result.z /= static_cast<double>(points.size());
      return result;
    };

    // Process all points to find the average position.
    g->forEachPoint(
        [&points](const auto& p)
        {
          points.push_back(p);
          return true;  // Continue iterating.
        });

    if (totalPoints == 0) {
        std::cerr << "Geometry has no points." << std::endl;
        return {};
    }

    Point averagePoint = averageVectorPosition(points);
    if (g->geomType() != GeomType::Mesh && g->geomType() != GeomType::Line) {
        return averagePoint;
    }

    // Sort points based on distance to the average point.
    auto pointsSorted = points;
    std::sort(
        pointsSorted.begin(),
        pointsSorted.end(),
        [&averagePoint](const Point& a, const Point& b)
        {
          auto da = (a.x - averagePoint.x) * (a.x - averagePoint.x) +
                    (a.y - averagePoint.y) * (a.y - averagePoint.y);
          auto db = (b.x - averagePoint.x) * (b.x - averagePoint.x) +
                    (b.y - averagePoint.y) * (b.y - averagePoint.y);
          return da < db;
        });

    // For lines, return the shape-point closest to the average.
    if (g->geomType() == GeomType::Line) {
        if (totalPoints % 2 == 1) {
            // Odd number of points: Return closest point.
            return pointsSorted.front();
        }

        // Return the average of the two closest points.
        return {
            (pointsSorted[0].x + pointsSorted[1].x) * .5,
            (pointsSorted[0].y + pointsSorted[1].y) * .5,
            (pointsSorted[0].z + pointsSorted[1].z) * .5};
    }

    // If we are here, then the geometry is a mesh.
    // Check if the average point is inside the mesh.
    // Then we don't need to fix it.
    for (size_t i = 0; i < totalPoints / 3; ++i)
    {
        if (isPointInsideTriangle(
            averagePoint,
            points[3 * i],
            points[3 * i + 1],
            points[3 * i + 2]))
        {
            return averagePoint;
        }
    }

    // Use line intersection method to find a better center.
    // Create line from average position to closest.
    std::vector<Point> intersectedTrianglePoints;
    Point lineDirection = {
        pointsSorted.front().x - averagePoint.x,
        pointsSorted.front().y - averagePoint.y};

    for (size_t i = 0; i < totalPoints / 3; ++i) {
        if (checkIfTriangleIntersectsWithInfinite2dLine(
            averagePoint,
            lineDirection,
            points[3 * i],
            points[3 * i + 1],
            points[3 * i + 2]))
        {
            intersectedTrianglePoints.push_back(points[3 * i]);
            intersectedTrianglePoints.push_back(points[3 * i + 1]);
            intersectedTrianglePoints.push_back(points[3 * i + 2]);
        }
    }

    if (intersectedTrianglePoints.empty())
        return averagePoint;

    return averageVectorPosition(intersectedTrianglePoints);
}

double erdblick::pointSideOfLine(const Point& lineVector, const Point& lineStart, const Point& p)
{
    return lineVector.x * (p.y - lineStart.y) - lineVector.y * (p.x - lineStart.x);
}

bool erdblick::checkIfTriangleIntersectsWithInfinite2dLine(
    const Point& lineStart,
    const Point& lineVector,
    const Point& triA,
    const Point& triB,
    const Point& triC)
{
    // Calculate on which side of the line the triangle vertices are using the line vector.
    double sideA = pointSideOfLine(lineVector, lineStart, triA);
    double sideB = pointSideOfLine(lineVector, lineStart, triB);
    double sideC = pointSideOfLine(lineVector, lineStart, triC);

    // Check if all points are on the same side of the line.
    if ((sideA > 0 && sideB > 0 && sideC > 0) || (sideA < 0 && sideB < 0 && sideC < 0)) {
        return false;
    }

    // If not all points are on the same side, then there's an intersection.
    return true;
}

bool erdblick::isPointInsideTriangle(
    const Point& p,
    const Point& p0,
    const Point& p1,
    const Point& p2)
{
    // Calculate the direction vectors for the edges of the triangle
    mapget::Point edge0 = {p1.x - p0.x, p1.y - p0.y};
    mapget::Point edge1 = {p2.x - p1.x, p2.y - p1.y};
    mapget::Point edge2 = {p0.x - p2.x, p0.y - p2.y};

    // Calculate the side of the point relative to each edge of the triangle
    double side0 = pointSideOfLine(edge0, p0, p);
    double side1 = pointSideOfLine(edge1, p1, p);
    double side2 = pointSideOfLine(edge2, p2, p);

    // Check if the point is on the same side of each edge
    // If the point is on the same side of all edges, it is inside the triangle
    // Note: Using <= on all checks to include points lying exactly on an edge
    return (side0 <= 0 && side1 <= 0 && side2 <= 0) || (side0 >= 0 && side1 >= 0 && side2 >= 0);
}

glm::dmat3x3 erdblick::localWgs84UnitCoordinateSystem(const model_ptr<Geometry>& g)
{
    constexpr auto latMetersPerDegree = 110574.; // Meters per degree of latitude
    constexpr auto lonMetersPerDegree = 111320.; // Meters per degree of longitude at equator
    constexpr glm::dmat3x3 defaultResult = {
        {1./lonMetersPerDegree, .0, .0},
        {.0, 1./latMetersPerDegree, .0},
        {.0, .0, 1.}};

    if (!g || g->geomType() != GeomType::Line || g->numPoints() < 2) {
        return defaultResult;
    }

    auto const aWgs = g->pointAt(0);
    auto const a = wgsToCartesian<glm::dvec3>(aWgs);
    auto const b = wgsToCartesian<glm::dvec3>(g->pointAt(g->numPoints() - 1));
    auto const c = wgsToCartesian<glm::dvec3>(aWgs, {.0, .0, 1.});
    auto const forward = glm::normalize(b - a);
    auto const up = glm::normalize(c - a);
    auto const sideways = glm::cross(forward, up);
    auto const aWgsForward = cartesianToWgs<glm::dvec3>(a + forward);
    auto const aWgsSideways = cartesianToWgs<glm::dvec3>(a + sideways);

    glm::dmat3x3 result = {
        aWgsSideways - glm::dvec3(aWgs.x, aWgs.y, aWgs.z),
        aWgsForward - glm::dvec3(aWgs.x, aWgs.y, aWgs.z),
        {.0, .0, 1.},
    };

    if (glm::any(glm::isnan(result[0])) || glm::any(glm::isnan(result[1])) || glm::any(glm::isnan(result[2]))) {
        return defaultResult;
    }

    return result;
}
