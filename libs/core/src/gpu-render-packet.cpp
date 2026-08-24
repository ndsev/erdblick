#include "erdblick/gpu-render-packet.h"

#include <algorithm>
#include <bit>
#include <cmath>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <string_view>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>

namespace erdblick
{
namespace
{

constexpr uint32_t kStreamDescriptorBytes = 48U;
constexpr uint32_t kContributionDescriptorBytes = 56U;
constexpr uint32_t kContributionSpanBytes = 16U;
constexpr uint32_t kPickRecordBytes = 24U;
constexpr uint32_t kPickMemberBytes = 8U;
constexpr uint32_t kLabelRecordBytes = 120U;
constexpr uint32_t kResourceRequestBytes = 24U;
constexpr uint32_t kRuntimeIssueBytes = 40U;
constexpr uint32_t kTableAlignment = 8U;
constexpr uint16_t kKnownMaterialFlags =
    static_cast<uint16_t>(GpuMaterialFlag::Billboard) |
    static_cast<uint16_t>(GpuMaterialFlag::DepthTest) |
    static_cast<uint16_t>(GpuMaterialFlag::CompactPath) |
    static_cast<uint16_t>(GpuMaterialFlag::SimplePath) |
    static_cast<uint16_t>(GpuMaterialFlag::DualStrokePath) |
    static_cast<uint16_t>(GpuMaterialFlag::SemanticSupport) |
    static_cast<uint16_t>(GpuMaterialFlag::SemanticOverlay) |
    static_cast<uint16_t>(GpuMaterialFlag::PointRing) |
    static_cast<uint16_t>(GpuMaterialFlag::SurfaceShading) |
    kGpuScreenLengthAnchorFlags;
constexpr uint32_t kKnownPacketFlags =
    static_cast<uint32_t>(GpuRenderPacketFlag::RevisionComplete);
constexpr uint32_t kGpuActivationTokenMax = 0x00ffffffU;
constexpr uint32_t kKnownLabelFlags =
    static_cast<uint32_t>(GpuLabelFlag::Billboard) |
    static_cast<uint32_t>(GpuLabelFlag::DepthTest) |
    static_cast<uint32_t>(GpuLabelFlag::Background) |
    static_cast<uint32_t>(GpuLabelFlag::Collision) |
    kGpuLabelMinimumLodMask;

/** One validated byte interval inside an untrusted packet. */
struct PacketRange {
    uint32_t offset = 0U;
    uint32_t length = 0U;
};

/** Fixed header offsets which store table `(offset, count)` pairs. */
enum class HeaderField : uint32_t {
    StreamTable = 72U,
    ContributionTable = 80U,
    SpanTable = 88U,
    PickTable = 96U,
    PickMemberTable = 104U,
    LabelTable = 112U,
    StringTable = 120U,
    ResourceTable = 128U,
    IssueTable = 144U,
    ZIndexTable = 152U,
};

/** Mutable byte sink which writes explicit little-endian scalar encodings. */
class ByteWriter
{
public:
    /** Preallocate the exact packet size, then zero-fill its fixed header. */
    explicit ByteWriter(uint32_t expectedSize)
    {
        bytes_.reserve(expectedSize);
        bytes_.resize(kGpuRenderPacketHeaderBytes);
    }

    /** Return the current byte offset after checking it fits the wire type. */
    [[nodiscard]] uint32_t size() const
    {
        if (bytes_.size() > std::numeric_limits<uint32_t>::max()) {
            throw std::length_error("GpuRenderPacket exceeds uint32 offsets.");
        }
        return static_cast<uint32_t>(bytes_.size());
    }

    /** Pad the next section to the ABI's fixed table alignment. */
    void align()
    {
        while ((bytes_.size() % kTableAlignment) != 0U) {
            bytes_.push_back(std::byte{0U});
        }
    }

    /** Reserve zero-filled bytes and return their starting offset. */
    [[nodiscard]] uint32_t reserve(uint32_t byteCount)
    {
        auto const offset = size();
        if (byteCount > kGpuRenderPacketMaxBytes - bytes_.size()) {
            throw std::length_error("GpuRenderPacket exceeds its byte limit.");
        }
        bytes_.resize(bytes_.size() + byteCount, std::byte{0U});
        return offset;
    }

    /** Append an already packed record stream without interpreting its bytes. */
    [[nodiscard]] uint32_t append(std::span<std::byte const> data)
    {
        auto const offset = size();
        if (data.size() > kGpuRenderPacketMaxBytes - bytes_.size()) {
            throw std::length_error("GpuRenderPacket exceeds its byte limit.");
        }
        bytes_.insert(bytes_.end(), data.begin(), data.end());
        return offset;
    }

    /** Write one trivially copyable scalar in little-endian order. */
    template<typename T>
    void put(uint32_t offset, T value)
    {
        static_assert(std::is_trivially_copyable_v<T>);
        if (offset > bytes_.size() || sizeof(T) > bytes_.size() - offset) {
            throw std::out_of_range("GpuRenderPacket write exceeds packet bounds.");
        }
        auto raw = std::bit_cast<std::array<std::byte, sizeof(T)>>(value);
        if constexpr (std::endian::native == std::endian::big) {
            std::reverse(raw.begin(), raw.end());
        }
        std::memcpy(bytes_.data() + offset, raw.data(), raw.size());
    }

    /** Transfer ownership of the finished packet bytes. */
    [[nodiscard]] std::vector<std::byte> finish() &&
    {
        return std::move(bytes_);
    }

private:
    std::vector<std::byte> bytes_;
};

/** Read-only bounds-checked little-endian packet access. */
class ByteReader
{
public:
    /** Wrap bytes supplied by the worker without taking ownership. */
    explicit ByteReader(std::span<std::byte const> bytes) : bytes_(bytes) {}

    /** Read one scalar after checking packet bounds. */
    template<typename T>
    [[nodiscard]] T get(uint32_t offset) const
    {
        static_assert(std::is_trivially_copyable_v<T>);
        if (offset > bytes_.size() || sizeof(T) > bytes_.size() - offset) {
            throw std::out_of_range("GpuRenderPacket read exceeds packet bounds.");
        }
        std::array<std::byte, sizeof(T)> raw{};
        std::memcpy(raw.data(), bytes_.data() + offset, raw.size());
        if constexpr (std::endian::native == std::endian::big) {
            std::reverse(raw.begin(), raw.end());
        }
        return std::bit_cast<T>(raw);
    }

    /** Validate one `[offset, length]` byte range and its alignment. */
    void byteRange(uint32_t offset, uint32_t length, uint32_t alignment) const
    {
        if ((offset % alignment) != 0U || offset > bytes_.size() ||
            length > bytes_.size() - offset)
        {
            throw std::invalid_argument("GpuRenderPacket table range is invalid.");
        }
    }

