#pragma once

#include "erdblick/gpu-render-packet.h"

#include "mapget/model/point.h"

#include <glm/vec2.hpp>

#include <array>
#include <cstdint>
#include <memory>
#include <optional>
#include <span>
#include <vector>

namespace erdblick
{

inline constexpr uint32_t kGpuUnselectable = 0xffffffffU;
inline constexpr uint32_t kGpuLocalZIndexMask = 0x1fffffffU;
inline constexpr uint32_t kGpuMinimumLodShift = 29U;
// The scene allocator uses power-of-two tie buckets up to this fixed limit.
// Retaining any higher hash bits in packet metadata cannot affect rendering.
inline constexpr uint32_t kGpuDepthTieBucketCount = 32U;

/** Per-segment branches consumed by the shared path and mask shaders. */
enum class GpuPathRecordFlag : uint32_t {
    None = 0U,
    Active = 1U << 0U,
    StartCap = 1U << 1U,
    EndCap = 1U << 2U,
    VariableOffset = 1U << 3U,
    Dashed = 1U << 4U,
    TrimStart = 1U << 5U,
    TrimEnd = 1U << 6U,
    DashMeters = 1U << 7U,
};

/** Per-instance branches consumed by the arrow shader. */
enum class GpuArrowRecordFlag : uint32_t {
    None = 0U,
    Active = 1U << 0U,
    VariableOffset = 1U << 1U,
};

/** Stream-level function in the semantic support/overlay render pipeline. */
enum class GpuSemanticZIndexRole {
    None,
    Support,
    Overlay,
};

/** Style values common to point, path, arrow, and surface records. */
struct GpuRecordStyle {
    std::array<uint8_t, 4> color{};
    std::array<uint8_t, 4> glowColor{};
    float glowRadius = 0.0F;
    double zIndex = 0.0;
    uint32_t depthTieKey = 0U;
    uint32_t semanticGroup = 0U;
    GpuSemanticZIndexRole semanticZIndexRole = GpuSemanticZIndexRole::None;
    uint32_t localPickIndex = kGpuUnselectable;
    uint32_t renderOrder = 0U;
    uint8_t minimumLod = 0U;
};

/** Final point-instance values before explicit byte packing. */
struct GpuPointRecordData {
    mapget::Point position;
    float radius = 0.0F;
    GpuRecordStyle style;
};

/** Inner stroke painted inside one wider path without duplicating geometry. */
struct GpuPathOverlay {
    float width = 0.0F;
    std::array<uint8_t, 4> color{};
};

/** Pins one end or the midpoint while a short path is enlarged in screen space. */
enum class GpuScreenLengthAnchor {
    None,
    Start,
    End,
    Center,
};

/** Path-wide values copied into each independently drawable segment record. */
struct GpuPathRecordData {
    std::span<mapget::Point const> points;
    std::span<float const> lateralOffsetsPx;
    std::span<glm::fvec2 const> lateralOffsetVectorsPx;
    float width = 0.0F;
    float dashLength = 1.0F;
    float dashGap = 0.0F;
    bool dashUnitsMeters = false;
    float lateralOffsetScaleThreshold = 0.0F;
    bool forwardArrow = false;
    bool backwardArrow = false;
    GpuScreenLengthAnchor screenLengthAnchor = GpuScreenLengthAnchor::None;
    std::optional<GpuPathOverlay> overlay;
    GpuRecordStyle style;
};

/** One screen-space triangle arrow expanded by the shared arrow vertex shader. */
struct GpuArrowRecordData {
    mapget::Point previous;
    mapget::Point tip;
    std::array<float, 2> lateralOffsetVectorPx{};
    float lateralOffsetPx = 0.0F;
    float width = 0.0F;
    float lateralOffsetScaleThreshold = 0.0F;
    bool variableOffset = false;
    GpuScreenLengthAnchor screenLengthAnchor = GpuScreenLengthAnchor::None;
    GpuRecordStyle style;
};

/** Browser-atlas icon instance; arrows deliberately use a separate record. */
struct GpuIconRecordData {
    mapget::Point position;
    std::array<float, 2> pixelSize{};
    std::array<float, 2> pixelOffset{};
    std::array<float, 4> uv{};
    uint32_t atlasPage = 0U;
    uint32_t flags = 0U;
    GpuRecordStyle style;
};

/** Final stream ranges belonging to one path and its optional arrowheads. */
struct GpuPathRecordHandle {
    uint32_t pathStreamIndex = 0xffffffffU;
    uint32_t firstPathRecord = 0U;
    uint32_t pathRecordCount = 0U;
    uint32_t arrowStreamIndex = 0xffffffffU;
    uint32_t firstArrowRecord = 0U;
    uint32_t arrowRecordCount = 0U;
};

/**
 * Builds final fixed-stride primitive streams while preserving contribution
 * ownership. Geometry is expanded exactly once here; packet encoding only
 * concatenates these bytes and writes their descriptors.
 */
class GpuRenderPacketBuilder
{
public:
    /** Create an empty packet writer with default scene metadata. */
    GpuRenderPacketBuilder();
    ~GpuRenderPacketBuilder();

