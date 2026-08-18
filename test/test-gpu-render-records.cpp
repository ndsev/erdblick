#include "erdblick/gpu-render-records.h"

#include <catch2/catch_test_macros.hpp>

#include <cstring>
#include <limits>

namespace
{

template<typename T>
T read(std::vector<std::byte> const& bytes, size_t offset)
{
    REQUIRE(offset + sizeof(T) <= bytes.size());
    T result{};
    std::memcpy(&result, bytes.data() + offset, sizeof(T));
    return result;
}

erdblick::GpuRecordStyle style(
    uint32_t pick = 0U,
    uint32_t renderOrder = 5U,
    uint32_t depthTieKey = 0U)
{
    return {
        .color = {10U, 20U, 30U, 255U},
        .glowColor = {255U, 200U, 100U, 128U},
        .glowRadius = 3.0F,
        .zIndex = 12.0,
        .depthTieKey = depthTieKey,
        .localPickIndex = pick,
        .renderOrder = renderOrder,
    };
}

TEST_CASE("GpuRenderPacketBuilder bounds depth-tie metadata to GPU buckets")
{
    using namespace erdblick;
    GpuRenderPacketBuilder builder;
    builder.configure(1U, 1U, 0U, {});
    builder.beginContribution(1U, 1U, 0U, 1U);
    for (uint32_t tieKey = 0U;
         tieKey < kGpuDepthTieBucketCount * 4U;
         ++tieKey)
    {
        builder.appendPoint({
            .position = {static_cast<double>(tieKey), 0.0, 0.0},
            .radius = 1.0F,
            .style = style(0U, 5U, tieKey),
        }, false, false);
    }
    builder.endContribution();

    auto const info = GpuRenderPacketCodec::validate(builder.build());
    CHECK(info.zIndexCount == kGpuDepthTieBucketCount);
}

} // namespace

