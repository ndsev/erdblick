#pragma once

#include "buffer.h"
#include "mapget/model/featurelayer.h"
#include "mapget/model/featurelayer-filter.h"
#include <nlohmann/json.hpp>
#include <map>
#include <optional>

namespace erdblick
{

/** Browser-owned, transactional file document projected into one mapget object partition. */
class DrawingSource
{
public:
    /** Create a local datasource whose only source representation is GeoJSON. */
    explicit DrawingSource(std::string mapId);
    /** Validate a candidate completely before replacing the accepted source/model. */
    std::string replace(std::string const& source);
    /** Return paged file-order rows, avoiding a full document copy for a virtual list. */
    std::string rows(uint32_t offset, uint32_t count) const;
    /** Return accepted revision, bounds, row count, and source metadata. */
    std::string describe() const;
    /** Return accepted file text, never mapget's GeoJSON export representation. */
    std::string source() const;
    /** Retain session identities and the allocation watermark across a worker restart. */
    std::string checkpoint() const;
    /** Restore accepted text and identities into a fresh owner. */
    std::string restore(std::string const& source, std::string const& checkpoint);
    /** Update a feature property in GeoJSON while retaining native record identities. */
    std::string editDescription(std::string const& id, std::string const& description);
    /** Append a GeoJSON Point feature; clicked altitude defaults to zero meters. */
    std::string append(double longitude, double latitude, std::string const& description);
    /** Replace the joined polygon feature using selected point IDs in file order, or clear it. */
    std::string join(std::string const& ids);
    /** Apply one revision-checked atomic object batch, shared by UI and automation. */
    std::string editObjects(std::string const& request);
    /** Validate/materialize an edit without publishing it; cancellation can discard this candidate. */
    void stage(std::string const& request);
    /** Publish the prepared candidate only if the accepted revision is still its input revision. */
    std::string commitStage();
    /** Release a prepared candidate without changing accepted geometry or identities. */
    void cancelStage();
    /** Read one exact logical feature and its derived metrics without copying the document. */
    std::string object(std::string const& id) const;
    /** Page one semantic JSON branch, retaining exact leaf lexemes and bounded response size. */
    std::string branch(std::string const& request) const;
    /** Export the exact immutable schema used by the model. */
    void schema(SharedUint8Array& out) const;
    /** Export the current append-only field dictionary before dependent model bytes. */
    void dictionary(SharedUint8Array& out) const;
    /** Evaluate trusted browser-generated channels through mapget, including local point groups. */
    void filter(std::string const& request, SharedUint8Array& out) const;
    /** Export a destination-owned snapshot containing only the requested canonical feature IDs. */
    void snapshot(std::string const& ids, SharedUint8Array& out) const;
    /** Expose the accepted model for native integration tests and local consumers. */
    mapget::PartitionFeatureLayer::Ptr model() const { return model_; }

private:
    /** One GeoJSON feature owns its identity, display fields and native geometry projection. */
    struct Row {
        uint64_t id = 0;
        bool generatedJoin = false;
        nlohmann::json value;
        nlohmann::json geometry;
        nlohmann::json feature;
        nlohmann::json properties;
        nlohmann::json decorations;
        nlohmann::json metrics;
        nlohmann::json markerPaths;
        std::string identity;
    };
    /** Unpublished native transaction; accepted filters/reads keep using the previous model. */
    struct Prepared {
        uint32_t revision;
        uint64_t nextId;
        std::string text;
        std::vector<Row> rows;
        mapget::PartitionFeatureLayer::Ptr model;
        std::map<std::string, uint64_t> objects;
        std::map<std::string, std::vector<uint64_t>> previous;
    };
    /** Move a validated transaction into the accepted owner at its single commit point. */
    std::string publish(Prepared candidate);
    /** Adapt standard GeoJSON into inert properties and mapget-supported geometry components. */
    std::vector<Row> parseGeoJson(std::string const& text) const;
    /** Build and commit a candidate, with optional known row identities for structured edits. */
    std::string install(std::string const& text, std::vector<uint64_t> const& identities = {}, bool preservePreviousIds = false);
    /** Materialize sanitized geometry and ordinary property trees in a fresh destination model. */
    mapget::PartitionFeatureLayer::Ptr materialize(std::vector<Row> const& rows, nlohmann::json const& viewport = nullptr) const;
    mapget::DataSourceInfo metadata_;
    std::shared_ptr<mapget::StringPool> strings_;
    mapget::PartitionFeatureLayer::Ptr model_;
    std::vector<Row> rows_;
    std::string source_;
    uint32_t revision_ = 0;
    uint64_t nextId_ = 1;
    std::map<std::string, uint64_t> objectIdentities_;
    std::map<std::string, std::vector<uint64_t>> legacyIdentities_;
    std::optional<Prepared> prepared_;
    bool staging_ = false;
};

nlohmann::json drawingPolygonGeometry(nlohmann::json ring);
/** Rebuild visible interval markers from cached evaluated samples, without parsing or resampling source. */
nlohmann::json drawingMarkerDecorations(nlohmann::json const& paths, nlohmann::json const& author, nlohmann::json const& viewport = nullptr);
nlohmann::json evaluateDrawingShape(nlohmann::json author, nlohmann::json const& ordinary = nullptr);
/** Edit control vertices/curves using the same physical/geodesic interpolation as evaluation. */
nlohmann::json editDrawingControls(nlohmann::json author, nlohmann::json const& operation);
std::string drawingCompose(std::string const& text, bool separate);
std::string drawingEvaluate(std::string const& text);
std::string drawingPlane(std::string const& text);

/** Horizontal WGS84 ellipsoidal distance in meters; boundary arguments are longitude/latitude. */
double drawingDistance(double lon1, double lat1, double lon2, double lat2);

/** Import-only coordinate codec; the returned GeoJSON replaces the coordinate text. */
std::string drawingCoordinatesToGeoJson(std::string const& text);
/** Produce styled GeoJSON geometry and labels for drawing tools and bounded live previews. */
std::string drawingToolGeoJson(std::string const& text, bool preview);
/** Ellipsoidal polygon area (square meters), perimeter, and three-point interior angle. */
std::string drawingMetrics(std::string const& points);
/** Snap the endpoint to the nearest 45-degree geodesic bearing while retaining distance. */
std::string drawingSnap(double lon1, double lat1, double lon2, double lat2);

}
