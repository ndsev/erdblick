#include "drawing.h"
#include "mapget/model/geojson-import.h"
#include "mapget/model/mapschema.h"
#include "mapget/model/stringpool.h"
#include "simfil/model/json.h"
#include <algorithm>
#include <charconv>
#include <cmath>
#include <functional>
#include <limits>
#include <map>
#include <regex>
#include <set>
#include <sstream>
#include <stdexcept>

namespace erdblick
{
namespace
{
using Json = nlohmann::json;
constexpr size_t MaxBytes = 32U * 1024U * 1024U;
constexpr size_t MaxRows = 100000;
constexpr size_t MaxVertices = 1000000;
constexpr size_t MaxDepth = 64;
constexpr double MercatorLatitude = 85.0511287798066;
constexpr std::string_view FeatureType = "DrawingFeature";
constexpr std::string_view GeneratedMember = "erdblick:generated";

/** Fail with a source-addressable diagnostic before publishing a candidate. */
[[noreturn]] void invalid(std::string const& path, std::string const& message)
{
    throw std::invalid_argument(path + ": " + message);
}

/** Validate geographic input independently of a particular map projection. */
void position(double longitude, double latitude, double altitude = 0)
{
    if (!std::isfinite(longitude) || !std::isfinite(latitude) || !std::isfinite(altitude) ||
        longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90)
        invalid("Position", "expected finite WGS84 longitude [-180, 180], latitude [-90, 90], and height");
}

/** Reject duplicate JSON members and excessive nesting before adaptation. */
Json parseJson(std::string const& text)
{
    std::vector<std::set<std::string>> keys;
    return Json::parse(text, [&keys](int depth, Json::parse_event_t event, Json& value) {
        if (depth > static_cast<int>(MaxDepth)) invalid("JSON", "nesting exceeds 64 levels");
        if (event == Json::parse_event_t::object_start) keys.emplace_back();
        if (event == Json::parse_event_t::key && !keys.back().insert(value.get<std::string>()).second)
            invalid("JSON", "duplicate member '" + value.get<std::string>() + "'");
        if (event == Json::parse_event_t::object_end) keys.pop_back();
        return true;
    });
}

/** Reject property values the native scalar model cannot represent faithfully. */
void validateProperties(Json const& value, std::string const& path)
{
    if (value.is_number_unsigned() && value.get<uint64_t>() > uint64_t(std::numeric_limits<int64_t>::max()))
        invalid(path, "integer property exceeds the native signed 64-bit range");
    if (value.is_number_float() && !std::isfinite(value.get<double>()))
        invalid(path, "numeric property must be finite");
    if (value.is_structured())
        for (auto const& item : value.items()) validateProperties(item.value(), path + "/" + item.key());
}

/** Preserve arbitrary JSON as ordinary data, owning string values outside the field-name dictionary. */
simfil::ModelNode::Ptr plainJson(Json const& value, simfil::ModelPool& model)
{
    if (value.is_null()) return model.resolve<simfil::ModelNode>(
        simfil::ModelNodeAddress{simfil::Model::Null, 1}, simfil::ScalarValueType{});
    if (value.is_boolean()) return model.newSmallValue(value.get<bool>());
    if (value.is_string()) {
        auto node = model.tryNewValue(std::string_view(value.get_ref<std::string const&>()));
        if (!node) throw std::runtime_error(node.error().message);
        return *node;
    }
    if (value.is_number()) {
        auto node = value.is_number_float() ? model.tryNewValue(value.get<double>()) : model.tryNewValue(value.get<int64_t>());
        if (!node) throw std::runtime_error(node.error().message);
        return *node;
    }
    if (value.is_array()) {
        auto array = model.tryNewArray(value.size(), true);
        if (!array) throw std::runtime_error(array.error().message);
        for (auto const& child : value) (*array)->append(plainJson(child, model));
        return *array;
    }
    auto object = model.tryNewObject(value.size(), true);
    if (!object) throw std::runtime_error(object.error().message);
    for (auto const& [key, child] : value.items()) {
        auto added = (*object)->addField(key, plainJson(child, model));
        if (!added) throw std::runtime_error(added.error().message);
    }
    return *object;
}

/** Parse a complete decimal token with no locale or partial-number acceptance. */
double number(std::string_view token, std::string const& path)
{
    if (!token.empty() && token.front() == '+') token.remove_prefix(1);
    double result = 0;
    auto const parsed = std::from_chars(token.data(), token.data() + token.size(), result);
    if (token.empty() || parsed.ec != std::errc{} || parsed.ptr != token.data() + token.size() ||
        !std::isfinite(result)) invalid(path, "expected a finite decimal number");
    return result;
}

/** Recognize optional height; nonnumeric descriptions remain ordinary text. */
bool numericToken(std::string const& token)
{
    static std::regex const pattern(R"([+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)");
    return std::regex_match(token, pattern);
}

/** Flatten only runtime geometry, preserving every component and hole in file order. */
void geometryParts(Json const& geometry, Json& parts, size_t& vertices,
                   std::string const& path, size_t depth = 0)
{
    if (geometry.is_null()) return;
    if (depth > MaxDepth || !geometry.is_object() || !geometry.contains("type") || !geometry["type"].is_string())
        invalid(path, "expected a geometry object with a type");
    if (geometry.contains("crs")) invalid(path, "legacy CRS is unsupported; convert to WGS84 GeoJSON");
    auto const type = geometry["type"].get<std::string>();
    if (type == "GeometryCollection") {
        if (!geometry.contains("geometries") || !geometry["geometries"].is_array())
            invalid(path, "GeometryCollection requires a geometries array");
        for (size_t i = 0; i < geometry["geometries"].size(); ++i)
            geometryParts(geometry["geometries"][i], parts, vertices,
                          path + "/geometries/" + std::to_string(i), depth + 1);
        return;
    }
    if (!geometry.contains("coordinates") || !geometry["coordinates"].is_array())
        invalid(path, "geometry requires a coordinates array");
    auto const& coordinates = geometry["coordinates"];
    if (type == "MultiPoint" || type == "MultiLineString" || type == "MultiPolygon") {
        for (size_t i = 0; i < coordinates.size(); ++i)
            geometryParts({{"type", type.substr(5)}, {"coordinates", coordinates[i]}}, parts, vertices,
                          path + "/coordinates/" + std::to_string(i), depth + 1);
        return;
    }
    auto checkPosition = [&](Json const& p) {
        if (!p.is_array() || (p.size() != 2 && p.size() != 3) ||
            !std::ranges::all_of(p, [](auto const& n) { return n.is_number(); }))
            invalid(path, "positions must contain two or three numbers");
        position(p[0].get<double>(), p[1].get<double>(), p.size() == 3 ? p[2].get<double>() : 0);
        if (++vertices > MaxVertices) invalid(path, "document exceeds 1,000,000 vertices");
    };
    if (type != "Point" && type != "LineString" && type != "Polygon")
        invalid(path, "unsupported geometry type '" + type + "'");
    // Empty coordinates remain listed and editable without inventing a point.
    if (coordinates.empty()) return;
    if (type == "Point") checkPosition(coordinates);
    else if (type == "LineString") {
        if (coordinates.size() < 2) invalid(path, "a line needs at least two positions");
        for (auto const& p : coordinates) checkPosition(p);
    } else if (type == "Polygon") {
        for (auto const& ring : coordinates) {
            if (!ring.is_array() || ring.size() < 4 || ring.front() != ring.back())
                invalid(path, "polygon rings need at least four positions and exact closure");
            for (auto const& p : ring) checkPosition(p);
        }
    } else invalid(path, "unsupported geometry type '" + type + "'");
    // Omit foreign geometry members, including mapget decorations.
    parts.push_back({{"type", type}, {"coordinates", coordinates}});
}

/** Visit validated geometry coordinates without interpreting property arrays. */
void eachPosition(Json const& geometry, std::function<void(Json const&)> const& visit)
{
    if (geometry.is_null()) return;
    auto const type = geometry.at("type").get<std::string>();
    if (type == "GeometryCollection") {
        for (auto const& child : geometry.at("geometries")) eachPosition(child, visit);
    } else if (type == "Point") visit(geometry.at("coordinates"));
    else if (type == "LineString") for (auto const& p : geometry.at("coordinates")) visit(p);
    else if (type == "Polygon")
        for (auto const& ring : geometry.at("coordinates")) for (auto const& p : ring) visit(p);
}

/** Clip presentation segments, retaining source coordinates and interpolated height. */
void visibleLineParts(Json const& coordinates, Json& parts)
{
    Json run = Json::array();
    auto flush = [&] {
        if (run.size() >= 2) parts.push_back({{"type", "LineString"}, {"coordinates", run}});
        run = Json::array();
    };
    for (size_t i = 1; i < coordinates.size(); ++i) {
        auto const& a = coordinates[i - 1];
        auto const& b = coordinates[i];
        double latitude = a[1], delta = b[1].get<double>() - latitude;
        double first = 0, last = 1;
        if (delta == 0) {
            if (std::abs(latitude) > MercatorLatitude) { flush(); continue; }
        } else {
            double lower = (-MercatorLatitude - latitude) / delta;
            double upper = (MercatorLatitude - latitude) / delta;
            first = std::max(0.0, std::min(lower, upper));
            last = std::min(1.0, std::max(lower, upper));
            if (first >= last) { flush(); continue; }
        }
        auto interpolate = [&](double t) {
            if (t == 0) return a;
            if (t == 1) return b;
            Json point = Json::array();
            for (size_t dimension = 0; dimension < std::max(a.size(), b.size()); ++dimension) {
                double from = dimension < a.size() ? a[dimension].get<double>() : 0;
                double to = dimension < b.size() ? b[dimension].get<double>() : 0;
                point.push_back(std::lerp(from, to, t));
            }
            point[1] = std::clamp(point[1].get<double>(), -MercatorLatitude, MercatorLatitude);
            return point;
        };
        auto start = interpolate(first), end = interpolate(last);
        if (!run.empty() && run.back() != start) flush();
        if (run.empty()) run.push_back(start);
        if (run.back() != end) run.push_back(end);
        if (last < 1) flush();
    }
    flush();
}

/** Serialize a checked model artifact with explicit failure propagation. */
template <typename Model> void writeModel(Model& model, SharedUint8Array& out)
{
    std::ostringstream stream;
    if (auto result = model.write(stream); !result) throw std::runtime_error(result.error().message);
    out.writeToArray(stream.str());
}

/** Reject degenerate or crossing joins without reordering selected file records. */
Json joinedGeometry(std::vector<Json> points)
{
    if (points.size() < 3 || points.size() > 5000)
        invalid("Join", "select between 3 and 5,000 distinct positions");
    std::set<std::pair<double, double>> distinct;
    for (size_t i = 0; i < points.size(); ++i) {
        double x = points[i][0], y = points[i][1];
        if (!distinct.emplace(x, y).second) invalid("Join", "selected positions must be distinct");
        if (i) {
            double const previous = points[i - 1][0];
            while (x - previous > 180) x -= 360;
            while (x - previous < -180) x += 360;
            points[i][0] = x;
        }
    }
    auto cross = [](Json const& a, Json const& b, Json const& c) {
        return (b[0].get<double>() - a[0].get<double>()) * (c[1].get<double>() - a[1].get<double>()) -
               (b[1].get<double>() - a[1].get<double>()) * (c[0].get<double>() - a[0].get<double>());
    };
    double area = 0;
    for (size_t i = 0; i < points.size(); ++i) {
        auto const& a = points[i];
        auto const& b = points[(i + 1) % points.size()];
        area += a[0].get<double>() * b[1].get<double>() - b[0].get<double>() * a[1].get<double>();
        for (size_t j = i + 2; j < points.size(); ++j) {
            if (i == 0 && j + 1 == points.size()) continue;
            auto const& c = points[j];
            auto const& d = points[(j + 1) % points.size()];
            if (std::max(a[0].get<double>(), b[0].get<double>()) < std::min(c[0].get<double>(), d[0].get<double>()) ||
                std::max(c[0].get<double>(), d[0].get<double>()) < std::min(a[0].get<double>(), b[0].get<double>()) ||
                std::max(a[1].get<double>(), b[1].get<double>()) < std::min(c[1].get<double>(), d[1].get<double>()) ||
                std::max(c[1].get<double>(), d[1].get<double>()) < std::min(a[1].get<double>(), b[1].get<double>())) continue;
            if (cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0)
                invalid("Join", "selected positions form a self-intersecting polygon");
        }
    }
    if (std::abs(area) < 1e-14) invalid("Join", "selected positions form a degenerate polygon");
    for (auto& point : points) point[0] = std::remainder(point[0].get<double>(), 360.0);
    points.push_back(points.front());
    return {{"type", "Polygon"}, {"coordinates", Json::array({points})}};
}

/** Normalize only structured edits; untouched imported GeoJSON retains its exact source. */
/** Unknown authoring extensions remain ordinary GeoJSON and are never regenerated. */
bool recognizedAuthoring(Json const& feature)
{
    auto found = feature.find("erdblick:drawing");
    if (found == feature.end() || !found->is_object()) return false;
    auto version = found->find("version"), kind = found->find("kind");
    if (version == found->end() || !version->is_number_integer() || *version != 1 ||
        kind == found->end() || !kind->is_string()) return false;
    for (auto known : {"point", "annotation", "polyline", "polygon", "ellipse", "ordinary"})
        if (*kind == known) return true;
    return false;
}

Json featureCollection(std::string const& source)
{
    auto root = parseJson(source);
    if (root.value("type", "") != "FeatureCollection") {
        if (root.value("type", "") != "Feature")
            root = {{"type", "Feature"}, {"properties", nullptr}, {"geometry", std::move(root)}};
        root = {{"type", "FeatureCollection"}, {"features", Json::array({std::move(root)})}};
    }
    // Integers up to uint64_t stay exact in native JSON. Larger numeric IDs need a string
    // before reserialization; keep the original source/model intact on this diagnostic.
    for (auto const& feature : root.at("features"))
        if (feature.contains("id") && feature["id"].is_number_float() &&
            std::abs(feature["id"].get<double>()) > 9007199254740991.0)
            invalid("Edit", "convert oversized numeric feature IDs to strings in the GeoJSON editor first");
    return root;
}

/** Bind the app's channel DTO to mapget; model validation/evaluation remains authoritative. */
mapget::FeatureLayerFilterRequest filterRequest(Json const& value)
{
    mapget::FeatureLayerFilterRequest result;
    result.filterId_ = value.at("filterId").get<std::string>();
    result.generation_ = value.at("generation").get<uint64_t>();
    for (auto const& raw : value.at("channels")) {
        mapget::FeatureLayerFilterChannel channel;
        channel.channelId_ = raw.at("channelId").get<std::string>();
        auto const scope = raw.value("scope", "feature");
        if (scope == "relation" || raw.contains("relation"))
            invalid("Style", "relation channels are unavailable for virtual drawing sources");
        if (scope != "feature" && scope != "attribute" && scope != "auto") invalid("Style", "invalid filter scope");
        channel.scope_ = scope == "attribute" ? mapget::FeatureLayerFilterScope::Attribute :
                         scope == "auto" ? mapget::FeatureLayerFilterScope::Auto : mapget::FeatureLayerFilterScope::Feature;
        channel.rewrite_ = raw.value("rewrite", false);
        channel.featureTypes_ = raw.value("featureTypes", std::vector<std::string>{});
        channel.featureFields_ = raw.value("featureFields", std::vector<std::string>{});
        channel.entryFields_ = raw.value("entryFields", std::vector<std::string>{});
        channel.geometryTypes_ = raw.value("geometryTypes", uint32_t{0xffffffff});
        if (raw.contains("schemaId")) channel.schemaId_ = raw["schemaId"].get<std::string>();
        if (raw.contains("featureFilter")) channel.featureFilter_ = raw["featureFilter"].get<std::string>();
        if (raw.contains("entryFilter")) channel.entryFilter_ = raw["entryFilter"].get<std::string>();
        if (raw.contains("geometryName") && raw["geometryName"] != "*") channel.geometryName_ = raw["geometryName"].get<std::string>();
        if (raw.contains("pointCloudMaxPoints")) channel.pointCloudMaxPoints_ = raw["pointCloudMaxPoints"].get<uint32_t>();
        if (raw.contains("group")) {
            auto const& group = raw["group"];
            if (group.at("kind") != "point-grid") invalid("Style", "unsupported grouping");
            auto origin = group.value("origin", std::array<double, 3>{0, 0, 0});
            auto cell = group.at("cellSize").get<std::array<double, 3>>();
            channel.group_ = mapget::FeatureLayerPointGridGroup{{origin[0], origin[1], origin[2]}, {cell[0], cell[1], cell[2]}};
        }
        result.channels_.push_back(std::move(channel));
    }
    auto const bindings = value.value("bindings", Json::object());
    for (auto const& item : bindings.items()) {
        auto const& v = item.value();
        if (v.is_null()) result.bindings_[item.key()] = std::monostate{};
        else if (v.is_boolean()) result.bindings_[item.key()] = v.get<bool>();
        else if (v.is_number_integer()) result.bindings_[item.key()] = v.get<int64_t>();
        else if (v.is_number_float()) result.bindings_[item.key()] = v.get<double>();
        else if (v.is_string()) result.bindings_[item.key()] = v.get<std::string>();
        else invalid("Style", "bindings must be scalar");
    }
    return result;
}
}

DrawingSource::DrawingSource(std::string mapId)
{
    auto schema = std::make_shared<mapget::MapSchema>(mapget::MapFormat{"Drawing", "1", {}});
    auto layerSchema = schema->newLayer("Drawing", mapget::LayerType::Features);
    auto properties = schema->newObjectType();
    auto drawing = schema->newObjectType();
    drawing.setOpen(true);
    auto string = schema->newScalarType(simfil::SchemaType::Kind::String);
    auto floating = schema->newScalarType(simfil::SchemaType::Kind::Float);
    auto integer = schema->newScalarType(simfil::SchemaType::Kind::Int);
    for (auto name : {"description", "role", "recordId", "externalId"}) drawing.addField(name, string);
    for (auto name : {"longitude", "latitude", "heightCm"}) drawing.addField(name, floating);
    drawing.addField("ordinal", integer);
    properties.addField("drawing", drawing);
    properties.addField("user", schema->newType(simfil::SchemaType::Kind::Any));
    auto feature = layerSchema->newFeature(mapget::FeatureTypeInfo::fromJson({
        {"name", FeatureType}, {"uniqueIdCompositions",
            Json::array({Json::array({{{"partId", "record"}, {"datatype", "U64"}}})})}}), properties);
    auto decoration = schema->newAttribute("drawing-decoration", "DrawingDecoration");
    decoration.addField("text", string); decoration.addField("role", string);
    layerSchema->bindAttribute(decoration, FeatureType, "DrawingDecorations", "Decoration");
    layerSchema->setRootSchema(feature.id());
    schema->finalize();
    metadata_.mapId_ = mapId;
    metadata_.stringPoolId_ = mapId;
    metadata_.layers_["Drawing"] = mapget::LayerInfo::fromJson({
        {"layerId", "Drawing"}, {"type", "Features"}, {"partitionKind", "object"},
        {"tileAssociationLevel", 0}, {"defaultVisible", true}});
    metadata_.setMapSchema(schema);
    strings_ = std::make_shared<mapget::StringPool>(mapId);
    install(R"({"type":"FeatureCollection","features":[]})");
}

std::string drawingCoordinatesToGeoJson(std::string const& text)
{
    if (text.size() > MaxBytes) invalid("File", "maximum supported input is 32 MiB");
    static_cast<void>(Json(text).dump());
    Json result = Json::array();
    size_t begin = text.starts_with("\xef\xbb\xbf") ? 3 : 0;
    size_t line = 1;
    while (begin < text.size()) {
        size_t end = text.find('\n', begin);
        if (end == std::string::npos) end = text.size();
        size_t contentEnd = end;
        if (contentEnd > begin && text[contentEnd - 1] == '\r') --contentEnd;
        size_t cursor = begin;
        auto skipSpace = [&] { while (cursor < contentEnd && (text[cursor] == ' ' || text[cursor] == '\t')) ++cursor; };
        auto token = [&] {
            skipSpace();
            auto start = cursor;
            while (cursor < contentEnd && text[cursor] != ' ' && text[cursor] != '\t') ++cursor;
            return text.substr(start, cursor - start);
        };
        skipSpace();
        if (cursor < contentEnd) {
            auto path = "Line " + std::to_string(line);
            double longitude = number(token(), path + ", longitude");
            double latitude = number(token(), path + ", latitude");
            skipSpace();
            auto descriptionStart = cursor;
            auto third = token();
            double height = 0;
            if (numericToken(third)) { height = number(third, path + ", height"); skipSpace(); descriptionStart = cursor; }
            if (descriptionStart == contentEnd) invalid(path, "a description is required; use \"\" for an empty description");
            std::string description = text.substr(descriptionStart, contentEnd - descriptionStart);
            if (description.front() == '"') {
                auto parsed = parseJson(description);
                if (!parsed.is_string()) invalid(path, "quoted description must be a JSON string");
                description = parsed.get<std::string>();
            }
            try { position(longitude, latitude, height / 100); }
            catch (std::exception const& error) { invalid(path, error.what()); }
            result.push_back({{"type", "Feature"},
                {"geometry", {{"type", "Point"}, {"coordinates", {longitude, latitude, height / 100}}}},
                {"properties", {{"description", description}}}});
            if (result.size() > MaxRows) invalid(path, "document exceeds 100,000 entries");
        }
        begin = end + 1;
        ++line;
    }
    return Json{{"type", "FeatureCollection"}, {"features", std::move(result)}}.dump() + "\n";
}

std::vector<DrawingSource::Row> DrawingSource::parseGeoJson(std::string const& text) const
{
    auto root = parseJson(text);
    if (!root.is_object()) invalid("GeoJSON", "root must be an object");
    if (root.contains("crs")) invalid("GeoJSON", "legacy CRS is unsupported; convert to WGS84 GeoJSON");
    auto const type = root.value("type", "");
    Json features;
    if (type == "FeatureCollection") features = root.at("features");
    else if (type == "Feature") features = Json::array({root});
    else features = Json::array({{{"type", "Feature"}, {"properties", nullptr}, {"geometry", root}}});
    if (!features.is_array() || features.size() > MaxRows) invalid("GeoJSON", "features must be an array of at most 100,000 entries");
    std::vector<Row> result;
    size_t vertices = 0, renderedVertices = 0;
    for (size_t index = 0; index < features.size(); ++index) {
        auto const& feature = features[index];
        auto path = "/features/" + std::to_string(index);
        if (!feature.is_object() || feature.value("type", "") != "Feature" || !feature.contains("geometry"))
            invalid(path, "expected a Feature with a geometry member");
        if (feature.contains("crs")) invalid(path, "legacy CRS is unsupported");
        auto props = feature.value("properties", Json(nullptr));
        if (!props.is_null() && !props.is_object()) invalid(path + "/properties", "expected an object or null");
        validateProperties(props, path + "/properties");
        Json parts = Json::array();
        geometryParts(feature["geometry"], parts, vertices, path + "/geometry");
        Row row; row.feature = feature;
        row.generatedJoin = feature.contains(GeneratedMember) && feature[GeneratedMember] == "join";
        row.geometry = parts.empty() ? Json(nullptr) : parts.size() == 1 ? parts.front() :
            Json{{"type", "GeometryCollection"}, {"geometries", std::move(parts)}};
        row.properties = props;
        if (recognizedAuthoring(feature)) {
            auto evaluated = evaluateDrawingShape(feature["erdblick:drawing"], feature["geometry"]);
            if (evaluated["geometry"] != feature["geometry"])
                invalid(path, "Sampled geometry differs from its drawing controls. Update the controls, or convert to ordinary geometry before editing coordinates.");
            row.decorations = evaluated["decorations"]; row.markerPaths = evaluated["markerPaths"]; row.metrics = evaluated["metrics"];
        }
        if(!recognizedAuthoring(feature) || feature["erdblick:drawing"].value("kind", "")=="ordinary") {
            auto evaluated=evaluateDrawingShape({{"version",1},{"kind","ordinary"},{"space","2d"}},feature["geometry"]);
            Json rendered=Json::array();
            geometryParts(evaluated["presentationGeometry"],rendered,renderedVertices,path+"/presentation");
            row.geometry=rendered.empty()?Json(nullptr):rendered.size()==1?rendered.front():Json{{"type","GeometryCollection"},{"geometries",std::move(rendered)}};
        }
        std::string description;
        if (props.is_object()) {
            for (auto key : {"description", "name"}) {
                if (props.contains(key) && props[key].is_string()) { description = props[key].get<std::string>(); break; }
            }
        }
        auto const role = props.is_object() && props.contains("role") && props["role"].is_string()
            ? props["role"].get<std::string>() : "imported";
        auto const geometryType = feature["geometry"].is_object() ? feature["geometry"].value("type", "") : "";
        row.value = {{"description", description}, {"role", role}, {"geometryType", geometryType}, {"position", nullptr}};
        if (feature.contains("id")) {
            if (!feature["id"].is_string() && !feature["id"].is_number()) invalid(path + "/id", "expected a string or number");
            row.value["externalId"] = feature["id"].dump();
        }
        size_t withHeight = 0, withoutHeight = 0;
        eachPosition(row.geometry, [&](Json const& p) {
            if (row.value["position"].is_null()) row.value["position"] = p;
            if (p.size() >= 3) ++withHeight; else ++withoutHeight;
        });
        row.value["vertexCount"] = withHeight + withoutHeight;
        row.value["heightState"] = withHeight ? (withoutHeight ? "mixed" : "present") : "absent";
        if (geometryType == "Point" && !row.value["position"].is_null()) {
            auto const& p = row.value["position"];
            row.value["longitude"] = p[0]; row.value["latitude"] = p[1];
            row.value["heightCm"] = (p.size() == 3 ? p[2].get<double>() : 0) * 100;
        }
        if (recognizedAuthoring(feature)) {
            auto const& author = feature["erdblick:drawing"];
            row.value["space"] = author.value("space", "2d");
            row.value["kind"] = author.value("kind", "ordinary");
            row.value["measurements"] = author.value("measurements", Json::object());
        }
        row.value["visible"] = !feature.value("erdblick:hidden", false);
        row.identity = feature.contains("erdblick:object") && feature["erdblick:object"].is_string() ? "object:" + feature["erdblick:object"].get<std::string>() : feature.contains("id") ? "id:" + feature["id"].dump() :
            geometryType == "Point" ? "point:" + feature["geometry"].dump() : feature.dump();
        result.push_back(std::move(row));
    }
    return result;
}

mapget::PartitionFeatureLayer::Ptr DrawingSource::materialize(std::vector<Row> const& rows, Json const& viewport) const
{
    auto layer = std::make_shared<mapget::PartitionFeatureLayer>(mapget::PartitionId::object(0),
        metadata_.stringPoolId_, metadata_.mapId_, metadata_.layers_.at("Drawing"), strings_);
    mapget::Point anchor{0, 0, 0};
    bool anchored = false;
    Json features = Json::array();
    for (auto const& row : rows) {
        if (!anchored) eachPosition(row.geometry, [&](Json const& p) {
            if (!anchored) { anchor = {p[0], p[1], p.size() == 3 ? p[2].get<double>() : 0}; anchored = true; }
        });
        // Web Mercator presentation is separate from accepted polar geometry. Omit any
        // affected polygon as a whole; never invent a filled closure across a clipped edge.
        Json displayParts = Json::array();
        std::function<void(Json const&)> visible = [&](Json const& g) {
            if (g.is_null()) return;
            auto type = g.at("type").get<std::string>();
            if (type == "GeometryCollection") { for (auto const& part : g["geometries"]) visible(part); return; }
            bool limited = false;
            eachPosition(g, [&](Json const& p) { limited |= std::abs(p[1].get<double>()) > MercatorLatitude; });
            if (!limited) { displayParts.push_back(g); return; }
            if (type == "LineString") {
                visibleLineParts(g["coordinates"], displayParts);
            }
        };
        if (row.value.value("visible", true)) visible(row.geometry);
        Json display = displayParts.empty() ? Json(nullptr) : displayParts.size() == 1 ? displayParts[0] :
            Json{{"type", "GeometryCollection"}, {"geometries", displayParts}};
        features.push_back({{"type", "Feature"}, {"typeId", FeatureType}, {"record", row.id},
                            {"geometry", display}, {"properties", Json::object()}});
    }
    layer->setGeometryAnchor(anchor);
    layer->fromJson({{"type", "FeatureCollection"}, {"features", std::move(features)}},
                    mapget::GeoJsonImportOptions{false, std::string(FeatureType), false});
    for (size_t i = 0; i < rows.size(); ++i) {
        auto const& row = rows[i];
        auto drawing = row.value;
        drawing["recordId"] = std::to_string(row.id);
        drawing["ordinal"] = i + 1;
        // No mapget or simfil tagged JSON conventions apply to user property values.
        for (auto const& [key, value] : std::array<std::pair<std::string, Json>, 2>{{{"drawing", drawing}, {"user", row.properties}}}) {
            auto added = layer->at(i)->attributes()->addField(key, plainJson(value, *layer));
            if (!added) throw std::runtime_error(added.error().message);
        }
        if (row.value.value("visible", true) && !row.decorations.empty()) {
            auto attributes = layer->at(i)->attributeLayers()->newLayer("DrawingDecorations");
            Json decorations=row.decorations;
            if(viewport.is_object()&&!row.markerPaths.empty()){
                decorations.erase(std::remove_if(decorations.begin(),decorations.end(),[](Json const& item){return item.value("role", "")=="point"||item.value("role", "")=="tick";}),decorations.end());
                auto markers=drawingMarkerDecorations(row.markerPaths,row.feature["erdblick:drawing"],viewport);
                for(auto& marker:markers["decorations"])
                    decorations.push_back(std::move(marker));
            }
            for (auto const& decoration : decorations) {
                auto attr = attributes->newAttribute("Decoration");
                for (auto key : {"text", "role", "fontSize"}) {
                    auto result = attr->addField(key, plainJson(decoration.at(key), *layer));
                    if (!result) throw std::runtime_error(result.error().message);
                }
                auto line=decoration.contains("line");
                auto geom = layer->newGeometry(line?mapget::GeomType::Line:mapget::GeomType::Points, line?2:1);
                if(line)for(auto const& p:decoration["line"])geom->append({p[0],p[1],p[2]});
                else {auto const& p=decoration.at("position");geom->append({p[0],p[1],p[2]});}
                attr->validity()->newGeometry(geom);
            }
        }
    }
    return layer;
}

std::string DrawingSource::install(std::string const& text, std::vector<uint64_t> const& identities, bool preservePreviousIds)
{
    if (text.size() > MaxBytes) invalid("File", "maximum supported input is 32 MiB");
    static_cast<void>(Json(text).dump()); // Reject invalid UTF-8 before publishing a model.
    auto candidate = parseGeoJson(text);
    std::map<std::string, std::vector<uint64_t>> previous;
    std::map<std::string, size_t> counts;
    for (auto const& row : rows_) previous[row.identity].push_back(row.id);
    for (auto const& row : candidate) ++counts[row.identity];
    auto next = nextId_;
    std::map<std::string, size_t> occurrences;
    for (size_t i = 0; i < candidate.size(); ++i) {
        auto& row = candidate[i];
        auto const old = previous.find(row.identity);
        row.id = i < identities.size() && identities[i] ? identities[i] :
            old != previous.end() && old->second.size() == 1 && counts[row.identity] == 1 ? old->second.front() :
            row.identity.starts_with("object:") && objectIdentities_.contains(row.identity) && counts[row.identity] == 1 ? objectIdentities_.at(row.identity) :
            legacyIdentities_.contains(row.identity) && legacyIdentities_.at(row.identity).size() == counts[row.identity] ? legacyIdentities_.at(row.identity)[occurrences[row.identity]] : next++;
        ++occurrences[row.identity];
        next = std::max(next, row.id + 1);
    }
    auto model = materialize(candidate);
    std::map<std::string, uint64_t> objects;
    for (auto const& row : candidate)
        if (row.identity.starts_with("object:") && counts[row.identity] == 1)
            objects[row.identity] = row.id;
    if (!preservePreviousIds) previous.clear();
    Prepared value{revision_, next, text, std::move(candidate), std::move(model),
        std::move(objects), std::move(previous)};
    if (staging_) {
        prepared_ = std::move(value);
        return describe();
    }
    prepared_.reset();
    return publish(std::move(value));
}

std::string DrawingSource::publish(Prepared candidate)
{
    if (candidate.revision != revision_) invalid("Edit", "stale prepared revision");
    // Archive pre-extension identities only after commit, so cancellation consumes no IDs.
    for (auto const& [identity, ids] : candidate.previous)
        if (!identity.starts_with("object:")) legacyIdentities_[identity] = ids;
    for (auto const& [identity, id] : candidate.objects) objectIdentities_[identity] = id;
    source_ = std::move(candidate.text);
    rows_ = std::move(candidate.rows);
    model_ = std::move(candidate.model);
    nextId_ = candidate.nextId;
    ++revision_;
    return describe();
}

void DrawingSource::stage(std::string const& text)
{
    auto request = parseJson(text);
    prepared_.reset();
    staging_ = true;
    try {
        auto type = request.at("type").get<std::string>();
        if (type == "objects") editObjects(request.at("request").dump());
        else if (type == "replace") replace(request.at("text").get<std::string>());
        else if (type == "description") editDescription(request.at("id"), request.at("description"));
        else if (type == "append") append(request.at("longitude"), request.at("latitude"), request.at("description"));
        else if (type == "join") join(request.at("ids").dump());
        else invalid("Edit", "unsupported staged operation");
        staging_ = false;
    } catch (...) { staging_ = false; prepared_.reset(); throw; }
}

std::string DrawingSource::commitStage()
{
    if (!prepared_) invalid("Edit", "prepared operation no longer exists");
    auto value = std::move(*prepared_);
    prepared_.reset();
    return publish(std::move(value));
}

void DrawingSource::cancelStage() { prepared_.reset(); }

std::string DrawingSource::replace(std::string const& text) { return install(text); }
std::string DrawingSource::source() const { return source_; }

std::string DrawingSource::checkpoint() const
{
    Json ids = Json::array();
    for (auto const& row : rows_) ids.push_back(std::to_string(row.id));
    Json known = Json::object();
    for (auto const& [identity, id] : objectIdentities_) known[identity] = std::to_string(id);
    return Json{{"ids", ids}, {"nextId", std::to_string(nextId_)}, {"objects", known}, {"legacy", legacyIdentities_}}.dump();
}

std::string DrawingSource::restore(std::string const& text, std::string const& checkpointText)
{
    if (revision_ != 1 || !rows_.empty()) invalid("Recovery", "requires a fresh source owner");
    if (text.size() > MaxBytes) invalid("Recovery", "maximum supported input is 32 MiB");
    static_cast<void>(Json(text).dump());
    auto state = parseJson(checkpointText);
    auto parseId = [](Json const& value) -> uint64_t {
        auto const string = value.get<std::string>();
        if (string.empty() || string.find_first_not_of("0123456789") != std::string::npos)
            invalid("Recovery", "invalid record identity");
        size_t consumed = 0;
        auto result = std::stoull(string, &consumed);
        if (!result || consumed != string.size()) invalid("Recovery", "invalid record identity");
        return result;
    };
    auto const next = parseId(state.at("nextId"));
    std::vector<uint64_t> ids;
    std::set<uint64_t> unique;
    for (auto const& value : state.at("ids")) {
        auto const id = parseId(value);
        if (id >= next || !unique.insert(id).second) invalid("Recovery", "invalid identity watermark");
        ids.push_back(id);
    }
    // Check the row count before installation; failed recovery must publish nothing.
    auto const count = parseGeoJson(text).size();
    if (ids.size() != count) invalid("Recovery", "record count does not match checkpoint");
    std::map<std::string, uint64_t> restored;
    auto knownObjects = state.value("objects", Json::object());
    for (auto const& item : knownObjects.items()) {
        auto id = parseId(item.value());
        if (!item.key().starts_with("object:") || id >= next) invalid("Recovery", "invalid object identity");
        restored[item.key()] = id;
    }
    auto legacy = state.value("legacy", std::map<std::string, std::vector<uint64_t>>{});
    for (auto const& [identity, archivedIds] : legacy) {
        if (identity.empty() || archivedIds.empty()) invalid("Recovery", "invalid legacy identity");
        for (auto id : archivedIds) if (!id || id >= next) invalid("Recovery", "invalid legacy identity watermark");
    }
    auto result = install(text, ids);
    legacyIdentities_ = std::move(legacy);
    objectIdentities_.insert(restored.begin(), restored.end());
    nextId_ = next;
    return result;
}

template <class Visit>
static Json geometryBounds(Visit visit)
{
    Json bounds = nullptr;
    std::vector<std::pair<double, double>> intervals;
    double south = 90, north = -90;
    bool projectionLimited = false;
    std::function<void(Json const&)> collect = [&](Json const& geometry) {
        if (geometry.is_null()) return;
        auto type = geometry.at("type").get<std::string>();
        if (type == "GeometryCollection") {
            for (auto const& part : geometry["geometries"]) collect(part);
            return;
        }
        auto path = [&](Json const& points) {
            for (size_t i = 1; i < points.size(); ++i) {
                double a = points[i - 1][0], b = points[i][0];
                intervals.emplace_back(std::min(a, b), std::max(a, b));
            }
        };
        if (type == "Point") intervals.emplace_back(geometry["coordinates"][0], geometry["coordinates"][0]);
        else if (type == "LineString") path(geometry["coordinates"]);
        else for (auto const& ring : geometry["coordinates"]) path(ring);
    };
    visit([&](Json const& geometry) {
        collect(geometry);
        eachPosition(geometry, [&](Json const& p) {
            double lat = p[1];
            south = std::min(south, lat);
            north = std::max(north, lat);
            projectionLimited |= std::abs(lat) > MercatorLatitude;
        });
    });
    if (!intervals.empty()) {
        // Search only gaps not traversed by a segment. Ordinary GeoJSON may span
        // 340 degrees, whereas authored dateline paths have explicitly split parts.
        std::ranges::sort(intervals);
        std::vector<std::pair<double, double>> merged;
        for (auto const& interval : intervals) {
            if (merged.empty() || interval.first > merged.back().second) merged.push_back(interval);
            else merged.back().second = std::max(merged.back().second, interval.second);
        }
        double gap = -1, west = merged.front().first, east = merged.back().second;
        for (size_t i = 0; i < merged.size(); ++i) {
            auto const next = i + 1 == merged.size() ? merged.front().first + 360 : merged[i + 1].first;
            if (next - merged[i].second > gap) {
                gap = next - merged[i].second;
                west = next > 180 ? next - 360 : next;
                east = west + 360 - gap;
            }
        }
        if (gap == 0) { west = -180; east = 180; }
        bounds = {west, south, east, north};
    }
    return {{"bounds", bounds}, {"projectionLimited", projectionLimited}};
}

std::string DrawingSource::describe() const
{
    auto bounds=geometryBounds([&](auto const& consume) { for(auto const& row:rows_)consume(row.geometry); });
    return Json{{"revision", revision_}, {"rowCount", rows_.size()}, {"bounds", bounds["bounds"]},
                {"projectionLimited", bounds["projectionLimited"]}, {"metadata", metadata_.toJson()},
                {"joined", std::ranges::any_of(rows_, [](Row const& row) { return row.generatedJoin; })}}.dump();
}

std::string DrawingSource::rows(uint32_t offset, uint32_t count) const
{
    Json values = Json::array();
    auto const end = std::min(rows_.size(), size_t(offset) + std::min(count, uint32_t{1000}));
    for (size_t index = offset; index < end; ++index) {
        auto value = rows_[index].value;
        value["id"] = std::to_string(rows_[index].id);
        value["featureId"] = std::string(FeatureType) + "." + std::to_string(rows_[index].id);
        value["ordinal"] = index + 1;
        values.push_back(std::move(value));
    }
    return values.dump();
}

std::string DrawingSource::editDescription(std::string const& id, std::string const& description)
{
    auto const found = std::ranges::find_if(rows_, [&](Row const& row) { return std::to_string(row.id) == id; });
    if (found == rows_.end()) invalid("Edit", "record no longer exists");
    auto root = featureCollection(source_);
    auto& properties = root["features"][std::distance(rows_.begin(), found)]["properties"];
    if (properties.is_null()) properties = Json::object();
    properties["description"] = description;
    std::vector<uint64_t> ids;
    for (auto const& row : rows_) ids.push_back(row.id);
    return install(root.dump() + "\n", ids);
}

std::string DrawingSource::object(std::string const& id) const
{
    auto found = std::ranges::find_if(rows_, [&](Row const& row) { return std::to_string(row.id) == id; });
    if (found == rows_.end()) invalid("Object", "record no longer exists");
    return Json{{"revision", revision_}, {"id", id}, {"feature", found->feature},
        {"metrics", found->metrics}, {"presentation", geometryBounds([&](auto const& consume){consume(found->geometry);})}}.dump();
}

std::string DrawingSource::branch(std::string const& text) const
{
    auto request = parseJson(text);
    auto id = request.at("id").get<std::string>();
    if (request.contains("revision") && request.at("revision").get<uint32_t>() != revision_)
        invalid("Read", "stale document revision");
    auto found = std::ranges::find_if(rows_, [&](Row const& row) { return std::to_string(row.id) == id; });
    if (found == rows_.end()) invalid("Object", "record no longer exists");
    auto path = request.value("path", "");
    if (path.size() > 4096) invalid("Read", "branch path exceeds 4096 bytes");
    auto pointer = Json::json_pointer(path);
    if (!found->feature.contains(pointer)) invalid("Read", "branch no longer exists");
    auto const& value = found->feature.at(pointer);
    auto offset = request.value("offset", size_t{0});
    auto count = std::clamp(request.value("count", size_t{50}), size_t{1}, size_t{100});
    auto describeValue = [](Json const& item, std::string const& itemPath, std::string const& key) {
        Json result{{"key", key}, {"path", itemPath}, {"type", item.type_name()}};
        if (item.is_structured()) result["size"] = item.size();
        else {
            auto exact = item.dump();
            // Exact lexemes avoid rounding foreign 64-bit IDs in the JavaScript reader.
            if (exact.size() <= 8192) result["text"] = exact;
            else { result["size"] = exact.size(); result["limited"] = true; }
        }
        return result;
    };
    auto result = describeValue(value, path, "");
    result["id"] = id; result["revision"] = revision_;
    result["entries"] = Json::array(); result["nextOffset"] = nullptr;
    size_t index = 0, bytes = 0;
    if (value.is_structured()) for (auto it = value.begin(); it != value.end(); ++it, ++index) {
        if (index < offset) continue;
        auto key = value.is_array() ? std::to_string(index) : it.key();
        auto child = pointer / key;
        auto entry = describeValue(it.value(), child.to_string(), key);
        auto length = entry.dump().size();
        if (result["entries"].size() >= count || bytes + length > 65536) {
            result["nextOffset"] = index; break;
        }
        result["entries"].push_back(std::move(entry)); bytes += length;
    }
    if (path.empty()) {
        auto feature = Json{{"type", "Feature"}, {"properties", Json::object()},
            {"geometry", found->feature["geometry"].is_null() ? Json(nullptr) :
                Json{{"type", found->feature["geometry"].value("type", "")}}}};
        for (auto const* key : {"name", "description", "color"})
            if (found->properties.is_object() && found->properties.contains(key) &&
                found->properties[key].is_string() && found->properties[key].get_ref<std::string const&>().size() <= 4096)
                feature["properties"][key] = found->properties[key];
        if (recognizedAuthoring(found->feature)) {
            auto const& author = found->feature["erdblick:drawing"];
            Json controls = Json::object();
            for (auto const* key : {"version", "kind", "space", "plane", "text", "fontSize", "unit", "measurements"})
                if (author.contains(key) && author[key].dump().size() <= 8192) controls[key] = author[key];
            feature["erdblick:drawing"] = controls;
            result["controlCount"] = author.value("points", Json::array()).size();
            result["curveSegments"] = Json::array();
            if (author.contains("curves")) {
                result["curveCount"] = author["curves"].size();
                for (auto const& item : author["curves"].items()) {
                    if (result["curveSegments"].size() >= 100) break;
                    result["curveSegments"].push_back(item.key());
                }
            }
        }
        if (request.value("editing", false)) {
            // Interactive editing transfers controls, never the sampled geometry of an authored shape.
            auto const authored = recognizedAuthoring(found->feature) &&
                found->feature["erdblick:drawing"].contains("points");
            if (authored) {
                auto const& author = found->feature["erdblick:drawing"];
                auto controls = author["points"].size();
                if (author.contains("curves"))
                    for (auto const& curve : author["curves"]) controls += curve.size();
                if (controls > 10000) invalid("Edit", "more than 10,000 handles; use the paged Quick editor");
                feature["erdblick:drawing"]["points"] = author["points"];
                if (author.contains("curves")) feature["erdblick:drawing"]["curves"] = author["curves"];
                feature["geometry"] = nullptr;
            } else {
                if (found->value.value("vertexCount", size_t{0}) > 10000)
                    invalid("Edit", "more than 10,000 handles; use the paged Quick editor");
                feature["geometry"] = found->feature["geometry"];
            }
            if (feature.dump().size() > 1048576) invalid("Edit", "handle data exceeds 1 MiB; use the paged Quick editor");
        }
        Json metrics = nullptr;
        if (found->metrics.is_object()) {
            metrics = Json::object();
            for (auto const& item : found->metrics.items()) {
                if (item.key() != "anglesDegrees") metrics[item.key()] = item.value();
                else {
                    metrics["angleCount"] = item.value().size();
                    metrics["anglesDegrees"] = Json::array();
                    for (size_t i = 0; i < std::min(item.value().size(), size_t{100}); ++i)
                        metrics["anglesDegrees"].push_back(item.value()[i]);
                }
            }
        }
        result["object"] = {{"id", id}, {"revision", revision_}, {"feature", feature}, {"metrics", metrics},
            {"presentation", geometryBounds([&](auto const& consume) { consume(found->geometry); })}};
        result["row"] = found->value;
        result["row"]["id"] = id;
        result["row"]["ordinal"] = std::distance(rows_.begin(), found)+1;
        result["row"]["featureId"] = std::string(FeatureType)+"."+id;
    }
    return result.dump();
}

std::string drawingCompose(std::string const& text, bool separate)
{
    auto input = parseJson(text), sources = input.is_object() ? input.at("sources") : input;
    Json output = Json::array(), combined;
    if(input.is_object() && input.contains("collection")) {
        auto collection=input.at("collection");
        if(collection.at("members").size()!=sources.size()) invalid("Collection", "member/source count differs");
        for(size_t i=0;i<sources.size();++i) {
            auto root=featureCollection(sources[i].get<std::string>());
            root["erdblick:collection"]=collection; root["erdblick:collection"]["memberId"]=collection["members"][i]["id"];
            output.push_back(root.dump()+"\n");
        }
        return output.dump();
    }
    for (auto const& source : sources) {
        auto root = featureCollection(source.get<std::string>());
        if (input.is_object() && input.value("ordinary", false)) for (auto& feature : root["features"]) {
            if (feature.contains("erdblick:drawing")) {
                auto& author = feature["erdblick:drawing"];
                if (author.is_object() && author.value("version", 0) == 1) {
                    author["kind"] = "ordinary"; author.erase("points"); author.erase("curves");
                }
            }
        }
        if (combined.is_null()) { combined = root; combined["features"] = Json::array(); }
        for (auto const& feature : root["features"]) {
            if (separate) { auto single = root; single["features"] = Json::array({feature}); single.erase("bbox"); output.push_back(single.dump() + "\n"); }
            else combined["features"].push_back(feature);
        }
    }
    if (!separate) { if (combined.is_null()) combined = {{"type", "FeatureCollection"}, {"features", Json::array()}}; combined.erase("bbox"); output.push_back(combined.dump() + "\n"); }
    return output.dump();
}

std::string DrawingSource::editObjects(std::string const& text)
{
    auto request = parseJson(text);
    if (request.at("revision").get<uint32_t>() != revision_) invalid("Edit", "stale document revision");
    auto const& operations = request.at("operations");
    if (!operations.is_array() || operations.empty() || operations.size() > 1000) invalid("Edit", "expected 1–1000 operations");
    auto root = featureCollection(source_);
    std::vector<uint64_t> ids; for (auto const& row : rows_) ids.push_back(row.id);
    auto insertedId = nextId_;
    for (size_t i = 0; i < ids.size(); ++i)
        if (!root["features"][i].contains("erdblick:object"))
            root["features"][i]["erdblick:object"] = metadata_.mapId_ + ":" + std::to_string(ids[i]);
    for (auto const& operation : operations) {
        auto type = operation.at("type").get<std::string>();
        if (type == "insert") {
            auto feature = operation.at("feature");
            if (recognizedAuthoring(feature)) {
                auto evaluated = evaluateDrawingShape(feature["erdblick:drawing"], feature.value("geometry", Json(nullptr)));
                feature["geometry"] = evaluated["geometry"]; feature["erdblick:drawing"] = evaluated["authoring"];
            }
            if (!feature.contains("erdblick:object"))
                feature["erdblick:object"] = metadata_.mapId_ + ":" + std::to_string(insertedId);
            root["features"].push_back(feature); ids.push_back(insertedId++); continue;
        }
        auto wanted = operation.at("id").get<std::string>();
        auto found = std::ranges::find_if(ids, [&](uint64_t id) { return id && std::to_string(id) == wanted; });
        if (found == ids.end()) invalid("Edit", "record no longer exists");
        auto index = std::distance(ids.begin(), found);
        if (type == "delete") { root["features"].erase(index); ids.erase(found); continue; }
        auto& feature = root["features"][index];
        if (type == "convert") {
            auto display = feature.value("erdblick:drawing", Json::object());
            feature["erdblick:drawing"] = {{"version", 1}, {"kind", "ordinary"}, {"space", display.value("space", "2d")},
                {"unit", display.value("unit", "meters")}, {"measurements", display.value("measurements", Json::object())}};
        } else if (type == "author") {
            if (feature.contains("erdblick:drawing") && !recognizedAuthoring(feature))
                invalid("Edit", "Unrecognized drawing metadata. Remove it explicitly in Advanced before enabling authoring or measurements.");
            if (!feature.contains("erdblick:drawing")) {
                if (!operation.at("value").contains("space")) invalid("Edit", "Choose 2D or 3D before enabling measurements on imported geometry.");
                feature["erdblick:drawing"] = {{"version", 1}, {"kind", "ordinary"}};
            }
            feature["erdblick:drawing"].merge_patch(operation.at("value"));
        } else if (type == "height") {
            double meters=operation.at("meters");
            if(!std::isfinite(meters))invalid("Height","expected finite ellipsoidal meters");
            auto fill=[&](auto&& self,Json& value)->void{
                if(!value.is_array())return;
                if(value.size()>=2 && value[0].is_number() && value[1].is_number()) {if(value.size()==2)value.push_back(meters);return;}
                for(auto& child:value)self(self,child);
            };
            std::function<void(Json&)> geometry=[&](Json& g){if(g.is_null())return;if(g.value("type", "")=="GeometryCollection")for(auto& child:g["geometries"])geometry(child);else fill(fill,g["coordinates"]);};
            if(recognizedAuthoring(feature) && feature["erdblick:drawing"].value("kind", "")!="ordinary") {
                fill(fill,feature["erdblick:drawing"]["points"]);
                if(feature["erdblick:drawing"].contains("curves"))for(auto& controls:feature["erdblick:drawing"]["curves"].items())fill(fill,controls.value());
            } else geometry(feature["geometry"]);
        } else if (type == "curve" || ((type == "insertVertex" || type == "deleteVertex") && operation.at("path") == "/erdblick:drawing/points")) {
            if (!recognizedAuthoring(feature)) invalid("Edit", "Select an authored object first.");
            feature["erdblick:drawing"] = editDrawingControls(feature["erdblick:drawing"], operation);
        } else if (type == "visibility") feature["erdblick:hidden"] = !operation.at("visible").get<bool>();
        else if (type == "set" || type == "setExact" || type == "remove" || type == "insertVertex" || type == "deleteVertex") {
            auto path = operation.at("path").get<std::string>();
            if (!((path == "/properties" || path.starts_with("/properties/")) || (path == "/geometry" || path.starts_with("/geometry/")) || path.starts_with("/erdblick:drawing/")))
                invalid("Edit", "path must address properties, geometry or authoring");
            auto pointer = Json::json_pointer(path);
            if (type == "set" || type == "setExact") {
                // Moving either repeated endpoint edits one logical closed-ring vertex.
                auto parent = pointer.parent_pointer();
                auto ring = parent;
                if (feature.contains(parent) && feature.at(parent).is_array() && !feature.at(parent).empty() && feature.at(parent)[0].is_number()) ring = parent.parent_pointer();
                auto oldRing = feature.contains(ring) ? feature.at(ring) : Json(nullptr);
                feature[pointer] = type == "setExact" ? parseJson(operation.at("text").get<std::string>()) : operation.at("value");
                if (oldRing.is_array() && oldRing.size() >= 4 && oldRing.front().is_array() && oldRing.front() == oldRing.back()) {
                    auto& changed = feature.at(ring);
                    if (changed.size() == oldRing.size()) {
                        if (changed.front() != oldRing.front()) changed.back() = changed.front();
                        else if (changed.back() != oldRing.back()) changed.front() = changed.back();
                    }
                }
            }
            else if (type == "remove") feature = feature.patch(Json::array({{{"op", "remove"}, {"path", path}}}));
            else {
                auto& vertices = feature.at(pointer); auto vertex = operation.at("index").get<size_t>();
                if (!vertices.is_array() || vertex >= vertices.size()) invalid("Vertex", "index outside the selected part/ring");
                bool closed = vertices.size() >= 4 && vertices.front() == vertices.back();
                if (closed) vertices.erase(vertices.size()-1);
                if (vertex >= vertices.size()) vertex = 0;
                if (type == "insertVertex") {
                    if (operation.contains("value")) vertices.insert(vertices.begin()+vertex, operation.at("value"));
                    else {
                        if (vertex+1 >= vertices.size() && !closed) invalid("Vertex", "Choose a segment before inserting.");
                        auto const a = vertices[vertex], b = vertices[(vertex+1)%vertices.size()];
                        auto middle = Json::array();
                        for (size_t axis=0; axis<std::min(a.size(),b.size()); ++axis)
                            middle.push_back((a[axis].get<double>()+b[axis].get<double>())/2);
                        vertices.insert(vertices.begin()+vertex+1, middle);
                    }
                }
                else vertices.erase(vertex);
                if (closed && !vertices.empty()) vertices.push_back(vertices.front());
            }
        } else invalid("Edit", "unknown object operation");
        feature.erase("bbox");
        if (recognizedAuthoring(feature) && !operation.value("preserveGeometry", false)) {
            auto evaluated = evaluateDrawingShape(feature["erdblick:drawing"], feature["geometry"]);
            feature["geometry"] = evaluated["geometry"]; feature["erdblick:drawing"] = evaluated["authoring"];
        }
    }
    root.erase("bbox");
    return install(root.dump() + "\n", ids, true);
}

std::string DrawingSource::append(double longitude, double latitude, std::string const& description)
{
    position(longitude, latitude);
    auto root = featureCollection(source_);
    root.erase("bbox");
    root["features"].push_back({{"type", "Feature"},
        {"geometry", {{"type", "Point"}, {"coordinates", {longitude, latitude, 0}}}},
        {"properties", {{"description", description}}}});
    std::vector<uint64_t> ids;
    for (auto const& row : rows_) ids.push_back(row.id);
    return install(root.dump() + "\n", ids);
}

std::string DrawingSource::join(std::string const& ids)
{
    auto values = parseJson(ids).get<std::vector<std::string>>();
    std::vector<Json> points;
    for (auto const& row : rows_) if (std::ranges::find(values, std::to_string(row.id)) != values.end()) {
        if (row.value["geometryType"] != "Point" || row.geometry.is_null()) invalid("Join", "select point features only");
        points.push_back(row.geometry["coordinates"]);
    }
    if (points.size() != values.size()) invalid("Join", "selection includes missing or duplicate records");
    auto root = featureCollection(source_);
    auto features = Json::array();
    std::vector<uint64_t> identities;
    for (size_t index = 0; index < rows_.size(); ++index) {
        if (rows_[index].generatedJoin) continue;
        features.push_back(root["features"][index]);
        identities.push_back(rows_[index].id);
    }
    if (!points.empty()) features.push_back({{"type", "Feature"}, {std::string(GeneratedMember), "join"}, {"geometry", joinedGeometry(points)},
        {"properties", {{"description", "Joined positions"}, {"role", "join"}}}});
    root["features"] = std::move(features);
    root.erase("bbox");
    return install(root.dump() + "\n", identities);
}

void DrawingSource::schema(SharedUint8Array& out) const { writeModel(*metadata_.mapSchema_, out); }

void DrawingSource::dictionary(SharedUint8Array& out) const
{
    std::ostringstream stream;
    if (auto result = strings_->write(stream, 0); !result) throw std::runtime_error(result.error().message);
    out.writeToArray(stream.str());
}

void DrawingSource::filter(std::string const& request, SharedUint8Array& out) const
{
    auto json = parseJson(request);
    auto native = filterRequest(json);
    std::vector<mapget::FeatureLayerFilterRoot> roots;
    for (auto const& root : json.value("roots", Json::array())) {
        mapget::FeatureLayerFilterRoot exact;
        exact.partitionId_ = model_->partitionId();
        exact.canonicalFeatureId_ = root.at("featureId").get<std::string>();
        exact.requestOrdinal_ = roots.size();
        roots.push_back(std::move(exact));
    }
    auto viewModel = json.contains("drawingViewport") && std::ranges::any_of(rows_,[](Row const& row){return !row.markerPaths.empty();})
        ? materialize(rows_,json["drawingViewport"]) : model_;
    auto result = native.filterSource(*viewModel, true, roots);
    if (!result) throw std::runtime_error(result.error().message);
    if (!result->pointGroupMembers_.empty()) {
        auto completion = native.completePointGroups(*result->layer_, result->pointGroupMembers_);
        if (!completion) throw std::runtime_error(completion.error().message);
    }
    writeModel(*result->layer_, out);
}

void DrawingSource::snapshot(std::string const& ids, SharedUint8Array& out) const
{
    auto layer = std::make_shared<mapget::PartitionFeatureLayer>(mapget::PartitionId::object(0),
        metadata_.stringPoolId_, metadata_.mapId_, metadata_.layers_.at("Drawing"), strings_);
    layer->setGeometryAnchor(model_->geometryAnchor());
    mapget::PartitionFeatureLayer::CloneCache cache;
    for (auto const& id : parseJson(ids)) {
        auto feature = model_->find(id.get<std::string>());
        if (feature) {
            auto parts = feature->id()->keyValuePairs();
            layer->clone(cache, model_, *feature, feature->id()->typeId(), parts);
        }
    }
    writeModel(*layer, out);
}

}
