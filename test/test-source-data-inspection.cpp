#include <catch2/catch_test_macros.hpp>

#include "erdblick/layer.h"
#include "mapget/model/info.h"
#include "mapget/model/sourcedata.h"
#include "mapget/model/sourcedatalayer.h"
#include "mapget/model/stringpool.h"
#include "nlohmann/json.hpp"

TEST_CASE(
    "SourceData inspection reuses propagated feature summaries",
    "[erdblick.inspection][sourcedata]")
{
    auto layerInfo = mapget::LayerInfo::fromJson(nlohmann::json::parse(R"json(
        {
            "layerId": "SourceData-Test",
            "type": "SourceData"
        }
    )json"));
    auto strings = std::make_shared<mapget::StringPool>("SourceDataInspection");
    auto model = std::make_shared<mapget::TileSourceDataLayer>(
        mapget::TileId{},
        "SourceDataInspection",
        "TestMap",
        layerInfo,
        strings);

    auto root = model->newCompound(2);
    root->setSchemaName("Example.Root");
    root->setSourceDataAddress({0, 64});
    auto details = model->newCompound(2);
    details->setSchemaName("Example.Details");
    details->setSourceDataAddress({8, 32});
    REQUIRE(details->object()->addField("speed", int64_t{50}));
    REQUIRE(details->object()->addBool("enabled", true));
    REQUIRE(root->object()->addField("details", details));
    model->addRoot(root);

    auto result = erdblick::TileSourceDataLayer(model).toObject();
    REQUIRE(result.value("schemaType", std::string{}) == "Example.Root");
    REQUIRE(result.contains("children"));
    REQUIRE(result.at("children").size() == 1);

    auto const& detailsNode = result.at("children").front();
    REQUIRE(detailsNode.value("schemaType", std::string{}) == "Example.Details");
    REQUIRE(detailsNode.contains("valueBubbles"));
    REQUIRE(detailsNode.at("valueBubbles").size() == 2);
    REQUIRE(detailsNode.at("children").at(0).value("nodeId", std::string{}) ==
            "0:details/0:speed");
}
