#include "mapget/model/featurelayer.h"
#include "glm/glm.hpp"

#include <iostream>

namespace m = mapget;

namespace erdblick
{

/**
 * Signed 2D cross product of lineVector and (p - lineStart).
 * Positive means left of the directed line, negative right, and zero on it;
 * altitude is ignored and the magnitude is not a normalized distance.
 */
double pointSideOfLine(m::Point const& lineVector, m::Point const& lineStart, m::Point const& p);

/**
 * Function to check if a triangle intersects with an infinite 2D line,
 * using start point and direction vector for the line
 */
bool checkIfTriangleIntersectsWithInfinite2dLine(m::Point const& lineStart, m::Point const& lineVector, m::Point const& triA, m::Point const& triB, m::Point const& triC);

/**
 * Test XY coordinates against triangle edge half-planes, including the edges.
 * Callers must supply a non-degenerate triangle; altitude is ignored.
 */
bool isPointInsideTriangle(m::Point const& p, m::Point const& p0, m::Point const& p1, m::Point const& p2);

/**
 * Calculate a reasonable center point for the given geometry.
 * Used for labels and relation-vector origins. This is a geometric heuristic,
 * not a center of mass: lines use their points nearest the arithmetic mean,
 * while meshes try to keep the result near intersected triangles.
 * Empty geometry logs a diagnostic and returns the zero point.
 */
m::Point geometryCenter(m::SelfContainedGeometry const& g);

/**
 * Calculate a point furthest from the center for the given geometry.
 * Used to properly scale the camera in the viewer
 * relative to the feature's bounding sphere. Distance is measured in ECEF
 * metres from geometryCenter(), and the returned point remains in WGS84.
 */
m::Point boundingRadiusEndPoint(m::SelfContainedGeometry const& g);

/**
 * Calculate a local WGS84 coordinate system for the geometry.
 * The axes are scaled, such that each represents approx. 1m
 * in real-world length. The y-axis will point in the direction
 * (first-point -> last-point). The x-axis is perpendicular.
 */
glm::dmat3x3 localWgs84UnitCoordinateSystem(mapget::SelfContainedGeometry const& g);

/**
 * Shift geometry by a local meter offset.
 *
 * For line geometries, the lateral component follows a per-vertex miter
 * direction so adjacent segments keep a uniform spacing. Non-line geometries
 * fall back to a single geometry-local basis.
 */
m::SelfContainedGeometry offsetGeometryLocally(
    mapget::SelfContainedGeometry const& g,
    glm::dvec3 const& localOffsetMeters);

}  // namespace erdblick
