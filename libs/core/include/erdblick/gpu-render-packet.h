#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <span>
#include <string>
#include <vector>

namespace erdblick
{

/** Binary ABI version understood by the persistent GPU renderer. */
inline constexpr uint16_t kGpuRenderPacketAbiVersion = 10U;

/** Little-endian integer whose bytes spell `ERGP`. */
inline constexpr uint32_t kGpuRenderPacketMagic = 0x50475245U;

/** Fixed packet-header size. All packet tables begin at or after this byte. */
inline constexpr uint16_t kGpuRenderPacketHeaderBytes = 160U;

/** Hard worker-output ceiling used to keep one transferable packet bounded. */
inline constexpr uint32_t kGpuRenderPacketMaxBytes = 4U * 1024U * 1024U;

/** Maximum fragments retained for one worker task before admission. */
inline constexpr uint32_t kGpuRenderPacketMaxFragments = 8U;

/** Packet-level lifecycle marker; only the final fragment may complete a revision. */
enum class GpuRenderPacketFlag : uint32_t {
    None = 0U,
    RevisionComplete = 1U << 0U,
};

/** Primitive program selected by one record-stream descriptor. */
enum class GpuPrimitiveKind : uint16_t {
    Point = 1U,
    PathSegment = 2U,
    Arrow = 3U,
    SurfaceTriangle = 4U,
    Icon = 5U,
};

/** State that changes a shader program or fixed GPU render parameters. */
enum class GpuMaterialFlag : uint16_t {
    None = 0U,
    Billboard = 1U << 0U,
    DepthTest = 1U << 1U,
    CompactPath = 1U << 2U,
    SimplePath = 1U << 3U,
    DualStrokePath = 1U << 4U,
};

/** Exact fixed strides associated with each primitive program in ABI v10. */
inline constexpr uint32_t kGpuPointRecordBytes = 40U;
inline constexpr uint32_t kGpuSimplePathSegmentRecordBytes = 52U;
inline constexpr uint32_t kGpuCompactPathSegmentRecordBytes = 76U;
inline constexpr uint32_t kGpuDualSimplePathSegmentRecordBytes = 60U;
inline constexpr uint32_t kGpuDualCompactPathSegmentRecordBytes = 84U;
inline constexpr uint32_t kGpuPathSegmentRecordBytes = 144U;
inline constexpr uint32_t kGpuArrowRecordBytes = 68U;
inline constexpr uint32_t kGpuSurfaceTriangleRecordBytes = 60U;
inline constexpr uint32_t kGpuIconRecordBytes = 68U;
inline constexpr uint32_t kGpuZIndexEntryBytes = 16U;

/** Browser-owned resource categories requested by native packet generation. */
enum class GpuResourceKind : uint32_t {
    Icon = 1U,
};

/** Per-label branches retained by the shared Deck TextLayer host. */
enum class GpuLabelFlag : uint32_t {
    None = 0U,
    Billboard = 1U << 0U,
    DepthTest = 1U << 1U,
    Background = 1U << 2U,
    Collision = 1U << 3U,
};

/** Scene-assigned origin metadata shared by every vector record in a packet. */
struct GpuPacketOrigin {
    uint32_t slot = 0U;
    uint64_t key = 0U;
    double longitude = 0.0;
    double latitude = 0.0;
    double altitude = 0.0;
};

/** One physical fixed-stride stream ready for a bulk GPU upload. */
struct GpuRecordStream {
    GpuPrimitiveKind kind = GpuPrimitiveKind::Point;
    uint16_t flags = 0U;
    uint64_t materialKey = 0U;
    uint32_t recordStride = 0U;
    std::array<uint8_t, 4> glowColor{};
    float glowRadius = 0.0F;
    uint32_t atlasPage = 0U;
    uint32_t renderOrder = 0U;
    std::vector<std::byte> records;
};

/** A contiguous range in one record stream owned by one contribution. */
struct GpuContributionSpan {
    uint32_t streamIndex = 0U;
    uint32_t firstRecord = 0U;
    uint32_t recordCount = 0U;
};

/** One authored z-index and its contribution-independent rule-order tie key. */
struct GpuZIndexEntry {
    double value = 0.0;
    uint32_t tieBreaker = 0U;
};

/** Independently replaceable tile/style revision and its physical stream spans. */
struct GpuContribution {
    uint64_t key = 0U;
    uint32_t revision = 0U;
    uint32_t slot = 0U;
    uint32_t activationToken = 0U;
    uint32_t totalPickCount = 0U;
    std::vector<GpuContributionSpan> spans;
    std::vector<GpuZIndexEntry> zIndices;
};

/** Compact subset row identity resolved semantically only after interaction. */
struct GpuPickRecord {
    uint32_t contributionIndex = 0U;
    uint32_t localPickIndex = 0U;
    uint32_t channelOrdinal = 0U;
    uint32_t entryOrdinal = 0U;
    uint32_t endpointRole = 0U;
    float navigationAltitude = std::numeric_limits<float>::quiet_NaN();
};

/** Logical text datum retained by the shared Deck TextLayer host. */
struct GpuLabelRecord {
    uint32_t contributionIndex = 0U;
    uint32_t localPickIndex = 0U;
    std::array<double, 3> positionWgs84{};
    std::string text;
    std::string fontFamily;
    float size = 12.0F;
    std::array<float, 2> pixelOffset{};
    float angle = 0.0F;
    double zIndex = 0.0;
    std::array<uint8_t, 4> color{255U, 255U, 255U, 255U};
    std::array<uint8_t, 4> outlineColor{};
    std::array<uint8_t, 4> backgroundColor{};
    float outlineWidth = 0.0F;
    std::array<float, 2> backgroundPadding{};
    uint32_t flags = 0U;
    int32_t horizontalOrigin = 0;
    int32_t verticalOrigin = 0;
    uint32_t renderOrder = 0U;
    uint32_t fontWeight = 400U;
    int32_t collisionPriority = 0;
};

/** Browser resource missing from the worker's current append-only icon catalog. */
struct GpuResourceRequest {
    uint32_t resourceKind = 0U;
    std::string uri;
};

/** Runtime style issue transported outside primitive streams but inside the packet. */
struct GpuRuntimeIssue {
    uint32_t contributionIndex = 0U;
    uint32_t ruleIndex = 0U;
    uint64_t occurrenceCount = 1U;
    std::string property;
    std::string expression;
    std::string message;
};

/** Complete logical input encoded into one bounded `GpuRenderPacket`. */
struct GpuRenderPacketData {
    GpuRenderPacketFlag flags = GpuRenderPacketFlag::RevisionComplete;
    uint32_t sceneGeneration = 0U;
    uint32_t packetSequence = 0U;
    uint32_t fragmentIndex = 0U;
    uint32_t fragmentCount = 1U;
    uint32_t iconCatalogVersion = 0U;
    GpuPacketOrigin origin;
    std::vector<GpuRecordStream> streams;
    std::vector<GpuContribution> contributions;
    std::vector<GpuPickRecord> picks;
    std::vector<GpuLabelRecord> labels;
    std::vector<GpuResourceRequest> resourceRequests;
    std::vector<GpuRuntimeIssue> issues;
};

/** Header-only facts returned after validating every packet table and stream. */
struct GpuRenderPacketInfo {
    uint32_t totalBytes = 0U;
    uint32_t sceneGeneration = 0U;
    uint32_t packetSequence = 0U;
    uint32_t fragmentIndex = 0U;
    uint32_t fragmentCount = 0U;
    bool revisionComplete = false;
    uint32_t streamCount = 0U;
    uint32_t contributionCount = 0U;
    uint32_t pickCount = 0U;
    uint32_t labelCount = 0U;
    uint32_t zIndexCount = 0U;
};

/**
 * Explicit little-endian codec for the worker-to-main-thread GPU packet ABI.
 *
 * It never copies raw C++ object layouts. Every scalar is written at a named
 * offset, and validation checks table alignment, multiplication overflow,
 * packet bounds, stream strides, contribution spans, and string references.
 */
class GpuRenderPacketCodec
{
public:
    /** Return the exact encoded byte count without materializing packet bytes. */
    [[nodiscard]] static uint64_t encodedSize(
        GpuRenderPacketData const& packet);

    /** Encode one complete packet, throwing when references or sizes are invalid. */
    [[nodiscard]] static std::vector<std::byte> encode(
        GpuRenderPacketData const& packet);

    /** Encode using a previously computed exact size to avoid rescanning the packet. */
    [[nodiscard]] static std::vector<std::byte> encode(
        GpuRenderPacketData const& packet,
        uint64_t exactEncodedSize);

    /** Validate an untrusted packet before any GPU upload and return its summary. */
    [[nodiscard]] static GpuRenderPacketInfo validate(
        std::span<std::byte const> bytes);
};

} // namespace erdblick
