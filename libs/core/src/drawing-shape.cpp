#include <geodesic.h>
#include <ndsmath/polygonarea.h>
#include <algorithm>
#include <cmath>
#include <functional>
#include <iomanip>
#include <numbers>
#include <sstream>
#include <stdexcept>
#include "drawing.h"
#include "geo/point-conversion.h"

namespace erdblick
{
namespace
{
using Json = nlohmann::json;
using Vec = glm::dvec3;
constexpr size_t MaxVertices = 1000000;
constexpr double MercatorLimit = 85.0511287798066;
constexpr double PlaneToleranceMeters = 0.01;
/** Reject malformed requests at the native boundary. */
void require(bool condition, char const* message)
{
    if (!condition)
        throw std::invalid_argument(message);
}
/** Share the immutable WGS84 ellipsoid across evaluations. */
geod_geodesic const& earth()
{
    static auto const value = []
    {
        geod_geodesic g;
        geod_init(&g, 6378137, 1 / 298.257223563);
        return g;
    }();
    return value;
}
/** Validate one lossless geographic position before geometric operations. */
Vec read(Json const& p)
{
    require(
        p.is_array() && (p.size() == 2 || p.size() == 3),
        "Drawing position needs longitude, latitude and optional height.");
    Vec v{p.at(0).get<double>(), p.at(1).get<double>(), p.size() == 3 ? p.at(2).get<double>() : 0};
    require(
        std::isfinite(v.x) && std::isfinite(v.y) && std::isfinite(v.z) && std::abs(v.x) <= 180 &&
            std::abs(v.y) <= 90,
        "Drawing coordinates must be finite WGS84 positions through ±90°.");
    return v;
}
/** Encode a position with an explicit height policy. */
Json array(Vec v, bool height = true)
{
    return height ? Json::array({v.x, v.y, v.z}) : Json::array({v.x, v.y});
}
/** Convert WGS84 ellipsoidal height to physical ECEF coordinates. */
Vec cart(Vec p)
{
    return wgsToCartesian<Vec>({p.x, p.y, p.z});
}
/** Convert physical ECEF coordinates to WGS84 and ellipsoidal height. */
Vec wgs(Vec p)
{
    return cartesianToWgs<Vec>(p);
}
/** Measure the shortest ellipsoidal span and optionally its initial bearing. */
double geodesic(Vec a, Vec b, double* azimuth = nullptr)
{
    double result;
    geod_inverse(&earth(), a.y, a.x, b.y, b.x, &result, azimuth, nullptr);
    return result;
}
/** Lift a shortest geodesic with linearly interpolated ellipsoidal height. */
Vec interpolate(Vec a, Vec b, double t)
{
    double azimuth;
    auto length = geodesic(a, b, &azimuth);
    require(length < 19990000, "An antipodal control span needs an additional anchor.");
    Vec result;
    geod_direct(&earth(), a.y, a.x, azimuth, length * t, &result.y, &result.x, nullptr);
    result.z = a.z + (b.z - a.z) * t;
    return result;
}
/** An orthonormal physical frame; local values are meters. */
struct Plane
{
    Vec origin, u, v, normal;
    Vec local(Vec p) const
    {
        auto delta = cart(p) - origin;
        return {glm::dot(delta, u), glm::dot(delta, v), glm::dot(delta, normal)};
    }
    Vec global(Vec p) const { return wgs(origin + p.x * u + p.y * v); }
};
/** Validate and reconstruct a persisted orthonormal working frame. */
Plane plane(Json const& value)
{
    auto origin = read(value.at("origin"));
    auto vector = [](Json const& j)
    {
        require(j.is_array() && j.size() == 3, "Plane axes need three components.");
        return Vec(j[0], j[1], j[2]);
    };
    auto u = vector(value.at("u")), v = vector(value.at("v"));
    require(
        std::isfinite(glm::length(u)) && std::isfinite(glm::length(v)) &&
            std::abs(glm::length(u) - 1) < 1e-8 && std::abs(glm::length(v) - 1) < 1e-8 &&
            std::abs(glm::dot(u, v)) < 1e-8,
        "Plane axes must be orthonormal.");
    return {cart(origin), u, v, glm::cross(u, v)};
}
/** Construct a horizontal east/north frame at a WGS84 anchor. */
Json horizontal(Vec origin)
{
    auto lon = glm::radians(origin.x), lat = glm::radians(origin.y);
    return {
        {"origin", array(origin)},
        {"u", array({-std::sin(lon), std::cos(lon), 0})},
        {"v",
         array({-std::sin(lat) * std::cos(lon), -std::sin(lat) * std::sin(lon), std::cos(lat)})}};
}
/** Format physical values using the document display units. */
std::string label(double n, std::string const& unit, bool area = false)
{
    bool miles = unit == "miles";
    std::ostringstream out;
    out.imbue(std::locale::classic());
    out << std::fixed << std::setprecision(miles ? 4 : 2)
        << n / (miles ? (area ? 1609.344 * 1609.344 : 1609.344) : 1)
        << (miles ? (area ? " mi²" : " mi") : (area ? " m²" : " m"));
    return out.str();
}
/** Sample position and cumulative physical chainage. */
struct Sample
{
    double t;
    Vec p;
    double chainage;
};
/** One evaluated part shared by export, metrics and decorations. */
struct Path
{
    std::vector<Sample> samples;
    std::vector<double> segments;
    std::vector<Json> angles;
    double length = 0;
};
/** Sampling is deterministic, independent of the view and display units. Quarter samples catch
 * symmetric cubics. */
/** Adaptively integrate and tessellate one segment with deterministic limits. */
void sample(
    std::function<Vec(double)> const& at,
    bool spatial,
    double start,
    Vec a,
    double end,
    Vec b,
    Path& output,
    size_t depth = 0)
{
    auto middle = (start + end) / 2;
    auto m = at(middle), q1 = at((start + middle) / 2), q3 = at((middle + end) / 2);
    auto length = [spatial](Vec p, Vec q)
    {
        return spatial ? glm::length(cart(p) - cart(q)) : geodesic(p, q);
    };
    auto coarse = length(a, m) + length(m, b),
         fine = length(a, q1) + length(q1, m) + length(m, q3) + length(q3, b);
    auto chord = glm::length(cart(b) - cart(a));
    auto deviation = glm::length(cart(m) - (cart(a) + cart(b)) / 2.0);
    bool split = chord > 1000 || deviation > 0.02 || fine - coarse > std::max(0.00001, fine * 1e-9);
    require(
        !split || depth < 24,
        "Drawing approximation limit reached; split this path into shorter spans.");
    if (split) {
        sample(at, spatial, start, a, middle, m, output, depth + 1);
        sample(at, spatial, middle, m, end, b, output, depth + 1);
    }
    else {
        for (auto [t, p] : std::array<std::pair<double, Vec>, 4>{
                 {{(start + middle) / 2, q1}, {middle, m}, {(middle + end) / 2, q3}, {end, b}}})
        {
            require(
                output.samples.size() < MaxVertices,
                "Drawing exceeds the deterministic sampling budget.");
            output.length += length(output.samples.back().p, p);
            output.samples.push_back({t, p, output.length});
        }
    }
}
/** Interpolate markers on the evaluated path, retaining physical-planar geometry. */
Vec atChainage(Path const& path, double target, Plane const* frame, bool ordinary = false)
{
    auto it = std::lower_bound(
        path.samples.begin(),
        path.samples.end(),
        target,
        [](auto const& p, double n) { return p.chainage < n; });
    if (it == path.samples.begin())
        return it->p;
    if (it == path.samples.end())
        return path.samples.back().p;
    auto const& a = *(it - 1);
    double d = it->chainage - a.chainage;
    if (d <= 0)
        return it->p;
    auto fraction = (target - a.chainage) / d;
    if (ordinary) return a.p*(1-fraction)+it->p*fraction;
    return frame ?
        wgs(cart(a.p) * (1 - fraction) + cart(it->p) * fraction) :
        interpolate(a.p, it->p, fraction);
}
/** Split longitude wrapping for standard GeoJSON without crossing the map. */
Json pathGeometry(Json const& path, bool height)
{
    Json lines = Json::array(), current = Json::array();
    for (auto const& value : path) {
        auto p = read(value);
        if (!current.empty()) {
            auto a = read(current.back());
            if (std::abs(p.x - a.x) > 180) {
                auto edge = a.x > 0 ? 180.0 : -180.0, unwrapped = p.x + (edge > 0 ? 360 : -360),
                     t = (edge - a.x) / (unwrapped - a.x);
                auto b = Vec(edge, a.y + (p.y - a.y) * t, a.z + (p.z - a.z) * t);
                current.push_back(array(b, height));
                if (current.size() >= 2)
                    lines.push_back(current);
                b.x = -edge;
                current = Json::array({array(b, height)});
            }
        }
        current.push_back(value);
    }
    if (current.size() >= 2)
        lines.push_back(current);
    return lines.size() == 1 ?
        Json{{"type", "LineString"}, {"coordinates", lines[0]}} :
        Json{{"type", "MultiLineString"}, {"coordinates", lines}};
}
/** Reject self crossings using an azimuthal frame, including rings enclosing either pole. */
bool validArea(std::vector<std::vector<Vec>> const& rings, Plane const* frame, bool& limited, bool ordinary = false)
{
    if (rings.empty() || rings.front().size() < 4)
        return false;
    // The shared simple-ring predicate compares edge pairs. Keep one object read
    // bounded even when an imported polygon approaches the source vertex limit.
    size_t vertices = 0;
    for (auto const& ring : rings)
        vertices += ring.size();
    if (vertices > 8192) {
        limited = true;
        return false;
    }
    Vec centroid{};
    for (auto p : rings.front())
        centroid += cart({p.x, p.y, 0});
    if (glm::length(centroid) < 1)
        return false;
    Vec anchor = wgs(centroid / double(rings.front().size()));
    std::vector<ndsmath::PlanarRing> planar;
    for (auto const& ring : rings) {
        ndsmath::PlanarRing points;
        for (auto p : ring) {
            if (frame) {
                auto xy = frame->local(p);
                if (std::abs(xy.z) > PlaneToleranceMeters)
                    return false;
                points.push_back({xy.x, xy.y});
            }
            else if (ordinary) points.push_back({p.x, p.y});
            else {
                double az;
                auto distance = geodesic(anchor, p, &az);
                points.push_back(
                    {distance * std::sin(glm::radians(az)), distance * std::cos(glm::radians(az))});
            }
        }
        planar.push_back(std::move(points));
    }
    return ndsmath::validPolygonArea(planar.front(), {planar.begin() + 1, planar.end()});
}
}  // namespace

std::string drawingPlane(std::string const& text)
{
    auto request = Json::parse(text);
    auto action = request.value("action", "horizontal");
    if (action == "horizontal")
        return horizontal(read(request.at("origin"))).dump();
    if (action == "through") {
        auto const& points = request.at("points");
        require(points.size() == 3, "A plane needs three positions.");
        auto a = read(points[0]), ab = cart(read(points[1])) - cart(a),
             ac = cart(read(points[2])) - cart(a);
        require(
            glm::length(ab) > 1e-6 && glm::length(glm::cross(ab, ac)) > 1e-8,
            "Plane points must be distinct and non-collinear.");
        auto u = glm::normalize(ab), n = glm::normalize(glm::cross(ab, ac)), v = glm::cross(n, u);
        return Json{{"origin", array(a)}, {"u", array(u)}, {"v", array(v)}}.dump();
    }
    auto frame = plane(request.at("plane"));
    if (action == "snap") {
        auto origin=frame.local(read(request.at("origin"))), point=frame.local(read(request.at("position")));
        auto delta=point-origin;
        auto angle=std::round(std::atan2(delta.y,delta.x)/(std::numbers::pi/4))*(std::numbers::pi/4);
        auto length=std::hypot(delta.x,delta.y);
        return array(frame.global(origin+Vec{length*std::cos(angle),length*std::sin(angle),0})).dump();
    }
    if (action == "project")
        return array(frame.global(frame.local(read(request.at("position"))))).dump();
    if (action == "local")
        return array(frame.local(read(request.at("position")))).dump();
    if (action == "global") {
        auto p = request.at("position");
        return array(frame.global({p[0], p[1], 0})).dump();
    }
    throw std::invalid_argument("Unknown drawing plane operation.");
}

/** One evaluator for authored shapes, metrics, ticks and transient labels. */
nlohmann::json evaluateDrawingShape(nlohmann::json author, nlohmann::json const& ordinary)
{
    require(
        author.is_object() && author.value("version", 0) == 1,
        "Unsupported drawing authoring version.");
    require(author.contains("space"), "Choose 2D or 3D before enabling authoring or measurements.");
    auto space = author.at("space").get<std::string>();
    require(space == "2d" || space == "3d", "Drawing space must be 2d or 3d.");
    bool spatial = space == "3d";
    auto kind = author.value("kind", "polyline"), unit = author.value("unit", "meters");
    require(unit == "meters" || unit == "miles", "Unknown drawing units.");
    require(
        kind == "polyline" || kind == "polygon" || kind == "ellipse" || kind == "point" ||
            kind == "annotation" || kind == "ordinary",
        "Unknown drawing shape.");
    Json metrics = {
        {"lengthMeters", 0},
        {"areaSquareMeters", nullptr},
        {"perimeterMeters", 0},
        {"anglesDegrees", Json::array()}};
    Json decorations = Json::array(), markerPaths = Json::array(), sampledParts = Json::array(), geometry;
    auto display = author.value("measurements", Json::object());
    require(display.is_object(), "Measurements must be an object.");
    for (auto key : {"distances", "angles", "area", "perimeter", "ticks"})
        if (display.contains(key))
            require(display[key].is_boolean(), "Measurement toggles must be boolean.");
    double interval = display.value("intervalMeters", 100.0);
    require(std::isfinite(interval) && interval > 0, "Marker interval must be positive meters.");
    auto marker = display.value("marker", "point");
    require(marker == "point" || marker == "tick", "Unknown marker style.");
    double fontSize = author.value("fontSize", 13.0);
    require(
        std::isfinite(fontSize) && fontSize >= 8 && fontSize <= 48,
        "Annotation size must be 8–48 pixels.");
    auto decorate = [&](Vec p, std::string text, std::string role = "label")
    {
        if (std::abs(p.y) <= MercatorLimit)
            decorations.push_back(
                {{"position", array(p)}, {"text", text}, {"role", role}, {"fontSize", fontSize}});
    };
    Json parts = Json::array();
    std::optional<Plane> frame;
    if (spatial && author.contains("plane"))
        frame = plane(author["plane"]);
    bool authored = kind != "ordinary", closed = kind == "polygon" || kind == "ellipse";
    if (authored) {
        auto points = author.at("points");
        require(
            points.is_array() && !points.empty() && points.size() <= 10000,
            "An object needs 1–10,000 positions.");
        for (auto const& p : points) {
            read(p);
            require(!spatial || p.size() == 3, "3D authoring requires an explicit height for every position.");
        }
        if (closed && spatial) {
            if (!frame) {
                require(false, "Choose a working plane before creating a 3D polygon or ellipse.");
            }
        }
        if (frame) {
            for (auto const& p : points)
                require(std::abs(frame->local(read(p)).z) <= PlaneToleranceMeters,
                    "Position is outside the working plane (tolerance 0.01 m). Project it explicitly before editing.");
        }
        if (kind == "point" || kind == "annotation") {
            require(points.size() == 1, "A point or annotation needs one position.");
            geometry = {{"type", "Point"}, {"coordinates", points[0]}};
            if (kind == "annotation") {
                auto text = author.value("text", "");
                require(text.size() <= 4096, "Annotation is limited to 4096 UTF-8 bytes.");
                decorate(read(points[0]), text);
            }
        }
        else {
            if (kind == "ellipse") {
                require(
                    points.size() == 2,
                    "Ellipse needs its center and a diagonal radius handle.");
                auto center = read(points[0]);
                double az;
                auto radius = geodesic(center, read(points[1]), &az);
                Vec corner = frame ?
                    frame->local(read(points[1])) :
                    Vec{radius * std::sin(glm::radians(az)),
                        radius * std::cos(glm::radians(az)),
                        0};
                auto origin = frame ? frame->local(center) : Vec{};
                corner -= origin;
                auto rx = std::abs(corner.x), ry = std::abs(corner.y);
                require(rx > 0.001 && ry > 0.001, "Both ellipse radii must be positive.");
                points = Json::array();
                for (int i = 0; i < 256; ++i) {
                    auto t = 2 * std::numbers::pi * i / 256;
                    Vec local{rx * std::cos(t), ry * std::sin(t), 0}, p;
                    if (frame)
                        p = frame->global(origin + local);
                    else {
                        geod_direct(
                            &earth(),
                            center.y,
                            center.x,
                            glm::degrees(std::atan2(local.x, local.y)),
                            glm::length(local),
                            &p.y,
                            &p.x,
                            nullptr);
                        p.z = center.z;
                    }
                    points.push_back(array(p, spatial));
                }
            }
            require(
                points.size() >= (closed ? 3 : 2),
                closed ? "A polygon needs three vertices." : "A polyline needs two vertices.");
            if (closed && points.front() != points.back())
                points.push_back(points.front());
            parts.push_back(
                {{"points", points},
                 {"closed", closed},
                 {"hole", false},
                 {"curves", author.value("curves", Json::object())}});
        }
    }
    else {
        geometry = ordinary;
        std::function<void(Json const&)> collect = [&](Json const& g)
        {
            if (g.is_null())
                return;
            auto type = g.at("type").get<std::string>();
            if (type == "GeometryCollection")
                for (auto const& child : g.at("geometries"))
                    collect(child);
            else if (type == "MultiLineString" || type == "MultiPolygon" || type == "MultiPoint")
                for (auto const& c : g.at("coordinates"))
                    collect({{"type", type.substr(5)}, {"coordinates", c}});
            else if (type == "LineString")
                parts.push_back(
                    {{"points", g.at("coordinates")}, {"closed", false}, {"hole", false}});
            else if (type == "Polygon")
                for (size_t i = 0; i < g.at("coordinates").size(); ++i)
                    parts.push_back(
                        {{"points", g["coordinates"][i]}, {"closed", true}, {"hole", i > 0}});
        };
        collect(ordinary);
    }
    bool missingHeights = false;
    if (spatial && !authored)
        for (auto const& part : parts)
            for (auto const& point : part.at("points")) missingHeights |= point.size() < 3;
    if (missingHeights) for (auto key : {"distances", "angles", "area", "perimeter", "ticks"}) display[key] = false;
    std::vector<std::vector<Vec>> areaRings;
    std::optional<Vec> lastPosition;
    bool areaAvailable = !missingHeights, anyArea = false, areaValidationLimited = false;
    double total = 0, area = 0, perimeter = 0;
    for (auto const& part : parts) {
        auto const& points = part.at("points");
        if (points.empty()) { sampledParts.push_back(Json::array()); continue; }
        bool ring = part.at("closed");
        auto curves = part.value("curves", Json::object());
        require(curves.is_object(), "Curve controls must be keyed by segment index.");
        require(
            curves.empty() || kind == "polyline",
            "Editable curves are supported on polylines.");
        for (auto const& item : curves.items()) {
            size_t index = 0;
            try {
                index = std::stoul(item.key());
            }
            catch (...) {
                throw std::invalid_argument("Invalid curve segment index.");
            }
            require(
                index + 1 < points.size() && std::to_string(index) == item.key(),
                "Curve segment index is outside the object.");
            require(
                item.value().is_array() && item.value().size() == 2,
                "A cubic segment needs two control handles.");
            for(auto const& point:item.value()){
                auto control=read(point);
                require(!spatial || point.size()==3,"3D curve handles need explicit heights.");
                require(!frame || std::abs(frame->local(control).z)<=PlaneToleranceMeters,"Curve handle is outside its working plane (tolerance 0.01 m).");
            }
        }
        lastPosition = read(points.back());
        Path path;
        path.samples.push_back({0, read(points[0]), 0});
        std::vector<Vec> outline;
        for (auto const& p : points)
            outline.push_back(read(p));
        for (size_t i = 1; i < points.size(); ++i) {
            auto a = read(points[i - 1]), b = read(points[i]);
            auto control = curves.value(std::to_string(i - 1), Json(nullptr));
            auto mix = [&](Vec x, Vec y, double t)
            {
                return frame ?
                    frame->global(frame->local(x) * (1 - t) + frame->local(y) * t) :
                    interpolate(x, y, t);
            };
            auto at = [&](double t)
            {
                if (!control.is_null()) {
                    auto c = read(control[0]), d = read(control[1]);
                    return mix(
                        mix(mix(a, c, t), mix(c, d, t), t),
                        mix(mix(c, d, t), mix(d, b, t), t),
                        t);
                }
                if (!authored)
                    return a * (1 - t) + b * t;
                return mix(a, b, t);
            };
            auto previous = path.length;
            sample(at, spatial, 0, a, 1, b, path);
            auto length = path.length - previous;
            path.segments.push_back(length);
            if (display.value("distances", false))
                decorate(at(0.5), label(length, unit));
        }
        for (size_t i = 1; i + 1 < points.size(); ++i) {
            Vec a = read(points[i - 1]), b = read(points[i]), c = read(points[i + 1]);
            auto before = curves.value(std::to_string(i - 1), Json(nullptr)),
                 after = curves.value(std::to_string(i), Json(nullptr));
            if (!before.is_null())
                a = read(before[1]);
            if (!after.is_null())
                c = read(after[0]);
            Json angle = nullptr;
            if (spatial || !authored) {
                auto tangent = [&](Vec target)
                {
                    if (!authored) {
                        auto origin = b;
                        if (!spatial) { origin.z = 0; target.z = 0; }
                        auto delta = target - origin;
                        auto span = std::max({std::abs(delta.x), std::abs(delta.y), std::abs(delta.z) / 111000.0});
                        if (span <= 1e-14) return Vec{};
                        auto v = cart(origin + delta * std::min(1.0, 1e-6 / span)) - cart(origin);
                        if (!spatial) {
                            if (std::abs(origin.y) == 90) return Vec{};
                            auto lon = glm::radians(origin.x), lat = glm::radians(origin.y);
                            Vec normal{std::cos(lat) * std::cos(lon), std::cos(lat) * std::sin(lon), std::sin(lat)};
                            v -= normal * glm::dot(v, normal);
                        }
                        return v;
                    }
                    if (frame)
                        return cart(target) - cart(b);
                    auto extent = std::max(geodesic(b, target), std::abs(target.z - b.z));
                    return extent > 1e-6 ?
                        cart(interpolate(b, target, std::min(1.0, 0.01 / extent))) - cart(b) :
                        Vec{};
                };
                auto u = tangent(a), v = tangent(c);
                auto n = glm::length(u) * glm::length(v);
                if (n > 1e-12)
                    angle = glm::degrees(std::acos(std::clamp(glm::dot(u, v) / n, -1.0, 1.0)));
            }
            else {
                double az, az2;
                if (geodesic(b, a, &az) > 1e-6 && geodesic(b, c, &az2) > 1e-6 && std::abs(b.y) < 90)
                    angle = std::abs(std::remainder(az2 - az, 360.0));
            }
            metrics["anglesDegrees"].push_back(angle);
            if (!angle.is_null() && display.value("angles", false))
                decorate(
                    b,
                    label(angle.get<double>(), "meters")
                            .substr(0, label(angle.get<double>(), "meters").size() - 2) +
                        "°");
        }
        if (display.value("ticks", false)) {
            Json cached = Json::array();
            for (auto const& point : path.samples) cached.push_back({point.chainage,array(point.p)});
            markerPaths.push_back({{"samples",cached},{"length",path.length},{"ordinary",!authored}});
        }
        if (ring) {
            anyArea = true;
            perimeter += path.length;
            if (!part.at("hole").get<bool>() && !areaRings.empty()) {
                if (!validArea(areaRings, frame ? &*frame : nullptr, areaValidationLimited, !authored))
                    areaAvailable = false;
                areaRings.clear();
            }
            areaRings.push_back(outline);
            if (spatial && !frame)
                areaAvailable = false;
            if (!authored && frame)
                for (auto const& point : path.samples)
                    if (std::abs(frame->local(point.p).z) > PlaneToleranceMeters) areaAvailable = false;
            double signedArea = 0;
            if (frame) {
                auto first = frame->local(outline.front());
                for (size_t i = 1; i + 1 < outline.size(); ++i) {
                    auto a = frame->local(outline[i]) - first,
                         b = frame->local(outline[i + 1]) - first;
                    signedArea += a.x * b.y - a.y * b.x;
                }
                signedArea /= 2;
            }
            else {
                geod_polygon p;
                geod_polygon_init(&p, 0);
                if (authored) {
                    for (auto point : outline) geod_polygon_addpoint(&earth(), &p, point.y, point.x);
                } else {
                    // The boundary follows the same coordinate-linear path used by length,
                    // tangents and chainage, rather than endpoint-to-endpoint geodesics.
                    for (auto const& point : path.samples) geod_polygon_addpoint(&earth(), &p, point.p.y, point.p.x);
                }
                geod_polygon_compute(&earth(), &p, 0, 1, &signedArea, nullptr);
            }
            area += (part.at("hole").get<bool>() ? -1 : 1) * std::abs(signedArea);
        }
        total += path.length;
        Json sampled=Json::array();
        for(auto const& point:path.samples)sampled.push_back(array(point.p,true));
        sampledParts.push_back(std::move(sampled));
        if (authored) {
            Json coords = Json::array();
            for (auto s : path.samples)
                coords.push_back(array(s.p, spatial));
            if (ring) {
                coords.back() = coords.front();
                geometry = drawingPolygonGeometry(coords);
            }
            else
                geometry = pathGeometry(coords, spatial);
        }
    }
    if (!areaRings.empty() &&
        !validArea(areaRings, frame ? &*frame : nullptr, areaValidationLimited, !authored))
        areaAvailable = false;
    metrics["lengthMeters"] = missingHeights ? Json(nullptr) : Json(total);
    metrics["perimeterMeters"] = missingHeights ? Json(nullptr) : Json(perimeter);
    if (anyArea && areaAvailable)
        metrics["areaSquareMeters"] = std::max(0.0, area);
    if (anyArea && !areaAvailable)
        metrics["warning"] = areaValidationLimited ?
            "Area unavailable: polygon validation exceeds 8,192 vertices. Geometry is preserved." :
            "Area unavailable: provide a valid simple polygon and a plane for 3D area.";
    if (missingHeights) {
        metrics["warning"] = "3D measurements unavailable: some positions have no height. Choose an explicit elevation or measure in 2D.";
        for (auto& angle : metrics["anglesDegrees"]) angle = nullptr;
    }
    auto anglesAvailable = !metrics["anglesDegrees"].empty() &&
        std::ranges::none_of(metrics["anglesDegrees"], [](Json const& value) { return value.is_null(); });
    metrics["availability"] = {
        {"length", {{"available", !missingHeights}, {"reason", missingHeights ? "missing_height" : ""}}},
        {"area", {{"available", anyArea && areaAvailable}, {"reason", !anyArea ? "not_polygon" :
            areaAvailable ? "" : missingHeights ? "missing_height" : areaValidationLimited ? "validation_limit" : spatial && !frame ? "missing_plane" : "invalid_polygon_or_plane"}}},
        {"angles", {{"available", anglesAvailable}, {"reason", anglesAvailable ? "" :
            missingHeights ? "missing_height" : metrics["anglesDegrees"].empty() ? "insufficient_points" : "degenerate_or_undefined_orientation"}}}
    };
    if (lastPosition) {
        auto p = *lastPosition;
        std::vector<std::string> labels;
        if (display.value("distances", false))
            labels.push_back("Total " + label(total, unit));
        if (display.value("area", false) && anyArea && areaAvailable)
            labels.push_back((spatial ? "Planar " : "") + label(area, unit, true));
        if (display.value("perimeter", false) && anyArea)
            labels.push_back("Perimeter " + label(perimeter, unit));
        std::string summary;
        for (auto const& text : labels) {
            if (!summary.empty())
                summary += " · ";
            summary += text;
        }
        if (!summary.empty())
            decorate(p, summary);
    }
    Json presentation=geometry;
    if(!authored){
        size_t partIndex=0;
        std::function<void(Json&)> replace=[&](Json& g){
            if(g.is_null())return;
            auto type=g.value("type", "");
            if(type=="GeometryCollection")for(auto& child:g["geometries"])replace(child);
            else if(type=="LineString")g["coordinates"]=sampledParts.at(partIndex++);
            else if(type=="MultiLineString"||type=="Polygon")for(auto& part:g["coordinates"])part=sampledParts.at(partIndex++);
            else if(type=="MultiPolygon")for(auto& polygon:g["coordinates"])for(auto& ring:polygon)ring=sampledParts.at(partIndex++);
        };
        replace(presentation);
    }
    if (!markerPaths.empty()) {
        auto markers = drawingMarkerDecorations(markerPaths, author);
        for (auto& decoration : markers["decorations"]) decorations.push_back(std::move(decoration));
        metrics["markerLimit"] = markers["limited"];
    }
    return {
        {"presentationGeometry", presentation},
        {"markerPaths", markerPaths},
        {"authoring", author},
        {"geometry", geometry},
        {"metrics", metrics},
        {"decorations", decorations}};
}

/** Cull chainage intervals on cached paths and draw bounded, tangent-oriented marker strokes. */
nlohmann::json drawingMarkerDecorations(Json const& paths, Json const& author, Json const& viewport)
{
    auto display=author.value("measurements",Json::object());
    double interval=display.value("intervalMeters",100.0);
    Json decorations=Json::array();
    size_t remaining=1000;
    bool limited=false;
    std::optional<Plane> frame;
    if(author.contains("plane"))frame=plane(author["plane"]);
    bool visible=viewport.is_object();
    double mpp=visible?viewport.value("metersPerPixel",1.0):std::clamp(interval*.015,.2,100.0);
    if(!std::isfinite(mpp)||mpp<=0)mpp=1;
    for(auto const& cached:paths){
        Path path;
        for(auto const& item:cached["samples"])path.samples.push_back({0,read(item[1]),item[0].get<double>()});
        if(path.samples.empty())continue;
        path.length=cached["length"];
        bool ordinary=cached.value("ordinary",false);
        std::vector<std::pair<double,double>> ranges;
        if(!visible)ranges.emplace_back(0,path.length);
        else {
            double west=viewport.at("west"),south=viewport.at("south");
            double east=west+viewport.at("width").get<double>(),north=south+viewport.at("height").get<double>();
            // Liang–Barsky clipping on small cached geographic spans; never iterate billions of markers.
            for(size_t i=1;i<path.samples.size();++i){
                auto const& a=path.samples[i-1];auto const& b=path.samples[i];
                for(int wrap=-1;wrap<=1;++wrap){
                    double x=a.p.x+wrap*360.0,dx=std::remainder(b.p.x-a.p.x,360.0),dy=b.p.y-a.p.y,lo=0,hi=1;
                    auto clip=[&](double p,double q){if(std::abs(p)<1e-14)return q>=0;double t=q/p;if(p<0)lo=std::max(lo,t);else hi=std::min(hi,t);return lo<=hi;};
                    if(clip(-dx,x-west)&&clip(dx,east-x)&&clip(-dy,a.p.y-south)&&clip(dy,north-a.p.y)){
                        double from=a.chainage+(b.chainage-a.chainage)*lo,to=a.chainage+(b.chainage-a.chainage)*hi;
                        if(!ranges.empty()&&from<=ranges.back().second+1e-6)ranges.back().second=std::max(ranges.back().second,to);
                        else ranges.emplace_back(from,to);
                    }
                }
            }
        }
        double count=0;
        for(auto range:ranges)count+=std::max(0.0,std::floor(range.second/interval)-std::max(1.0,std::ceil(range.first/interval))+1);
        double stride=std::max({1.0,std::ceil(count/std::max(size_t{1},remaining)),std::ceil(7*mpp/interval)});
        limited|=stride>1;
        for(auto range:ranges){
            auto first=std::max(1.0,std::ceil(range.first/interval));
            double index=std::ceil(first/stride)*stride;
            for(;remaining&&index*interval<=range.second+1e-7;index+=stride){
                double chainage=index*interval;
                auto position=atChainage(path,chainage,frame?&*frame:nullptr,ordinary);
                if(std::abs(position.y)>MercatorLimit)continue;
                Json decoration{{"position",array(position)},{"role",display.value("marker","point")},
                    {"fontSize",author.value("fontSize",13.0)},{"text",std::fmod(index,5.0)==0?label(chainage,author.value("unit","meters")):""}};
                if(display.value("marker","point")=="tick"){
                    auto before=atChainage(path,std::max(0.0,chainage-.1),frame?&*frame:nullptr,ordinary);
                    auto after=atChainage(path,std::min(path.length,chainage+.1),frame?&*frame:nullptr,ordinary);
                    Vec a,b;
                    if(frame){
                        auto direction=glm::cross(frame->normal,cart(after)-cart(before));
                        if(glm::length(direction)<1e-12)continue;
                        direction=glm::normalize(direction)*3.0*mpp;a=wgs(cart(position)-direction);b=wgs(cart(position)+direction);
                    }else{
                        double az;geodesic(before,after,&az);a=b=position;
                        geod_direct(&earth(),position.y,position.x,az-90,3*mpp,&a.y,&a.x,nullptr);
                        geod_direct(&earth(),position.y,position.x,az+90,3*mpp,&b.y,&b.x,nullptr);
                    }
                    decoration["line"]={array(a),array(b)};
                }
                decorations.push_back(std::move(decoration));--remaining;
            }
        }
    }
    return {{"decorations",decorations},{"limited",limited}};
}

/** Native vertex edits retain curve indexing and qualify geographic splits against the source curve. */
nlohmann::json editDrawingControls(Json author, Json const& operation)
{
    auto& points = author.at("points");
    auto index = operation.at("index").get<size_t>();
    auto type = operation.at("type").get<std::string>();
    require(points.is_array() && index < points.size(), "Vertex index is outside the object.");
    auto curves = author.value("curves", Json::object());
    std::optional<Plane> frame;
    if (author.contains("plane")) frame = plane(author["plane"]);
    auto mix = [&](Vec a, Vec b, double t) {
        return frame ? frame->global(frame->local(a) * (1-t) + frame->local(b) * t) : interpolate(a, b, t);
    };
    bool height = author.at("space") == "3d";
    if (type == "curve") {
        require(author.at("kind") == "polyline" && index+1 < points.size(), "Choose a polyline segment.");
        if (operation.value("enabled", true)) {
            auto a = read(points[index]), b = read(points[index+1]);
            curves[std::to_string(index)] = {array(mix(a,b,1.0/3),height), array(mix(a,b,2.0/3),height)};
        } else curves.erase(std::to_string(index));
        author["curves"] = curves;
        return author;
    }
    Json updated = Json::object();
    if (type == "deleteVertex") {
        for (auto const& item : curves.items()) {
            auto segment = std::stoul(item.key());
            if (segment == index || segment+1 == index) continue;
            updated[std::to_string(segment > index ? segment-1 : segment)] = item.value();
        }
        points.erase(index);
    } else {
        require(index+1 < points.size() || author.at("kind") == "polygon", "Choose a segment to insert a vertex.");
        auto a = read(points[index]), b = read(points[(index+1)%points.size()]);
        auto control = curves.value(std::to_string(index), Json(nullptr));
        Vec middle = mix(a,b,.5);
        for (auto const& item : curves.items()) {
            auto segment = std::stoul(item.key());
            if (segment != index) updated[std::to_string(segment > index ? segment+1 : segment)] = item.value();
        }
        if (!control.is_null()) {
            auto c = read(control[0]), d = read(control[1]);
            auto ac = mix(a,c,.5), cd = mix(c,d,.5), db = mix(d,b,.5);
            auto left = mix(ac,cd,.5), right = mix(cd,db,.5);
            middle = mix(left,right,.5);
            auto cubic = [&](Vec p, Vec q, Vec r, Vec u, double t) {
                return mix(mix(mix(p,q,t),mix(q,r,t),t),mix(mix(q,r,t),mix(r,u,t),t),t);
            };
            // Planar de Casteljau is exact. Geographic interpolation is not affine;
            // qualify its adaptive samples rather than claiming the Euclidean identity.
            Path original;
            original.samples.push_back({0,a,0});
            sample([&](double t){return cubic(a,c,d,b,t);}, height, 0,a,1,b,original);
            for (auto const& point : original.samples) {
                auto split = point.t <= .5 ? cubic(a,ac,left,middle,point.t*2) : cubic(middle,right,db,b,point.t*2-1);
                require(glm::length(cart(split)-cart(point.p)) <= .01,
                    "This geographic curve cannot be split within 1 cm. Convert it to sampled geometry before inserting here.");
            }
            updated[std::to_string(index)] = {array(ac,height),array(left,height)};
            updated[std::to_string(index+1)] = {array(right,height),array(db,height)};
        }
        points.insert(points.begin()+index+1, array(middle,height));
    }
    author["curves"] = updated;
    return author;
}

std::string drawingEvaluate(std::string const& text)
{
    auto request = Json::parse(text);
    if (request.value("action", "") == "capabilities")
        return Json{{"spaces", {"2d", "3d"}}, {"planeToleranceMeters", PlaneToleranceMeters},
            {"maxAuthoringPoints", 10000}, {"maxSamples", MaxVertices}, {"maxAreaVertices", 8192},
            {"mercatorLatitudeLimit", MercatorLimit}, {"maxMarkers", 1000},
            {"pathSemantics", {"authored-geodesic", "physical-plane", "imported-coordinate-linear"}}}.dump();
    if (request.value("action", "") == "segment") {
        auto author=request.at("authoring"), points=author.at("points");
        require(author.value("kind", "")=="polyline" && points.size()>=2,"Choose a polyline segment.");
        auto target=cart(read(request.at("position")));
        double best=std::numeric_limits<double>::infinity();size_t selected=0;
        for(size_t index=0;index+1<points.size();++index){
            auto part=author;part["points"]={points[index],points[index+1]};part["measurements"]=Json::object();part["curves"]=Json::object();
            if(author.value("curves",Json::object()).contains(std::to_string(index)))part["curves"]["0"]=author["curves"][std::to_string(index)];
            auto shape=evaluateDrawingShape(part);
            std::function<void(Json const&)> visit=[&](Json const& geometry){
                if(geometry.value("type", "")=="GeometryCollection"){for(auto const& child:geometry["geometries"])visit(child);return;}
                auto const& coordinates=geometry.at("coordinates");
                for(size_t i=1;i<coordinates.size();++i){auto a=cart(read(coordinates[i-1])),b=cart(read(coordinates[i])),v=b-a;auto length=glm::dot(v,v);auto t=length>0?std::clamp(glm::dot(target-a,v)/length,0.0,1.0):0.0;auto distance=glm::length(target-a-v*t);if(distance<best){best=distance;selected=index;}}
            };
            visit(shape["geometry"]);
        }
        return Json{{"index",selected},{"distanceMeters",best}}.dump();
    }
    if (request.value("action", "") == "controls") {
        auto a = read(request.at("points")[0]), b = read(request.at("points")[1]);
        if (request.contains("plane") && !request["plane"].is_null()) {
            auto frame = plane(request["plane"]);
            auto u = frame.local(a), v = frame.local(b);
            return Json::array({array(frame.global(u + (v - u) / 3.0)),
                                array(frame.global(u + (v - u) * 2.0 / 3.0))})
                .dump();
        }
        return Json::array({array(interpolate(a, b, 1.0 / 3)), array(interpolate(a, b, 2.0 / 3))})
            .dump();
    }
    return evaluateDrawingShape(request.at("authoring"), request.value("geometry", Json(nullptr)))
        .dump();
}
}  // namespace erdblick
