#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "erdblick/gpu-render-packet.h"
#include "erdblick/gpu-render-records.h"
#include "erdblick/subset-renderer.h"
#include "mapget/model/info.h"
#include "mapget/model/stringpool.h"
#include "mapget/model/subsetlayer.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstring>
#include <string>
#include <vector>

using namespace erdblick;

namespace
{

template<typename T>
T readPacketScalar(std::span<std::byte const> bytes, size_t offset)
{
    REQUIRE(offset + sizeof(T) <= bytes.size());
    std::array<std::byte, sizeof(T)> raw{};
    std::memcpy(raw.data(), bytes.data() + offset, raw.size());
    if constexpr (std::endian::native == std::endian::big) {
        std::reverse(raw.begin(), raw.end());
    }
    return std::bit_cast<T>(raw);
}

/** Install one test subset using valid deterministic scene ownership metadata. */
void installSubset(
    TileSubsetLayerRenderer& renderer,
    TileSubsetLayer const& subset)
{
    renderer.addTileSubsetContribution(subset, 1U, 0U, 0U, 0U, 1U);
}

/** Read renderer assertions from the production packet rather than a shadow buffer. */
class RendererPacketView
{
public:
    struct Stream {
        GpuPrimitiveKind kind;
        uint16_t flags = 0U;
        uint32_t stride = 0U;
        uint32_t count = 0U;
        uint32_t dataOffset = 0U;
        std::array<uint8_t, 4> glowColor{};
        float glowRadius = 0.0F;
        uint32_t renderOrder = 0U;
    };

    struct Path {
        std::vector<mapget::Point> points;
        std::vector<float> lateralOffsetsPx;
        std::vector<std::array<float, 2>> lateralOffsetVectorsPx;
        float scaleThreshold = 0.0F;
    };

    struct Arrow {
        std::array<float, 2> lateralOffsetVectorPx{};
        float lateralOffsetPx = 0.0F;
        float scaleThreshold = 0.0F;
        uint32_t flags = 0U;
    };

    struct Pick {
        uint32_t contributionIndex = 0U;
        uint32_t localPickIndex = 0U;
        uint32_t channelOrdinal = 0U;
        uint32_t entryOrdinal = 0U;
        uint32_t endpointRole = 0U;
        float navigationAltitude = 0.0F;
        uint32_t presentationZIndexSlot = 0U;
        uint32_t presentationPrimitiveOrder = 0U;
    };

    struct Issue {
        std::string property;
        std::string expression;
    };

    /** Validate and retain one renderer packet for typed record inspection. */
    explicit RendererPacketView(TileSubsetLayerRenderer const& renderer)
        : bytes_(renderer.renderPacketBytes())
    {
        static_cast<void>(GpuRenderPacketCodec::validate(bytes_));
    }

    /** Return the packet's contribution descriptor count. */
    [[nodiscard]] uint32_t contributionCount() const
    {
        return read<uint32_t>(84U);
    }

    /** Return all streams using one primitive program. */
    [[nodiscard]] std::vector<Stream> streams(GpuPrimitiveKind kind) const
    {
        auto const table = read<uint32_t>(72U);
        auto const count = read<uint32_t>(76U);
        std::vector<Stream> result;
        for (uint32_t index = 0U; index < count; ++index) {
            auto const descriptor = table + index * 48U;
            if (read<uint16_t>(descriptor) != static_cast<uint16_t>(kind)) {
                continue;
            }
            Stream stream{
                .kind = kind,
                .flags = read<uint16_t>(descriptor + 2U),
                .stride = read<uint32_t>(descriptor + 12U),
                .count = read<uint32_t>(descriptor + 16U),
                .dataOffset = read<uint32_t>(descriptor + 20U),
                .glowColor = {
                    read<uint8_t>(descriptor + 28U),
                    read<uint8_t>(descriptor + 29U),
                    read<uint8_t>(descriptor + 30U),
                    read<uint8_t>(descriptor + 31U),
                },
                .glowRadius = read<float>(descriptor + 32U),
                .renderOrder = read<uint32_t>(descriptor + 40U),
            };
            result.push_back(stream);
        }
        return result;
    }

    /** Reconstruct logical paths from segment start/end flags. */
    [[nodiscard]] std::vector<Path> paths() const
    {
        std::vector<Path> result;
        for (auto const& stream : streams(GpuPrimitiveKind::PathSegment)) {
            auto const compact =
                (stream.flags & static_cast<uint16_t>(
                    GpuMaterialFlag::CompactPath)) != 0U;
            auto const simple =
                (stream.flags & static_cast<uint16_t>(
                    GpuMaterialFlag::SimplePath)) != 0U;
            Path current;
            for (uint32_t index = 0U; index < stream.count; ++index) {
                auto const record = stream.dataOffset + index * stream.stride;
                auto const flags = read<uint32_t>(
                    record + (simple ? 48U : compact ? 72U : 144U));
                auto const starts = (flags & static_cast<uint32_t>(
                    GpuPathRecordFlag::StartCap)) != 0U;
                auto const ends = (flags & static_cast<uint32_t>(
                    GpuPathRecordFlag::EndCap)) != 0U;
                if (starts) {
                    REQUIRE(current.points.empty());
                    current.scaleThreshold = compact || simple
                        ? 0.0F
                        : read<float>(record + 108U);
                    current.points.push_back(point(record + (simple ? 0U : 12U)));
                    current.lateralOffsetVectorsPx.push_back(compact || simple
                        ? std::array<float, 2>{}
                        : vector(record + 56U));
                    current.lateralOffsetsPx.push_back(compact || simple
                        ? 0.0F
                        : read<float>(record + 84U));
                }
                REQUIRE_FALSE(current.points.empty());
                current.points.push_back(point(record + (simple ? 12U : 24U)));
                current.lateralOffsetVectorsPx.push_back(compact || simple
                    ? std::array<float, 2>{}
                    : vector(record + 64U));
                current.lateralOffsetsPx.push_back(compact || simple
                    ? 0.0F
                    : read<float>(record + 88U));
                if (!compact && !simple) {
                    REQUIRE(read<float>(record + 108U) ==
                        current.scaleThreshold);
                }
                if (ends) {
                    result.push_back(std::move(current));
                    current = {};
                }
            }
            REQUIRE(current.points.empty());
        }
        return result;
    }

    /** Decode screen-space arrow offset state from every arrow instance. */
    [[nodiscard]] std::vector<Arrow> arrows() const
    {
        std::vector<Arrow> result;
        for (auto const& stream : streams(GpuPrimitiveKind::Arrow)) {
            for (uint32_t index = 0U; index < stream.count; ++index) {
                auto const record = stream.dataOffset + index * stream.stride;
                result.push_back({
                    .lateralOffsetVectorPx = vector(record + 24U),
                    .lateralOffsetPx = read<float>(record + 32U),
                    .scaleThreshold = read<float>(record + 40U),
                    .flags = read<uint32_t>(record + 64U),
                });
            }
        }
        return result;
    }

    /** Decode contribution ownership and compact source rows from pick records. */
    [[nodiscard]] std::vector<Pick> picks() const
    {
        auto const table = read<uint32_t>(96U);
        auto const count = read<uint32_t>(100U);
        std::vector<Pick> result;
        result.reserve(count);
        for (uint32_t index = 0U; index < count; ++index) {
            auto const record = table + index * 32U;
            result.push_back({
                .contributionIndex = read<uint32_t>(record),
                .localPickIndex = read<uint32_t>(record + 4U),
                .channelOrdinal = read<uint32_t>(record + 8U),
                .entryOrdinal = read<uint32_t>(record + 12U),
                .endpointRole = read<uint32_t>(record + 16U),
                .navigationAltitude = read<float>(record + 20U),
                .presentationZIndexSlot = read<uint32_t>(record + 24U),
                .presentationPrimitiveOrder = read<uint32_t>(record + 28U),
            });
        }
        return result;
    }

    /** Decode all label texts from the packet's logical label table. */
    [[nodiscard]] std::vector<std::string> labelTexts() const
    {
        auto const table = read<uint32_t>(112U);
        auto const count = read<uint32_t>(116U);
        std::vector<std::string> result;
        result.reserve(count);
        for (uint32_t index = 0U; index < count; ++index) {
            auto const record = table + index * 176U;
            result.push_back(string(
                read<uint32_t>(record + 32U),
                read<uint32_t>(record + 36U)));
        }
        return result;
    }

    /** Decode the packed minimum style LOD from every logical label. */
    [[nodiscard]] std::vector<uint8_t> labelMinimumLods() const
    {
        auto const table = read<uint32_t>(112U);
        auto const count = read<uint32_t>(116U);
        std::vector<uint8_t> result;
        result.reserve(count);
        for (uint32_t index = 0U; index < count; ++index) {
            auto const flags = read<uint32_t>(
                table + index * 176U + 96U);
            result.push_back(static_cast<uint8_t>(
                (flags & kGpuLabelMinimumLodMask) >>
                kGpuLabelMinimumLodShift));
        }
        return result;
    }

    /** Decode parsed font sizes from every logical label. */
    [[nodiscard]] std::vector<float> labelSizes() const
    {
        auto const table = read<uint32_t>(112U);
        auto const count = read<uint32_t>(116U);
        std::vector<float> result;
        result.reserve(count);
        for (uint32_t index = 0U; index < count; ++index) {
            result.push_back(read<float>(table + index * 176U + 48U));
        }
        return result;
    }

    /** Decode parsed font families from every logical label. */
    [[nodiscard]] std::vector<std::string> labelFontFamilies() const
    {
        auto const table = read<uint32_t>(112U);
        auto const count = read<uint32_t>(116U);
        std::vector<std::string> result;
        result.reserve(count);
        for (uint32_t index = 0U; index < count; ++index) {
            auto const record = table + index * 176U;
            result.push_back(string(
                read<uint32_t>(record + 40U),
                read<uint32_t>(record + 44U)));
        }
        return result;
    }