    /** Validate a fixed-stride table while guarding multiplication overflow. */
    void table(uint32_t offset, uint32_t count, uint32_t stride) const
    {
        auto const bytes = static_cast<uint64_t>(count) * stride;
        if (bytes > std::numeric_limits<uint32_t>::max()) {
            throw std::invalid_argument("GpuRenderPacket table size overflows.");
        }
        byteRange(offset, static_cast<uint32_t>(bytes), kTableAlignment);
    }

private:
    std::span<std::byte const> bytes_;
};

/** String interner whose offsets are relative to the packet string table. */
class StringTable
{
public:
    /** Intern a UTF-8 byte string and return its relative offset and length. */
    [[nodiscard]] std::pair<uint32_t, uint32_t> add(std::string const& value)
    {
        if (value.empty()) {
            return {0U, 0U};
        }
        if (auto const found = offsets_.find(value); found != offsets_.end()) {
            return {found->second, static_cast<uint32_t>(value.size())};
        }
        if (value.size() > std::numeric_limits<uint32_t>::max() - bytes_.size()) {
            throw std::length_error("GpuRenderPacket string table overflows.");
        }
        auto const offset = static_cast<uint32_t>(bytes_.size());
        bytes_.insert(bytes_.end(), value.begin(), value.end());
        offsets_.emplace(value, offset);
        return {offset, static_cast<uint32_t>(value.size())};
    }

