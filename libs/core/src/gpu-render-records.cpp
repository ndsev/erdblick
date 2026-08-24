#include "erdblick/gpu-render-records.h"

#include <algorithm>
#include <bit>
#include <cmath>
#include <cstring>
#include <limits>
#include <optional>
#include <stdexcept>
#include <tuple>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>
#include <utility>

#include <mapbox/earcut.hpp>

namespace erdblick
{
namespace
{

constexpr float kArrowMinimumPixels = 8.0F;
constexpr float kArrowWidthFactor = 4.0F;
constexpr float kArrowShaftOverlapPixels = 1.0F;
constexpr uint32_t kGpuRecordFlagMask = 0xffU;
constexpr uint32_t kGpuActivationTokenMax = 0x00ffffffU;
static_assert(std::has_single_bit(kGpuDepthTieBucketCount));

template<typename T>
void appendScalar(std::vector<std::byte>& bytes, T value)
{
    static_assert(std::is_trivially_copyable_v<T>);
    auto raw = std::bit_cast<std::array<std::byte, sizeof(T)>>(value);
    if constexpr (std::endian::native == std::endian::big) {
        std::reverse(raw.begin(), raw.end());
    }
    bytes.insert(bytes.end(), raw.begin(), raw.end());
}

template<typename T>
void overwriteScalar(
    std::vector<std::byte>& bytes,
    size_t offset,
    T value)
{
    static_assert(std::is_trivially_copyable_v<T>);
    if (offset + sizeof(T) > bytes.size()) {
        throw std::out_of_range("GPU record patch exceeds stream bounds.");
    }
    auto raw = std::bit_cast<std::array<std::byte, sizeof(T)>>(value);
    if constexpr (std::endian::native == std::endian::big) {
        std::reverse(raw.begin(), raw.end());
    }
    std::memcpy(bytes.data() + offset, raw.data(), raw.size());
}

void appendPoint3(std::vector<std::byte>& bytes, mapget::Point const& point)
{
    appendScalar(bytes, static_cast<float>(point.x));
    appendScalar(bytes, static_cast<float>(point.y));
    appendScalar(bytes, static_cast<float>(point.z));
}

void overwritePoint3(
    std::vector<std::byte>& bytes,
    size_t offset,
    mapget::Point const& point)
{
    overwriteScalar(bytes, offset, static_cast<float>(point.x));
    overwriteScalar(bytes, offset + 4U, static_cast<float>(point.y));
    overwriteScalar(bytes, offset + 8U, static_cast<float>(point.z));
}

void appendColor(
    std::vector<std::byte>& bytes,
    std::array<uint8_t, 4> const& color)
{
    for (auto const component : color) {
        appendScalar(bytes, component);
    }
}

void padRecord(std::vector<std::byte>& bytes, size_t recordStart, size_t stride)
{
    if (bytes.size() > recordStart + stride) {
        throw std::logic_error("GPU primitive record exceeded its ABI stride.");
    }
    bytes.resize(recordStart + stride, std::byte{0U});
}

[[nodiscard]] uint16_t materialFlags(
    bool billboard,
    bool depthTest,
    bool compactPath = false,
    bool simplePath = false,
    bool dualStrokePath = false,
    GpuScreenLengthAnchor screenLengthAnchor = GpuScreenLengthAnchor::None,
    GpuSemanticZIndexRole semanticRole = GpuSemanticZIndexRole::None,
    bool pointRing = false,
    bool surfaceShading = false)
{
    if ((compactPath && simplePath) ||
        (dualStrokePath && !compactPath && !simplePath))
    {
        throw std::logic_error("GPU path layouts are mutually exclusive.");
    }
    return static_cast<uint16_t>(
        (billboard ? static_cast<uint16_t>(GpuMaterialFlag::Billboard) : 0U) |
        (depthTest ? static_cast<uint16_t>(GpuMaterialFlag::DepthTest) : 0U) |
        (compactPath
            ? static_cast<uint16_t>(GpuMaterialFlag::CompactPath)
            : 0U) |
        (simplePath
            ? static_cast<uint16_t>(GpuMaterialFlag::SimplePath)
            : 0U) |
        (dualStrokePath
            ? static_cast<uint16_t>(GpuMaterialFlag::DualStrokePath)
            : 0U) |
        (screenLengthAnchor == GpuScreenLengthAnchor::Start
            ? static_cast<uint16_t>(GpuMaterialFlag::ScreenLengthStartAnchor)
            : 0U) |
        (screenLengthAnchor == GpuScreenLengthAnchor::End
            ? static_cast<uint16_t>(GpuMaterialFlag::ScreenLengthEndAnchor)
            : 0U) |
        (screenLengthAnchor == GpuScreenLengthAnchor::Center
            ? static_cast<uint16_t>(GpuMaterialFlag::ScreenLengthCenterAnchor)
            : 0U) |
        (semanticRole == GpuSemanticZIndexRole::Support
            ? static_cast<uint16_t>(GpuMaterialFlag::SemanticSupport)
            : 0U) |
        (semanticRole == GpuSemanticZIndexRole::Overlay
            ? static_cast<uint16_t>(GpuMaterialFlag::SemanticOverlay)
            : 0U) |
        (pointRing
            ? static_cast<uint16_t>(GpuMaterialFlag::PointRing)
            : 0U) |
        (surfaceShading
            ? static_cast<uint16_t>(GpuMaterialFlag::SurfaceShading)
            : 0U));
}

[[nodiscard]] GpuScreenLengthAnchor reversedAnchor(
    GpuScreenLengthAnchor anchor)
{
    if (anchor == GpuScreenLengthAnchor::Start) {
        return GpuScreenLengthAnchor::End;
    }
    if (anchor == GpuScreenLengthAnchor::End) {
        return GpuScreenLengthAnchor::Start;
    }
    return anchor;
}

[[nodiscard]] uint64_t materialKey(
    GpuPrimitiveKind kind,
    uint16_t flags,
    GpuRecordStyle const& style,
    uint32_t atlasPage = 0U)
{
    // Material keys are opaque collision-checked identifiers, not packed
    // fields. Hashing keeps the wire key fixed-size while preserving the exact
    // float glow radius and full icon atlas page in the stream descriptor.
    uint64_t result = 14695981039346656037ULL;
    auto append = [&](auto value) {
        using Value = decltype(value);
        auto const raw = std::bit_cast<std::array<std::byte, sizeof(Value)>>(value);
        for (auto const byte : raw) {
            result ^= static_cast<uint8_t>(byte);
            result *= 1099511628211ULL;
        }
    };
    append(static_cast<uint16_t>(kind));
    append(flags);
    append(atlasPage);
    for (auto const component : style.glowColor) {
        append(component);
    }
    append(std::max(0.0F, style.glowRadius));
    append(style.renderOrder);
    append(uint32_t{0U});
    return result;
}

[[nodiscard]] uint32_t pathBits(GpuPathRecordFlag flag)
{
    return static_cast<uint32_t>(flag);
}

[[nodiscard]] std::array<float, 2> offsetVectorAt(
    GpuPathRecordData const& path,
    size_t index)
{
    return index < path.lateralOffsetVectorsPx.size()
        ? std::array<float, 2>{
              path.lateralOffsetVectorsPx[index].x,
              path.lateralOffsetVectorsPx[index].y}
        : std::array<float, 2>{};
}

[[nodiscard]] size_t adjacentPointIndex(
    size_t pointCount,
    size_t index,
    int delta)
{
    auto const candidate = static_cast<int64_t>(index) + delta;
    return static_cast<size_t>(std::clamp<int64_t>(
        candidate,
        0,
        static_cast<int64_t>(pointCount - 1U)));
}

[[nodiscard]] float scalarOffsetAt(
    GpuPathRecordData const& path,
    size_t index)
{
    return index < path.lateralOffsetsPx.size()
        ? path.lateralOffsetsPx[index]
        : 0.0F;
}

[[nodiscard]] double projectedRingArea(
    std::span<mapget::Point const> points,
    size_t begin,
    size_t end,
    uint32_t xAxis,
    uint32_t yAxis)
{
    if (end <= begin + 2U) {
        return 0.0;
    }
    auto coordinate = [](mapget::Point const& point, uint32_t axis) {
        return axis == 0U ? point.x : axis == 1U ? point.y : point.z;
    };
    double area = 0.0;
    for (size_t index = begin; index < end; ++index) {
        auto const next = index + 1U < end ? index + 1U : begin;
        area += coordinate(points[index], xAxis) *
            coordinate(points[next], yAxis);
        area -= coordinate(points[next], xAxis) *
            coordinate(points[index], yAxis);
    }
    return std::abs(area * 0.5);
}

} // namespace

/** Mutable packet-building state hidden from the stable public header. */
class GpuRenderPacketBuilder::Impl
{
public:
    /** Rule-local stream identity which avoids re-hashing material bytes per record. */
    struct StreamIdentity {
        uint32_t renderOrder = 0U;
        uint32_t atlasPage = 0U;
        uint16_t kind = 0U;
        uint16_t flags = 0U;