TEST_CASE("GpuRenderPacketBuilder emits final primitive records and ownership spans")
{
    using namespace erdblick;
    GpuRenderPacketBuilder builder;
    builder.configure(5U, 6U, 7U, {
        .slot = 8U,
        .key = 9U,
        .longitude = 11.0,
        .latitude = 48.0,
        .altitude = 400.0,
    });
    builder.beginContribution(100U, 2U, 3U, 17U);
    builder.appendPoint({
        .position = {1.0, 2.0, 3.0},
        .radius = 4.0F,
        .style = style(),
    }, true, false);
    std::array<mapget::Point, 3> const path{{
        {0.0, 0.0, 0.0},
        {5.0, 0.0, 0.0},
        {5.0, 5.0, 0.0},
    }};
    std::array<float, 3> const offsets{2.0F, 2.0F, 2.0F};
    static_cast<void>(builder.appendPath({
        .points = path,
        .lateralOffsetsPx = offsets,
        .width = 5.0F,
        .dashLength = 2.0F,
        .dashGap = 2.0F,
        .dashUnitsMeters = true,
        .forwardArrow = true,
        .backwardArrow = true,
        .style = style(),
    }, true, true));
    std::array<mapget::Point, 8> const polygon{{
        {0.0, 0.0, 0.0}, {10.0, 0.0, 0.0},
        {10.0, 10.0, 0.0}, {0.0, 10.0, 0.0},
        {2.0, 2.0, 0.0}, {2.0, 8.0, 0.0},
        {8.0, 8.0, 0.0}, {8.0, 2.0, 0.0},
    }};
    std::array<uint32_t, 2> const rings{0U, 4U};
    builder.appendSurface(polygon, rings, style(), true);
    builder.endContribution();
    builder.appendPick({
        .contributionIndex = 0U,
        .localPickIndex = 0U,
        .channelOrdinal = 1U,
        .entryOrdinal = 2U,
    });

    auto const bytes = builder.build();
    auto const info = GpuRenderPacketCodec::validate(bytes);
    CHECK(info.sceneGeneration == 5U);
    CHECK(info.contributionCount == 1U);
    CHECK(info.streamCount == 4U);

    auto const streamTable = read<uint32_t>(bytes, 72U);
    auto const streamCount = read<uint32_t>(bytes, 76U);
    uint32_t pointCount = 0U;
    uint32_t pathCount = 0U;
    uint32_t arrowCount = 0U;
    uint32_t triangleCount = 0U;
    uint32_t pathDataOffset = 0U;
    uint32_t arrowDataOffset = 0U;
    for (uint32_t index = 0U; index < streamCount; ++index) {
        auto const descriptor = streamTable + index * 48U;
        auto const kind = read<uint16_t>(bytes, descriptor);
        auto const count = read<uint32_t>(bytes, descriptor + 16U);
        CHECK(read<uint32_t>(bytes, descriptor + 40U) == 5U);
        CHECK(read<uint32_t>(bytes, descriptor + 44U) == 0U);
        if (kind == static_cast<uint16_t>(GpuPrimitiveKind::Point)) {
            pointCount = count;
        } else if (kind == static_cast<uint16_t>(GpuPrimitiveKind::PathSegment)) {
            pathCount = count;
            pathDataOffset = read<uint32_t>(bytes, descriptor + 20U);
        } else if (kind == static_cast<uint16_t>(GpuPrimitiveKind::Arrow)) {
            arrowCount = count;
            arrowDataOffset = read<uint32_t>(bytes, descriptor + 20U);
        } else if (kind == static_cast<uint16_t>(GpuPrimitiveKind::SurfaceTriangle)) {
            triangleCount = count;
        }
    }
    CHECK(pointCount == 1U);
    CHECK(pathCount == 2U);
    CHECK(arrowCount == 2U);
    CHECK(triangleCount > 0U);

    auto const firstFlags = read<uint32_t>(bytes, pathDataOffset + 144U);
    auto const secondFlags = read<uint32_t>(
        bytes,
        pathDataOffset + kGpuPathSegmentRecordBytes + 144U);
    CHECK((firstFlags & static_cast<uint32_t>(GpuPathRecordFlag::TrimStart)) != 0U);
    CHECK((secondFlags & static_cast<uint32_t>(GpuPathRecordFlag::TrimEnd)) != 0U);
    CHECK((firstFlags & static_cast<uint32_t>(GpuPathRecordFlag::DashMeters)) != 0U);
    CHECK((secondFlags & static_cast<uint32_t>(GpuPathRecordFlag::DashMeters)) != 0U);
    CHECK((firstFlags >> 8U) == 17U);
    CHECK((secondFlags >> 8U) == 17U);
    CHECK(read<float>(bytes, pathDataOffset + 112U) > 0.0F);
    CHECK(read<float>(
        bytes,
        pathDataOffset + kGpuPathSegmentRecordBytes + 116U) > 0.0F);
    CHECK(read<float>(bytes, pathDataOffset + 120U) == 0.0F);
    CHECK(read<float>(
        bytes,
        pathDataOffset + kGpuPathSegmentRecordBytes + 120U) == 1.0F);
    CHECK(read<float>(bytes, arrowDataOffset + 32U) == 2.0F);
    CHECK(read<float>(
        bytes,
        arrowDataOffset + kGpuArrowRecordBytes + 32U) == -2.0F);
    auto const contributionTable = read<uint32_t>(bytes, 80U);
    auto const zIndexTable = read<uint32_t>(bytes, 152U);
    CHECK(read<uint32_t>(bytes, contributionTable + 48U) == 1U);
    CHECK(read<double>(bytes, zIndexTable) == 12.0);
    CHECK(read<uint32_t>(bytes, pathDataOffset + 120U) == 0U);
}

TEST_CASE("GpuRenderPacketBuilder separates concrete authored rule orders")
{
    using namespace erdblick;
    GpuRenderPacketBuilder builder;
    builder.configure(1U, 1U, 0U, {});
    builder.beginContribution(1U, 1U, 0U, 1U);
    builder.appendPoint({
        .position = {0.0, 0.0, 0.0},
        .radius = 1.0F,
        .style = style(0U, 8U),
    }, false, false);
    builder.appendPoint({
        .position = {1.0, 0.0, 0.0},
        .radius = 1.0F,
        .style = style(1U, 2U),
    }, false, false);
    builder.endContribution();

    auto const bytes = builder.build();
    auto const streamTable = read<uint32_t>(bytes, 72U);
    REQUIRE(read<uint32_t>(bytes, 76U) == 2U);
    auto const firstOrder = read<uint32_t>(bytes, streamTable + 40U);
    auto const secondOrder = read<uint32_t>(bytes, streamTable + 48U + 40U);
    CHECK(((firstOrder == 2U && secondOrder == 8U) ||
        (firstOrder == 8U && secondOrder == 2U)));
}