    /** Access packed UTF-8 bytes after all references have been interned. */
    [[nodiscard]] std::span<std::byte const> bytes() const
    {
        return {
            reinterpret_cast<std::byte const*>(bytes_.data()),
            bytes_.size(),
        };
    }

private:
    std::vector<char> bytes_;
    std::unordered_map<std::string_view, uint32_t> offsets_;
};

/** Return the legal ABI stride for one primitive program/material layout. */
[[nodiscard]] constexpr uint32_t recordStride(
    GpuPrimitiveKind kind,
    uint16_t flags)
{
    auto const compactPath =
        (flags & static_cast<uint16_t>(GpuMaterialFlag::CompactPath)) != 0U;
    auto const simplePath =
        (flags & static_cast<uint16_t>(GpuMaterialFlag::SimplePath)) != 0U;
    auto const dualStrokePath =
        (flags & static_cast<uint16_t>(GpuMaterialFlag::DualStrokePath)) != 0U;
    auto const pointRing =
        (flags & static_cast<uint16_t>(GpuMaterialFlag::PointRing)) != 0U;
    auto const surfaceShading =
        (flags & static_cast<uint16_t>(GpuMaterialFlag::SurfaceShading)) != 0U;
    auto const screenLengthAnchor = static_cast<uint16_t>(
        flags & kGpuScreenLengthAnchorFlags);
    auto const semanticRoles = static_cast<uint16_t>(
        flags & (
            static_cast<uint16_t>(GpuMaterialFlag::SemanticSupport) |
            static_cast<uint16_t>(GpuMaterialFlag::SemanticOverlay)));
    auto const validScreenLengthAnchor = screenLengthAnchor == 0U ||
        std::has_single_bit(screenLengthAnchor);
    if ((compactPath && simplePath) ||
        (dualStrokePath && !compactPath && !simplePath) ||
        (semanticRoles != 0U && !std::has_single_bit(semanticRoles)) ||
        (pointRing && kind != GpuPrimitiveKind::Point) ||
        (surfaceShading && kind != GpuPrimitiveKind::SurfaceTriangle) ||
        ((compactPath || simplePath) &&
            kind != GpuPrimitiveKind::PathSegment) ||
        !validScreenLengthAnchor ||
        (screenLengthAnchor != 0U &&
            ((kind != GpuPrimitiveKind::PathSegment &&
              kind != GpuPrimitiveKind::Arrow) ||
             compactPath || simplePath)))
    {
        return 0U;
    }
    switch (kind) {
    case GpuPrimitiveKind::Point: return kGpuPointRecordBytes;
    case GpuPrimitiveKind::PathSegment:
        return simplePath
            ? dualStrokePath
                ? kGpuDualSimplePathSegmentRecordBytes
                : kGpuSimplePathSegmentRecordBytes
            : compactPath
                ? dualStrokePath
                    ? kGpuDualCompactPathSegmentRecordBytes
                    : kGpuCompactPathSegmentRecordBytes
                : kGpuPathSegmentRecordBytes;
    case GpuPrimitiveKind::Arrow: return kGpuArrowRecordBytes;
    case GpuPrimitiveKind::SurfaceTriangle:
        return kGpuSurfaceTriangleRecordBytes;
    case GpuPrimitiveKind::Icon: return kGpuIconRecordBytes;
    }
    return 0U;
}

void setTableHeader(
    ByteWriter& writer,
    HeaderField field,
    uint32_t offset,
    uint32_t count)
{
    auto const fieldOffset = static_cast<uint32_t>(field);
    writer.put(fieldOffset, offset);
    writer.put(fieldOffset + 4U, count);
}

void validateString(
    ByteReader const& reader,
    uint32_t stringOffset,
    uint32_t stringBytes,
    uint32_t relativeOffset,
    uint32_t length)
{
    if (relativeOffset > stringBytes || length > stringBytes - relativeOffset) {
        throw std::invalid_argument("GpuRenderPacket string reference is invalid.");
    }
    reader.byteRange(stringOffset + relativeOffset, length, 1U);
}

/** Reject aliases between non-empty packet tables and primitive streams. */
void validateDisjointRanges(std::vector<PacketRange> ranges)
{
    std::erase_if(ranges, [](PacketRange const& range) {
        return range.length == 0U;
    });
    std::ranges::sort(ranges, {}, &PacketRange::offset);
    auto previousEnd = static_cast<uint32_t>(kGpuRenderPacketHeaderBytes);
    for (auto const& range : ranges) {
        if (range.offset < previousEnd) {
            throw std::invalid_argument(
                "GpuRenderPacket byte ranges overlap.");
        }
        previousEnd = range.offset + range.length;
    }
}

/** Reject logical packets whose contribution ownership is not a partition. */
void validateLogicalOwnership(GpuRenderPacketData const& packet)
{
    auto const packetFlags = static_cast<uint32_t>(packet.flags);
    auto const revisionComplete =
        (packetFlags & static_cast<uint32_t>(
            GpuRenderPacketFlag::RevisionComplete)) != 0U;
    if ((packetFlags & ~kKnownPacketFlags) != 0U ||
        packet.fragmentCount == 0U ||
        packet.fragmentCount > kGpuRenderPacketMaxFragments ||
        packet.fragmentIndex >= packet.fragmentCount ||
        revisionComplete !=
            (packet.fragmentIndex + 1U == packet.fragmentCount))
    {
        throw std::invalid_argument(
            "GpuRenderPacket fragment lifecycle metadata is invalid.");
    }
    std::vector<std::vector<std::pair<uint32_t, uint32_t>>> streamRanges(
        packet.streams.size());
    std::unordered_set<uint64_t> contributionKeys;
    std::unordered_set<uint32_t> contributionSlots;
    std::unordered_set<uint32_t> activationTokens;
    for (auto const& stream : packet.streams) {
        auto const stride = recordStride(stream.kind, stream.flags);
        if (stride == 0U || stream.recordStride != stride ||
            (stream.records.size() % stride) != 0U ||
            !std::isfinite(stream.glowRadius) || stream.glowRadius < 0.0F)
        {
            throw std::invalid_argument(
                "GpuRenderPacket stream has an invalid record layout.");
        }
    }
    for (auto const& contribution : packet.contributions) {
        if (!contributionKeys.insert(contribution.key).second ||
            !contributionSlots.insert(contribution.slot).second ||
            contribution.activationToken == 0U ||
            contribution.activationToken > kGpuActivationTokenMax ||
            !activationTokens.insert(contribution.activationToken).second)
        {
            throw std::invalid_argument(
                "GpuRenderPacket contribution identity, slot, or activation token is invalid.");
        }
        std::unordered_set<uint32_t> ownedStreams;
        for (auto const& span : contribution.spans) {
            if (span.streamIndex >= packet.streams.size() ||
                span.recordCount == 0U ||
                !ownedStreams.insert(span.streamIndex).second)
            {
                throw std::invalid_argument(
                    "GpuRenderPacket contribution span is invalid.");
            }
            auto const& stream = packet.streams[span.streamIndex];
            auto const streamCount = static_cast<uint32_t>(
                stream.records.size() / stream.recordStride);
            if (span.firstRecord > streamCount ||
                span.recordCount > streamCount - span.firstRecord)
            {
                throw std::invalid_argument(
                    "GpuRenderPacket contribution span exceeds its stream.");
            }
            streamRanges[span.streamIndex].emplace_back(
                span.firstRecord,
                span.recordCount);
        }
    }
    for (uint32_t streamIndex = 0U;
         streamIndex < packet.streams.size();
         ++streamIndex)
    {
        auto& ranges = streamRanges[streamIndex];
        std::ranges::sort(ranges);
        uint32_t cursor = 0U;
        for (auto const& [first, count] : ranges) {
            if (first != cursor) {
                throw std::invalid_argument(
                    "GpuRenderPacket stream ownership has a gap or overlap.");
            }
            cursor += count;
        }
        auto const& stream = packet.streams[streamIndex];
        auto const streamCount = static_cast<uint32_t>(
            stream.records.size() / stream.recordStride);
        if (cursor != streamCount) {
            throw std::invalid_argument(
                "GpuRenderPacket stream records are not fully owned.");
        }
    }

    std::vector<uint32_t> previousLocalPick(packet.contributions.size(), 0U);
    std::vector<bool> hasPreviousLocalPick(packet.contributions.size(), false);
    std::vector<uint32_t> packetPickCounts(packet.contributions.size(), 0U);
    uint32_t previousOwner = 0U;
    bool hasPreviousOwner = false;
    for (auto const& pick : packet.picks) {
        if (pick.contributionIndex >= packet.contributions.size() ||
            (hasPreviousOwner && pick.contributionIndex < previousOwner) ||
            pick.localPickIndex >=
                packet.contributions[pick.contributionIndex].totalPickCount ||
            (hasPreviousLocalPick[pick.contributionIndex] &&
             pick.localPickIndex <= previousLocalPick[pick.contributionIndex]))
        {
            throw std::invalid_argument(
                "GpuRenderPacket picks do not form ordered owner-local ranges.");
        }
        previousLocalPick[pick.contributionIndex] = pick.localPickIndex;
        hasPreviousLocalPick[pick.contributionIndex] = true;
        ++packetPickCounts[pick.contributionIndex];
        previousOwner = pick.contributionIndex;
        hasPreviousOwner = true;
    }
    previousOwner = 0U;
    hasPreviousOwner = false;
    for (auto const& label : packet.labels) {
        if (label.contributionIndex >= packet.contributions.size() ||
            (hasPreviousOwner && label.contributionIndex < previousOwner) ||
            (label.localPickIndex != std::numeric_limits<uint32_t>::max() &&
             label.localPickIndex >=
                packet.contributions[label.contributionIndex].totalPickCount))
        {
            throw std::invalid_argument(
                "GpuRenderPacket label ownership is invalid.");
        }
        previousOwner = label.contributionIndex;
        hasPreviousOwner = true;
    }
    if (packet.fragmentCount == 1U) {
        for (uint32_t contributionIndex = 0U;
             contributionIndex < packet.contributions.size();
             ++contributionIndex)
        {
            auto const total =
                packet.contributions[contributionIndex].totalPickCount;
            if (packetPickCounts[contributionIndex] != total ||
                (total > 0U &&
                 (!hasPreviousLocalPick[contributionIndex] ||
                  previousLocalPick[contributionIndex] + 1U != total)))
            {
                throw std::invalid_argument(
                    "GpuRenderPacket complete revision has incomplete picking metadata.");
            }
        }
    }
    for (auto const& issue : packet.issues) {
        if (issue.contributionIndex >= packet.contributions.size()) {
            throw std::invalid_argument(
                "GpuRenderPacket issue references an unknown contribution.");
        }
    }
    for (auto const& contribution : packet.contributions) {
        if (std::ranges::any_of(
                contribution.zIndices,
                [](GpuZIndexEntry const& entry) {
                    return std::isinf(entry.value);
                }))
        {
            throw std::invalid_argument(
                "GpuRenderPacket z-index table contains infinity.");
        }
    }
}

[[nodiscard]] uint64_t alignedTableEnd(
    uint64_t offset,
    uint64_t count,
    uint64_t stride)
{
    constexpr uint64_t alignment = kTableAlignment;
    auto const aligned = (offset + alignment - 1U) & ~(alignment - 1U);
    return aligned + count * stride;
}

[[nodiscard]] uint64_t encodedStringBytes(
    GpuRenderPacketData const& packet)
{
    std::unordered_set<std::string_view> strings;
    uint64_t result = 0U;
    auto add = [&](std::string const& value) {
        if (!value.empty() && strings.insert(value).second) {
            result += value.size();
        }
    };
    for (auto const& label : packet.labels) {
        add(label.text);
        add(label.fontFamily);
    }
    for (auto const& resource : packet.resourceRequests) {
        add(resource.uri);
    }
    for (auto const& issue : packet.issues) {
        add(issue.property);
        add(issue.expression);
        add(issue.message);
    }
    return result;
}

} // namespace

uint64_t GpuRenderPacketCodec::encodedSize(
    GpuRenderPacketData const& packet)
{
    uint64_t totalSpans = 0U;
    uint64_t totalZIndices = 0U;
    for (auto const& contribution : packet.contributions) {
        totalSpans += contribution.spans.size();
        totalZIndices += contribution.zIndices.size();
    }
    uint64_t size = kGpuRenderPacketHeaderBytes;
    size = alignedTableEnd(size, packet.streams.size(), kStreamDescriptorBytes);
    size = alignedTableEnd(
        size,
        packet.contributions.size(),
        kContributionDescriptorBytes);
    size = alignedTableEnd(size, totalZIndices, kGpuZIndexEntryBytes);
    size = alignedTableEnd(size, totalSpans, kContributionSpanBytes);
    size = alignedTableEnd(size, packet.picks.size(), kPickRecordBytes);
    size = alignedTableEnd(size, 0U, kPickMemberBytes);
    size = alignedTableEnd(size, packet.labels.size(), kLabelRecordBytes);
    size = alignedTableEnd(
        size,
        packet.resourceRequests.size(),
        kResourceRequestBytes);
    size = alignedTableEnd(size, packet.issues.size(), kRuntimeIssueBytes);
    size = alignedTableEnd(size, encodedStringBytes(packet), 1U);
    for (auto const& stream : packet.streams) {
        size = alignedTableEnd(size, stream.records.size(), 1U);
    }
    return size;
}

std::vector<std::byte> GpuRenderPacketCodec::encode(
    GpuRenderPacketData const& packet)
{
    return encode(packet, encodedSize(packet));
}

std::vector<std::byte> GpuRenderPacketCodec::encode(
    GpuRenderPacketData const& packet,
    uint64_t exactEncodedSize)
{
    validateLogicalOwnership(packet);

    if (exactEncodedSize > kGpuRenderPacketMaxBytes) {
        throw std::length_error("GpuRenderPacket exceeds its byte limit.");
    }
    ByteWriter writer(static_cast<uint32_t>(exactEncodedSize));
    StringTable strings;

    writer.align();
    auto const streamTable = writer.reserve(
        static_cast<uint32_t>(packet.streams.size()) * kStreamDescriptorBytes);
    writer.align();
    auto const contributionTable = writer.reserve(
        static_cast<uint32_t>(packet.contributions.size()) *
        kContributionDescriptorBytes);

    uint64_t totalZIndices = 0U;
    for (auto const& contribution : packet.contributions) {
        totalZIndices += contribution.zIndices.size();
    }
    if (totalZIndices >
        std::numeric_limits<uint32_t>::max() / kGpuZIndexEntryBytes)
    {
        throw std::length_error("GpuRenderPacket has too many z-index values.");
    }
    writer.align();
    auto const zIndexTable = writer.reserve(
        static_cast<uint32_t>(totalZIndices) * kGpuZIndexEntryBytes);

    uint64_t totalSpans = 0U;
    for (auto const& contribution : packet.contributions) {
        totalSpans += contribution.spans.size();
    }
    if (totalSpans > std::numeric_limits<uint32_t>::max()) {
        throw std::length_error("GpuRenderPacket has too many contribution spans.");
    }
    writer.align();
    auto const spanTable = writer.reserve(
        static_cast<uint32_t>(totalSpans) * kContributionSpanBytes);

    writer.align();
    auto const pickTable = writer.reserve(
        static_cast<uint32_t>(packet.picks.size()) * kPickRecordBytes);
    writer.align();
    auto const pickMemberTable = writer.reserve(0U);

    writer.align();
    auto const labelTable = writer.reserve(
        static_cast<uint32_t>(packet.labels.size()) * kLabelRecordBytes);
    writer.align();
    auto const resourceTable = writer.reserve(
        static_cast<uint32_t>(packet.resourceRequests.size()) *
        kResourceRequestBytes);
    writer.align();
    auto const issueTable = writer.reserve(
        static_cast<uint32_t>(packet.issues.size()) * kRuntimeIssueBytes);

    std::vector<uint32_t> pickCounts(packet.contributions.size(), 0U);
    std::vector<uint32_t> labelCounts(packet.contributions.size(), 0U);
    uint32_t previousContribution = 0U;
    bool hasPreviousContribution = false;
    auto countOrdered = [&](uint32_t contributionIndex, auto& counts) {
        if (contributionIndex >= packet.contributions.size()) {
            throw std::invalid_argument(
                "GpuRenderPacket record references an unknown contribution.");
        }
        if (hasPreviousContribution && contributionIndex < previousContribution) {
            throw std::invalid_argument(
                "GpuRenderPacket contribution-owned records must be grouped by owner.");
        }
        previousContribution = contributionIndex;
        hasPreviousContribution = true;
        ++counts[contributionIndex];
    };
    for (auto const& pick : packet.picks) {
        countOrdered(pick.contributionIndex, pickCounts);
    }
    previousContribution = 0U;
    hasPreviousContribution = false;
    for (auto const& label : packet.labels) {
        countOrdered(label.contributionIndex, labelCounts);
    }

    uint32_t spanIndex = 0U;
    uint32_t pickIndex = 0U;
    uint32_t labelIndex = 0U;
    uint32_t zIndex = 0U;
    for (uint32_t contributionIndex = 0U;
         contributionIndex < packet.contributions.size();
         ++contributionIndex)
    {
        auto const& contribution = packet.contributions[contributionIndex];
        auto const descriptor = contributionTable +
            contributionIndex * kContributionDescriptorBytes;
        writer.put(descriptor, contribution.key);
        writer.put(descriptor + 8U, contribution.revision);
        writer.put(descriptor + 12U, contribution.slot);
        writer.put(descriptor + 16U, contribution.activationToken);
        writer.put(descriptor + 20U, spanIndex);
        writer.put(
            descriptor + 24U,
            static_cast<uint32_t>(contribution.spans.size()));
        writer.put(descriptor + 28U, pickIndex);
        auto const contributionPickCount = pickCounts[contributionIndex];
        writer.put(descriptor + 32U, contributionPickCount);
        writer.put(descriptor + 36U, labelIndex);
        auto const contributionLabelCount = labelCounts[contributionIndex];
        writer.put(descriptor + 40U, contributionLabelCount);
        writer.put(descriptor + 44U, zIndex);
        writer.put(
            descriptor + 48U,
            static_cast<uint32_t>(contribution.zIndices.size()));
        writer.put(descriptor + 52U, contribution.totalPickCount);
        for (auto const& entry : contribution.zIndices) {
            auto const offset = zIndexTable + zIndex * kGpuZIndexEntryBytes;
            writer.put(offset, entry.value);
            writer.put(offset + 8U, entry.tieBreaker);
            writer.put(offset + 12U, entry.semanticGroup);
            ++zIndex;
        }

        for (auto const& span : contribution.spans) {
            if (span.streamIndex >= packet.streams.size()) {
                throw std::invalid_argument(
                    "GpuRenderPacket contribution references an unknown stream.");
            }
            auto const& stream = packet.streams[span.streamIndex];
            auto const streamCount = stream.recordStride == 0U
                ? 0U
                : static_cast<uint32_t>(stream.records.size() / stream.recordStride);
            if (span.firstRecord > streamCount ||
                span.recordCount > streamCount - span.firstRecord)
            {
                throw std::invalid_argument(
                    "GpuRenderPacket contribution span exceeds its stream.");
            }
            auto const offset = spanTable + spanIndex * kContributionSpanBytes;
            writer.put(offset, span.streamIndex);
            writer.put(offset + 4U, span.firstRecord);
            writer.put(offset + 8U, span.recordCount);
            ++spanIndex;
        }
        pickIndex += contributionPickCount;
        labelIndex += contributionLabelCount;
    }

    for (uint32_t index = 0U; index < packet.picks.size(); ++index) {
        auto const& pick = packet.picks[index];
        if (pick.contributionIndex >= packet.contributions.size()) {
            throw std::invalid_argument(
                "GpuRenderPacket pick references an unknown contribution.");
        }
        auto const offset = pickTable + index * kPickRecordBytes;
        writer.put(offset, pick.contributionIndex);
        writer.put(offset + 4U, pick.localPickIndex);
        writer.put(offset + 8U, pick.channelOrdinal);
        writer.put(offset + 12U, pick.entryOrdinal);
        writer.put(offset + 16U, pick.endpointRole);
        writer.put(offset + 20U, pick.navigationAltitude);
    }

    for (uint32_t index = 0U; index < packet.labels.size(); ++index) {
        auto const& label = packet.labels[index];
        if (label.contributionIndex >= packet.contributions.size()) {
            throw std::invalid_argument(
                "GpuRenderPacket label references an unknown contribution.");
        }
        auto const offset = labelTable + index * kLabelRecordBytes;
        auto const text = strings.add(label.text);
        auto const font = strings.add(label.fontFamily);
        writer.put(offset, label.contributionIndex);
        writer.put(offset + 4U, label.localPickIndex);
        writer.put(offset + 8U, label.positionWgs84[0]);
        writer.put(offset + 16U, label.positionWgs84[1]);
        writer.put(offset + 24U, label.positionWgs84[2]);
        writer.put(offset + 32U, text.first);
        writer.put(offset + 36U, text.second);
        writer.put(offset + 40U, font.first);
        writer.put(offset + 44U, font.second);
        writer.put(offset + 48U, label.size);
        writer.put(offset + 52U, label.pixelOffset[0]);
        writer.put(offset + 56U, label.pixelOffset[1]);
        writer.put(offset + 60U, label.angle);
        writer.put(offset + 64U, label.zIndex);
        for (uint32_t component = 0U; component < 4U; ++component) {
            writer.put(offset + 72U + component, label.color[component]);
            writer.put(offset + 76U + component, label.outlineColor[component]);
            writer.put(offset + 80U + component, label.backgroundColor[component]);
        }
        writer.put(offset + 84U, label.outlineWidth);
        writer.put(offset + 88U, label.backgroundPadding[0]);
        writer.put(offset + 92U, label.backgroundPadding[1]);
        if (label.minimumLod > 7U) {
            throw std::invalid_argument(
                "GpuRenderPacket label minimum LOD is invalid.");
        }
        writer.put(
            offset + 96U,
            label.flags |
                (static_cast<uint32_t>(label.minimumLod) <<
                 kGpuLabelMinimumLodShift));
        writer.put(offset + 100U, label.horizontalOrigin);
        writer.put(offset + 104U, label.verticalOrigin);
        writer.put(offset + 108U, label.renderOrder);
        writer.put(offset + 112U, label.fontWeight);
        writer.put(offset + 116U, label.collisionPriority);
    }

    for (uint32_t index = 0U;
         index < packet.resourceRequests.size();
         ++index)
    {
        auto const& request = packet.resourceRequests[index];
        auto const uri = strings.add(request.uri);
        auto const offset = resourceTable + index * kResourceRequestBytes;
        writer.put(offset, request.resourceKind);
        writer.put(offset + 4U, uint32_t{0U});
        writer.put(offset + 8U, uri.first);
        writer.put(offset + 12U, uri.second);
    }

    for (uint32_t index = 0U; index < packet.issues.size(); ++index) {
        auto const& issue = packet.issues[index];
        if (issue.contributionIndex >= packet.contributions.size()) {
            throw std::invalid_argument(
                "GpuRenderPacket issue references an unknown contribution.");
        }
        auto const property = strings.add(issue.property);
        auto const expression = strings.add(issue.expression);
        auto const message = strings.add(issue.message);
        auto const offset = issueTable + index * kRuntimeIssueBytes;
        writer.put(offset, issue.contributionIndex);
        writer.put(offset + 4U, issue.ruleIndex);
        writer.put(offset + 8U, issue.occurrenceCount);
        writer.put(offset + 16U, property.first);
        writer.put(offset + 20U, property.second);
        writer.put(offset + 24U, expression.first);
        writer.put(offset + 28U, expression.second);
        writer.put(offset + 32U, message.first);
        writer.put(offset + 36U, message.second);
    }

    writer.align();
    auto const stringTable = writer.append(strings.bytes());

    for (uint32_t index = 0U; index < packet.streams.size(); ++index) {
        auto const& stream = packet.streams[index];
        if (stream.recordStride != recordStride(stream.kind, stream.flags) ||
            (stream.records.size() % stream.recordStride) != 0U ||
            !std::isfinite(stream.glowRadius) || stream.glowRadius < 0.0F)
        {
            throw std::invalid_argument(
                "GpuRenderPacket stream has an invalid record stride.");
        }
        writer.align();
        auto const dataOffset = writer.append(stream.records);
        auto const descriptor = streamTable + index * kStreamDescriptorBytes;
        writer.put(descriptor, static_cast<uint16_t>(stream.kind));
        writer.put(descriptor + 2U, stream.flags);
        writer.put(descriptor + 4U, stream.materialKey);
        writer.put(descriptor + 12U, stream.recordStride);
        writer.put(
            descriptor + 16U,
            static_cast<uint32_t>(stream.records.size() / stream.recordStride));
        writer.put(descriptor + 20U, dataOffset);
        writer.put(
            descriptor + 24U,
            static_cast<uint32_t>(stream.records.size()));
        for (uint32_t component = 0U; component < stream.glowColor.size();
             ++component)
        {
            writer.put(
                descriptor + 28U + component,
                stream.glowColor[component]);
        }
        writer.put(descriptor + 32U, stream.glowRadius);
        writer.put(descriptor + 36U, stream.atlasPage);
        writer.put(descriptor + 40U, stream.renderOrder);
        writer.put(descriptor + 44U, uint32_t{0U});
    }

    auto const totalBytes = writer.size();
    writer.put(0U, kGpuRenderPacketMagic);
    writer.put(4U, kGpuRenderPacketAbiVersion);
    writer.put(6U, kGpuRenderPacketHeaderBytes);
    writer.put(8U, totalBytes);
    writer.put(12U, static_cast<uint32_t>(packet.flags));
    writer.put(16U, packet.sceneGeneration);
    writer.put(20U, packet.packetSequence);
    writer.put(24U, packet.fragmentIndex);
    writer.put(28U, packet.iconCatalogVersion);
    writer.put(32U, packet.origin.slot);
    writer.put(36U, packet.fragmentCount);
    writer.put(40U, packet.origin.key);
    writer.put(48U, packet.origin.longitude);
    writer.put(56U, packet.origin.latitude);
    writer.put(64U, packet.origin.altitude);
    setTableHeader(
        writer,
        HeaderField::StreamTable,
        streamTable,
        static_cast<uint32_t>(packet.streams.size()));
    setTableHeader(
        writer,
        HeaderField::ContributionTable,
        contributionTable,
        static_cast<uint32_t>(packet.contributions.size()));
    setTableHeader(
        writer,
        HeaderField::SpanTable,
        spanTable,
        static_cast<uint32_t>(totalSpans));
    setTableHeader(
        writer,
        HeaderField::PickTable,
        pickTable,
        static_cast<uint32_t>(packet.picks.size()));
    setTableHeader(
        writer,
        HeaderField::PickMemberTable,
        pickMemberTable,
        0U);
    setTableHeader(
        writer,
        HeaderField::LabelTable,
        labelTable,
        static_cast<uint32_t>(packet.labels.size()));
    setTableHeader(
        writer,
        HeaderField::StringTable,
        stringTable,
        static_cast<uint32_t>(strings.bytes().size()));
    setTableHeader(
        writer,
        HeaderField::ResourceTable,
        resourceTable,
        static_cast<uint32_t>(packet.resourceRequests.size()));
    setTableHeader(
        writer,
        HeaderField::IssueTable,
        issueTable,
        static_cast<uint32_t>(packet.issues.size()));
    setTableHeader(
        writer,
        HeaderField::ZIndexTable,
        zIndexTable,
        static_cast<uint32_t>(totalZIndices));

    if (totalBytes != exactEncodedSize) {
        throw std::logic_error(
            "GpuRenderPacket encoded size changed between sizing and encoding.");
    }
    return std::move(writer).finish();
}

GpuRenderPacketInfo GpuRenderPacketCodec::validate(
    std::span<std::byte const> bytes)
{
    if (bytes.size() < kGpuRenderPacketHeaderBytes ||
        bytes.size() > kGpuRenderPacketMaxBytes)
    {
        throw std::invalid_argument("GpuRenderPacket size is invalid.");
    }
    ByteReader reader(bytes);
    if (reader.get<uint32_t>(0U) != kGpuRenderPacketMagic) {
        throw std::invalid_argument("GpuRenderPacket magic does not match.");
    }
    if (reader.get<uint16_t>(4U) != kGpuRenderPacketAbiVersion) {
        throw std::invalid_argument("GpuRenderPacket ABI version is unsupported.");
    }
    if (reader.get<uint16_t>(6U) != kGpuRenderPacketHeaderBytes) {
        throw std::invalid_argument("GpuRenderPacket header size is unsupported.");
    }
    auto const totalBytes = reader.get<uint32_t>(8U);
    if (totalBytes != bytes.size()) {
        throw std::invalid_argument("GpuRenderPacket total byte length does not match.");
    }
    auto const packetFlags = reader.get<uint32_t>(12U);
    auto const fragmentIndex = reader.get<uint32_t>(24U);
    auto const fragmentCount = reader.get<uint32_t>(36U);
    auto const revisionComplete =
        (packetFlags & static_cast<uint32_t>(
            GpuRenderPacketFlag::RevisionComplete)) != 0U;
    if ((packetFlags & ~kKnownPacketFlags) != 0U ||
        fragmentCount == 0U ||
        fragmentCount > kGpuRenderPacketMaxFragments ||
        fragmentIndex >= fragmentCount ||
        revisionComplete != (fragmentIndex + 1U == fragmentCount))
    {
        throw std::invalid_argument(
            "GpuRenderPacket fragment lifecycle metadata is invalid.");
    }

    auto tablePair = [&reader](HeaderField field) {
        auto const offset = static_cast<uint32_t>(field);
        return std::pair{
            reader.get<uint32_t>(offset),
            reader.get<uint32_t>(offset + 4U),
        };
    };
    auto const streams = tablePair(HeaderField::StreamTable);
    auto const contributions = tablePair(HeaderField::ContributionTable);
    auto const spans = tablePair(HeaderField::SpanTable);
    auto const picks = tablePair(HeaderField::PickTable);
    auto const members = tablePair(HeaderField::PickMemberTable);
    auto const labels = tablePair(HeaderField::LabelTable);
    auto const strings = tablePair(HeaderField::StringTable);
    auto const resources = tablePair(HeaderField::ResourceTable);
    auto const issues = tablePair(HeaderField::IssueTable);
    auto const zIndices = tablePair(HeaderField::ZIndexTable);
    reader.table(streams.first, streams.second, kStreamDescriptorBytes);
    reader.table(
        contributions.first,
        contributions.second,
        kContributionDescriptorBytes);
    reader.table(spans.first, spans.second, kContributionSpanBytes);
    reader.table(picks.first, picks.second, kPickRecordBytes);
    reader.table(members.first, members.second, kPickMemberBytes);
    reader.table(labels.first, labels.second, kLabelRecordBytes);
    reader.byteRange(strings.first, strings.second, kTableAlignment);
    reader.table(resources.first, resources.second, kResourceRequestBytes);
    if (reader.get<uint32_t>(136U) != 0U ||
        reader.get<uint32_t>(140U) != 0U)
    {
        throw std::invalid_argument(
            "GpuRenderPacket reserved header table is nonzero.");
    }
    reader.table(issues.first, issues.second, kRuntimeIssueBytes);
    reader.table(
        zIndices.first,
        zIndices.second,
        kGpuZIndexEntryBytes);

    std::vector<PacketRange> packetRanges;
    auto addTableRange = [&](std::pair<uint32_t, uint32_t> table,
                             uint32_t stride) {
        if (table.first < kGpuRenderPacketHeaderBytes) {
            throw std::invalid_argument(
                "GpuRenderPacket table overlaps its header.");
        }
        packetRanges.push_back({
            table.first,
            static_cast<uint32_t>(
                static_cast<uint64_t>(table.second) * stride),
        });
    };
    addTableRange(streams, kStreamDescriptorBytes);
    addTableRange(contributions, kContributionDescriptorBytes);
    addTableRange(spans, kContributionSpanBytes);
    addTableRange(picks, kPickRecordBytes);
    addTableRange(members, kPickMemberBytes);
    addTableRange(labels, kLabelRecordBytes);
    addTableRange(strings, 1U);
    addTableRange(resources, kResourceRequestBytes);
    addTableRange(issues, kRuntimeIssueBytes);
    addTableRange(zIndices, kGpuZIndexEntryBytes);

    std::vector<uint32_t> streamRecordCounts;
    streamRecordCounts.reserve(streams.second);
    for (uint32_t index = 0U; index < streams.second; ++index) {
        auto const descriptor = streams.first + index * kStreamDescriptorBytes;
        auto const kind = reader.get<uint16_t>(descriptor);
        if (kind < static_cast<uint16_t>(GpuPrimitiveKind::Point) ||
            kind > static_cast<uint16_t>(GpuPrimitiveKind::Icon))
        {
            throw std::invalid_argument("GpuRenderPacket primitive kind is invalid.");
        }
        auto const primitiveKind = static_cast<GpuPrimitiveKind>(kind);
        auto const flags = reader.get<uint16_t>(descriptor + 2U);
        auto const stride = reader.get<uint32_t>(descriptor + 12U);
        auto const count = reader.get<uint32_t>(descriptor + 16U);
        auto const offset = reader.get<uint32_t>(descriptor + 20U);
        auto const length = reader.get<uint32_t>(descriptor + 24U);
        auto const glowRadius = reader.get<float>(descriptor + 32U);
        if ((flags & ~kKnownMaterialFlags) != 0U ||
            stride != recordStride(primitiveKind, flags) ||
            static_cast<uint64_t>(stride) * count != length) {
            throw std::invalid_argument("GpuRenderPacket stream shape is invalid.");
        }
        if (!std::isfinite(glowRadius) || glowRadius < 0.0F ||
            reader.get<uint32_t>(descriptor + 44U) != 0U)
        {
            throw std::invalid_argument(
                "GpuRenderPacket stream material parameters are invalid.");
        }
        reader.byteRange(offset, length, kTableAlignment);
        packetRanges.push_back({offset, length});
        streamRecordCounts.push_back(count);
    }
    validateDisjointRanges(std::move(packetRanges));

    uint32_t expectedSpan = 0U;
    uint32_t expectedPick = 0U;
    uint32_t expectedLabel = 0U;
    uint32_t expectedZIndex = 0U;
    std::unordered_set<uint64_t> contributionKeys;
    std::unordered_set<uint32_t> contributionSlots;
    std::unordered_set<uint32_t> activationTokens;
    for (uint32_t index = 0U; index < contributions.second; ++index) {
        auto const descriptor =
            contributions.first + index * kContributionDescriptorBytes;
        auto const contributionKey = reader.get<uint64_t>(descriptor);
        auto const contributionSlot = reader.get<uint32_t>(descriptor + 12U);
        auto const activationToken = reader.get<uint32_t>(descriptor + 16U);
        if (!contributionKeys.insert(contributionKey).second ||
            !contributionSlots.insert(contributionSlot).second ||
            activationToken == 0U ||
            activationToken > kGpuActivationTokenMax ||
            !activationTokens.insert(activationToken).second)
        {
            throw std::invalid_argument(
                "GpuRenderPacket contribution identity, slot, or activation token is invalid.");
        }
        auto const firstSpan = reader.get<uint32_t>(descriptor + 20U);
        auto const spanCount = reader.get<uint32_t>(descriptor + 24U);
        if (firstSpan != expectedSpan ||
            firstSpan > spans.second || spanCount > spans.second - firstSpan)
        {
            throw std::invalid_argument(
                "GpuRenderPacket contribution span range is invalid.");
        }
        expectedSpan += spanCount;
        auto const firstPick = reader.get<uint32_t>(descriptor + 28U);
        auto const pickCount = reader.get<uint32_t>(descriptor + 32U);
        auto const totalPickCount = reader.get<uint32_t>(descriptor + 52U);
        if (firstPick != expectedPick ||
            firstPick > picks.second || pickCount > picks.second - firstPick)
        {
            throw std::invalid_argument(
                "GpuRenderPacket contribution pick range is invalid.");
        }
        expectedPick += pickCount;
        auto const firstLabel = reader.get<uint32_t>(descriptor + 36U);
        auto const labelCount = reader.get<uint32_t>(descriptor + 40U);
        if (firstLabel != expectedLabel ||
            firstLabel > labels.second || labelCount > labels.second - firstLabel)
        {
            throw std::invalid_argument(
                "GpuRenderPacket contribution label range is invalid.");
        }
        expectedLabel += labelCount;
        auto const firstZIndex = reader.get<uint32_t>(descriptor + 44U);
        auto const zIndexCount = reader.get<uint32_t>(descriptor + 48U);
        if (firstZIndex != expectedZIndex ||
            firstZIndex > zIndices.second ||
            zIndexCount > zIndices.second - firstZIndex)
        {
            throw std::invalid_argument(
                "GpuRenderPacket contribution z-index range is invalid.");
        }
        expectedZIndex += zIndexCount;
        uint32_t previousLocalPick = 0U;
        bool hasPreviousLocalPick = false;
        for (uint32_t ordinal = 0U; ordinal < pickCount; ++ordinal) {
            auto const pick = picks.first +
                (firstPick + ordinal) * kPickRecordBytes;
            auto const localPick = reader.get<uint32_t>(pick + 4U);
            if (reader.get<uint32_t>(pick) != index ||
                localPick >= totalPickCount ||
                (hasPreviousLocalPick && localPick <= previousLocalPick))
            {
                throw std::invalid_argument(
                    "GpuRenderPacket pick ownership is not ordered.");
            }
            previousLocalPick = localPick;
            hasPreviousLocalPick = true;
        }
        if (fragmentCount == 1U &&
            (pickCount != totalPickCount ||
             (pickCount > 0U && previousLocalPick + 1U != totalPickCount)))
        {
            throw std::invalid_argument(
                "GpuRenderPacket complete picking metadata is not dense.");
        }
        for (uint32_t ordinal = 0U; ordinal < labelCount; ++ordinal) {
            auto const label = labels.first +
                (firstLabel + ordinal) * kLabelRecordBytes;
            auto const localPick = reader.get<uint32_t>(label + 4U);
            if (reader.get<uint32_t>(label) != index ||
                (localPick != std::numeric_limits<uint32_t>::max() &&
                 localPick >= totalPickCount))
            {
                throw std::invalid_argument(
                    "GpuRenderPacket label ownership is invalid.");
            }
        }
    }
    if (expectedSpan != spans.second || expectedPick != picks.second ||
        expectedLabel != labels.second || expectedZIndex != zIndices.second)
    {
        throw std::invalid_argument(
            "GpuRenderPacket contribution tables are not fully owned.");
    }
    for (uint32_t index = 0U; index < zIndices.second; ++index) {
        auto const offset = zIndices.first + index * kGpuZIndexEntryBytes;
        auto const value = reader.get<double>(offset);
        if (std::isinf(value)) {
            throw std::invalid_argument(
                "GpuRenderPacket z-index metadata is invalid.");
        }
    }

    std::vector<std::vector<std::pair<uint32_t, uint32_t>>> ownedRanges(
        streams.second);
    for (uint32_t index = 0U; index < spans.second; ++index) {
        auto const span = spans.first + index * kContributionSpanBytes;
        if (reader.get<uint32_t>(span + 12U) != 0U) {
            throw std::invalid_argument(
                "GpuRenderPacket span reserved field is nonzero.");
        }
        auto const streamIndex = reader.get<uint32_t>(span);
        if (streamIndex >= streams.second) {
            throw std::invalid_argument(
                "GpuRenderPacket span references an unknown stream.");
        }
        auto const stream =
            streams.first + streamIndex * kStreamDescriptorBytes;
        auto const streamCount = reader.get<uint32_t>(stream + 16U);
        auto const firstRecord = reader.get<uint32_t>(span + 4U);
        auto const recordCount = reader.get<uint32_t>(span + 8U);
        if (recordCount == 0U || firstRecord > streamCount ||
            recordCount > streamCount - firstRecord)
        {
            throw std::invalid_argument(
                "GpuRenderPacket span exceeds its record stream.");
        }
        ownedRanges[streamIndex].emplace_back(firstRecord, recordCount);
    }
    for (uint32_t streamIndex = 0U;
         streamIndex < streams.second;
         ++streamIndex)
    {
        auto& ranges = ownedRanges[streamIndex];
        std::ranges::sort(ranges);
        uint32_t cursor = 0U;
        for (auto const& [first, count] : ranges) {
            if (first != cursor) {
                throw std::invalid_argument(
                    "GpuRenderPacket stream ownership has a gap or overlap.");
            }
            cursor += count;
        }
        if (cursor != streamRecordCounts[streamIndex]) {
            throw std::invalid_argument(
                "GpuRenderPacket stream records are not fully owned.");
        }
    }

    for (uint32_t index = 0U; index < picks.second; ++index) {
        auto const pick = picks.first + index * kPickRecordBytes;
        auto const navigationAltitude = reader.get<float>(pick + 20U);
        if (std::isinf(navigationAltitude)) {
            throw std::invalid_argument(
                "GpuRenderPacket pick navigation altitude is infinite.");
        }
        if (reader.get<uint32_t>(pick) >= contributions.second) {
            throw std::invalid_argument(
                "GpuRenderPacket pick references an unknown contribution.");
        }
    }
    if (members.second != 0U) {
        throw std::invalid_argument(
            "GpuRenderPacket compact picks cannot own member records.");
    }
    for (uint32_t index = 0U; index < labels.second; ++index) {
        auto const label = labels.first + index * kLabelRecordBytes;
        auto const fontWeight = reader.get<uint32_t>(label + 112U);
        auto const collisionPriority = reader.get<int32_t>(label + 116U);
        if (fontWeight == 0U || fontWeight > 1000U ||
            collisionPriority < -1000 || collisionPriority > 1000 ||
            (reader.get<uint32_t>(label + 96U) & ~kKnownLabelFlags) != 0U) {
            throw std::invalid_argument(
                "GpuRenderPacket label metadata is invalid.");
        }
        if (reader.get<uint32_t>(label) >= contributions.second) {
            throw std::invalid_argument(
                "GpuRenderPacket label references an unknown contribution.");
        }
        validateString(
            reader,
            strings.first,
            strings.second,
            reader.get<uint32_t>(label + 32U),
            reader.get<uint32_t>(label + 36U));
        validateString(
            reader,
            strings.first,
            strings.second,
            reader.get<uint32_t>(label + 40U),
            reader.get<uint32_t>(label + 44U));
    }
    for (uint32_t index = 0U; index < resources.second; ++index) {
        auto const resource = resources.first + index * kResourceRequestBytes;
        if (reader.get<uint32_t>(resource + 4U) != 0U ||
            reader.get<uint32_t>(resource + 16U) != 0U ||
            reader.get<uint32_t>(resource + 20U) != 0U) {
            throw std::invalid_argument(
                "GpuRenderPacket resource reserved field is nonzero.");
        }
        validateString(
            reader,
            strings.first,
            strings.second,
            reader.get<uint32_t>(resource + 8U),
            reader.get<uint32_t>(resource + 12U));
    }
    for (uint32_t index = 0U; index < issues.second; ++index) {
        auto const issue = issues.first + index * kRuntimeIssueBytes;
        if (reader.get<uint32_t>(issue) >= contributions.second) {
            throw std::invalid_argument(
                "GpuRenderPacket issue references an unknown contribution.");
        }
        for (uint32_t fieldOffset : {16U, 24U, 32U}) {
            validateString(
                reader,
                strings.first,
                strings.second,
                reader.get<uint32_t>(issue + fieldOffset),
                reader.get<uint32_t>(issue + fieldOffset + 4U));
        }
    }

    return {
        .totalBytes = totalBytes,
        .sceneGeneration = reader.get<uint32_t>(16U),
        .packetSequence = reader.get<uint32_t>(20U),
        .fragmentIndex = fragmentIndex,
        .fragmentCount = fragmentCount,
        .revisionComplete = revisionComplete,
        .streamCount = streams.second,
        .contributionCount = contributions.second,
        .pickCount = picks.second,
        .labelCount = labels.second,
        .zIndexCount = zIndices.second,
    };
}

} // namespace erdblick
