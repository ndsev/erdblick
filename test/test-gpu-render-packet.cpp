#include "erdblick/gpu-render-packet.h"

#include <catch2/catch_test_macros.hpp>

#include <cstring>
#include <limits>
#include <stdexcept>

namespace
{

template<typename T>
void overwrite(std::vector<std::byte>& bytes, size_t offset, T value)
{
    REQUIRE(offset + sizeof(T) <= bytes.size());
    std::memcpy(bytes.data() + offset, &value, sizeof(T));
}

erdblick::GpuRenderPacketData samplePacket()
{
    using namespace erdblick;
    GpuRenderPacketData packet{
        .sceneGeneration = 7U,
        .packetSequence = 11U,
        .iconCatalogVersion = 3U,
        .origin = {
            .slot = 4U,
            .key = 0x0102030405060708ULL,
            .longitude = 11.5,
            .latitude = 48.1,
            .altitude = 500.0,
        },
    };
    GpuRecordStream stream{
        .kind = GpuPrimitiveKind::Point,
        .flags = 3U,
        .materialKey = 0x77U,
        .recordStride = kGpuPointRecordBytes,
        .renderOrder = 6U,
        .records = std::vector<std::byte>(
            2U * kGpuPointRecordBytes,
            std::byte{0x2a}),
    };
    packet.streams.push_back(std::move(stream));
    packet.contributions.push_back({
        .key = 0x1122334455667788ULL,
        .revision = 9U,
        .slot = 5U,
        .activationToken = 23U,
        .totalPickCount = 1U,
        .spans = {{.streamIndex = 0U, .firstRecord = 0U, .recordCount = 2U}},
        .zIndices = {
            {.value = 65535.0, .tieBreaker = 17U},
            {.value = 65535.0001, .tieBreaker = 23U},
        },
    });
    packet.picks.push_back({
        .contributionIndex = 0U,
        .localPickIndex = 0U,
        .channelOrdinal = 3U,
        .entryOrdinal = 17U,
        .endpointRole = 2U,
        .navigationAltitude = 412.25F,
        .presentationZIndexSlot = 1U,
        .presentationPrimitiveOrder = 2U,
    });
    packet.labels.push_back({
        .contributionIndex = 0U,
        .localPickIndex = 0U,
        .positionWgs84 = {11.5, 48.1, 500.0},
        .text = "Main Street",
        .fontFamily = "Noto Sans",
        .flags = static_cast<uint32_t>(GpuLabelFlag::Collision),
        .minimumLod = 5U,
        .renderOrder = 6U,
        .fontWeight = 700U,
        .collisionPriority = 42,
        .sizeUnit = GpuLabelSizeUnit::Common,
        .wordBreak = GpuLabelWordBreak::BreakAll,
    });
    packet.resourceRequests.push_back({
        .resourceKind = 1U,
        .uri = "https://example.test/icon.png",
    });
    packet.issues.push_back({
        .contributionIndex = 0U,
        .ruleIndex = 2U,
        .occurrenceCount = 4U,
        .property = "color-expression",
        .expression = "missing",
        .message = "Field is missing",
    });
    return packet;
}

} // namespace