TEST_CASE("GpuRenderPacketBuilder compacts ordinary path records")
{
    using namespace erdblick;
    GpuRenderPacketBuilder builder;
    builder.configure(1U, 1U, 0U, {});
    builder.beginContribution(1U, 1U, 3U, 7U);
    std::array<mapget::Point, 3> const path{{
        {1.0, 2.0, 3.0},
        {4.0, 5.0, 6.0},
        {7.0, 8.0, 9.0},
    }};
    static_cast<void>(builder.appendPath({
        .points = path,
        .width = 4.0F,
        .style = style(11U),
    }, false, true));
    builder.endContribution();

    auto const bytes = builder.build();
    static_cast<void>(GpuRenderPacketCodec::validate(bytes));
    auto const streamTable = read<uint32_t>(bytes, 72U);
    REQUIRE(read<uint32_t>(bytes, 76U) == 1U);
    CHECK(read<uint16_t>(bytes, streamTable) ==
        static_cast<uint16_t>(GpuPrimitiveKind::PathSegment));
    auto const flags = read<uint16_t>(bytes, streamTable + 2U);
    CHECK((flags & static_cast<uint16_t>(GpuMaterialFlag::CompactPath)) != 0U);
    CHECK(read<uint32_t>(bytes, streamTable + 12U) ==
        kGpuCompactPathSegmentRecordBytes);
    CHECK(read<uint32_t>(bytes, streamTable + 16U) == 2U);
    auto const records = read<uint32_t>(bytes, streamTable + 20U);
    CHECK(read<float>(bytes, records + 48U) == 4.0F);
    CHECK(read<uint32_t>(bytes, records + 68U) == 11U);
    auto const firstWord = read<uint32_t>(bytes, records + 72U);
    auto const secondWord = read<uint32_t>(
        bytes,
        records + kGpuCompactPathSegmentRecordBytes + 72U);
    CHECK((firstWord & static_cast<uint32_t>(GpuPathRecordFlag::StartCap)) != 0U);
    CHECK((secondWord & static_cast<uint32_t>(GpuPathRecordFlag::EndCap)) != 0U);
    CHECK((firstWord >> 8U) == 7U);
    CHECK((secondWord >> 8U) == 7U);
}

TEST_CASE("GpuRenderPacketBuilder removes duplicate adjacency from two-point paths")
{
    using namespace erdblick;
    GpuRenderPacketBuilder builder;
    builder.configure(1U, 1U, 0U, {});
    builder.beginContribution(1U, 1U, 3U, 7U);
    std::array<mapget::Point, 2> const path{{
        {1.0, 2.0, 3.0},
        {4.0, 5.0, 6.0},
    }};
    static_cast<void>(builder.appendPath({
        .points = path,
        .width = 4.0F,
        .style = style(11U),
    }, false, true));
    builder.endContribution();

    auto const bytes = builder.build();
    static_cast<void>(GpuRenderPacketCodec::validate(bytes));
    auto const streamTable = read<uint32_t>(bytes, 72U);
    REQUIRE(read<uint32_t>(bytes, 76U) == 1U);
    auto const flags = read<uint16_t>(bytes, streamTable + 2U);
    CHECK((flags & static_cast<uint16_t>(GpuMaterialFlag::SimplePath)) != 0U);
    CHECK((flags & static_cast<uint16_t>(GpuMaterialFlag::CompactPath)) == 0U);
    CHECK(read<uint32_t>(bytes, streamTable + 12U) ==
        kGpuSimplePathSegmentRecordBytes);
    CHECK(read<uint32_t>(bytes, streamTable + 16U) == 1U);
    auto const records = read<uint32_t>(bytes, streamTable + 20U);
    CHECK(read<float>(bytes, records) == 1.0F);
    CHECK(read<float>(bytes, records + 12U) == 4.0F);
    CHECK(read<float>(bytes, records + 24U) == 4.0F);
    CHECK(read<uint32_t>(bytes, records + 44U) == 11U);
    auto const recordWord = read<uint32_t>(bytes, records + 48U);
    CHECK((recordWord & static_cast<uint32_t>(GpuPathRecordFlag::StartCap)) != 0U);
    CHECK((recordWord & static_cast<uint32_t>(GpuPathRecordFlag::EndCap)) != 0U);
    CHECK((recordWord >> 8U) == 7U);
}