    /** Decode layer-wide CSS font weights from every logical label. */
    [[nodiscard]] std::vector<uint32_t> labelFontWeights() const
    {
        auto const table = read<uint32_t>(112U);
        auto const count = read<uint32_t>(116U);
        std::vector<uint32_t> result;
        result.reserve(count);
        for (uint32_t index = 0U; index < count; ++index) {
            result.push_back(read<uint32_t>(table + index * 176U + 112U));
        }
        return result;
    }

    /** Decode horizontal anchor and vertical baseline codes for every label. */
    [[nodiscard]] std::vector<std::pair<int32_t, int32_t>> labelAlignments() const
    {
        auto const table = read<uint32_t>(112U);
        auto const count = read<uint32_t>(116U);
        std::vector<std::pair<int32_t, int32_t>> result;
        result.reserve(count);
        for (uint32_t index = 0U; index < count; ++index) {
            auto const record = table + index * 176U;
            result.emplace_back(
                read<int32_t>(record + 100U),
                read<int32_t>(record + 104U));
        }
        return result;
    }

    /** Decode the exact float64 authored orders owned by one contribution. */
    [[nodiscard]] std::vector<double> zIndices(
        uint32_t contributionIndex) const
    {
        auto const contributionTable = read<uint32_t>(80U);
        REQUIRE(contributionIndex < read<uint32_t>(84U));
        auto const descriptor = contributionTable + contributionIndex * 56U;
        auto const first = read<uint32_t>(descriptor + 44U);
        auto const count = read<uint32_t>(descriptor + 48U);
        auto const table = read<uint32_t>(152U);
        REQUIRE(first <= read<uint32_t>(156U));
        REQUIRE(count <= read<uint32_t>(156U) - first);
        std::vector<double> result;
        result.reserve(count);
        for (uint32_t index = 0U; index < count; ++index) {
            result.push_back(read<double>(
                table + (first + index) * kGpuZIndexEntryBytes));
        }
        return result;
    }

    /** Decode stable semantic tie keys owned by one contribution. */
    [[nodiscard]] std::vector<uint32_t> depthTieKeys(
        uint32_t contributionIndex) const
    {
        auto const contributionTable = read<uint32_t>(80U);
        REQUIRE(contributionIndex < read<uint32_t>(84U));
        auto const descriptor = contributionTable + contributionIndex * 56U;
        auto const first = read<uint32_t>(descriptor + 44U);
        auto const count = read<uint32_t>(descriptor + 48U);
        auto const table = read<uint32_t>(152U);
        REQUIRE(first <= read<uint32_t>(156U));
        REQUIRE(count <= read<uint32_t>(156U) - first);
        std::vector<uint32_t> result;
        result.reserve(count);
        for (uint32_t index = 0U; index < count; ++index) {
            result.push_back(read<uint32_t>(
                table + (first + index) * kGpuZIndexEntryBytes + 8U));
        }
        return result;
    }

    /** Decode style issue identity fields from the packet. */
    [[nodiscard]] std::vector<Issue> issues() const
    {
        auto const table = read<uint32_t>(144U);
        auto const count = read<uint32_t>(148U);
        std::vector<Issue> result;
        result.reserve(count);
        for (uint32_t index = 0U; index < count; ++index) {
            auto const record = table + index * 40U;
            result.push_back({
                .property = string(
                    read<uint32_t>(record + 16U),
                    read<uint32_t>(record + 20U)),
                .expression = string(
                    read<uint32_t>(record + 24U),
                    read<uint32_t>(record + 28U)),
            });
        }
        return result;
    }

    /** Read one scalar from the packet's explicit little-endian ABI. */
    template<typename T>
    [[nodiscard]] T read(size_t offset) const
    {
        return readPacketScalar<T>(bytes_, offset);
    }

private:
    [[nodiscard]] mapget::Point point(size_t offset) const
    {
        return {
            read<float>(offset),
            read<float>(offset + 4U),
            read<float>(offset + 8U),
        };
    }

    [[nodiscard]] std::array<float, 2> vector(size_t offset) const
    {
        return {read<float>(offset), read<float>(offset + 4U)};
    }

    [[nodiscard]] std::string string(uint32_t offset, uint32_t length) const
    {
        auto const table = read<uint32_t>(120U);
        auto const bytes = read<uint32_t>(124U);
        REQUIRE(offset <= bytes);
        REQUIRE(length <= bytes - offset);
        auto const begin = reinterpret_cast<char const*>(
            bytes_.data() + table + offset);
        return {begin, length};
    }

