#include "drawing.h"
#include <geodesic.h>
#include <algorithm>
#include <cmath>
#include <iomanip>
#include <numbers>
#include <regex>
#include <sstream>
#include <stdexcept>

namespace erdblick
{
namespace
{
using Json = nlohmann::json;
constexpr size_t MaxPoints = 10000;
constexpr size_t MaxVertices = 1000000;

geod_geodesic const& ellipsoid()
{
    static auto const result = [] {
        geod_geodesic value;
        geod_init(&value, 6378137, 1 / 298.257223563);
        return value;
    }();
    return result;
}

/** Validate tool requests before any geometry or metrics are published. */
void position(double lon, double lat)
{
    if (!std::isfinite(lon) || !std::isfinite(lat) || std::abs(lon) > 180 || std::abs(lat) > 90)
        throw std::invalid_argument("Drawing: expected finite WGS84 longitude/latitude");
}
Json readPoints(Json const& points, size_t limit = MaxPoints)
{
    if (!points.is_array() || points.size() > limit)
        throw std::invalid_argument("Drawing: expected at most 10,000 positions");
    for (auto const& p : points) {
        if (!p.is_array() || p.size() != 2) throw std::invalid_argument("Drawing: positions must be longitude/latitude pairs");
        position(p[0].get<double>(), p[1].get<double>());
    }
    return points;
}
double distance(Json const& a, Json const& b, double* bearing = nullptr)
{
    double length;
    geod_inverse(&ellipsoid(), a[1], a[0], b[1], b[0], &length, bearing, nullptr);
    return length;
}
Json destination(Json const& origin, double bearing, double length)
{
    double lat, lon;
    geod_direct(&ellipsoid(), origin[1], origin[0], bearing, length, &lat, &lon, nullptr);
    return Json::array({lon, lat});
}

/** The smaller ellipsoidal area is orientation-independent; angles use the middle vertex. */
Json metrics(Json const& points)
{
    double area = 0, perimeter = 0, angle = 0;
    if (points.size() >= 3) {
        geod_polygon polygon;
        geod_polygon_init(&polygon, 0);
        for (auto const& p : points) geod_polygon_addpoint(&ellipsoid(), &polygon, p[1], p[0]);
        geod_polygon_compute(&ellipsoid(), &polygon, 0, 1, &area, &perimeter);
        auto const n = points.size();
        double before, after;
        if (distance(points[n - 2], points[n - 3], &before) > 0 && distance(points[n - 2], points[n - 1], &after) > 0)
            angle = std::abs(std::remainder(after - before, 360.0));
    }
    return {{"areaSquareMeters", std::abs(area)}, {"perimeterMeters", perimeter}, {"angleDegrees", angle}};
}

std::string formatted(double value, std::string const& suffix, int precision = 2)
{
    std::ostringstream out;
    out.imbue(std::locale::classic());
    out << std::fixed << std::setprecision(precision) << value << suffix;
    return out.str();
}

/** Split sampled linework at the antimeridian; keep stored coordinates in standard WGS84. */
Json lineGeometry(Json const& path)
{
    Json lines = Json::array(), current = Json::array();
    for (auto p : path) {
        p[0] = std::remainder(p[0].get<double>(), 360.0);
        if (!current.empty() && std::abs(p[0].get<double>() - current.back()[0].get<double>()) > 180) {
            auto const previous = current.back();
            double const edge = previous[0].get<double>() > 0 ? 180 : -180;
            double const unwrapped = p[0].get<double>() + (edge > 0 ? 360 : -360);
            double const fraction = (edge - previous[0].get<double>()) / (unwrapped - previous[0].get<double>());
            double const latitude = previous[1].get<double>() + fraction * (p[1].get<double>() - previous[1].get<double>());
            current.push_back({edge, latitude}); lines.push_back(std::move(current));
            current = Json::array({Json::array({-edge, latitude})});
        }
        current.push_back(std::move(p));
    }
    if (current.size() >= 2) lines.push_back(std::move(current));
    return lines.size() == 1 ? Json{{"type", "LineString"}, {"coordinates", lines.front()}} :
        Json{{"type", "MultiLineString"}, {"coordinates", std::move(lines)}};
}

/** Clip unwrapped polygon rings at longitude bands so date-line polygons retain their short extent. */
Json polygonGeometry(Json ring)
{
    for (size_t i = 1; i < ring.size(); ++i) {
        auto lon = ring[i][0].get<double>(), previous = ring[i - 1][0].get<double>();
        while (lon - previous > 180) lon -= 360;
        while (lon - previous < -180) lon += 360;
        ring[i][0] = lon;
    }
    double low = ring.front()[0], high = low;
    for (auto const& p : ring) { low = std::min(low, p[0].get<double>()); high = std::max(high, p[0].get<double>()); }
    if (high - low >= 360) throw std::invalid_argument("Drawing: polygons enclosing a pole are not supported");
    auto clip = [](Json input, double edge, bool keepAbove) {
        Json output = Json::array();
        if (input.empty()) return output;
        auto previous = input.back();
        auto inside = [=](Json const& p) { return keepAbove ? p[0].get<double>() >= edge : p[0].get<double>() <= edge; };
        for (auto const& p : input) {
            if (inside(previous) != inside(p)) {
                auto fraction = (edge - previous[0].get<double>()) / (p[0].get<double>() - previous[0].get<double>());
                output.push_back({edge, previous[1].get<double>() + fraction * (p[1].get<double>() - previous[1].get<double>())});
            }
            if (inside(p)) output.push_back(p);
            previous = p;
        }
        return output;
    };
    Json polygons = Json::array();
    for (int band = static_cast<int>(std::floor((low + 180) / 360)); band <= std::floor((high + 180) / 360); ++band) {
        auto clipped = clip(clip(ring, -180 + band * 360, true), 180 + band * 360, false);
        if (clipped.size() < 3) continue;
        for (auto& p : clipped) p[0] = p[0].get<double>() - band * 360;
        if (clipped.front() != clipped.back()) clipped.push_back(clipped.front());
        if (clipped.size() >= 4) polygons.push_back(Json::array({std::move(clipped)}));
    }
    return polygons.size() == 1 ? Json{{"type", "Polygon"}, {"coordinates", polygons.front()}} :
        Json{{"type", "MultiPolygon"}, {"coordinates", std::move(polygons)}};
}
}

double drawingDistance(double lon1, double lat1, double lon2, double lat2)
{
    position(lon1, lat1); position(lon2, lat2);
    return distance(Json::array({lon1, lat1}), Json::array({lon2, lat2}));
}

std::string drawingMetrics(std::string const& text) { return metrics(readPoints(Json::parse(text), MaxPoints + 1)).dump(); }

std::string drawingSnap(double lon1, double lat1, double lon2, double lat2)
{
    position(lon1, lat1); position(lon2, lat2);
    auto origin = Json::array({lon1, lat1});
    double bearing;
    auto length = distance(origin, Json::array({lon2, lat2}), &bearing);
    return destination(origin, std::round(bearing / 45) * 45, length).dump();
}

std::string drawingToolGeoJson(std::string const& text, bool preview)
{
    auto request = Json::parse(text);
    auto points = readPoints(request.at("points"));
    auto mode = request.value("mode", "distance"), unit = request.value("unit", "meters");
    auto color = request.value("color", "#ff8a24");
    auto spacing = request.value("maxSegmentLength", 20000.0);
    if (!std::isfinite(spacing) || spacing < 100 || spacing > 20000) throw std::invalid_argument("Drawing: invalid render spacing");
    if (!std::regex_match(color, std::regex("#[0-9a-fA-F]{6}"))) throw std::invalid_argument("Drawing: invalid color");
    if (mode != "distance" && mode != "area" && mode != "angle" && mode != "point" && mode != "polygon" && mode != "ellipse" && mode != "pen")
        throw std::invalid_argument("Drawing: unknown tool");
    if (preview && points.size() > 2) throw std::invalid_argument("Preview: expected at most two positions");
    bool const measured = mode == "distance" || mode == "area" || mode == "angle";
    bool const miles = unit == "miles";
    auto lengthText = [=](double value) { return formatted(miles ? value / 1609.344 : value, miles ? " mi" : " m", miles ? 4 : 2); };
    Json features = Json::array();
    auto feature = [&](std::string id, Json geometry, std::string role, std::string label = "") {
        features.push_back({{"type", "Feature"}, {"id", std::move(id)}, {"geometry", std::move(geometry)},
            {"properties", {{"role", std::move(role)}, {"color", color}, {"preview", preview}, {"label", label}, {"description", label}}}});
    };
    auto label = [&](std::string id, Json p, std::string value) {
        feature(std::move(id), {{"type", "Point"}, {"coordinates", std::move(p)}}, "measurement-label", std::move(value));
    };
    for (size_t i = 0; i < points.size(); ++i) {
        if (mode == "pen" && !preview && points.size() > 1) continue;
        feature("point-" + std::to_string(i), {{"type", "Point"}, {"coordinates", points[i]}}, preview ? "cursor" : measured ? "measurement-point" : "draw-point");
    }
    if (mode == "point") return Json{{"type", "FeatureCollection"}, {"features", features}}.dump() + "\n";

    auto shapePoints = points;
    bool closed = (mode == "area" || mode == "polygon") && !preview && points.size() >= 3;
    if (mode == "ellipse" && points.size() == 2) {
        double bearing;
        auto radius = distance(points[0], points[1], &bearing);
        auto radians = bearing * std::numbers::pi / 180;
        auto east = std::abs(radius * std::sin(radians)), north = std::abs(radius * std::cos(radians));
        if (!preview && (east < 0.01 || north < 0.01)) throw std::invalid_argument("Ellipse: both radii must be positive; choose a corner diagonally from its center");
        if (east >= 0.01 && north >= 0.01) {
            shapePoints = Json::array();
            for (int i = 0; i < 128; ++i) {
                auto angle = 2 * std::numbers::pi * i / 128;
                auto x = east * std::cos(angle), y = north * std::sin(angle);
                shapePoints.push_back(destination(points[0], std::atan2(x, y) * 180 / std::numbers::pi, std::hypot(x, y)));
            }
            closed = true;
            features = Json::array();
        }
    }
    if (closed) shapePoints.push_back(shapePoints.front());
    Json path = Json::array();
    double total = 0;
    for (size_t i = 1; i < shapePoints.size(); ++i) {
        geod_geodesicline line;
        auto const& a = shapePoints[i - 1]; auto const& b = shapePoints[i];
        geod_inverseline(&line, &ellipsoid(), a[1], a[0], b[1], b[0], 0);
        total += line.s13;
        auto steps = std::max(1, static_cast<int>(std::ceil(line.s13 / spacing)));
        if (preview) steps = std::min(steps, mode == "ellipse" ? 16 : 2048);
        for (int step = i == 1 ? 0 : 1; step <= steps; ++step) {
            double lat, lon;
            geod_genposition(&line, GEOD_LONG_UNROLL, line.s13 * step / steps, &lat, &lon, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr);
            path.push_back({lon, lat});
            if (path.size() > MaxVertices) throw std::invalid_argument("Drawing: render path exceeds 1,000,000 vertices");
        }
        if (measured && line.s13 > 0) label("segment-" + std::to_string(i), destination(a, line.azi1, line.s13 / 2), lengthText(line.s13));
    }
    if (path.size() >= 2) feature("path", lineGeometry(path), preview ? "cursor-segment" : measured ? "measurement-path" : "draw-path");
    if (closed) feature("shape", polygonGeometry(path), mode == "area" ? "measurement-area" : "draw-area");
    if (measured && points.size() >= 2) {
        auto all = metrics(points);
        auto value = "Total " + lengthText(total + request.value("previousMeters", 0.0));
        if (preview && request.contains("previewLabel")) value = request["previewLabel"].get<std::string>();
        if (!preview && mode == "area" && points.size() >= 3)
            value = formatted(all["areaSquareMeters"].get<double>() / (miles ? 1609.344 * 1609.344 : 1), miles ? " mi²" : " m²", miles ? 4 : 2);
        if (!preview && mode == "angle" && points.size() == 3) value = formatted(all["angleDegrees"], "°");
        label("total", points.back(), value);
    }
    return Json{{"type", "FeatureCollection"}, {"features", std::move(features)}}.dump() + "\n";
}
}