TEST_CASE("GpuRenderPacketBuilder packs dual strokes beside compact path records")
{
    using namespace erdblick;
    auto render = [](std::span<mapget::Point const> path) {
        GpuRenderPacketBuilder builder;
        builder.configure(1U, 1U, 0U, {});
        builder.beginContribution(1U, 1U, 3U, 7U);
        static_cast<void>(builder.appendPath({
            .points = path,
            .width = 8.0F,
            .overlay = GpuPathOverlay{
                .width = 4.0F,
                .color = {90U, 100U, 110U, 255U},
            },
            .style = style(11U),
        }, false, true));
        builder.endContribution();
        return builder.build();
    };

    SECTION("two-point path") {
        std::array<mapget::Point, 2> const path{{
            {1.0, 2.0, 3.0},
            {4.0, 5.0, 6.0},
        }};
        auto const bytes = render(path);
        static_cast<void>(GpuRenderPacketCodec::validate(bytes));
        auto const stream = read<uint32_t>(bytes, 72U);
        auto const flags = read<uint16_t>(bytes, stream + 2U);
        CHECK((flags & static_cast<uint16_t>(
            GpuMaterialFlag::SimplePath)) != 0U);
        CHECK((flags & static_cast<uint16_t>(
            GpuMaterialFlag::DualStrokePath)) != 0U);
        CHECK(read<uint32_t>(bytes, stream + 12U) ==
            kGpuDualSimplePathSegmentRecordBytes);
        auto const record = read<uint32_t>(bytes, stream + 20U);
        CHECK(read<float>(bytes, record + 24U) == 8.0F);
        CHECK(read<float>(bytes, record + 52U) == 4.0F);
        CHECK(read<uint8_t>(bytes, record + 56U) == 90U);
        CHECK(read<uint8_t>(bytes, record + 59U) == 255U);
    }

    SECTION("multi-segment path") {
        std::array<mapget::Point, 3> const path{{
            {1.0, 2.0, 3.0},
            {4.0, 5.0, 6.0},
            {7.0, 8.0, 9.0},
        }};
        auto const bytes = render(path);
        static_cast<void>(GpuRenderPacketCodec::validate(bytes));
        auto const stream = read<uint32_t>(bytes, 72U);
        auto const flags = read<uint16_t>(bytes, stream + 2U);
        CHECK((flags & static_cast<uint16_t>(
            GpuMaterialFlag::CompactPath)) != 0U);
        CHECK((flags & static_cast<uint16_t>(
            GpuMaterialFlag::DualStrokePath)) != 0U);
        CHECK(read<uint32_t>(bytes, stream + 12U) ==
            kGpuDualCompactPathSegmentRecordBytes);
        CHECK(read<uint32_t>(bytes, stream + 16U) == 2U);
        auto const records = read<uint32_t>(bytes, stream + 20U);
        CHECK(read<float>(bytes, records + 48U) == 8.0F);
        CHECK(read<float>(bytes, records + 76U) == 4.0F);
        CHECK(read<uint8_t>(bytes, records + 80U) == 90U);
        CHECK(read<uint8_t>(
            bytes,
            records + kGpuDualCompactPathSegmentRecordBytes + 83U) == 255U);
    }
}