    std::vector<std::byte> bytes_;
};

std::shared_ptr<mapget::LayerInfo> rendererLayerInfo()
{
    return mapget::LayerInfo::fromJson(
        nlohmann::json::parse(R"json(
        {
            "layerId": "Road",
            "type": "Features",
            "featureTypes": [
                {
                    "name": "Road",
                    "uniqueIdCompositions": [[
                        {"partId": "roadId", "datatype": "U64"}
                    ]]
                }
            ]
        })json"));
}

mapget::model_ptr<mapget::GeometryCollection> lineGeometry(
    mapget::TileSubsetLayer& layer,
    std::string_view name)
{
    auto collection = layer.newGeometryCollection(1, true);
    auto geometry = layer.newGeometry(
        mapget::GeomType::Line,
        2,
        true);
    geometry->setName(name);
    geometry->append({11.0, 48.0, 0.0});
    geometry->append({11.001, 48.001, 0.0});
    collection->addGeometry(geometry);
    return collection;
}

mapget::model_ptr<mapget::GeometryCollection> lineGeometryWithPoints(
    mapget::TileSubsetLayer& layer,
    std::string_view name,
    std::span<mapget::Point const> points)
{
    auto collection = layer.newGeometryCollection(1, true);
    auto geometry = layer.newGeometry(
        mapget::GeomType::Line,
        static_cast<uint32_t>(points.size()),
        true);
    geometry->setName(name);
    for (auto const& point : points) {
        geometry->append(point);
    }
    collection->addGeometry(geometry);
    return collection;
}

mapget::model_ptr<mapget::GeometryCollection> meshGeometry(
    mapget::TileSubsetLayer& layer,
    std::string_view name)
{
    auto collection = layer.newGeometryCollection(1, true);
    auto geometry = layer.newGeometry(mapget::GeomType::Mesh, 6, true);
    geometry->setName(name);
    geometry->append({11.0, 48.0, 2.0});
    geometry->append({11.001, 48.0, 2.0});
    geometry->append({11.001, 48.001, 2.0});
    geometry->append({11.0, 48.0, 2.0});
    geometry->append({11.001, 48.001, 2.0});
    geometry->append({11.0, 48.001, 2.0});
    collection->addGeometry(geometry);
    return collection;
}

FeatureLayerStyle rendererStyle(std::string_view source)
{
    return FeatureLayerStyle(
        SharedUint8Array(std::string(source)));
}

} // namespace

TEST_CASE(
    "TileSubsetLayerRenderer consumes projected color scales and emits tuple picks",
    "[erdblick.subset-renderer]")
{
    auto info = rendererLayerInfo();
    auto strings = std::make_shared<mapget::StringPool>(
        "SubsetRendererPool");
    auto tileId = mapget::TileId::fromWgs84(11.0, 48.0, 13);
    auto subset = std::make_shared<mapget::TileSubsetLayer>(
        tileId,
        "SubsetRendererPool",
        "TestMap",
        info,
        strings,
        "roads",
        3);
    subset->setGeometryAnchor({11.0, 48.0, 0.0});

    auto featureId = subset->newFeatureId(
        "Road",
        {{"roadId", int64_t{7}}});
    std::vector<std::string> featureFields{
        "roadClass",
        "drawOrder",
        "detailLod",
    };
    auto channel = subset->newChannel(
        "style-rule:0",
        mapget::Scope::Feature,
        1U << static_cast<uint8_t>(mapget::GeomType::Line),
        "centerline",
        featureFields);
    std::vector<simfil::ModelNode::Ptr> featureValues{
        subset->newValue(int64_t{2}),
        subset->newValue(int64_t{17}),
        subset->newValue(4.2),
    };
    channel->newFeatureEntry(
        featureId,
        lineGeometry(*subset, "centerline"),
        featureValues);

    auto style = rendererStyle(R"yaml(
name: SubsetRenderer
version: 2
rules:
  - type: Road
    geometry: line
    geometry-name: centerline
    width: 4
    z-index-expression: drawOrder
    min-lod-expression: detailLod
    glow: {color: "#102030", radius: 5, opacity: 0.5}
    color-scale:
      mode: categorical
      expression: roadClass
      stops:
        - [1, "#ff0000"]
        - [2, "#00ff00"]
      fallback: "#0000ff"
    width-scale:
      mode: categorical
      expression: roadClass
      stops:
        - [1, 2]
        - [2, 6]
      fallback: 1
)yaml");
    REQUIRE(style.isValid());

    TileSubsetLayerRenderer renderer(
        0,
        "Features:TestMap:Road:0",
        style,
        static_cast<int>(FeatureStyleRule::NoHighlight),
        FeatureStyleRule::kMaximumLod);
    installSubset(renderer, TileSubsetLayer(subset));
    renderer.run();

    RendererPacketView packet(renderer);
    REQUIRE(renderer.vertexCount() == 2);
    auto const pathStreams = packet.streams(GpuPrimitiveKind::PathSegment);
    REQUIRE(pathStreams.size() == 1);
    auto const& pathStream = pathStreams.front();
    REQUIRE(pathStream.count == 1);
    REQUIRE(pathStream.glowColor == std::array<uint8_t, 4>{16, 32, 48, 128});
    REQUIRE(pathStream.glowRadius == 5.0F);
    REQUIRE((pathStream.flags & static_cast<uint16_t>(
        GpuMaterialFlag::SimplePath)) != 0U);
    auto const record = pathStream.dataOffset;
    REQUIRE(packet.read<float>(record + 24U) == 6.0F);
    auto const packedLocalZIndex = packet.read<uint32_t>(record + 28U);
    REQUIRE((packedLocalZIndex & kGpuLocalZIndexMask) == 0U);
    REQUIRE((packedLocalZIndex >> kGpuMinimumLodShift) == 5U);
    REQUIRE(packet.zIndices(0U) == std::vector<double>{17.0});
    REQUIRE(packet.read<uint8_t>(record + 32U) == 0U);
    REQUIRE(packet.read<uint8_t>(record + 33U) == 255U);
    REQUIRE(packet.read<uint8_t>(record + 34U) == 0U);
    REQUIRE(packet.read<uint8_t>(record + 35U) == 255U);
    auto const picks = packet.picks();
    REQUIRE(picks.size() == 1);
    REQUIRE(picks[0].contributionIndex == 0U);
    REQUIRE(picks[0].localPickIndex == 0U);
    REQUIRE(picks[0].channelOrdinal == 0U);
    REQUIRE(picks[0].entryOrdinal == 0U);
    REQUIRE(picks[0].endpointRole == 0U);
    REQUIRE(picks[0].navigationAltitude == 0.0F);
    REQUIRE(packet.issues().empty());

    TileSubsetLayer pickLayer(subset);
    auto const references = pickLayer.findPickReferences(
        "Road.7", "feature", -1, -1);
    REQUIRE(references == nlohmann::json::array({{
        {"channelOrdinal", 0U},
        {"entryOrdinal", 0U},
        {"endpointRole", 0U},
    }}));
    auto const resolved = pickLayer.resolvePick(0U, 0U, 0U);
    REQUIRE(resolved["featureId"] == "Road.7");

    TileSubsetLayerRenderer duplicateRenderer(
        0,
        "z13/d1/p0",
        style,
        static_cast<int>(FeatureStyleRule::NoHighlight),
        FeatureStyleRule::kMaximumLod);
    installSubset(duplicateRenderer, TileSubsetLayer(subset));
    REQUIRE_THROWS_AS(
        installSubset(duplicateRenderer, TileSubsetLayer(subset)),
        std::logic_error);
}

TEST_CASE(
    "TileSubsetLayerRenderer extrudes mesh surfaces from projected style fields",
    "[erdblick.subset-renderer]")
{
    auto info = rendererLayerInfo();
    auto strings = std::make_shared<mapget::StringPool>("SubsetRendererPool");
    auto tileId = mapget::TileId::fromWgs84(11.0, 48.0, 13);
    auto subset = std::make_shared<mapget::TileSubsetLayer>(
        tileId,
        "SubsetRendererPool",
        "TestMap",
        info,
        strings,
        "roads",
        3);
    subset->setGeometryAnchor({11.0, 48.0, 0.0});

    auto featureId = subset->newFeatureId("Road", {{"roadId", int64_t{7}}});
    std::vector<std::string> featureFields{"height"};
    auto channel = subset->newChannel(
        "style-rule:0",
        mapget::Scope::Feature,
        1U << static_cast<uint8_t>(mapget::GeomType::Mesh),
        "footprint",
        featureFields);
    std::vector<simfil::ModelNode::Ptr> featureValues{
        subset->newValue(12.0),
    };
    channel->newFeatureEntry(
        featureId,
        meshGeometry(*subset, "footprint"),
        featureValues);

    auto style = rendererStyle(R"yaml(
name: PolygonExtrusion
version: 2
rules:
  - type: Road
    geometry: mesh
    geometry-name: footprint
    surface-shading: true
    polygon-height-expression: height
    color: "#506070"
)yaml");
    REQUIRE(style.isValid());

    TileSubsetLayerRenderer renderer(
        0,
        "Features:TestMap:Road:0",
        style,
        static_cast<int>(FeatureStyleRule::NoHighlight),
        FeatureStyleRule::kMaximumLod);
    installSubset(renderer, TileSubsetLayer(subset));
    renderer.run();

    RendererPacketView packet(renderer);
    auto const surfaceStreams = packet.streams(GpuPrimitiveKind::SurfaceTriangle);
    REQUIRE(surfaceStreams.size() == 1);
    CHECK(surfaceStreams.front().count == 10U);
    CHECK((surfaceStreams.front().flags & static_cast<uint16_t>(
        GpuMaterialFlag::SurfaceShading)) != 0U);
}

TEST_CASE(
    "TileSubsetLayerRenderer keeps geometry continuous across packet origins",
    "[erdblick.subset-renderer][projection]")
{
    auto info = rendererLayerInfo();
    auto strings = std::make_shared<mapget::StringPool>(
        "SubsetRendererProjectionPool");
    auto tileId = mapget::TileId::fromWgs84(11.25, 50.0, 5);
    auto subset = std::make_shared<mapget::TileSubsetLayer>(
        tileId,
        "SubsetRendererProjectionPool",
        "TestMap",
        info,
        strings,
        "roads",
        1);
    auto featureId = subset->newFeatureId(
        "Road",
        {{"roadId", int64_t{8}}});
    auto channel = subset->newChannel(
        "style-rule:0",
        mapget::Scope::Feature,
        1U << static_cast<uint8_t>(mapget::GeomType::Line),
        "centerline");
    std::array<mapget::Point, 2> const points{{
        {11.25, 50.0, 0.0},
        {11.251, 50.001, 0.0},
    }};
    channel->newFeatureEntry(
        featureId,
        lineGeometryWithPoints(*subset, "centerline", points),
        {});

    auto style = rendererStyle(R"yaml(
name: Projection
version: 2
rules:
  - type: Road
    geometry: line
    geometry-name: centerline
    color: "#ff0000"
    width: 2
)yaml");
    REQUIRE(style.isValid());

    auto renderFirstPoint = [&](double originLongitude,
                                double originLatitude) {
        TileSubsetLayerRenderer renderer(
            0,
            "Features:TestMap:Road:0",
            style,
            static_cast<int>(FeatureStyleRule::NoHighlight),
            FeatureStyleRule::kMaximumLod);
        renderer.setCoordinateOrigin(
            originLongitude,
            originLatitude,
            0.0);
        installSubset(renderer, TileSubsetLayer(subset));
        renderer.run();
        auto const paths = RendererPacketView(renderer).paths();
        REQUIRE(paths.size() == 1U);
        REQUIRE(paths.front().points.size() == 2U);
        return paths.front().points.front();
    };
    auto reconstructCommonPosition = [](double originLongitude,
                                        double originLatitude,
                                        mapget::Point const& localPoint) {
        constexpr double pi = 3.14159265358979323846;
        constexpr double worldSize = 512.0;
        constexpr double earthCircumferenceMeters = 40.03e6;
        auto const originLatitudeRadians = originLatitude * pi / 180.0;
        auto const unitsPerMeter = worldSize /
            earthCircumferenceMeters /
            std::abs(std::cos(originLatitudeRadians));
        auto const originWorldX = worldSize *
            ((originLongitude * pi / 180.0) + pi) / (2.0 * pi);
        auto const originWorldY = worldSize *
            (pi + std::log(std::tan(
                pi * 0.25 + originLatitudeRadians * 0.5))) /
            (2.0 * pi);
        return mapget::Point{
            originWorldX + localPoint.x * unitsPerMeter,
            originWorldY + localPoint.y * unitsPerMeter,
            localPoint.z,
        };
    };

    auto const west = reconstructCommonPosition(
        8.4375,
        47.8125,
        renderFirstPoint(8.4375, 47.8125));
    auto const east = reconstructCommonPosition(
        14.0625,
        47.8125,
        renderFirstPoint(14.0625, 47.8125));
    REQUIRE(std::abs(west.x - east.x) < 1e-5);
    REQUIRE(std::abs(west.y - east.y) < 1e-5);

    auto const south = reconstructCommonPosition(
        11.25,
        47.8125,
        renderFirstPoint(11.25, 47.8125));
    auto const north = reconstructCommonPosition(
        11.25,
        53.4375,
        renderFirstPoint(11.25, 53.4375));
    REQUIRE(std::abs(south.x - north.x) < 1e-5);
    REQUIRE(std::abs(south.y - north.y) < 1e-5);
}

TEST_CASE(
    "TileSubsetLayerRenderer assigns stable depth ties by feature identity",
    "[erdblick.subset-renderer][depth]")
{
    auto info = rendererLayerInfo();
    auto strings = std::make_shared<mapget::StringPool>(
        "SubsetRendererDepthPool");
    auto style = rendererStyle(R"yaml(
name: StableDepth
version: 2
rules:
  - type: Road
    geometry: line
    geometry-name: centerline
    color: "#ffffff"
    width: 2
    z-index: 10
)yaml");
    REQUIRE(style.isValid());

    auto renderTieKeys = [&](mapget::TileId const& tileId) {
        auto subset = std::make_shared<mapget::TileSubsetLayer>(
            tileId,
            "SubsetRendererDepthPool",
            "TestMap",
            info,
            strings,
            "roads",
            1);
        auto channel = subset->newChannel(
            "style-rule:0",
            mapget::Scope::Feature,
            1U << static_cast<uint8_t>(mapget::GeomType::Line),
            "centerline");
        for (auto const roadId : {int64_t{7}, int64_t{8}}) {
            channel->newFeatureEntry(
                subset->newFeatureId("Road", {{"roadId", roadId}}),
                lineGeometry(*subset, "centerline"),
                {});
        }
        TileSubsetLayerRenderer renderer(
            0,
            "Features:TestMap:Road:0",
            style,
            static_cast<int>(FeatureStyleRule::NoHighlight),
            FeatureStyleRule::kMaximumLod);
        installSubset(renderer, TileSubsetLayer(subset));
        renderer.run();
        return RendererPacketView(renderer).depthTieKeys(0U);
    };

    auto const tileId = mapget::TileId::fromWgs84(11.0, 48.0, 13);
    auto const first = renderTieKeys(tileId);
    auto const second = renderTieKeys(tileId);
    auto const east = renderTieKeys(tileId.neighbour(1, 0));
    REQUIRE(first.size() == 2U);
    REQUIRE(first[0] != first[1]);
    REQUIRE((first[0] & 0xFU) != (first[1] & 0xFU));
    REQUIRE(second == first);
    REQUIRE((first[0] & 0xFU) != (east[0] & 0xFU));
}

TEST_CASE(
    "TileSubsetLayerRenderer fuses compatible bundled line strokes",
    "[erdblick.subset-renderer][performance]")
{
    auto info = rendererLayerInfo();
    auto strings = std::make_shared<mapget::StringPool>(
        "SubsetRendererBundledRulesPool");
    auto subset = std::make_shared<mapget::TileSubsetLayer>(
        mapget::TileId::fromWgs84(11.0, 48.0, 13),
        "SubsetRendererBundledRulesPool",
        "TestMap",
        info,
        strings,
        "roads",
        1);
    subset->setGeometryAnchor({11.0, 48.0, 0.0});
    auto channel = subset->newChannel(
        "style-rules:0,1",
        mapget::Scope::Feature,
        1U << static_cast<uint8_t>(mapget::GeomType::Line),
        "centerline");
    channel->newFeatureEntry(
        subset->newFeatureId("Road", {{"roadId", int64_t{7}}}),
        lineGeometry(*subset, "centerline"),
        {});

    auto style = rendererStyle(R"yaml(
name: BundledRules
version: 2
rules:
  - type: Road
    geometry: line
    geometry-name: centerline
    color: "#000000"
    opacity: 0.94
    width: 6
    z-index: 3
  - type: Road
    geometry: line
    geometry-name: centerline
    color: "#ffffff"
    width: 3
    z-index: 3
)yaml");
    REQUIRE(style.isValid());

    TileSubsetLayerRenderer renderer(
        0,
        "Features:TestMap:Road:0",
        style,
        static_cast<int>(FeatureStyleRule::NoHighlight),
        FeatureStyleRule::kMaximumLod);
    installSubset(renderer, TileSubsetLayer(subset));
    renderer.run();

    RendererPacketView packet(renderer);
    REQUIRE(renderer.vertexCount() == 2);
    auto const pathStreams = packet.streams(GpuPrimitiveKind::PathSegment);
    REQUIRE(pathStreams.size() == 1);
    auto const& pathStream = pathStreams.front();
    REQUIRE(pathStream.count == 1U);
    REQUIRE(pathStream.stride == kGpuDualSimplePathSegmentRecordBytes);
    REQUIRE((pathStream.flags & static_cast<uint16_t>(
        GpuMaterialFlag::SimplePath)) != 0U);
    REQUIRE((pathStream.flags & static_cast<uint16_t>(
        GpuMaterialFlag::DualStrokePath)) != 0U);
    REQUIRE(packet.read<float>(pathStream.dataOffset + 24U) == 6.0F);
    REQUIRE(packet.read<float>(pathStream.dataOffset + 52U) == 3.0F);
    REQUIRE(packet.read<uint8_t>(pathStream.dataOffset + 32U) == 0U);
    REQUIRE(packet.read<uint8_t>(pathStream.dataOffset + 35U) == 240U);
    REQUIRE(packet.read<uint8_t>(pathStream.dataOffset + 56U) == 255U);
    REQUIRE(packet.picks().size() == 1);
    REQUIRE(packet.picks()[0].channelOrdinal == 0U);
    REQUIRE(packet.picks()[0].entryOrdinal == 0U);
    REQUIRE(packet.picks()[0].endpointRole == 0U);

    auto splitStyle = rendererStyle(R"yaml(
name: OrderedCasingRules
version: 2
rules:
  - type: Road
    geometry: line
    geometry-name: centerline
    color: "#000000"
    width: 6
    z-index: 3
  - type: Road
    geometry: line
    geometry-name: centerline
    color: "#ffffff"
    width: 3
    z-index: 4
)yaml");
    REQUIRE(splitStyle.isValid());

    TileSubsetLayerRenderer splitRenderer(
        0,
        "Features:TestMap:Road:0",
        splitStyle,
        static_cast<int>(FeatureStyleRule::NoHighlight),
        FeatureStyleRule::kMaximumLod);
    installSubset(splitRenderer, TileSubsetLayer(subset));
    splitRenderer.run();

    RendererPacketView splitPacket(splitRenderer);
    auto const splitStreams =
        splitPacket.streams(GpuPrimitiveKind::PathSegment);
    REQUIRE(splitStreams.size() == 2U);
    REQUIRE(std::ranges::none_of(
        splitStreams,
        [](RendererPacketView::Stream const& stream) {
            return (stream.flags & static_cast<uint16_t>(
                GpuMaterialFlag::DualStrokePath)) != 0U;
        }));
    REQUIRE(splitPacket.zIndices(0U) == std::vector<double>{3.0, 4.0});
}

TEST_CASE(
    "TileSubsetLayerRenderer simplifies only undecorated paths",
    "[erdblick.subset-renderer][performance]")
{
    auto info = rendererLayerInfo();
    auto strings = std::make_shared<mapget::StringPool>(
        "SubsetRendererSimplificationPool");
    auto subset = std::make_shared<mapget::TileSubsetLayer>(
        mapget::TileId::fromWgs84(11.0, 48.0, 13),
        "SubsetRendererSimplificationPool",
        "TestMap",
        info,
        strings,
        "roads",
        1);
    subset->setGeometryAnchor({11.0, 48.0, 0.0});
    std::array<mapget::Point, 5> const points{{
        {11.0, 48.0, 0.0},
        {11.0001, 48.00001, 0.0},
        {11.0002, 48.0, 0.0},
        {11.0003, 48.00001, 0.0},
        {11.0004, 48.0, 0.0},
    }};
    auto const featureId = subset->newFeatureId(
        "Road",
        {{"roadId", int64_t{7}}});
    for (uint32_t ruleIndex = 0U; ruleIndex < 3U; ++ruleIndex) {
        auto channel = subset->newChannel(
            "style-rule:" + std::to_string(ruleIndex),
            mapget::Scope::Feature,
            1U << static_cast<uint8_t>(mapget::GeomType::Line),
            "centerline");
        channel->newFeatureEntry(
            featureId,
            lineGeometryWithPoints(*subset, "centerline", points),
            {});
    }

    auto style = rendererStyle(R"yaml(
name: Simplification
version: 2
rules:
  - type: Road
    geometry: line
    geometry-name: centerline
    color: "#ff0000"
    width: 2
  - type: Road
    geometry: line
    geometry-name: centerline
    color: "#00ff00"
    width: 2
    dashed: true
  - type: Road
    geometry: line
    geometry-name: centerline
    color: "#0000ff"
    width: 2
    arrow: forward
)yaml");
    REQUIRE(style.isValid());

    TileSubsetLayerRenderer renderer(
        0,
        "Features:TestMap:Road:0",
        style,
        static_cast<int>(FeatureStyleRule::NoHighlight),
        FeatureStyleRule::kMaximumLod);
    renderer.setCoordinateOrigin(11.0, 48.0, 0.0);
    renderer.setLineSimplificationTolerance(5.0);
    installSubset(renderer, TileSubsetLayer(subset));
    renderer.run();

    auto const streams = RendererPacketView(renderer).streams(
        GpuPrimitiveKind::PathSegment);
    REQUIRE(streams.size() == 3U);
    std::vector<uint32_t> recordCounts;
    std::ranges::transform(
        streams,
        std::back_inserter(recordCounts),
        &RendererPacketView::Stream::count);
    std::ranges::sort(recordCounts);
    REQUIRE(recordCounts == std::vector<uint32_t>{1U, 4U, 4U});
    REQUIRE(renderer.vertexCount() == 15U);
}

TEST_CASE(
    "TileSubsetLayerRenderer rejects geometry with the wrong semantic name",
    "[erdblick.subset-renderer]")
{
    auto info = rendererLayerInfo();
    auto strings = std::make_shared<mapget::StringPool>(
        "SubsetRendererNamePool");
    auto tileId = mapget::TileId::fromWgs84(11.0, 48.0, 13);
    auto subset = std::make_shared<mapget::TileSubsetLayer>(
        tileId,
        "SubsetRendererNamePool",
        "TestMap",
        info,
        strings,
        "roads",
        1);

    auto featureId = subset->newFeatureId(
        "Road",
        {{"roadId", int64_t{8}}});
    auto channel = subset->newChannel(
        "style-rule:0",
        mapget::Scope::Feature,
        1U << static_cast<uint8_t>(mapget::GeomType::Line),
        "centerline");
    channel->newFeatureEntry(
        featureId,
        lineGeometry(*subset, "topology"),
        {});

    auto style = rendererStyle(R"yaml(
name: SemanticGeometry
version: 2
rules:
  - type: Road
    geometry: line
    geometry-name: centerline
    color: "#ffffff"
    width: 2
)yaml");
    REQUIRE(style.isValid());

    TileSubsetLayerRenderer renderer(
        0,
        "Features:TestMap:Road:0",
        style,
        static_cast<int>(FeatureStyleRule::NoHighlight),
        FeatureStyleRule::kMaximumLod);
    installSubset(renderer, TileSubsetLayer(subset));
    renderer.run();

    REQUIRE(renderer.vertexCount() == 0);
    REQUIRE(RendererPacketView(renderer).streams(
        GpuPrimitiveKind::PathSegment).empty());
}

TEST_CASE(
    "TileSubsetLayerRenderer labels each semantic relation endpoint once",
    "[erdblick.subset-renderer][relation]")
{
    auto info = rendererLayerInfo();
    auto strings = std::make_shared<mapget::StringPool>(
        "SubsetRendererRelationLabelPool");
    auto tileId = mapget::TileId::fromWgs84(11.0, 48.0, 13);
    auto subset = std::make_shared<mapget::TileSubsetLayer>(
        tileId,
        "SubsetRendererRelationLabelPool",
        "TestMap",
        info,
        strings,
        "relations",
        1);
    subset->setGeometryAnchor({11.0, 48.0, 0.0});

    auto endpointGeometry = [&](double longitude) {
        auto collection = subset->newGeometryCollection(2, true);
        for (double latitude : {48.0, 48.0001}) {
            auto geometry = subset->newGeometry(
                mapget::GeomType::Line,
                2,
                true);
            geometry->setName("centerline");
            geometry->append({longitude, latitude, 0.0});
            geometry->append({longitude + 0.0001, latitude, 0.0});
            collection->addGeometry(geometry);
        }
        return collection;
    };
    auto road1 = subset->newFeatureId("Road", {{"roadId", int64_t{1}}});
    auto road2 = subset->newFeatureId("Road", {{"roadId", int64_t{2}}});
    auto road3 = subset->newFeatureId("Road", {{"roadId", int64_t{3}}});
    std::vector<std::string> endpointFields{"endpointLabel", "4"};
    auto channel = subset->newChannel(
        "style-rule:0",
        mapget::Scope::Relation,
        1U << static_cast<uint8_t>(mapget::GeomType::Line),
        "centerline",
        endpointFields);
    auto endpoint = [&](mapget::model_ptr<mapget::FeatureId> const& featureId,
                        std::string_view label,
                        double longitude) {
        std::vector<simfil::ModelNode::Ptr> values{
            subset->newValue(label),
            subset->newValue(int64_t{4}),
        };
        return channel->newFeatureEntry(
            featureId,
            endpointGeometry(longitude),
            values);
    };
    auto source1 = endpoint(road1, "1", 11.0);
    auto target2 = endpoint(road2, "2", 11.001);
    // Deliberately materialize the same semantic endpoint a second time to
    // cover both defensive renderer de-duplication and source/target role
    // changes in a recursive relation graph.
    auto source2 = endpoint(road2, "2", 11.001);
    auto target3 = endpoint(road3, "3", 11.002);
    channel->newRelationEntry(
        "Road.1/connectedTo/0",
        "connectedTo",
        "stored",
        mapget::RelationDirection::Forward,
        false,
        source1,
        target2,
        source1->geometry(),
        target2->geometry());
    channel->newRelationEntry(
        "Road.2/connectedTo/0",
        "connectedTo",
        "stored",
        mapget::RelationDirection::Forward,
        false,
        source2,
        target3,
        source2->geometry(),
        target3->geometry());

    auto style = rendererStyle(R"yaml(
name: RelationEndpointLabels
version: 2
rules:
  - type: Road
    scope: relation
    relation-type: connectedTo
    geometry: line
    width: 0
    relation-source-style:
      geometry: line
      geometry-name: centerline
      opacity: 0
      billboard: true
      label-font-family: Helvetica Neue
      label-font-weight: 800
      label-size: 7
      label-text-expression: endpointLabel
      min-lod-expression: 4
      label-text-anchor: start
      label-alignment-baseline: bottom
    relation-target-style:
      geometry: line
      geometry-name: centerline
      opacity: 0
      billboard: true
      label-font-family: Helvetica Neue
      label-font-weight: 800
      label-size: 7
      label-text-expression: endpointLabel
      min-lod-expression: 4
      label-text-anchor: start
      label-alignment-baseline: bottom
)yaml");
    REQUIRE(style.isValid());

    TileSubsetLayerRenderer renderer(
        0,
        "Features:TestMap:Road:0",
        style,
        static_cast<int>(FeatureStyleRule::NoHighlight),
        FeatureStyleRule::kMaximumLod);
    installSubset(renderer, TileSubsetLayer(subset));
    renderer.run();

    auto const packet = RendererPacketView(renderer);
    auto const labels = packet.labelTexts();
    REQUIRE(labels.size() == 3);
    REQUIRE(labels[0] == "1");
    REQUIRE(labels[1] == "2");
    REQUIRE(labels[2] == "3");
    REQUIRE(packet.labelSizes() == std::vector<float>(3U, 7.0F));
    REQUIRE(packet.labelFontFamilies() ==
        std::vector<std::string>(3U, "Helvetica Neue"));
    REQUIRE(packet.labelFontWeights() == std::vector<uint32_t>(3U, 800U));
    REQUIRE(packet.labelMinimumLods() == std::vector<uint8_t>(3U, 4U));
    REQUIRE(packet.labelAlignments() ==
        std::vector<std::pair<int32_t, int32_t>>(3U, {-1, 1}));
}

TEST_CASE(
    "TileSubsetLayerRenderer draws a shared interaction relation stub for both modes",
    "[erdblick.subset-renderer][relation]")
{
    auto info = rendererLayerInfo();
    auto strings = std::make_shared<mapget::StringPool>(
        "SubsetRendererRelationStubPool");
    auto tileId = mapget::TileId::fromWgs84(11.0, 48.0, 13);
    auto subset = std::make_shared<mapget::TileSubsetLayer>(
        tileId,
        "SubsetRendererRelationStubPool",
        "TestMap",
        info,
        strings,
        "relations",
        1);
    subset->setGeometryAnchor({11.0, 48.0, 0.0});

    auto emptyGeometry = subset->newGeometryCollection(0, true);
    auto laneGeometry = lineGeometryWithPoints(
        *subset,
        "centerline",
        std::array{
            mapget::Point{11.0, 48.0, 0.0},
            mapget::Point{11.001, 48.0, 0.0},
        });
    auto endpointGeometry = subset->newGeometryCollection(1, true);
    auto endpoint = subset->newGeometry(mapget::GeomType::Points, 1, true);
    endpoint->append({11.0, 48.0, 0.0});
    endpointGeometry->addGeometry(endpoint);

    auto connectorId = subset->newFeatureId(
        "Road",
        {{"roadId", int64_t{1}}});
    auto laneId = subset->newFeatureId(
        "Road",
        {{"roadId", int64_t{2}}});
    auto channel = subset->newChannel(
        "style-rule:0",
        mapget::Scope::Relation,
        1U << static_cast<uint8_t>(mapget::GeomType::Line),
        std::nullopt);
    auto connector = channel->newFeatureEntry(
        connectorId,
        emptyGeometry,
        {});
    auto lane = channel->newFeatureEntry(
        laneId,
        laneGeometry,
        {});
    channel->newRelationEntry(
        "Features:TestMap:Road:0:Road.1#3<->"
        "Features:TestMap:Road:0:Road.2#7",
        "outgoingLane",
        "stored",
        mapget::RelationDirection::Forward,
        true,
        connector,
        lane,
        emptyGeometry,
        endpointGeometry);

    auto style = rendererStyle(R"yaml(
name: RelationStub
version: 2
rules:
  - type: Road
    scope: relation
    mode: [hover, selection]
    relation-type: outgoingLane
    relation-line-geometry: connection-stubs
    geometry: line
    color: "#ffffff"
    width: 2
    arrow: forward
)yaml");
    REQUIRE(style.isValid());

    for (auto const mode : {
             FeatureStyleRule::HoverHighlight,
             FeatureStyleRule::SelectionHighlight})
    {
        TileSubsetLayerRenderer renderer(
            0,
            "Features:TestMap:Road:0",
            style,
            static_cast<int>(mode),
            FeatureStyleRule::kMaximumLod);
        renderer.setCoordinateOrigin(11.0, 48.0, 0.0);
        installSubset(renderer, TileSubsetLayer(subset));
        renderer.run();

        auto const paths = RendererPacketView(renderer).paths();
        REQUIRE(paths.size() == 1U);
        REQUIRE(paths.front().points.size() == 2U);
        auto const& first = paths.front().points.front();
        auto const& second = paths.front().points.back();
        REQUIRE(std::hypot(first.x, first.y) < 0.01);
        REQUIRE(std::abs(second.z - first.z) < 1.0e-6);
        REQUIRE(second.x > first.x);
        REQUIRE(second.distanceTo(first) > 7.9);
        REQUIRE(second.distanceTo(first) < 8.1);
    }

    auto const expectedReferences = nlohmann::json::array({
        {
            {"channelOrdinal", 0U},
            {"entryOrdinal", 0U},
            {"endpointRole", 0U},
        },
        {
            {"channelOrdinal", 0U},
            {"entryOrdinal", 0U},
            {"endpointRole", 1U},
        },
        {
            {"channelOrdinal", 0U},
            {"entryOrdinal", 0U},
            {"endpointRole", 2U},
        },
    });
    TileSubsetLayer pickLayer(subset);
    REQUIRE(pickLayer.findPickReferences(
        "Road.1", "relation", 3, -1) == expectedReferences);
    REQUIRE(pickLayer.findPickReferences(
        "Road.2", "relation", 7, -1) == expectedReferences);
}

TEST_CASE(
    "TileSubsetLayerRenderer anchors a visible connection stub at a point lane",
    "[erdblick.subset-renderer][relation]")
{
    auto info = rendererLayerInfo();
    auto strings = std::make_shared<mapget::StringPool>(
        "SubsetRendererConnectionStubPool");
    auto tileId = mapget::TileId::fromWgs84(11.0, 48.0, 13);
    auto subset = std::make_shared<mapget::TileSubsetLayer>(
        tileId,
        "SubsetRendererConnectionStubPool",
        "TestMap",
        info,
        strings,
        "relations",
        1);
    subset->setGeometryAnchor({11.0, 48.0, 0.0});

    auto laneGeometry = lineGeometryWithPoints(
        *subset,
        "centerline",
        std::array{
            mapget::Point{11.0, 48.0, 0.0},
            mapget::Point{11.001, 48.0, 0.0},
        });
    auto pointGeometry = subset->newGeometryCollection(1, true);
    auto point = subset->newGeometry(mapget::GeomType::Points, 1, true);
    point->append({11.001, 48.0, 0.0});
    pointGeometry->addGeometry(point);

    auto sourceId = subset->newFeatureId("Road", {{"roadId", int64_t{1}}});
    auto targetId = subset->newFeatureId("Road", {{"roadId", int64_t{2}}});
    auto channel = subset->newChannel(
        "style-rule:0",
        mapget::Scope::Relation,
        1U << static_cast<uint8_t>(mapget::GeomType::Line),
        std::nullopt);
    auto source = channel->newFeatureEntry(sourceId, laneGeometry, {});
    auto target = channel->newFeatureEntry(targetId, pointGeometry, {});
    channel->newRelationEntry(
        "Road.1/nextLane/0",
        "nextLane",
        "stored",
        mapget::RelationDirection::Forward,
        false,
        source,
        target,
        laneGeometry,
        pointGeometry);

    auto style = rendererStyle(R"yaml(
name: ConnectionStub
version: 2
rules:
  - type: Road
    scope: relation
    relation-type: nextLane
    relation-line-geometry: connection-stubs
    geometry: line
    color: "#ffffff"
    width: 2
    arrow: forward
)yaml");
    REQUIRE(style.isValid());

    TileSubsetLayerRenderer renderer(
        0,
        "Features:TestMap:Road:0",
        style,
        static_cast<int>(FeatureStyleRule::NoHighlight),
        FeatureStyleRule::kMaximumLod);
    renderer.setCoordinateOrigin(11.0, 48.0, 0.0);
    installSubset(renderer, TileSubsetLayer(subset));
    renderer.run();

    RendererPacketView packet(renderer);
    auto const paths = packet.paths();
    REQUIRE(paths.size() == 1U);
    REQUIRE(paths.front().points.size() == 2U);
    REQUIRE(paths.front().points.back().distanceTo(
        paths.front().points.front()) == Catch::Approx(8.0).margin(0.1));

    auto const pathStreams = packet.streams(GpuPrimitiveKind::PathSegment);
    REQUIRE(pathStreams.size() == 1U);
    REQUIRE((pathStreams.front().flags & static_cast<uint16_t>(
        GpuMaterialFlag::ScreenLengthEndAnchor)) != 0U);
    auto const arrowStreams = packet.streams(GpuPrimitiveKind::Arrow);
    REQUIRE(arrowStreams.size() == 1U);
    REQUIRE((arrowStreams.front().flags & static_cast<uint16_t>(
        GpuMaterialFlag::ScreenLengthEndAnchor)) != 0U);
}

TEST_CASE(
    "TileSubsetLayerRenderer rings a coincident point-to-point connection",
    "[erdblick.subset-renderer][relation]")
{
    auto info = rendererLayerInfo();
    auto strings = std::make_shared<mapget::StringPool>(
        "SubsetRendererCoincidentConnectionPool");
    auto tileId = mapget::TileId::fromWgs84(11.0, 48.0, 13);
    auto subset = std::make_shared<mapget::TileSubsetLayer>(
        tileId,
        "SubsetRendererCoincidentConnectionPool",
        "TestMap",
        info,
        strings,
        "relations",
        1);
    subset->setGeometryAnchor({11.0, 48.0, 0.0});

    auto makePointGeometry = [&] {
        auto collection = subset->newGeometryCollection(1, true);
        auto point = subset->newGeometry(mapget::GeomType::Points, 1, true);
        point->append({11.0, 48.0, 0.0});
        collection->addGeometry(point);
        return collection;
    };
    auto sourceGeometry = makePointGeometry();
    auto targetGeometry = makePointGeometry();
    auto sourceId = subset->newFeatureId("Road", {{"roadId", int64_t{1}}});
    auto targetId = subset->newFeatureId("Road", {{"roadId", int64_t{2}}});
    auto channel = subset->newChannel(
        "style-rule:0",
        mapget::Scope::Relation,
        1U << static_cast<uint8_t>(mapget::GeomType::Line),
        std::nullopt);
    auto source = channel->newFeatureEntry(sourceId, sourceGeometry, {});
    auto target = channel->newFeatureEntry(targetId, targetGeometry, {});
    channel->newRelationEntry(
        "Road.1/nextLane/0",
        "nextLane",
        "stored",
        mapget::RelationDirection::Forward,
        false,
        source,
        target,
        sourceGeometry,
        targetGeometry);

    auto style = rendererStyle(R"yaml(
name: CoincidentConnection
version: 2
rules:
  - type: Road
    scope: relation
    relation-type: nextLane
    relation-line-geometry: connection-stubs
    relation-line-height-offset: 4
    geometry: line
    billboard: true
    color: "#ffffff"
    width: 2.5
    arrow: forward
    glow: {color: "#000000", radius: 3, opacity: 0.5}
)yaml");
    REQUIRE(style.isValid());

    TileSubsetLayerRenderer renderer(
        0,
        "Features:TestMap:Road:0",
        style,
        static_cast<int>(FeatureStyleRule::NoHighlight),
        FeatureStyleRule::kMaximumLod);
    renderer.setCoordinateOrigin(11.0, 48.0, 0.0);
    installSubset(renderer, TileSubsetLayer(subset));
    renderer.run();

    RendererPacketView packet(renderer);
    REQUIRE(packet.paths().empty());
    REQUIRE(packet.arrows().empty());
    auto const pointStreams = packet.streams(GpuPrimitiveKind::Point);
    REQUIRE(pointStreams.size() == 1U);
    auto const& ring = pointStreams.front();
    REQUIRE(ring.count == 1U);
    REQUIRE(ring.stride == kGpuPointRecordBytes);
    REQUIRE((ring.flags & static_cast<uint16_t>(
        GpuMaterialFlag::Billboard)) != 0U);
    REQUIRE((ring.flags & static_cast<uint16_t>(
        GpuMaterialFlag::PointRing)) != 0U);
    REQUIRE(ring.glowRadius == Catch::Approx(3.0F));
    REQUIRE(packet.read<float>(ring.dataOffset + 12U) ==
        Catch::Approx(12.0F));
    REQUIRE(packet.read<float>(ring.dataOffset + 8U) ==
        Catch::Approx(4.0F));
}

TEST_CASE(
    "TileSubsetLayerRenderer offsets every terminal attribute validity entry",
    "[erdblick.subset-renderer]")
{
    auto info = rendererLayerInfo();
    auto strings = std::make_shared<mapget::StringPool>(
        "SubsetRendererValidityPool");
    auto tileId = mapget::TileId::fromWgs84(11.0, 48.0, 13);
    auto subset = std::make_shared<mapget::TileSubsetLayer>(
        tileId,
        "SubsetRendererValidityPool",
        "TestMap",
        info,
        strings,
        "validities",
        1);
    subset->setGeometryAnchor({11.0, 48.0, 0.0});

    auto featureId = subset->newFeatureId(
        "Road",
        {{"roadId", int64_t{11}}});
    auto channel = subset->newChannel(
        "style-rule:0",
        mapget::Scope::Attribute,
        1U << static_cast<uint8_t>(mapget::GeomType::Line),
        "centerline");
    channel->newAttributeValidityEntry(
        featureId,
        lineGeometry(*subset, "centerline"),
        0,
        true,
        0,
        2,
        {},
        {},
        "rules",
        "PROHIBITED_TRANSITION");
    channel->newAttributeValidityEntry(
        featureId,
        lineGeometry(*subset, "centerline"),
        0,
        true,
        1,
        2,
        {},
        {},
        "rules",
        "PROHIBITED_TRANSITION");

    auto style = rendererStyle(R"yaml(
name: ValidityOffsets
version: 2
rules:
  - type: Road
    scope: attribute
    geometry: line
    geometry-name: centerline
    color: "#ffffff"
    offset-increment: [0, 0, 5]
)yaml");
    REQUIRE(style.isValid());

    TileSubsetLayerRenderer renderer(
        0,
        "Features:TestMap:Road:0",
        style,
        static_cast<int>(FeatureStyleRule::NoHighlight),
        FeatureStyleRule::kMaximumLod);
    installSubset(renderer, TileSubsetLayer(subset));
    renderer.run();

    auto const paths = RendererPacketView(renderer).paths();
    REQUIRE(paths.size() == 2);
    REQUIRE(paths[0].points.size() == 2);
    REQUIRE(paths[1].points.size() == 2);
    REQUIRE(paths[0].points.front().z == 0.0);
    REQUIRE(paths[0].points.back().z == 0.0);
    REQUIRE(paths[1].points.front().z == 5.0);
    REQUIRE(paths[1].points.back().z == 5.0);
}

TEST_CASE(
    "Shared interaction rules render complete attributes with double arrows",
    "[erdblick.subset-renderer]")
{
    auto info = rendererLayerInfo();
    auto strings = std::make_shared<mapget::StringPool>(
        "SubsetRendererCompleteValidityPool");
    auto tileId = mapget::TileId::fromWgs84(11.0, 48.0, 13);
    auto subset = std::make_shared<mapget::TileSubsetLayer>(
        tileId,
        "SubsetRendererCompleteValidityPool",
        "TestMap",
        info,
        strings,
        "validities",
        1);
    subset->setGeometryAnchor({11.0, 48.0, 0.0});

    std::string const arrowExpression =
        "$hasValidity and (((validity[$validityIndex].direction == 'POSITIVE' or "
        "validity[$validityIndex].direction == 'NEGATIVE') and 'forward') or "
        "'double') or 'none'";
    std::vector<std::string> entryFields{arrowExpression};
    auto channel = subset->newChannel(
        "style-rule:0",
        mapget::Scope::Attribute,
        1U << static_cast<uint8_t>(mapget::GeomType::Line),
        "centerline",
        {},
        entryFields);
    auto featureId = subset->newFeatureId(
        "Road",
        {{"roadId", int64_t{12}}});
    std::vector<simfil::ModelNode::Ptr> entryValues{
        subset->newValue("double"),
    };
    channel->newAttributeValidityEntry(
        featureId,
        lineGeometry(*subset, "centerline"),
        0,
        true,
        0,
        1,
        {},
        entryValues,
        "rules",
        "CURVATURE");

    auto style = rendererStyle(R"yaml(
name: Complete validity arrows
version: 2
rules:
  - type: Road
    scope: attribute
    mode: [hover, selection]
    geometry: line
    geometry-name: centerline
    color: "#ffffff"
    arrow-expression: "$hasValidity and (((validity[$validityIndex].direction == 'POSITIVE' or validity[$validityIndex].direction == 'NEGATIVE') and 'forward') or 'double') or 'none'"
)yaml");
    REQUIRE(style.isValid());

    for (auto const mode : {
             FeatureStyleRule::HoverHighlight,
             FeatureStyleRule::SelectionHighlight})
    {
        TileSubsetLayerRenderer renderer(
            0,
            "Features:TestMap:Road:0",
            style,
            static_cast<int>(mode),
            FeatureStyleRule::kMaximumLod);
        installSubset(renderer, TileSubsetLayer(subset));
        renderer.run();

        REQUIRE(RendererPacketView(renderer).arrows().size() == 2U);
    }
}

TEST_CASE(
    "TileSubsetLayerRenderer stacks shared validity line segments independently",
    "[erdblick.subset-renderer]")
{
    auto info = rendererLayerInfo();
    auto strings = std::make_shared<mapget::StringPool>(
        "SubsetRendererSegmentStackPool");
    auto tileId = mapget::TileId::fromWgs84(11.0, 48.0, 13);
    auto subset = std::make_shared<mapget::TileSubsetLayer>(
        tileId,
        "SubsetRendererSegmentStackPool",
        "TestMap",
        info,
        strings,
        "validities",
        1);
    subset->setGeometryAnchor({11.0, 48.0, 0.0});

    auto featureId = subset->newFeatureId(
        "Road",
        {{"roadId", int64_t{11}}});
    auto channel = subset->newChannel(
        "style-rule:0",
        mapget::Scope::Attribute,
        1U << static_cast<uint8_t>(mapget::GeomType::Line),
        "centerline");
    auto transitionGeometry =
        [&](std::array<mapget::Point, 3> const& points) {
            auto collection = subset->newGeometryCollection(1, true);
            auto geometry = subset->newGeometry(
                mapget::GeomType::Line,
                3,
                true);
            geometry->setName("centerline");
            for (auto const& point : points) {
                geometry->append(point);
            }
            collection->addGeometry(geometry);
            return collection;
        };
    channel->newAttributeValidityEntry(
        featureId,
        transitionGeometry({{
            {10.999, 48.0, 0.0},
            {11.0, 48.0, 0.0},
            {11.001, 48.0, 0.0},
        }}),
        0,
        true,
        0,
        2,
        {},
        {},
        "rules",
        "PROHIBITED_TRANSITION");
    channel->newAttributeValidityEntry(
        featureId,
        transitionGeometry({{
            {11.001, 48.0, 0.0},
            {11.0, 48.0, 0.0},
            {11.0, 47.999, 0.0},
        }}),
        0,
        true,
        1,
        2,
        {},
        {},
        "rules",
        "PROHIBITED_TRANSITION");

    auto style = rendererStyle(R"yaml(
name: SegmentValidityOffsets
version: 2
rules:
  - type: Road
    scope: attribute
    geometry: line
    geometry-name: centerline
    color: "#ffffff"
    offset: [2, 0, 0]
    offset-increment: [2, 0, 0]
)yaml");
    REQUIRE(style.isValid());

    TileSubsetLayerRenderer renderer(
        0,
        "Features:TestMap:Road:0",
        style,
        static_cast<int>(FeatureStyleRule::NoHighlight),
        FeatureStyleRule::kMaximumLod);
    installSubset(renderer, TileSubsetLayer(subset));
    renderer.run();

    auto const paths = RendererPacketView(renderer).paths();
    REQUIRE(paths.size() == 2);
    REQUIRE(paths[0].points.size() > 2);
    REQUIRE(paths[1].points.size() > 2);
    // The shared east/west link is traversed in opposite directions.  A
    // positive authored offset is relative to each transition's visible
    // traversal, so the two occurrences occupy opposite physical sides.  The
    // later transition still reserves the next lane for the shared leg.
    auto rightmostY = [&](size_t pathIndex) {
        auto const& points = paths[pathIndex].points;
        auto rightmostX = points.front().x;
        auto y = points.front().y;
        for (auto const& point : points) {
            if (point.x > rightmostX) {
                rightmostX = point.x;
                y = point.y;
            }
        }
        return y;
    };
    auto const firstSharedRightY = rightmostY(0);
    auto const secondSharedRightY = rightmostY(1);
    REQUIRE(firstSharedRightY * secondSharedRightY < 0.0);
    REQUIRE(std::abs(secondSharedRightY) > std::abs(firstSharedRightY));
}

TEST_CASE(
    "TileSubsetLayerRenderer diagnoses entries which match no concrete rule",
    "[erdblick.subset-renderer]")
{
    auto info = rendererLayerInfo();
    auto strings = std::make_shared<mapget::StringPool>(
        "SubsetRendererRuleMatchPool");
    auto tileId = mapget::TileId::fromWgs84(11.0, 48.0, 13);
    auto subset = std::make_shared<mapget::TileSubsetLayer>(
        tileId,
        "SubsetRendererRuleMatchPool",
        "TestMap",
        info,
        strings,
        "roads",
        1);

    auto featureId = subset->newFeatureId(
        "Road",
        {{"roadId", int64_t{9}}});
    auto channel = subset->newChannel(
        "style-rule:0",
        mapget::Scope::Feature,
        1U << static_cast<uint8_t>(mapget::GeomType::Line),
        "centerline");
    channel->newFeatureEntry(
        featureId,
        lineGeometry(*subset, "centerline"),
        {});

    auto style = rendererStyle(R"yaml(
name: RuleMismatch
version: 2
rules:
  - first-of:
      - type: Lane
        geometry: line
        geometry-name: centerline
        color: "#ffffff"
)yaml");
    REQUIRE(style.isValid());

    TileSubsetLayerRenderer renderer(
        0,
        "Features:TestMap:Road:0",
        style,
        static_cast<int>(FeatureStyleRule::NoHighlight),
        FeatureStyleRule::kMaximumLod);
    installSubset(renderer, TileSubsetLayer(subset));
    renderer.run();

    REQUIRE(renderer.vertexCount() == 0);
    auto const issues = RendererPacketView(renderer).issues();
    REQUIRE(issues.size() == 1);
    REQUIRE(issues[0].property == "rule-match");
    REQUIRE(issues[0].expression == "Road");
}

TEST_CASE(
    "TileSubsetLayerRenderer stacks typed transition legs by physical road side",
    "[erdblick.subset-renderer][transition]")
{
    auto info = rendererLayerInfo();
    auto strings = std::make_shared<mapget::StringPool>(
        "SubsetRendererTypedTransitionPool");
    auto subset = std::make_shared<mapget::TileSubsetLayer>(
        mapget::TileId::fromWgs84(11.0, 48.0, 13),
        "SubsetRendererTypedTransitionPool",
        "TestMap",
        info,
        strings,
        "transitions",
        1);
    subset->setGeometryAnchor({11.0, 48.0, 0.0});
    auto host = subset->newFeatureId("Road", {{"roadId", int64_t{11}}});
    auto from = subset->newFeatureId("Road", {{"roadId", int64_t{1}}});
    auto toRight = subset->newFeatureId("Road", {{"roadId", int64_t{2}}});
    auto toSharperRight = subset->newFeatureId("Road", {{"roadId", int64_t{3}}});
    auto toLeft = subset->newFeatureId("Road", {{"roadId", int64_t{5}}});
    auto hairpinHost = subset->newFeatureId("Road", {{"roadId", int64_t{21}}});
    auto hairpinFrom = subset->newFeatureId("Road", {{"roadId", int64_t{22}}});
    auto hairpinTo = subset->newFeatureId("Road", {{"roadId", int64_t{23}}});
    auto channel = subset->newChannel(
        "style-rule:0",
        mapget::Scope::Attribute,
        1U << static_cast<uint8_t>(mapget::GeomType::Line),
        "centerline");
    auto geometry = [&](mapget::Point const& outerTo) {
        auto collection = subset->newGeometryCollection(1, true);
        auto line = subset->newGeometry(mapget::GeomType::Line, 5, true);
        line->setName("centerline");
        for (auto const& point : {
                 mapget::Point{10.9999, 48.0, 0.0},
                 mapget::Point{11.0, 48.0, 0.0},
                 mapget::Point{11.0, 48.0, 0.0},
                 mapget::Point{11.0, 48.0, 0.0},
                 outerTo})
        {
            line->append(point);
        }
        collection->addGeometry(line);
        return collection;
    };
    channel->newAttributeValidityEntry(
        host,
        geometry({11.0, 47.9999, 0.0}),
        0,
        true,
        0,
        3,
        {},
        {},
        "rules",
        "turn",
        mapget::ValidityData::FeatureTransition,
        from,
        mapget::ValidityData::End,
        toRight,
        mapget::ValidityData::Start,
        2);
    channel->newAttributeValidityEntry(
        host,
        geometry({10.99995, 47.9999, 0.0}),
        0,
        true,
        1,
        3,
        {},
        {},
        "rules",
        "turn",
        mapget::ValidityData::FeatureTransition,
        from,
        mapget::ValidityData::End,
        toSharperRight,
        mapget::ValidityData::Start,
        2);
    channel->newAttributeValidityEntry(
        host,
        geometry({11.0, 48.0001, 0.0}),
        0,
        true,
        2,
        3,
        {},
        {},
        "rules",
        "turn",
        mapget::ValidityData::FeatureTransition,
        from,
        mapget::ValidityData::End,
        toLeft,
        mapget::ValidityData::End,
        2);
    channel->newAttributeValidityEntry(
        host,
        geometry({10.9999, 48.0, 0.0}),
        0,
        true,
        3,
        4,
        {},
        {},
        "rules",
        "turn",
        mapget::ValidityData::FeatureTransition,
        from,
        mapget::ValidityData::End,
        from,
        mapget::ValidityData::End,
        2);
    channel->newAttributeValidityEntry(
        hairpinHost,
        geometry({10.9999, 48.00002, 0.0}),
        0,
        true,
        0,
        1,
        {},
        {},
        "rules",
        "turn",
        mapget::ValidityData::FeatureTransition,
        hairpinFrom,
        mapget::ValidityData::End,
        hairpinTo,
        mapget::ValidityData::Start,
        2);

    auto style = rendererStyle(R"yaml(
name: TypedTransitionOffsets
version: 2
rules:
  - type: Road
    scope: attribute
    geometry: line
    geometry-name: centerline
    color: "#ffffff"
    width: 2
    offset: [2, 0, 0]
    offset-increment: [2, 0, 0]
    lateral-offset-unit: px
    arrow: forward
)yaml");
    REQUIRE(style.isValid());

    TileSubsetLayerRenderer renderer(
        0,
        "Features:TestMap:Road:0",
        style,
        static_cast<int>(FeatureStyleRule::NoHighlight),
        FeatureStyleRule::kMaximumLod);
    installSubset(renderer, TileSubsetLayer(subset));
    renderer.run();
    RendererPacketView packet(renderer);
    auto const paths = packet.paths();
    REQUIRE(paths.size() == 5);
    auto pathStartOffset = [&](size_t pathIndex) {
        return paths[pathIndex].lateralOffsetsPx.front();
    };
    auto pathEndOffset = [&](size_t pathIndex) {
        return paths[pathIndex].lateralOffsetsPx.back();
    };
    // The first two maneuvers are right turns. Their common incoming road's
    // physical right-side stack advances independently of either outgoing
    // road, which starts at its own first slot.
    REQUIRE(pathStartOffset(0) == 2.0f);
    REQUIRE(pathEndOffset(0) == 2.0f);
    REQUIRE(pathStartOffset(1) == 4.0f);
    REQUIRE(pathEndOffset(1) == 2.0f);
    // A left turn takes the negative (left-of-traversal) side even though the
    // YAML's distance is positive. Reversed connected ends affect only the
    // canonical road-side key, not the visible turn side.
    REQUIRE(pathStartOffset(2) == -2.0f);
    REQUIRE(pathEndOffset(2) == -2.0f);
    // The U-turn occupies the common road's already-used canonical left and
    // right stacks independently. Its path remains left-of-traversal on both
    // legs while the magnitudes reflect the two distinct stack depths.
    REQUIRE(pathStartOffset(3) == -4.0f);
    REQUIRE(pathEndOffset(3) == -6.0f);
    // One host/rule uses one path-wide factor, including its U-turn. The
    // compact U-turn's correctly wound vector arc does not independently
    // reduce the lateral stack distance.
    auto const ordinaryScaleThreshold = paths[0].scaleThreshold;
    REQUIRE(ordinaryScaleThreshold > 0.0f);
    REQUIRE(paths[1].scaleThreshold == ordinaryScaleThreshold);
    REQUIRE(paths[2].scaleThreshold == ordinaryScaleThreshold);
    auto const uTurnScaleThreshold = paths[3].scaleThreshold;
    REQUIRE(uTurnScaleThreshold == ordinaryScaleThreshold);
    // A nearly reversing transition between different roads remains an
    // ordinary turn. It therefore contributes a real motion-derived safety
    // threshold instead of being misclassified as the compact U-turn above.
    auto const hairpinScaleThreshold = paths[4].scaleThreshold;
    REQUIRE(hairpinScaleThreshold > 0.0f);
    REQUIRE(hairpinScaleThreshold < ordinaryScaleThreshold);
    auto const& uTurn = paths[3];
    auto const uTurnBaseY = uTurn.points.front().y;
    auto maxUturnLateralDeparture = 0.0;
    for (auto const& point : uTurn.points) {
        maxUturnLateralDeparture = std::max(
            maxUturnLateralDeparture,
            std::abs(point.y - uTurnBaseY));
    }
    // Pixel-offset U-turns keep the undisplaced bridge on the source road.
    // The screen-space vector stream below owns the visible hairpin. Mixing a
    // second world-space side loop into it creates zoom-dependent loops.
    REQUIRE(maxUturnLateralDeparture < 1.0e-5);
    auto vectorAt = [&](size_t pathIndex, size_t pointIndex) {
        auto const& value = paths[pathIndex]
            .lateralOffsetVectorsPx[pointIndex];
        return std::pair{
            value[0],
            value[1],
        };
    };
    // The first right turn starts south of its eastbound incoming road and
    // ends west of its southbound outgoing road.
    REQUIRE(vectorAt(0, 0) ==
        std::pair{0.0f, -2.0f});
    REQUIRE(vectorAt(0, paths[0].points.size() - 1U) ==
        std::pair{-2.0f, 0.0f});
    // The bridge rotates its screen-space road normal without shrinking the
    // authored lane radius. Component-wise interpolation would collapse a
    // right-angle lane below either endpoint and drive a U-turn through zero.
    auto vectorMagnitude = [&](size_t pathIndex, size_t pointIndex) {
        auto const [x, y] = vectorAt(pathIndex, pointIndex);
        return std::hypot(x, y);
    };
    for (size_t pathIndex = 0; pathIndex < paths.size(); ++pathIndex) {
        auto const minimumMagnitude = std::min(
            std::abs(pathStartOffset(pathIndex)),
            std::abs(pathEndOffset(pathIndex)));
        auto const maximumMagnitude = std::max(
            std::abs(pathStartOffset(pathIndex)),
            std::abs(pathEndOffset(pathIndex)));
        for (size_t pointIndex = 0;
             pointIndex < paths[pathIndex].points.size();
             ++pointIndex) {
            REQUIRE(vectorMagnitude(pathIndex, pointIndex) >=
                minimumMagnitude - 1.0e-4f);
            REQUIRE(vectorMagnitude(pathIndex, pointIndex) <=
                maximumMagnitude + 1.0e-4f);
        }
    }
    // The U-turn bridge rotates between the two independently stacked sides
    // rather than deriving an offset from its projected curve radius.
    REQUIRE(vectorAt(3, 0) == std::pair{0.0f, 4.0f});
    REQUIRE(vectorAt(3, uTurn.points.size() - 1U) ==
        std::pair{0.0f, -6.0f});
    auto maximumUturnForwardOffset = 0.0f;
    auto minimumUturnForwardOffset = 0.0f;
    for (size_t pointIndex = 0;
         pointIndex < uTurn.points.size();
         ++pointIndex) {
        auto const [x, unusedY] = vectorAt(3, pointIndex);
        static_cast<void>(unusedY);
        maximumUturnForwardOffset = std::max(
            maximumUturnForwardOffset,
            x);
        minimumUturnForwardOffset = std::min(
            minimumUturnForwardOffset,
            x);
    }
    // The conventional left U-turn bows forward (east in this fixture). The
    // opposite winding bows backward and creates the inverted terminal hook.
    REQUIRE(maximumUturnForwardOffset > 3.0f);
    REQUIRE(minimumUturnForwardOffset >= -1.0e-4f);
    auto const arrows = packet.arrows();
    REQUIRE(arrows.size() == 5);
    auto arrowTipVector = [&](size_t pathIndex) {
        return std::pair{
            arrows[pathIndex].lateralOffsetVectorPx[0],
            arrows[pathIndex].lateralOffsetVectorPx[1],
        };
    };
    REQUIRE(arrowTipVector(0) == std::pair{-2.0f, 0.0f});
    REQUIRE(arrowTipVector(3) == std::pair{0.0f, -6.0f});
    for (size_t pathIndex = 0; pathIndex < 5; ++pathIndex) {
        REQUIRE(arrows[pathIndex].scaleThreshold ==
            paths[pathIndex].scaleThreshold);
        REQUIRE((arrows[pathIndex].flags & static_cast<uint32_t>(
            GpuArrowRecordFlag::VariableOffset)) != 0U);
    }
}

TEST_CASE(
    "TileSubsetLayerRenderer silently skips an inactive LOD channel",
    "[erdblick.subset-renderer]")
{
    auto info = rendererLayerInfo();
    auto strings = std::make_shared<mapget::StringPool>(
        "SubsetRendererLodPool");
    auto tileId = mapget::TileId::fromWgs84(11.0, 48.0, 13);
    auto subset = std::make_shared<mapget::TileSubsetLayer>(
        tileId,
        "SubsetRendererLodPool",
        "TestMap",
        info,
        strings,
        "roads",
        1);

    auto featureId = subset->newFeatureId(
        "Road",
        {{"roadId", int64_t{10}}});
    auto channel = subset->newChannel(
        "style-rule:0",
        mapget::Scope::Feature,
        1U << static_cast<uint8_t>(mapget::GeomType::Line),
        "centerline");
    channel->newFeatureEntry(
        featureId,
        lineGeometry(*subset, "centerline"),
        {});

    auto style = rendererStyle(R"yaml(
name: LodSwitch
version: 2
rules:
  - type: Road
    fidelity: low
    geometry: line
    geometry-name: centerline
    color: "#ffffff"
)yaml");
    REQUIRE(style.isValid());

    TileSubsetLayerRenderer renderer(
        0,
        "Features:TestMap:Road:0",
        style,
        static_cast<int>(FeatureStyleRule::NoHighlight),
        FeatureStyleRule::kMaximumLod);
    installSubset(renderer, TileSubsetLayer(subset));
    renderer.run();

    REQUIRE(renderer.vertexCount() == 0);
    REQUIRE(RendererPacketView(renderer).issues().empty());
}

TEST_CASE(
    "TileSubsetLayerRenderer silently skips a reserved search result channel",
    "[erdblick.subset-renderer]")
{
    auto info = rendererLayerInfo();
    auto strings = std::make_shared<mapget::StringPool>(
        "SubsetRendererSearchResultsPool");
    auto tileId = mapget::TileId::fromWgs84(11.0, 48.0, 13);
    auto subset = std::make_shared<mapget::TileSubsetLayer>(
        tileId,
        "SubsetRendererSearchResultsPool",
        "TestMap",
        info,
        strings,
        "roads",
        1);

    auto featureId = subset->newFeatureId(
        "Road",
        {{"roadId", int64_t{11}}});
    auto channel = subset->newChannel(
        "search-results:session:TestMap/Road",
        mapget::Scope::Feature,
        1U << static_cast<uint8_t>(mapget::GeomType::Line),
        "centerline");
    channel->newFeatureEntry(
        featureId,
        lineGeometry(*subset, "centerline"),
        {});

    auto style = rendererStyle(R"yaml(
name: SearchResultSkip
category: search
version: 2
rules:
  - geometry: line
    color: "#ffffff"
)yaml");
    REQUIRE(style.isValid());

    TileSubsetLayerRenderer renderer(
        0,
        "Features:TestMap:Road:0",
        style,
        static_cast<int>(FeatureStyleRule::NoHighlight),
        FeatureStyleRule::kMaximumLod);
    installSubset(renderer, TileSubsetLayer(subset));
    renderer.run();

    REQUIRE(renderer.vertexCount() == 0);
    REQUIRE(RendererPacketView(renderer).issues().empty());
}