        bool operator==(StreamIdentity const&) const = default;
    };

    /** Hash the already integral fast-path stream identity. */
    struct StreamIdentityHash {
        size_t operator()(StreamIdentity const& value) const noexcept
        {
            auto const high =
                (static_cast<uint64_t>(value.renderOrder) << 32U) |
                value.atlasPage;
            auto const low =
                (static_cast<uint32_t>(value.kind) << 16U) |
                value.flags;
            return std::hash<uint64_t>{}(
                high ^ (static_cast<uint64_t>(low) *
                    0x9e3779b97f4a7c15ULL));
        }
    };

    GpuRenderPacketData packet;
    std::unordered_map<uint64_t, uint32_t> streamIndices;
    std::unordered_map<StreamIdentity, uint32_t, StreamIdentityHash>
        fastStreamIndices;
    std::vector<uint32_t> contributionStreamStarts;
    std::unordered_set<std::string> resourceRequestKeys;
    std::optional<uint32_t> activeContribution;
    std::vector<std::tuple<uint64_t, uint32_t, uint32_t>> activeZIndexKeys;

    /** Resolve or create one material-compatible fixed-stride output stream. */
    [[nodiscard]] uint32_t stream(
        GpuPrimitiveKind kind,
        uint16_t flags,
        uint32_t stride,
        GpuRecordStyle const& style,
        uint32_t atlasPage = 0U)
    {
        auto const identity = StreamIdentity{
            .renderOrder = style.renderOrder,
            .atlasPage = atlasPage,
            .kind = static_cast<uint16_t>(kind),
            .flags = flags,
        };
        if (auto const found = fastStreamIndices.find(identity);
            found != fastStreamIndices.end())
        {
            auto const index = found->second;
            auto const& existing = packet.streams[index];
            if (existing.kind == kind && existing.flags == flags &&
                existing.recordStride == stride &&
                existing.glowColor == style.glowColor &&
                existing.glowRadius == std::max(0.0F, style.glowRadius) &&
                existing.atlasPage == atlasPage &&
                existing.renderOrder == style.renderOrder)
            {
                return index;
            }
        }
        auto const key = materialKey(kind, flags, style, atlasPage);
        if (auto const found = streamIndices.find(key);
            found != streamIndices.end())
        {
            auto const index = found->second;
            auto const& existing = packet.streams[index];
            if (existing.kind != kind || existing.flags != flags ||
                existing.recordStride != stride ||
                existing.glowColor != style.glowColor ||
                existing.glowRadius != std::max(0.0F, style.glowRadius) ||
                existing.atlasPage != atlasPage ||
                existing.renderOrder != style.renderOrder)
            {
                throw std::runtime_error(
                    "GPU material-key collision between incompatible streams.");
            }
            return index;
        }
        auto const index = static_cast<uint32_t>(packet.streams.size());
        packet.streams.push_back({
            .kind = kind,
            .flags = flags,
            .materialKey = key,
            .recordStride = stride,
            .glowColor = style.glowColor,
            .glowRadius = std::max(0.0F, style.glowRadius),
            .atlasPage = atlasPage,
            .renderOrder = style.renderOrder,
        });
        streamIndices.emplace(key, index);
        fastStreamIndices.try_emplace(identity, index);
        if (activeContribution) {
            contributionStreamStarts.push_back(0U);
        }
        return index;
    }

    /** Return the active contribution or reject records appended out of scope. */
    [[nodiscard]] GpuContribution& contribution()
    {
        if (!activeContribution) {
            throw std::logic_error(
                "GPU records require an active contribution.");
        }
        return packet.contributions[*activeContribution];
    }

    /** Return the packet index of the currently active contribution. */
    [[nodiscard]] uint32_t contributionIndex() const
    {
        if (!activeContribution) {
            throw std::logic_error(
                "GPU records require an active contribution.");
        }
        return *activeContribution;
    }

    /** Derive a stream's record count from its validated fixed stride. */
    [[nodiscard]] uint32_t recordCount(uint32_t streamIndex) const
    {
        auto const& output = packet.streams.at(streamIndex);
        return static_cast<uint32_t>(
            output.records.size() / output.recordStride);
    }

    /** Intern one authored order and stable rule-order tie in contribution metadata. */
    [[nodiscard]] uint32_t zIndexSlot(
        double value,
        uint32_t tieBreaker,
        uint32_t semanticGroup)
    {
        auto const normalized = std::isfinite(value)
            ? (value == 0.0 ? 0.0 : value)
            : std::numeric_limits<double>::quiet_NaN();
        auto const bits = std::isnan(normalized)
            ? uint64_t{0x7ff8000000000000ULL}
            : std::bit_cast<uint64_t>(normalized);
        auto const compactTieBreaker =
            tieBreaker & (kGpuDepthTieBucketCount - 1U);
        auto const key = std::tuple{
            bits,
            compactTieBreaker,
            semanticGroup,
        };
        auto const found = std::ranges::find(activeZIndexKeys, key);
        if (found != activeZIndexKeys.end()) {
            return static_cast<uint32_t>(
                std::distance(activeZIndexKeys.begin(), found));
        }
        auto& values = contribution().zIndices;
        if (values.size() >= std::numeric_limits<uint32_t>::max()) {
            throw std::length_error(
                "GPU contribution has too many distinct z-index values.");
        }
        auto const index = static_cast<uint32_t>(values.size());
        values.push_back({normalized, compactTieBreaker, semanticGroup});
        activeZIndexKeys.push_back(key);
        return index;
    }

