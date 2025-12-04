#include "mapget/model/featurelayer.h"
#include "glm/glm.hpp"

#include <iostream>

namespace m = mapget;

namespace erdblick
{

/**
 * Function to calculate the "side" (or relative position)
 * of a point to a line defined by a start point and a direction vector.
 */
double pointSideOfLine(m::Point const& lineVector, m::Point const& lineStart, m::Point const& p);

/**
 * Function to check if a triangle intersects with an infinite 2D line,
 * using start point and direction vector for the line
 */
bool checkIfTriangleIntersectsWithInfinite2dLine(m::Point const& lineStart, m::Point const& lineVector, m::Point const& triA, m::Point const& triB, m::Point const& triC);

/**
 * Returns true if the given point is inside the given 2d triangle.
 */
bool isPointInsideTriangle(m::Point const& p, m::Point const& p0, m::Point const& p1, m::Point const& p2);

/**
 * Calculate a reasonable center point for the given geometry.
 * This is used as a location for labels, and as the origin
 * for relation vectors.
 */
m::Point geometryCenter(m::SelfContainedGeometry const& g);

/**
 * Calculate a point furthest from the center for the given geometry.
 * Used to properly scale the camera in the viewer
 * relative to the feature's bounding sphere.
 */
m::Point boundingRadiusEndPoint(m::SelfContainedGeometry const& g);

/**
 * Calculate a local WGS84 coordinate system for the geometry.
 * The axes are scaled, such that each represents approx. 1m
 * in real-world length. The y-axis will point in the direction
 * (first-point -> last-point). The x-axis is perpendicular.
 */
glm::dmat3x3 localWgs84UnitCoordinateSystem(mapget::SelfContainedGeometry const& g);

}  // namespace erdblick