TEST_CASE("GpuRenderPacket round-trips its validated header and tables")
{
    auto bytes = erdblick::GpuRenderPacketCodec::encode(samplePacket());
    auto const info = erdblick::GpuRenderPacketCodec::validate(bytes);
    CHECK(info.totalBytes == bytes.size());
    CHECK(info.sceneGeneration == 7U);
    CHECK(info.packetSequence == 11U);
    CHECK(info.streamCount == 1U);
    CHECK(info.contributionCount == 1U);
    CHECK(info.pickCount == 1U);
    CHECK(info.labelCount == 1U);
    CHECK(info.zIndexCount == 2U);
    uint32_t pickTable = 0U;
    std::memcpy(&pickTable, bytes.data() + 96U, sizeof(pickTable));
    float navigationAltitude = 0.0F;
    std::memcpy(
        &navigationAltitude,
        bytes.data() + pickTable + 20U,
        sizeof(navigationAltitude));
    CHECK(navigationAltitude == 412.25F);
    uint32_t presentationZIndexSlot = 0U;
    std::memcpy(
        &presentationZIndexSlot,
        bytes.data() + pickTable + 24U,
        sizeof(presentationZIndexSlot));
    CHECK(presentationZIndexSlot == 1U);
    uint32_t presentationPrimitiveOrder = 0U;
    std::memcpy(
        &presentationPrimitiveOrder,
        bytes.data() + pickTable + 28U,
        sizeof(presentationPrimitiveOrder));
    CHECK(presentationPrimitiveOrder == 2U);
    uint32_t labelTable = 0U;
    std::memcpy(&labelTable, bytes.data() + 112U, sizeof(labelTable));
    uint32_t labelFlags = 0U;
    std::memcpy(
        &labelFlags,
        bytes.data() + labelTable + 96U,
        sizeof(labelFlags));
    CHECK(((labelFlags & erdblick::kGpuLabelMinimumLodMask) >>
        erdblick::kGpuLabelMinimumLodShift) == 5U);
    uint32_t labelOptions = 0U;
    std::memcpy(
        &labelOptions,
        bytes.data() + labelTable + 172U,
        sizeof(labelOptions));
    CHECK((labelOptions & 0xffU) ==
        static_cast<uint32_t>(erdblick::GpuLabelSizeUnit::Common));
    CHECK(((labelOptions >> 8U) & 0xffU) ==
        static_cast<uint32_t>(erdblick::GpuLabelWordBreak::BreakAll));
}