TEST_CASE("GpuRenderPacketBuilder triangulates winding, holes, and vertical surfaces")
{
    using namespace erdblick;
    auto render = [](std::span<mapget::Point const> points,
                     std::span<uint32_t const> rings) {
        GpuRenderPacketBuilder builder;
        builder.configure(1U, 1U, 0U, {});
        builder.beginContribution(1U, 1U, 0U, 1U);
        builder.appendSurface(points, rings, style(), true);
        builder.endContribution();
        return builder.build();
    };
    auto surfaceArea = [](std::vector<std::byte> const& bytes,
                          uint32_t xAxis,
                          uint32_t yAxis) {
        auto const streamTable = read<uint32_t>(bytes, 72U);
        auto const streamCount = read<uint32_t>(bytes, 76U);
        double area = 0.0;
        uint32_t triangleCount = 0U;
        for (uint32_t streamIndex = 0U;
             streamIndex < streamCount;
             ++streamIndex)
        {
            auto const descriptor = streamTable + streamIndex * 48U;
            if (read<uint16_t>(bytes, descriptor) !=
                static_cast<uint16_t>(GpuPrimitiveKind::SurfaceTriangle))
            {
                continue;
            }
            auto const stride = read<uint32_t>(bytes, descriptor + 12U);
            auto const count = read<uint32_t>(bytes, descriptor + 16U);
            auto const data = read<uint32_t>(bytes, descriptor + 20U);
            triangleCount += count;
            for (uint32_t triangle = 0U; triangle < count; ++triangle) {
                auto coordinate = [&](uint32_t vertex, uint32_t axis) {
                    return read<float>(
                        bytes,
                        data + triangle * stride + vertex * 12U + axis * 4U);
                };
                auto const x0 = coordinate(0U, xAxis);
                auto const y0 = coordinate(0U, yAxis);
                auto const x1 = coordinate(1U, xAxis);
                auto const y1 = coordinate(1U, yAxis);
                auto const x2 = coordinate(2U, xAxis);
                auto const y2 = coordinate(2U, yAxis);
                area += std::abs(
                    (x1 - x0) * (y2 - y0) -
                    (x2 - x0) * (y1 - y0)) * 0.5;
            }
        }
        return std::pair{triangleCount, area};
    };

    SECTION("clockwise outer ring with a hole") {
        std::array<mapget::Point, 8> const polygon{{
            {0.0, 0.0, 0.0}, {0.0, 10.0, 0.0},
            {10.0, 10.0, 0.0}, {10.0, 0.0, 0.0},
            {2.0, 2.0, 0.0}, {8.0, 2.0, 0.0},
            {8.0, 8.0, 0.0}, {2.0, 8.0, 0.0},
        }};
        std::array<uint32_t, 2> const rings{0U, 4U};
        auto const [triangleCount, area] = surfaceArea(
            render(polygon, rings),
            0U,
            1U);
        CHECK(triangleCount == 8U);
        CHECK(area == 64.0);
    }

    SECTION("vertical XZ surface") {
        std::array<mapget::Point, 4> const polygon{{
            {0.0, 5.0, 0.0}, {0.0, 5.0, 10.0},
            {10.0, 5.0, 10.0}, {10.0, 5.0, 0.0},
        }};
        auto const [triangleCount, area] = surfaceArea(
            render(polygon, {}),
            0U,
            2U);
        CHECK(triangleCount == 2U);
        CHECK(area == 100.0);
    }
}

TEST_CASE("GpuRenderPacketBuilder keeps same-material contributions independently replaceable")
{
    using namespace erdblick;
    GpuRenderPacketBuilder builder;
    builder.configure(1U, 1U, 0U, {});
    for (uint32_t contribution = 0U; contribution < 2U; ++contribution) {
        builder.beginContribution(
            100U + contribution,
            1U,
            10U + contribution,
            20U + contribution);
        builder.appendPoint({
            .position = {static_cast<double>(contribution), 0.0, 0.0},
            .radius = 1.0F,
            .style = style(contribution),
        }, false, true);
        builder.endContribution();
        builder.appendPick({
            .contributionIndex = contribution,
            .localPickIndex = 0U,
            .channelOrdinal = contribution,
            .entryOrdinal = contribution + 1U,
        });
    }
    auto const bytes = builder.build();
    auto const streamTable = read<uint32_t>(bytes, 72U);
    CHECK(read<uint32_t>(bytes, 76U) == 1U);
    CHECK(read<uint32_t>(bytes, streamTable + 16U) == 2U);

    auto const contributionTable = read<uint32_t>(bytes, 80U);
    auto const spanTable = read<uint32_t>(bytes, 88U);
    CHECK(read<uint32_t>(bytes, contributionTable + 20U) == 0U);
    CHECK(read<uint32_t>(bytes, contributionTable + 24U) == 1U);
    CHECK(read<uint32_t>(bytes, contributionTable + 56U + 20U) == 1U);
    CHECK(read<uint32_t>(bytes, contributionTable + 56U + 24U) == 1U);
    CHECK(read<uint32_t>(bytes, spanTable + 4U) == 0U);
    CHECK(read<uint32_t>(bytes, spanTable + 8U) == 1U);
    CHECK(read<uint32_t>(bytes, spanTable + 16U + 4U) == 1U);
    CHECK(read<uint32_t>(bytes, spanTable + 16U + 8U) == 1U);
}

