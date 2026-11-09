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

/**
 * Path-wide values expanded into independently drawable segment records.
 * Spans are borrowed only during appendPath().
 */
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

/**
 * Final stream ranges belonging to one path and its optional arrowheads, valid
 * only in the producing builder until reset().
 */
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
 * concatenates these bytes and writes their descriptors. Configure before rendering,
 * append geometry/labels within non-nested contributions, then close them before
 * building. Append failures can leave partial state; reset before reusing a failed build.
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

    /** Set packet sequencing and deterministic origin metadata before any contribution or primitive records exist. */
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

    /**
     * Expand one directed polyline into final adjacency segment and arrow records.
     * Fewer than two points or nonpositive width emits nothing. Screen-length
     * anchors require two points; overlays require a narrower compact stroke.
     */
    [[nodiscard]] GpuPathRecordHandle appendPath(
        GpuPathRecordData const& path,
        bool billboard,
        bool depthTest);

    /**
     * Patch one transition group's final contraction threshold in-place using a
     * live full-layout path/arrow handle. Clamps negative thresholds to zero and
     * rejects compact paths.
     */
    void updateAdaptiveOffsetThreshold(
        GpuPathRecordHandle const& handle,
        float threshold);

    /**
     * Triangulates outer/hole rings and optionally raises a roof with walls. Invalid
     * or non-increasing ring starts are ignored; a degenerate outer ring emits nothing.
     */
    void appendSurface(
        std::span<mapget::Point const> points,
        std::span<uint32_t const> ringStarts,
        GpuRecordStyle const& style,
        bool depthTest,
        double polygonHeight = 0.0,
        bool surfaceShading = false);

    /**
     * Append triangle-list surface geometry, ignoring trailing vertices that do
     * not form a complete triangle. Positive height extrudes exact-coordinate
     * boundary edges.
     */
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

    /**
     * Add semantic picking metadata after geometry assigns local indices.
     * Append in contribution/local-index order; complete builds require dense
     * local indices from zero.
     */
    void appendPick(GpuPickRecord pick);

    /** Add one logical label owned by its current contribution. */
    void appendLabel(GpuLabelRecord label);

    /** Add a deduplicated missing browser-resource request. */
    void appendResourceRequest(GpuResourceRequest request);

    /**
     * Add one style evaluation issue without touching primitive streams.
     * Its contribution must exist; keep issues grouped by increasing owner for
     * fragmentation.
     */
    void appendRuntimeIssue(GpuRuntimeIssue issue);

    /**
     * Encode the complete transferable packet after closing contributions and
     * checking logical ownership. Throws on invalid metadata or size overflow.
     */
    [[nodiscard]] std::vector<std::byte> build() const;

    /** Splits a closed revision into bounded fragments; throws if an individual record or z-index table cannot fit. */
    [[nodiscard]] std::vector<std::vector<std::byte>> buildFragments() const;

    /** Number of contribution descriptors currently present in the packet. */
    [[nodiscard]] uint32_t contributionCount() const;

private:
    class Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace erdblick
