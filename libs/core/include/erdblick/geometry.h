#include "mapget/model/featurelayer.h"

#include <iostream>

using namespace mapget;

namespace erdblick
{

/**
 * Function to calculate the "side" (or relative position)
 * of a point to a line defined by a start point and a direction vector.
 */
double pointSideOfLine(Point const& lineVector, Point const& lineStart, Point const& p);

/**
 * Function to check if a triangle intersects with an infinite 2D line,
 * using start point and direction vector for the line
 */
bool checkIfTriangleIntersectsWithInfinite2dLine(Point const& lineStart, Point const& lineVector, Point const& triA, Point const& triB, Point const& triC);

/**
 * Returns true if the given point is inside the given 2d triangle.
 */
bool isPointInsideTriangle(Point const& p, Point const& p0, Point const& p1, Point const& p2);

/**
 * Calculate a reasonable center point for the given geometry.
 * This is used as a location for labels, and as the origin
 * for relation vectors.
 */
Point geometryCenter(model_ptr<Geometry> const& g);

/**
 * Calculate a local WGS84 coordinate system for the geometry.
 * The axes are scaled, such that each represents approx. 1m
 * in real-world length. The y-axis will point in the direction
 * (first-point -> last-point). The x-axis is perpendicular.
 */
glm::dmat3x3 localWgs84UnitCoordinateSystem(const model_ptr<Geometry>& g);

}  // namespace erdblick