TEST_CASE("GpuRenderPacketBuilder reset reuses streams without retaining packet data")
{
    using namespace erdblick;
    GpuRenderPacketBuilder builder;
    auto emit = [&](uint32_t generation, uint64_t contributionKey) {
        builder.configure(generation, generation + 1U, 0U, {});
        builder.beginContribution(contributionKey, generation, 0U, 1U);
        builder.appendPoint({
            .position = {static_cast<double>(generation), 2.0, 3.0},
            .radius = 4.0F,
            .style = style(),
        }, true, false);
        builder.endContribution();
        builder.appendPick({
            .contributionIndex = 0U,
            .localPickIndex = 0U,
            .channelOrdinal = generation,
            .entryOrdinal = generation + 1U,
        });
        return builder.build();
    };

    auto const first = emit(3U, 100U);
    CHECK(GpuRenderPacketCodec::validate(first).sceneGeneration == 3U);

    builder.reset();
    auto const second = emit(7U, 200U);
    auto const info = GpuRenderPacketCodec::validate(second);
    CHECK(info.sceneGeneration == 7U);
    CHECK(info.contributionCount == 1U);
    CHECK(info.pickCount == 1U);
    CHECK(read<uint32_t>(second, 76U) == 1U);
    auto const streamTable = read<uint32_t>(second, 72U);
    CHECK(read<uint32_t>(second, streamTable + 16U) == 1U);
}

TEST_CASE("GpuRenderPacketBuilder bounds and orders oversized packet fragments")
{
    using namespace erdblick;
    GpuRenderPacketBuilder builder;
    builder.configure(5U, 6U, 7U, {
        .slot = 8U,
        .key = 9U,
        .longitude = 11.0,
        .latitude = 48.0,
        .altitude = 400.0,
    });
    builder.beginContribution(100U, 2U, 3U, 17U);
    constexpr uint32_t kPointCount = 600'000U;
    auto pointStyle = style(std::numeric_limits<uint32_t>::max());
    for (uint32_t index = 0U; index < kPointCount; ++index) {
        builder.appendPoint({
            .position = {static_cast<double>(index), 2.0, 3.0},
            .radius = 4.0F,
            .style = pointStyle,
        }, true, false);
    }
    builder.endContribution();

    CHECK_THROWS_AS(builder.build(), std::length_error);
    auto const fragments = builder.buildFragments();
    REQUIRE(fragments.size() >= 6U);
    REQUIRE(fragments.size() <= kGpuRenderPacketMaxFragments);

    uint32_t encodedPointCount = 0U;
    for (uint32_t fragmentIndex = 0U;
         fragmentIndex < fragments.size();
         ++fragmentIndex)
    {
        auto const& bytes = fragments[fragmentIndex];
        CHECK(bytes.size() <= kGpuRenderPacketMaxBytes);
        auto const info = GpuRenderPacketCodec::validate(bytes);
        CHECK(info.fragmentIndex == fragmentIndex);
        CHECK(info.fragmentCount == fragments.size());
        CHECK(info.revisionComplete ==
            (fragmentIndex + 1U == fragments.size()));
        auto const streamTable = read<uint32_t>(bytes, 72U);
        auto const streamCount = read<uint32_t>(bytes, 76U);
        for (uint32_t streamIndex = 0U;
             streamIndex < streamCount;
             ++streamIndex)
        {
            auto const descriptor = streamTable + streamIndex * 48U;
            if (read<uint16_t>(bytes, descriptor) ==
                static_cast<uint16_t>(GpuPrimitiveKind::Point))
            {
                encodedPointCount += read<uint32_t>(bytes, descriptor + 16U);
            }
        }
    }
    CHECK(encodedPointCount == kPointCount);
}