    GpuRenderPacketBuilder(GpuRenderPacketBuilder const&) = delete;
    GpuRenderPacketBuilder& operator=(GpuRenderPacketBuilder const&) = delete;
    GpuRenderPacketBuilder(GpuRenderPacketBuilder&&) noexcept;
    GpuRenderPacketBuilder& operator=(GpuRenderPacketBuilder&&) noexcept;

    /** Clear one completed or failed packet while retaining stream allocations. */
    void reset();

    /** Replace packet sequencing and deterministic origin metadata. */
    void configure(
        uint32_t sceneGeneration,
        uint32_t packetSequence,
        uint32_t iconCatalogVersion,
        GpuPacketOrigin origin);

    /** Begin one independently replaceable contribution before appending records. */
    void beginContribution(
        uint64_t key,
        uint32_t revision,
        uint32_t slot,
        uint32_t activationToken);

    /** Close the active contribution and capture all stream ranges it appended. */
    void endContribution();

    /** Append one final point instance. */
    void appendPoint(
        GpuPointRecordData const& point,
        bool billboard,
        bool depthTest,
        bool ring = false);

    /** Expand one directed polyline into final adjacency segment and arrow records. */
    [[nodiscard]] GpuPathRecordHandle appendPath(
        GpuPathRecordData const& path,
        bool billboard,
        bool depthTest);

    /** Patch one transition group's final contraction threshold in-place. */
    void updateAdaptiveOffsetThreshold(
        GpuPathRecordHandle const& handle,
        float threshold);

    /** Triangulate one polygon and optionally add a raised roof plus ring walls. */
    void appendSurface(
        std::span<mapget::Point const> points,
        std::span<uint32_t const> ringStarts,
        GpuRecordStyle const& style,
        bool depthTest,
        double polygonHeight = 0.0,
        bool surfaceShading = false);

    /** Append triangle-list surface geometry and optionally extrude its boundary. */
    void appendTriangleMesh(
        std::span<mapget::Point const> points,
        GpuRecordStyle const& style,
        bool depthTest,
        double polygonHeight = 0.0,
        bool surfaceShading = false);

    /** Append one atlas-backed icon instance. */
    void appendIcon(
        GpuIconRecordData const& icon,
        bool billboard,
        bool depthTest);

    /** Add semantic picking metadata after local indices have been assigned. */
    void appendPick(GpuPickRecord pick);

    /** Add one logical label owned by its current contribution. */
    void appendLabel(GpuLabelRecord label);

    /** Add a deduplicated missing browser-resource request. */
    void appendResourceRequest(GpuResourceRequest request);

    /** Add one style evaluation issue without touching primitive streams. */
    void appendRuntimeIssue(GpuRuntimeIssue issue);

    /** Encode and validate the complete transferable packet. */
    [[nodiscard]] std::vector<std::byte> build() const;

    /** Split an oversized revision into individually bounded packet fragments. */
    [[nodiscard]] std::vector<std::vector<std::byte>> buildFragments() const;

    /** Number of contribution descriptors currently present in the packet. */
    [[nodiscard]] uint32_t contributionCount() const;

private:
    class Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace erdblick