    /** Pack one record's z-index slot and minimum LOD into their shared word. */
    [[nodiscard]] uint32_t localZIndexWord(GpuRecordStyle const& style)
    {
        auto const localZIndex = zIndexSlot(
            style.zIndex,
            style.depthTieKey,
            style.semanticGroup);
        if (localZIndex > kGpuLocalZIndexMask || style.minimumLod > 7U) {
            throw std::length_error(
                "GPU record LOD or local z-index exceeds its packed ABI field.");
        }
        return localZIndex |
            (static_cast<uint32_t>(style.minimumLod) <<
             kGpuMinimumLodShift);
    }

    /** Pack z-order, color, ownership, picking, and activation fields. */
    void appendCommon(
        std::vector<std::byte>& bytes,
        GpuRecordStyle const& style,
        uint32_t recordFlags)
    {
        auto const activationToken = contribution().activationToken;
        if ((recordFlags & ~kGpuRecordFlagMask) != 0U ||
            activationToken == 0U ||
            activationToken > kGpuActivationTokenMax)
        {
            throw std::logic_error(
                "GPU record flags or activation token exceed their packed ABI fields.");
        }
        appendScalar(bytes, localZIndexWord(style));
        appendColor(bytes, style.color);
        appendScalar(bytes, packet.origin.slot);
        appendScalar(bytes, contribution().slot);
        appendScalar(bytes, style.localPickIndex);
        appendScalar(bytes, recordFlags | (activationToken << 8U));
    }