TEST_CASE("GpuRenderPacket rejects malformed wire data before upload")
{
    SECTION("magic") {
        auto bytes = erdblick::GpuRenderPacketCodec::encode(samplePacket());
        overwrite(bytes, 0U, uint32_t{0U});
        CHECK_THROWS_AS(
            erdblick::GpuRenderPacketCodec::validate(bytes),
            std::invalid_argument);
    }
    SECTION("total byte count") {
        auto bytes = erdblick::GpuRenderPacketCodec::encode(samplePacket());
        overwrite(bytes, 8U, uint32_t{12U});
        CHECK_THROWS_AS(
            erdblick::GpuRenderPacketCodec::validate(bytes),
            std::invalid_argument);
    }
    SECTION("reserved header bytes") {
        auto bytes = erdblick::GpuRenderPacketCodec::encode(samplePacket());
        overwrite(bytes, 24U, uint32_t{1U});
        CHECK_THROWS_AS(
            erdblick::GpuRenderPacketCodec::validate(bytes),
            std::invalid_argument);
    }
    SECTION("reserved span bytes") {
        auto bytes = erdblick::GpuRenderPacketCodec::encode(samplePacket());
        uint32_t spanTable = 0U;
        std::memcpy(&spanTable, bytes.data() + 88U, sizeof(spanTable));
        overwrite(bytes, spanTable + 12U, uint32_t{1U});
        CHECK_THROWS_AS(
            erdblick::GpuRenderPacketCodec::validate(bytes),
            std::invalid_argument);
    }
    SECTION("reserved stream bytes") {
        auto bytes = erdblick::GpuRenderPacketCodec::encode(samplePacket());
        uint32_t streamTable = 0U;
        std::memcpy(&streamTable, bytes.data() + 72U, sizeof(streamTable));
        overwrite(bytes, streamTable + 44U, uint32_t{1U});
        CHECK_THROWS_AS(
            erdblick::GpuRenderPacketCodec::validate(bytes),
            std::invalid_argument);
    }
    SECTION("invalid label font weight") {
        auto bytes = erdblick::GpuRenderPacketCodec::encode(samplePacket());
        uint32_t labelTable = 0U;
        std::memcpy(&labelTable, bytes.data() + 112U, sizeof(labelTable));
        overwrite(bytes, labelTable + 112U, uint32_t{0U});
        CHECK_THROWS_AS(
            erdblick::GpuRenderPacketCodec::validate(bytes),
            std::invalid_argument);
    }
    SECTION("invalid label collision priority") {
        auto bytes = erdblick::GpuRenderPacketCodec::encode(samplePacket());
        uint32_t labelTable = 0U;
        std::memcpy(&labelTable, bytes.data() + 112U, sizeof(labelTable));
        overwrite(bytes, labelTable + 116U, int32_t{1001});
        CHECK_THROWS_AS(
            erdblick::GpuRenderPacketCodec::validate(bytes),
            std::invalid_argument);
    }
    SECTION("invalid label TextLayer options") {
        auto bytes = erdblick::GpuRenderPacketCodec::encode(samplePacket());
        uint32_t labelTable = 0U;
        std::memcpy(&labelTable, bytes.data() + 112U, sizeof(labelTable));
        overwrite(bytes, labelTable + 172U, uint32_t{0x00010000U});
        CHECK_THROWS_AS(
            erdblick::GpuRenderPacketCodec::validate(bytes),
            std::invalid_argument);
    }
    SECTION("overlapping packet tables") {
        auto bytes = erdblick::GpuRenderPacketCodec::encode(samplePacket());
        uint32_t contributionTable = 0U;
        std::memcpy(
            &contributionTable,
            bytes.data() + 80U,
            sizeof(contributionTable));
        overwrite(bytes, 88U, contributionTable);
        CHECK_THROWS_AS(
            erdblick::GpuRenderPacketCodec::validate(bytes),
            std::invalid_argument);
    }
    SECTION("stream range") {
        auto bytes = erdblick::GpuRenderPacketCodec::encode(samplePacket());
        uint32_t streamTable = 0U;
        std::memcpy(&streamTable, bytes.data() + 72U, sizeof(streamTable));
        overwrite(bytes, streamTable + 20U, uint32_t{0xfffffff8U});
        CHECK_THROWS(
            erdblick::GpuRenderPacketCodec::validate(bytes));
    }
    SECTION("string range") {
        auto bytes = erdblick::GpuRenderPacketCodec::encode(samplePacket());
        uint32_t labelTable = 0U;
        std::memcpy(&labelTable, bytes.data() + 112U, sizeof(labelTable));
        overwrite(bytes, labelTable + 32U, uint32_t{0xffffffffU});
        CHECK_THROWS_AS(
            erdblick::GpuRenderPacketCodec::validate(bytes),
            std::invalid_argument);
    }
    SECTION("infinite pick navigation altitude") {
        auto bytes = erdblick::GpuRenderPacketCodec::encode(samplePacket());
        uint32_t pickTable = 0U;
        std::memcpy(&pickTable, bytes.data() + 96U, sizeof(pickTable));
        overwrite(
            bytes,
            pickTable + 20U,
            std::numeric_limits<float>::infinity());
        CHECK_THROWS_AS(
            erdblick::GpuRenderPacketCodec::validate(bytes),
            std::invalid_argument);
    }
    SECTION("invalid pick presentation order") {
        auto bytes = erdblick::GpuRenderPacketCodec::encode(samplePacket());
        uint32_t pickTable = 0U;
        std::memcpy(&pickTable, bytes.data() + 96U, sizeof(pickTable));
        overwrite(bytes, pickTable + 28U, uint32_t{6U});
        CHECK_THROWS_AS(
            erdblick::GpuRenderPacketCodec::validate(bytes),
            std::invalid_argument);
    }
}

