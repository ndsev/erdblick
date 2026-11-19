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
    size_t vertices = 0;
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
        Row row;
        row.generatedJoin = feature.contains(GeneratedMember) && feature[GeneratedMember] == "join";
        row.geometry = parts.empty() ? Json(nullptr) : parts.size() == 1 ? parts.front() :
            Json{{"type", "GeometryCollection"}, {"geometries", std::move(parts)}};
        row.properties = props;
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
        eachPosition(row.geometry, [&](Json const& p) { if (row.value["position"].is_null()) row.value["position"] = p; });
        if (geometryType == "Point" && !row.value["position"].is_null()) {
            auto const& p = row.value["position"];
            row.value["longitude"] = p[0]; row.value["latitude"] = p[1];
            row.value["heightCm"] = (p.size() == 3 ? p[2].get<double>() : 0) * 100;
        }
        row.identity = feature.contains("id") ? "id:" + feature["id"].dump() :
            geometryType == "Point" ? "point:" + feature["geometry"].dump() : feature.dump();
        result.push_back(std::move(row));
    }
    return result;
}

mapget::PartitionFeatureLayer::Ptr DrawingSource::materialize(std::vector<Row> const& rows) const
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
        features.push_back({{"type", "Feature"}, {"typeId", FeatureType}, {"record", row.id},
                            {"geometry", row.geometry}, {"properties", Json::object()}});
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
    }
    return layer;
}

std::string DrawingSource::install(std::string const& text, std::vector<uint64_t> const& identities)
{
    if (text.size() > MaxBytes) invalid("File", "maximum supported input is 32 MiB");
    static_cast<void>(Json(text).dump()); // Reject invalid UTF-8 before publishing a model.
    auto candidate = parseGeoJson(text);
    std::map<std::string, std::vector<uint64_t>> previous;
    std::map<std::string, size_t> counts;
    for (auto const& row : rows_) previous[row.identity].push_back(row.id);
    for (auto const& row : candidate) ++counts[row.identity];
    auto next = nextId_;
    for (size_t i = 0; i < candidate.size(); ++i) {
        auto& row = candidate[i];
        auto const old = previous.find(row.identity);
        row.id = i < identities.size() ? identities[i] :
            old != previous.end() && old->second.size() == 1 && counts[row.identity] == 1 ? old->second.front() : next++;
    }
    auto model = materialize(candidate);
    source_ = text;
    rows_ = std::move(candidate);
    model_ = std::move(model);
    nextId_ = next;
    ++revision_;
    return describe();
}

std::string DrawingSource::replace(std::string const& text) { return install(text); }
std::string DrawingSource::source() const { return source_; }

std::string DrawingSource::checkpoint() const
{
    Json ids = Json::array();
    for (auto const& row : rows_) ids.push_back(std::to_string(row.id));
    return Json{{"ids", ids}, {"nextId", std::to_string(nextId_)}}.dump();
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
    auto result = install(text, ids);
    nextId_ = next;
    return result;
}

std::string DrawingSource::describe() const
{
    Json bounds = nullptr;
    std::vector<double> longitudes;
    double south = 90, north = -90;
    bool projectionLimited = false;
    for (auto const& row : rows_) eachPosition(row.geometry, [&](Json const& p) {
        double lon = p[0], lat = p[1];
        longitudes.push_back(std::remainder(lon, 360));
        south = std::min(south, lat);
        north = std::max(north, lat);
        projectionLimited |= std::abs(lat) > 85.0511287798066;
    });
    if (!longitudes.empty()) {
        std::ranges::sort(longitudes);
        double gap = -1, west = longitudes.front(), east = longitudes.back();
        for (size_t i = 0; i < longitudes.size(); ++i) {
            auto const next = i + 1 == longitudes.size() ? longitudes.front() + 360 : longitudes[i + 1];
            if (next - longitudes[i] > gap) {
                gap = next - longitudes[i];
                west = std::remainder(next, 360);
                east = west + 360 - gap;
            }
        }
        bounds = {west, south, east, north};
    }
    return Json{{"revision", revision_}, {"rowCount", rows_.size()}, {"bounds", bounds},
                {"projectionLimited", projectionLimited}, {"metadata", metadata_.toJson()},
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
    auto result = native.filterSource(*model_, true, roots);
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