    /** Append one independently projected shader-arrow instance. */
    void appendArrow(
        GpuArrowRecordData const& arrow,
        bool billboard,
        bool depthTest)
    {
        auto const flags = materialFlags(
            billboard,
            depthTest,
            false,
            false,
            false,
            arrow.screenLengthAnchor,
            arrow.style.semanticZIndexRole);
        auto const streamIndex = stream(
            GpuPrimitiveKind::Arrow,
            flags,
            kGpuArrowRecordBytes,
            arrow.style);
        auto& bytes = packet.streams[streamIndex].records;
        auto const start = bytes.size();
        appendPoint3(bytes, arrow.previous);
        appendPoint3(bytes, arrow.tip);
        appendScalar(bytes, arrow.lateralOffsetVectorPx[0]);
        appendScalar(bytes, arrow.lateralOffsetVectorPx[1]);
        appendScalar(bytes, arrow.lateralOffsetPx);
        appendScalar(bytes, arrow.width);
        appendScalar(bytes, arrow.lateralOffsetScaleThreshold);
        appendCommon(
            bytes,
            arrow.style,
            static_cast<uint32_t>(GpuArrowRecordFlag::Active) |
                (arrow.variableOffset
                    ? static_cast<uint32_t>(
                          GpuArrowRecordFlag::VariableOffset)
                    : 0U));
        padRecord(bytes, start, kGpuArrowRecordBytes);
    }
};

GpuRenderPacketBuilder::GpuRenderPacketBuilder()
    : impl_(std::make_unique<Impl>())
{}

GpuRenderPacketBuilder::~GpuRenderPacketBuilder() = default;
GpuRenderPacketBuilder::GpuRenderPacketBuilder(
    GpuRenderPacketBuilder&&) noexcept = default;
GpuRenderPacketBuilder& GpuRenderPacketBuilder::operator=(
    GpuRenderPacketBuilder&&) noexcept = default;

void GpuRenderPacketBuilder::reset()
{
    for (auto& stream : impl_->packet.streams) {
        stream.records.clear();
    }
    impl_->packet.flags = GpuRenderPacketFlag::RevisionComplete;
    impl_->packet.sceneGeneration = 0U;
    impl_->packet.packetSequence = 0U;
    impl_->packet.fragmentIndex = 0U;
    impl_->packet.fragmentCount = 1U;
    impl_->packet.iconCatalogVersion = 0U;
    impl_->packet.origin = {};
    impl_->packet.contributions.clear();
    impl_->packet.picks.clear();
    impl_->packet.labels.clear();
    impl_->packet.resourceRequests.clear();
    impl_->packet.issues.clear();
    impl_->contributionStreamStarts.clear();
    impl_->resourceRequestKeys.clear();
    impl_->activeContribution.reset();
    impl_->activeZIndexKeys.clear();
}

void GpuRenderPacketBuilder::configure(
    uint32_t sceneGeneration,
    uint32_t packetSequence,
    uint32_t iconCatalogVersion,
    GpuPacketOrigin origin)
{
    if (impl_->activeContribution || !impl_->packet.contributions.empty() ||
        std::ranges::any_of(
            impl_->packet.streams,
            [](GpuRecordStream const& stream) {
                return !stream.records.empty();
            }))
    {
        throw std::logic_error(
            "GpuRenderPacket metadata must be configured before rendering.");
    }
    impl_->packet.sceneGeneration = sceneGeneration;
    impl_->packet.packetSequence = packetSequence;
    impl_->packet.iconCatalogVersion = iconCatalogVersion;
    impl_->packet.origin = origin;
}

void GpuRenderPacketBuilder::beginContribution(
    uint64_t key,
    uint32_t revision,
    uint32_t slot,
    uint32_t activationToken)
{
    if (impl_->activeContribution) {
        throw std::logic_error("Nested GPU contributions are not supported.");
    }
    auto const index = static_cast<uint32_t>(
        impl_->packet.contributions.size());
    impl_->packet.contributions.push_back({
        .key = key,
        .revision = revision,
        .slot = slot,
        .activationToken = activationToken,
    });
    impl_->activeContribution = index;
    impl_->activeZIndexKeys.clear();
    impl_->contributionStreamStarts.clear();
    impl_->contributionStreamStarts.reserve(impl_->packet.streams.size());
    for (uint32_t stream = 0U; stream < impl_->packet.streams.size(); ++stream) {
        impl_->contributionStreamStarts.push_back(impl_->recordCount(stream));
    }
}

void GpuRenderPacketBuilder::endContribution()
{
    auto& contribution = impl_->contribution();
    for (uint32_t streamIndex = 0U;
         streamIndex < impl_->packet.streams.size();
         ++streamIndex)
    {
        auto const first = impl_->contributionStreamStarts[streamIndex];
        auto const end = impl_->recordCount(streamIndex);
        if (end > first) {
            contribution.spans.push_back({
                .streamIndex = streamIndex,
                .firstRecord = first,
                .recordCount = end - first,
            });
        }
    }
    impl_->activeContribution.reset();
    impl_->activeZIndexKeys.clear();
    impl_->contributionStreamStarts.clear();
}

void GpuRenderPacketBuilder::appendPoint(
    GpuPointRecordData const& point,
    bool billboard,
    bool depthTest,
    bool ring)
{
    auto const flags = materialFlags(
        billboard,
        depthTest,
        false,
        false,
        false,
        GpuScreenLengthAnchor::None,
        point.style.semanticZIndexRole,
        ring);
    auto const streamIndex = impl_->stream(
        GpuPrimitiveKind::Point,
        flags,
        kGpuPointRecordBytes,
        point.style);
    auto& bytes = impl_->packet.streams[streamIndex].records;
    auto const start = bytes.size();
    appendPoint3(bytes, point.position);
    appendScalar(bytes, point.radius);
    impl_->appendCommon(bytes, point.style, uint32_t{1U});
    padRecord(bytes, start, kGpuPointRecordBytes);
}

GpuPathRecordHandle GpuRenderPacketBuilder::appendPath(
    GpuPathRecordData const& path,
    bool billboard,
    bool depthTest)
{
    if (path.points.size() < 2U || path.width <= 0.0F) {
        return {};
    }
    auto const variableOffset =
        path.lateralOffsetVectorsPx.size() >= path.points.size();
    if (path.screenLengthAnchor != GpuScreenLengthAnchor::None &&
        path.points.size() != 2U)
    {
        throw std::logic_error(
            "Minimum screen-length paths must contain exactly two points.");
    }
    if (path.forwardArrow && path.backwardArrow &&
        path.screenLengthAnchor != GpuScreenLengthAnchor::None &&
        path.screenLengthAnchor != GpuScreenLengthAnchor::Center)
    {
        throw std::logic_error(
            "Double-ended minimum screen-length paths require a center anchor.");
    }
    auto const compact =
        !variableOffset && path.lateralOffsetsPx.empty() &&
        path.dashGap <= 0.0F &&
        !path.forwardArrow && !path.backwardArrow &&
        path.screenLengthAnchor == GpuScreenLengthAnchor::None;
    auto const dualStroke = path.overlay.has_value();
    if (dualStroke &&
        (!compact || path.overlay->width <= 0.0F ||
         path.overlay->width >= path.width))
    {
        throw std::logic_error(
            "GPU dual strokes require one narrower overlay on a compact path.");
    }
    auto const simple = compact && path.points.size() == 2U;
    auto const flags = materialFlags(
        billboard,
        depthTest,
        compact && !simple,
        simple,
        dualStroke,
        path.screenLengthAnchor,
        path.style.semanticZIndexRole);
    auto const stride = simple
        ? dualStroke
            ? kGpuDualSimplePathSegmentRecordBytes
            : kGpuSimplePathSegmentRecordBytes
        : compact
            ? dualStroke
                ? kGpuDualCompactPathSegmentRecordBytes
                : kGpuCompactPathSegmentRecordBytes
            : kGpuPathSegmentRecordBytes;
    auto const streamIndex = impl_->stream(
        GpuPrimitiveKind::PathSegment,
        flags,
        stride,
        path.style);
    auto& bytes = impl_->packet.streams[streamIndex].records;
    GpuPathRecordHandle handle{
        .pathStreamIndex = streamIndex,
        .firstPathRecord = impl_->recordCount(streamIndex),
    };
    auto const segmentCount = path.points.size() - 1U;
    if (segmentCount >
        (std::numeric_limits<size_t>::max() - bytes.size()) /
            stride)
    {
        throw std::length_error("GPU path record stream exceeds address space.");
    }
    auto const firstByte = bytes.size();
    bytes.resize(
        firstByte + segmentCount * stride,
        std::byte{0U});

    auto const arrowPixels = std::max(
        kArrowMinimumPixels,
        path.width * kArrowWidthFactor);
    auto const trimPixels = std::max(
        0.0F,
        arrowPixels * 0.9375F - kArrowShaftOverlapPixels);
    auto const localZIndexWord = impl_->localZIndexWord(path.style);
    auto const& contribution = impl_->contribution();
    auto const activationToken = contribution.activationToken;
    if (activationToken == 0U || activationToken > kGpuActivationTokenMax) {
        throw std::logic_error(
            "GPU activation token exceeds its packed ABI field.");
    }
    if (simple) {
        overwritePoint3(bytes, firstByte, path.points.front());
        overwritePoint3(bytes, firstByte + 12U, path.points.back());
        overwriteScalar(bytes, firstByte + 24U, path.width);
        overwriteScalar(bytes, firstByte + 28U, localZIndexWord);
        std::memcpy(
            bytes.data() + static_cast<std::ptrdiff_t>(firstByte + 32U),
            path.style.color.data(),
            path.style.color.size());
        overwriteScalar(bytes, firstByte + 36U, impl_->packet.origin.slot);
        overwriteScalar(bytes, firstByte + 40U, contribution.slot);
        overwriteScalar(bytes, firstByte + 44U, path.style.localPickIndex);
        overwriteScalar(
            bytes,
            firstByte + 48U,
            pathBits(GpuPathRecordFlag::Active) |
                pathBits(GpuPathRecordFlag::StartCap) |
                pathBits(GpuPathRecordFlag::EndCap) |
                (activationToken << 8U));
        if (dualStroke) {
            overwriteScalar(bytes, firstByte + 52U, path.overlay->width);
            std::memcpy(
                bytes.data() + static_cast<std::ptrdiff_t>(firstByte + 56U),
                path.overlay->color.data(),
                path.overlay->color.size());
        }
        handle.pathRecordCount = 1U;
        return handle;
    }
    if (compact) {
        for (size_t segment = 0U; segment < segmentCount; ++segment) {
            auto const start = firstByte + segment * stride;
            overwritePoint3(
                bytes,
                start,
                segment == 0U
                    ? path.points[segment]
                    : path.points[segment - 1U]);
            overwritePoint3(bytes, start + 12U, path.points[segment]);
            overwritePoint3(bytes, start + 24U, path.points[segment + 1U]);
            overwritePoint3(
                bytes,
                start + 36U,
                segment + 2U < path.points.size()
                    ? path.points[segment + 2U]
                    : path.points[segment + 1U]);
            overwriteScalar(bytes, start + 48U, path.width);
            overwriteScalar(bytes, start + 52U, localZIndexWord);
            std::memcpy(
                bytes.data() + static_cast<std::ptrdiff_t>(start + 56U),
                path.style.color.data(),
                path.style.color.size());
            overwriteScalar(bytes, start + 60U, impl_->packet.origin.slot);
            overwriteScalar(bytes, start + 64U, contribution.slot);
            overwriteScalar(bytes, start + 68U, path.style.localPickIndex);
            uint32_t recordFlags = pathBits(GpuPathRecordFlag::Active);
            recordFlags |= segment == 0U
                ? pathBits(GpuPathRecordFlag::StartCap)
                : 0U;
            recordFlags |= segment + 2U == path.points.size()
                ? pathBits(GpuPathRecordFlag::EndCap)
                : 0U;
            overwriteScalar(
                bytes,
                start + 72U,
                recordFlags | (activationToken << 8U));
            if (dualStroke) {
                overwriteScalar(bytes, start + 76U, path.overlay->width);
                std::memcpy(
                    bytes.data() + static_cast<std::ptrdiff_t>(start + 80U),
                    path.overlay->color.data(),
                    path.overlay->color.size());
            }
        }
        handle.pathRecordCount =
            impl_->recordCount(streamIndex) - handle.firstPathRecord;
        return handle;
    }
    auto const dashPeriodMeters = static_cast<double>(
        path.dashLength + path.dashGap);
    auto const meterDashes =
        path.dashUnitsMeters && path.dashGap > 0.0F &&
        std::isfinite(dashPeriodMeters) && dashPeriodMeters > 0.0;
    double dashPhaseMeters = 0.0;
    for (size_t segment = 0U; segment < segmentCount; ++segment) {
        auto const start = firstByte + segment * stride;
        overwritePoint3(
            bytes,
            start,
            segment == 0U ? path.points[segment] : path.points[segment - 1U]);
        overwritePoint3(bytes, start + 12U, path.points[segment]);
        overwritePoint3(bytes, start + 24U, path.points[segment + 1U]);
        overwritePoint3(
            bytes,
            start + 36U,
            segment + 2U < path.points.size()
                ? path.points[segment + 2U]
                : path.points[segment + 1U]);
        auto const adjacency = std::array<size_t, 4>{
            adjacentPointIndex(path.points.size(), segment, -1),
            segment,
            segment + 1U,
            adjacentPointIndex(path.points.size(), segment + 1U, 1),
        };
        for (size_t adjacent = 0U; adjacent < adjacency.size(); ++adjacent) {
            auto const pointIndex = adjacency[adjacent];
            auto const vector = offsetVectorAt(path, pointIndex);
            overwriteScalar(bytes, start + 48U + adjacent * 8U, vector[0]);
            overwriteScalar(bytes, start + 52U + adjacent * 8U, vector[1]);
        }
        for (size_t adjacent = 0U; adjacent < adjacency.size(); ++adjacent) {
            overwriteScalar(
                bytes,
                start + 80U + adjacent * 4U,
                scalarOffsetAt(path, adjacency[adjacent]));
        }
        overwriteScalar(bytes, start + 96U, path.width);
        overwriteScalar(bytes, start + 100U, path.dashLength);
        overwriteScalar(bytes, start + 104U, path.dashGap);
        overwriteScalar(bytes, start + 108U, path.lateralOffsetScaleThreshold);
        overwriteScalar(
            bytes,
            start + 112U,
            segment == 0U && path.backwardArrow ? trimPixels : 0.0F);
        overwriteScalar(
            bytes,
            start + 116U,
            segment + 2U == path.points.size() && path.forwardArrow
                ? trimPixels
                : 0.0F);
        overwriteScalar(
            bytes,
            start + 120U,
            meterDashes ? static_cast<float>(dashPhaseMeters) : 0.0F);
        uint32_t recordFlags = pathBits(GpuPathRecordFlag::Active);
        recordFlags |= segment == 0U
            ? pathBits(GpuPathRecordFlag::StartCap)
            : 0U;
        recordFlags |= segment + 2U == path.points.size()
            ? pathBits(GpuPathRecordFlag::EndCap)
            : 0U;
        recordFlags |= variableOffset
            ? pathBits(GpuPathRecordFlag::VariableOffset)
            : 0U;
        recordFlags |= path.dashGap > 0.0F
            ? pathBits(GpuPathRecordFlag::Dashed)
            : 0U;
        recordFlags |= segment == 0U && path.backwardArrow
            ? pathBits(GpuPathRecordFlag::TrimStart)
            : 0U;
        recordFlags |= segment + 2U == path.points.size() && path.forwardArrow
            ? pathBits(GpuPathRecordFlag::TrimEnd)
            : 0U;
        recordFlags |= meterDashes
            ? pathBits(GpuPathRecordFlag::DashMeters)
            : 0U;
        overwriteScalar(bytes, start + 124U, localZIndexWord);
        std::memcpy(
            bytes.data() + static_cast<std::ptrdiff_t>(start + 128U),
            path.style.color.data(),
            path.style.color.size());
        overwriteScalar(bytes, start + 132U, impl_->packet.origin.slot);
        overwriteScalar(bytes, start + 136U, contribution.slot);
        overwriteScalar(bytes, start + 140U, path.style.localPickIndex);
        overwriteScalar(
            bytes,
            start + 144U,
            recordFlags | (activationToken << 8U));
        if (meterDashes) {
            auto const& from = path.points[segment];
            auto const& to = path.points[segment + 1U];
            dashPhaseMeters = std::fmod(
                dashPhaseMeters + std::hypot(to.x - from.x, to.y - from.y),
                dashPeriodMeters);
        }
    }
    handle.pathRecordCount =
        impl_->recordCount(streamIndex) - handle.firstPathRecord;

    auto const arrowAnchor = path.backwardArrow && !path.forwardArrow
        ? reversedAnchor(path.screenLengthAnchor)
        : path.screenLengthAnchor;
    auto const arrowFlags = materialFlags(
        billboard,
        depthTest,
        false,
        false,
        false,
        arrowAnchor,
        path.style.semanticZIndexRole);
    auto const arrowKey = materialKey(
        GpuPrimitiveKind::Arrow,
        arrowFlags,
        path.style);
    auto existingArrow = impl_->streamIndices.find(arrowKey);
    if (existingArrow != impl_->streamIndices.end()) {
        handle.arrowStreamIndex = existingArrow->second;
        handle.firstArrowRecord = impl_->recordCount(handle.arrowStreamIndex);
    }
    if (path.forwardArrow) {
        impl_->appendArrow({
            .previous = path.points[path.points.size() - 2U],
            .tip = path.points.back(),
            .lateralOffsetVectorPx = variableOffset
                ? offsetVectorAt(path, path.points.size() - 1U)
                : std::array<float, 2>{},
            .lateralOffsetPx = scalarOffsetAt(
                path,
                path.points.size() - 1U),
            .width = path.width,
            .lateralOffsetScaleThreshold = path.lateralOffsetScaleThreshold,
            .variableOffset = variableOffset,
            .screenLengthAnchor = path.screenLengthAnchor,
            .style = path.style,
        }, billboard, depthTest);
    }
    if (path.backwardArrow) {
        impl_->appendArrow({
            .previous = path.points[1U],
            .tip = path.points.front(),
            .lateralOffsetVectorPx = variableOffset
                ? offsetVectorAt(path, 0U)
                : std::array<float, 2>{},
            // The arrow tangent points against the path direction, so its
            // screen normal is reversed. Negate the scalar to keep the head
            // on the same authored side as the displaced shaft.
            .lateralOffsetPx = -scalarOffsetAt(path, 0U),
            .width = path.width,
            .lateralOffsetScaleThreshold = path.lateralOffsetScaleThreshold,
            .variableOffset = variableOffset,
            .screenLengthAnchor = reversedAnchor(path.screenLengthAnchor),
            .style = path.style,
        }, billboard, depthTest);
    }
    auto const emittedArrow = impl_->streamIndices.find(arrowKey);
    if (emittedArrow != impl_->streamIndices.end()) {
        auto const emittedArrowIndex = emittedArrow->second;
        if (handle.arrowStreamIndex == 0xffffffffU) {
            handle.arrowStreamIndex = emittedArrowIndex;
            handle.firstArrowRecord = 0U;
        }
        handle.arrowRecordCount =
            impl_->recordCount(handle.arrowStreamIndex) -
            handle.firstArrowRecord;
    }
    return handle;
}

void GpuRenderPacketBuilder::updateAdaptiveOffsetThreshold(
    GpuPathRecordHandle const& handle,
    float threshold)
{
    auto const safeThreshold = std::max(0.0F, threshold);
    if (handle.pathStreamIndex != 0xffffffffU) {
        auto& stream = impl_->packet.streams.at(handle.pathStreamIndex);
        if (stream.recordStride != kGpuPathSegmentRecordBytes) {
            throw std::logic_error(
                "Adaptive offsets require the full GPU path layout.");
        }
        for (uint32_t index = 0U; index < handle.pathRecordCount; ++index) {
            auto const record = handle.firstPathRecord + index;
            overwriteScalar(
                stream.records,
                static_cast<size_t>(record) * stream.recordStride + 108U,
                safeThreshold);
        }
    }
    if (handle.arrowStreamIndex != 0xffffffffU) {
        auto& stream = impl_->packet.streams.at(handle.arrowStreamIndex);
        for (uint32_t index = 0U; index < handle.arrowRecordCount; ++index) {
            auto const record = handle.firstArrowRecord + index;
            overwriteScalar(
                stream.records,
                static_cast<size_t>(record) * stream.recordStride + 40U,
                safeThreshold);
        }
    }
}

void GpuRenderPacketBuilder::appendSurface(
    std::span<mapget::Point const> points,
    std::span<uint32_t const> ringStarts,
    GpuRecordStyle const& style,
    bool depthTest,
    double polygonHeight,
    bool surfaceShading)
{
    if (points.size() < 3U) {
        return;
    }
    std::vector<uint32_t> starts;
    starts.reserve(ringStarts.size() + 1U);
    starts.push_back(0U);
    for (auto const start : ringStarts) {
        if (start > 0U && start < points.size() && start > starts.back()) {
            starts.push_back(start);
        }
    }
    starts.push_back(static_cast<uint32_t>(points.size()));

    auto const xy = projectedRingArea(points, starts[0], starts[1], 0U, 1U);
    auto const xz = projectedRingArea(points, starts[0], starts[1], 0U, 2U);
    auto const yz = projectedRingArea(points, starts[0], starts[1], 1U, 2U);
    if (xy == 0.0 && xz == 0.0 && yz == 0.0) {
        return;
    }
    auto const axes = xy > xz && xy > yz
        ? std::array<uint32_t, 2>{0U, 1U}
        : xz > yz
            ? std::array<uint32_t, 2>{0U, 2U}
            : std::array<uint32_t, 2>{1U, 2U};
    auto coordinate = [](mapget::Point const& point, uint32_t axis) {
        return axis == 0U ? point.x : axis == 1U ? point.y : point.z;
    };
    using EarcutPoint = std::array<double, 2>;
    std::vector<std::vector<EarcutPoint>> polygon;
    polygon.reserve(starts.size() - 1U);
    for (size_t ring = 0U; ring + 1U < starts.size(); ++ring) {
        auto& output = polygon.emplace_back();
        output.reserve(starts[ring + 1U] - starts[ring]);
        for (uint32_t index = starts[ring]; index < starts[ring + 1U]; ++index) {
            output.push_back({
                coordinate(points[index], axes[0]),
                coordinate(points[index], axes[1]),
            });
        }
    }
    auto const indices = mapbox::earcut<uint32_t>(polygon);
    auto const flags = materialFlags(
        false,
        depthTest,
        false,
        false,
        false,
        GpuScreenLengthAnchor::None,
        style.semanticZIndexRole,
        false,
        surfaceShading);
    auto const streamIndex = impl_->stream(
        GpuPrimitiveKind::SurfaceTriangle,
        flags,
        kGpuSurfaceTriangleRecordBytes,
        style);
    auto& bytes = impl_->packet.streams[streamIndex].records;
    auto const height = std::isfinite(polygonHeight)
        ? std::max(0.0, polygonHeight)
        : 0.0;
    auto lifted = [height](mapget::Point point) {
        point.z += height;
        return point;
    };
    auto appendTriangle = [&](mapget::Point const& first,
                              mapget::Point const& second,
                              mapget::Point const& third) {
        auto const start = bytes.size();
        appendPoint3(bytes, first);
        appendPoint3(bytes, second);
        appendPoint3(bytes, third);
        impl_->appendCommon(bytes, style, uint32_t{1U});
        padRecord(bytes, start, kGpuSurfaceTriangleRecordBytes);
    };
    for (size_t index = 0U; index + 2U < indices.size(); index += 3U) {
        if (indices[index] >= points.size() ||
            indices[index + 1U] >= points.size() ||
            indices[index + 2U] >= points.size())
        {
            throw std::runtime_error("Earcut returned an invalid polygon index.");
        }
        appendTriangle(
            lifted(points[indices[index]]),
            lifted(points[indices[index + 1U]]),
            lifted(points[indices[index + 2U]]));
    }
    if (height <= 0.0) {
        return;
    }
    for (size_t ring = 0U; ring + 1U < starts.size(); ++ring) {
        auto const begin = starts[ring];
        auto const end = starts[ring + 1U];
        if (end - begin < 2U) {
            continue;
        }
        for (auto current = begin; current < end; ++current) {
            auto const next = current + 1U < end ? current + 1U : begin;
            auto const& lowerCurrent = points[current];
            auto const& lowerNext = points[next];
            if (lowerCurrent.x == lowerNext.x &&
                lowerCurrent.y == lowerNext.y &&
                lowerCurrent.z == lowerNext.z)
            {
                continue;
            }
            auto const upperCurrent = lifted(lowerCurrent);
            auto const upperNext = lifted(lowerNext);
            appendTriangle(lowerCurrent, lowerNext, upperNext);
            appendTriangle(lowerCurrent, upperNext, upperCurrent);
        }
    }
}

void GpuRenderPacketBuilder::appendTriangleMesh(
    std::span<mapget::Point const> points,
    GpuRecordStyle const& style,
    bool depthTest,
    double polygonHeight,
    bool surfaceShading)
{
    if (points.size() < 3U) {
        return;
    }
    auto const height = std::isfinite(polygonHeight)
        ? std::max(0.0, polygonHeight)
        : 0.0;
    auto lifted = [height](mapget::Point point) {
        point.z += height;
        return point;
    };

    using PointKey = std::array<uint64_t, 3>;
    using EdgeKey = std::array<uint64_t, 6>;
    using Edge = std::pair<EdgeKey, std::pair<mapget::Point, mapget::Point>>;
    auto pointKey = [](mapget::Point const& point) {
        auto bits = [](double value) {
            return std::bit_cast<uint64_t>(value == 0.0 ? 0.0 : value);
        };
        return PointKey{bits(point.x), bits(point.y), bits(point.z)};
    };
    auto edge = [&](mapget::Point const& first, mapget::Point const& second) {
        auto firstKey = pointKey(first);
        auto secondKey = pointKey(second);
        if (secondKey < firstKey) {
            std::swap(firstKey, secondKey);
        }
        return Edge{
            EdgeKey{
                firstKey[0], firstKey[1], firstKey[2],
                secondKey[0], secondKey[1], secondKey[2],
            },
            {first, second},
        };
    };

    std::vector<Edge> edges;
    if (height > 0.0) {
        edges.reserve(points.size());
    }
    for (size_t index = 0U; index + 2U < points.size(); index += 3U) {
        std::array<mapget::Point, 3> const roof{
            lifted(points[index]),
            lifted(points[index + 1U]),
            lifted(points[index + 2U]),
        };
        appendSurface(roof, {}, style, depthTest, 0.0, surfaceShading);
        if (height <= 0.0) {
            continue;
        }
        for (size_t vertex = 0U; vertex < roof.size(); ++vertex) {
            auto const next = (vertex + 1U) % roof.size();
            auto const& first = points[index + vertex];
            auto const& second = points[index + next];
            if (pointKey(first) != pointKey(second)) {
                edges.push_back(edge(first, second));
            }
        }
    }
    if (height <= 0.0) {
        return;
    }

    std::sort(edges.begin(), edges.end(), [](Edge const& lhs, Edge const& rhs) {
        return lhs.first < rhs.first;
    });
    for (size_t begin = 0U; begin < edges.size();) {
        auto end = begin + 1U;
        while (end < edges.size() && edges[end].first == edges[begin].first) {
            ++end;
        }
        if (end - begin == 1U) {
            auto const& [lowerFirst, lowerSecond] = edges[begin].second;
            std::array<mapget::Point, 4> const wall{
                lowerFirst,
                lowerSecond,
                lifted(lowerSecond),
                lifted(lowerFirst),
            };
            appendSurface(wall, {}, style, depthTest, 0.0, surfaceShading);
        }
        begin = end;
    }
}

void GpuRenderPacketBuilder::appendIcon(
    GpuIconRecordData const& icon,
    bool billboard,
    bool depthTest)
{
    auto const flags = materialFlags(
        billboard,
        depthTest,
        false,
        false,
        false,
        GpuScreenLengthAnchor::None,
        icon.style.semanticZIndexRole);
    auto const streamIndex = impl_->stream(
        GpuPrimitiveKind::Icon,
        flags,
        kGpuIconRecordBytes,
        icon.style,
        icon.atlasPage);
    auto& bytes = impl_->packet.streams[streamIndex].records;
    auto const start = bytes.size();
    appendPoint3(bytes, icon.position);
    for (auto const value : icon.pixelSize) appendScalar(bytes, value);
    for (auto const value : icon.pixelOffset) appendScalar(bytes, value);
    for (auto const value : icon.uv) appendScalar(bytes, value);
    impl_->appendCommon(bytes, icon.style, icon.flags | 1U);
    padRecord(bytes, start, kGpuIconRecordBytes);
}

void GpuRenderPacketBuilder::appendPick(GpuPickRecord pick)
{
    if (pick.contributionIndex >= impl_->packet.contributions.size()) {
        throw std::out_of_range(
            "GPU pick references an unknown contribution.");
    }
    auto& totalPickCount =
        impl_->packet.contributions[pick.contributionIndex].totalPickCount;
    if (pick.localPickIndex == std::numeric_limits<uint32_t>::max()) {
        throw std::length_error("GPU pick index exceeds its local uint32 range.");
    }
    totalPickCount = std::max(totalPickCount, pick.localPickIndex + 1U);
    impl_->packet.picks.push_back(std::move(pick));
}

void GpuRenderPacketBuilder::appendLabel(GpuLabelRecord label)
{
    label.contributionIndex = impl_->contributionIndex();
    impl_->packet.labels.push_back(std::move(label));
}

void GpuRenderPacketBuilder::appendResourceRequest(
    GpuResourceRequest request)
{
    auto const key = std::to_string(request.resourceKind) + "\n" + request.uri;
    if (!impl_->resourceRequestKeys.insert(key).second) {
        return;
    }
    impl_->packet.resourceRequests.push_back(std::move(request));
}

void GpuRenderPacketBuilder::appendRuntimeIssue(GpuRuntimeIssue issue)
{
    impl_->packet.issues.push_back(std::move(issue));
}

std::vector<std::byte> GpuRenderPacketBuilder::build() const
{
    if (impl_->activeContribution) {
        throw std::logic_error(
            "Cannot encode a GPU packet with an open contribution.");
    }
    return GpuRenderPacketCodec::encode(impl_->packet);
}

std::vector<std::vector<std::byte>>
GpuRenderPacketBuilder::buildFragments() const
{
    if (impl_->activeContribution) {
        throw std::logic_error(
            "Cannot encode GPU packet fragments with an open contribution.");
    }
    auto const packetBytes = GpuRenderPacketCodec::encodedSize(impl_->packet);
    if (packetBytes <= kGpuRenderPacketMaxBytes)
    {
        return {GpuRenderPacketCodec::encode(impl_->packet, packetBytes)};
    }

    auto const& source = impl_->packet;
    if (source.contributions.empty()) {
        throw std::length_error(
            "An oversized GPU packet without contributions cannot be fragmented.");
    }

    auto makeFragment = [&](uint32_t contributionIndex) {
        auto contribution = source.contributions.at(contributionIndex);
        contribution.spans.clear();
        contribution.zIndices.clear();
        GpuRenderPacketData result{
            .flags = GpuRenderPacketFlag::None,
            .sceneGeneration = source.sceneGeneration,
            .packetSequence = source.packetSequence,
            .fragmentIndex = 0U,
            .fragmentCount = 2U,
            .iconCatalogVersion = source.iconCatalogVersion,
            .origin = source.origin,
        };
        result.contributions.push_back(std::move(contribution));
        return result;
    };
    auto hasPayload = [](GpuRenderPacketData const& packet) {
        return !packet.streams.empty() || !packet.picks.empty() ||
            !packet.labels.empty() || !packet.resourceRequests.empty() ||
            !packet.issues.empty() ||
            !packet.contributions.front().zIndices.empty();
    };
    auto fits = [](GpuRenderPacketData const& packet) {
        return GpuRenderPacketCodec::encodedSize(packet) <=
            kGpuRenderPacketMaxBytes;
    };

    std::vector<GpuRenderPacketData> fragments;
    auto appendFragment = [&](GpuRenderPacketData&& fragment) {
        if (fragments.size() >= kGpuRenderPacketMaxFragments) {
            throw std::length_error(
                "GPU render task exceeds its bounded fragment count.");
        }
        fragments.push_back(std::move(fragment));
    };

    for (uint32_t contributionIndex = 0U;
         contributionIndex < source.contributions.size();
         ++contributionIndex)
    {
        auto fragment = makeFragment(contributionIndex);
        auto const& contribution = source.contributions[contributionIndex];

        for (auto const& span : contribution.spans) {
            auto const& stream = source.streams.at(span.streamIndex);
            uint32_t consumed = 0U;
            while (consumed < span.recordCount) {
                auto appendRecords = [&](GpuRenderPacketData const& base,
                                         uint32_t recordCount) {
                    auto candidate = base;
                    auto fragmentStream = stream;
                    auto const firstRecord = span.firstRecord + consumed;
                    auto const firstByte = static_cast<size_t>(firstRecord) *
                        stream.recordStride;
                    auto const byteCount = static_cast<size_t>(recordCount) *
                        stream.recordStride;
                    fragmentStream.records.assign(
                        stream.records.begin() +
                            static_cast<std::ptrdiff_t>(firstByte),
                        stream.records.begin() +
                            static_cast<std::ptrdiff_t>(firstByte + byteCount));
                    auto const streamIndex = static_cast<uint32_t>(
                        candidate.streams.size());
                    candidate.streams.push_back(std::move(fragmentStream));
                    candidate.contributions.front().spans.push_back({
                        .streamIndex = streamIndex,
                        .firstRecord = 0U,
                        .recordCount = recordCount,
                    });
                    return candidate;
                };

                auto const remaining = span.recordCount - consumed;
                auto candidate = appendRecords(fragment, remaining);
                uint32_t accepted = 0U;
                if (fits(candidate)) {
                    accepted = remaining;
                } else {
                    uint32_t low = 1U;
                    uint32_t high = remaining;
                    while (low <= high) {
                        auto const middle = low + (high - low) / 2U;
                        auto middleCandidate = appendRecords(fragment, middle);
                        if (fits(middleCandidate)) {
                            accepted = middle;
                            candidate = std::move(middleCandidate);
                            low = middle + 1U;
                        } else {
                            high = middle - 1U;
                        }
                    }
                }
                if (accepted == 0U) {
                    if (!hasPayload(fragment)) {
                        throw std::length_error(
                            "One GPU primitive record cannot fit in a packet fragment.");
                    }
                    appendFragment(std::move(fragment));
                    fragment = makeFragment(contributionIndex);
                    continue;
                }
                fragment = std::move(candidate);
                consumed += accepted;
                if (consumed < span.recordCount) {
                    appendFragment(std::move(fragment));
                    fragment = makeFragment(contributionIndex);
                }
            }
        }

        auto appendOwnedRecords = [&](auto const& records, auto member) {
            size_t first = 0U;
            while (first < records.size() &&
                   records[first].contributionIndex < contributionIndex)
            {
                ++first;
            }
            auto last = first;
            while (last < records.size() &&
                   records[last].contributionIndex == contributionIndex)
            {
                ++last;
            }

            auto appendRange = [&](GpuRenderPacketData const& base,
                                   size_t offset,
                                   size_t count) {
                auto candidate = base;
                auto& destination = candidate.*member;
                destination.reserve(destination.size() + count);
                for (size_t index = offset; index < offset + count; ++index) {
                    auto copy = records[index];
                    copy.contributionIndex = 0U;
                    destination.push_back(std::move(copy));
                }
                return candidate;
            };

            while (first < last) {
                auto const remaining = last - first;
                auto candidate = appendRange(fragment, first, remaining);
                size_t accepted = 0U;
                if (fits(candidate)) {
                    accepted = remaining;
                }
                else {
                    size_t low = 1U;
                    size_t high = remaining;
                    while (low <= high) {
                        auto const middle = low + (high - low) / 2U;
                        auto middleCandidate = appendRange(
                            fragment,
                            first,
                            middle);
                        if (fits(middleCandidate)) {
                            accepted = middle;
                            candidate = std::move(middleCandidate);
                            low = middle + 1U;
                        }
                        else {
                            high = middle - 1U;
                        }
                    }
                }
                if (accepted == 0U) {
                    if (!hasPayload(fragment)) {
                        throw std::length_error(
                            "One GPU semantic record cannot fit in a packet fragment.");
                    }
                    appendFragment(std::move(fragment));
                    fragment = makeFragment(contributionIndex);
                    continue;
                }
                fragment = std::move(candidate);
                first += accepted;
                if (first < last) {
                    appendFragment(std::move(fragment));
                    fragment = makeFragment(contributionIndex);
                }
            }
        };
        appendOwnedRecords(source.picks, &GpuRenderPacketData::picks);
        appendOwnedRecords(source.labels, &GpuRenderPacketData::labels);
        appendOwnedRecords(source.issues, &GpuRenderPacketData::issues);

        auto withZIndices = fragment;
        withZIndices.contributions.front().zIndices = contribution.zIndices;
        if (!fits(withZIndices)) {
            if (hasPayload(fragment)) {
                appendFragment(std::move(fragment));
                fragment = makeFragment(contributionIndex);
                withZIndices = fragment;
                withZIndices.contributions.front().zIndices =
                    contribution.zIndices;
            }
            if (!fits(withZIndices)) {
                throw std::length_error(
                    "GPU z-index metadata cannot fit in a packet fragment.");
            }
        }
        fragment = std::move(withZIndices);

        if (contributionIndex + 1U == source.contributions.size()) {
            for (auto const& resource : source.resourceRequests) {
                auto candidate = fragment;
                candidate.resourceRequests.push_back(resource);
                if (!fits(candidate)) {
                    if (hasPayload(fragment)) {
                        appendFragment(std::move(fragment));
                        fragment = makeFragment(contributionIndex);
                        candidate = fragment;
                        candidate.resourceRequests.push_back(resource);
                    }
                    if (!fits(candidate)) {
                        throw std::length_error(
                            "One GPU resource request cannot fit in a packet fragment.");
                    }
                }
                fragment = std::move(candidate);
            }
        }
        appendFragment(std::move(fragment));
    }

    auto const fragmentCount = static_cast<uint32_t>(fragments.size());
    if (fragmentCount < 2U || fragmentCount > kGpuRenderPacketMaxFragments) {
        throw std::length_error("GPU render fragment count is invalid.");
    }
    std::vector<std::vector<std::byte>> result;
    result.reserve(fragments.size());
    for (uint32_t index = 0U; index < fragmentCount; ++index) {
        auto& fragment = fragments[index];
        fragment.fragmentIndex = index;
        fragment.fragmentCount = fragmentCount;
        fragment.flags = index + 1U == fragmentCount
            ? GpuRenderPacketFlag::RevisionComplete
            : GpuRenderPacketFlag::None;
        std::vector<std::byte> bytes;
        try {
            auto const fragmentBytes = GpuRenderPacketCodec::encodedSize(fragment);
            bytes = GpuRenderPacketCodec::encode(fragment, fragmentBytes);
        }
        catch (std::length_error const& error) {
            throw std::length_error(
                "Final GPU packet fragment " + std::to_string(index + 1U) +
                "/" + std::to_string(fragmentCount) +
                " exceeded its byte limit: " + error.what());
        }
        result.push_back(std::move(bytes));
    }
    return result;
}

uint32_t GpuRenderPacketBuilder::contributionCount() const
{
    return static_cast<uint32_t>(impl_->packet.contributions.size());
}

} // namespace erdblick