TEST_CASE("GpuRenderPacket rejects invalid logical references while encoding")
{
    SECTION("invalid stream stride") {
        auto packet = samplePacket();
        packet.streams.front().recordStride = 7U;
        CHECK_THROWS_AS(
            erdblick::GpuRenderPacketCodec::encode(packet),
            std::invalid_argument);
    }
    SECTION("surface shading on a non-surface stream") {
        auto packet = samplePacket();
        packet.streams.front().flags |= static_cast<uint16_t>(
            erdblick::GpuMaterialFlag::SurfaceShading);
        CHECK_THROWS_AS(
            erdblick::GpuRenderPacketCodec::encode(packet),
            std::invalid_argument);
    }
    SECTION("invalid contribution span") {
        auto packet = samplePacket();
        packet.contributions.front().spans.front().recordCount = 3U;
        CHECK_THROWS_AS(
            erdblick::GpuRenderPacketCodec::encode(packet),
            std::invalid_argument);
    }
    SECTION("invalid contribution index") {
        auto packet = samplePacket();
        packet.picks.front().contributionIndex = 3U;
        CHECK_THROWS_AS(
            erdblick::GpuRenderPacketCodec::encode(packet),
            std::invalid_argument);
    }
    SECTION("invalid pick presentation z-index slot") {
        auto packet = samplePacket();
        packet.picks.front().presentationZIndexSlot = 2U;
        CHECK_THROWS_AS(
            erdblick::GpuRenderPacketCodec::encode(packet),
            std::invalid_argument);
    }
    SECTION("unowned stream record") {
        auto packet = samplePacket();
        packet.contributions.front().spans.front().recordCount = 1U;
        CHECK_THROWS_AS(
            erdblick::GpuRenderPacketCodec::encode(packet),
            std::invalid_argument);
    }
    SECTION("overlapping stream ownership") {
        auto packet = samplePacket();
        packet.contributions.front().spans.front().recordCount = 2U;
        packet.contributions.push_back({
            .key = 0x22U,
            .revision = 1U,
            .slot = 6U,
            .activationToken = 24U,
            .spans = {{.streamIndex = 0U, .firstRecord = 1U, .recordCount = 1U}},
        });
        CHECK_THROWS_AS(
            erdblick::GpuRenderPacketCodec::encode(packet),
            std::invalid_argument);
    }
    SECTION("non-dense local pick index") {
        auto packet = samplePacket();
        packet.picks.front().localPickIndex = 1U;
        CHECK_THROWS_AS(
            erdblick::GpuRenderPacketCodec::encode(packet),
            std::invalid_argument);
    }
    SECTION("infinite z-index") {
        auto packet = samplePacket();
        packet.contributions.front().zIndices = {
            {
                .value = std::numeric_limits<double>::infinity(),
                .tieBreaker = 1U,
            },
        };
        CHECK_THROWS_AS(
            erdblick::GpuRenderPacketCodec::encode(packet),
            std::invalid_argument);
    }
    SECTION("duplicate contribution identity") {
        auto packet = samplePacket();
        packet.contributions.push_back(packet.contributions.front());
        packet.contributions.back().spans.clear();
        CHECK_THROWS_AS(
            erdblick::GpuRenderPacketCodec::encode(packet),
            std::invalid_argument);
    }
}

TEST_CASE("GpuRenderPacket fails visibly before one frame upload becomes unbounded")
{
    auto packet = samplePacket();
    packet.streams.front().records.resize(
        erdblick::kGpuRenderPacketMaxBytes,
        std::byte{0x2a});
    packet.contributions.front().spans.front().recordCount =
        static_cast<uint32_t>(packet.streams.front().records.size() /
            packet.streams.front().recordStride);
    packet.streams.front().records.resize(
        static_cast<size_t>(
            packet.contributions.front().spans.front().recordCount) *
        packet.streams.front().recordStride);

    CHECK(
        erdblick::GpuRenderPacketCodec::encodedSize(packet) >
        erdblick::kGpuRenderPacketMaxBytes);
    CHECK_THROWS_AS(
        erdblick::GpuRenderPacketCodec::encode(packet),
        std::length_error);
}

TEST_CASE("GpuRenderPacket size calculation matches its encoded representation")
{
    auto packet = samplePacket();
    auto const bytes = erdblick::GpuRenderPacketCodec::encode(packet);
    CHECK(erdblick::GpuRenderPacketCodec::encodedSize(packet) == bytes.size());
}

TEST_CASE("GpuRenderPacket rejects corrupted ownership tables on decode")
{
    SECTION("stream records are orphaned") {
        auto bytes = erdblick::GpuRenderPacketCodec::encode(samplePacket());
        uint32_t spanTable = 0U;
        std::memcpy(&spanTable, bytes.data() + 88U, sizeof(spanTable));
        overwrite(bytes, spanTable + 8U, uint32_t{1U});
        CHECK_THROWS_AS(
            erdblick::GpuRenderPacketCodec::validate(bytes),
            std::invalid_argument);
    }
    SECTION("pick index is not owner-local") {
        auto bytes = erdblick::GpuRenderPacketCodec::encode(samplePacket());
        uint32_t pickTable = 0U;
        std::memcpy(&pickTable, bytes.data() + 96U, sizeof(pickTable));
        overwrite(bytes, pickTable + 4U, uint32_t{1U});
        CHECK_THROWS_AS(
            erdblick::GpuRenderPacketCodec::validate(bytes),
            std::invalid_argument);
    }
}
