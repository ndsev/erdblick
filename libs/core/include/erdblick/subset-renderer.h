#pragma once

#include "layer.h"
#include "style.h"
#include "gpu-render-records.h"

#include <cstdint>
#include <functional>
#include <limits>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace erdblick
{

/**
 * Persistent-GPU packet renderer for immutable, server-evaluated TileSubsetLayers.
 *
 * The renderer performs no SIMFIL compilation or full-feature traversal. It
 * binds style expression strings to the projected scalar columns of each
 * channel, applies the remaining client-owned rule-tree semantics, and emits
 * renderer-local picking references.
 */
class TileSubsetLayerRenderer
{
public:
    /** Bind one immutable style/fidelity context; geometry arrives separately. */
    TileSubsetLayerRenderer(
        int viewIndex,
        std::string const& mapTileKey,
        FeatureLayerStyle const& style,
        int highlightMode,
        int fidelity);
    /** Release native packet, bridge, and semantic metadata owned by this run. */
    ~TileSubsetLayerRenderer();

    /** Fix the double-precision WGS84 origin used for all local packet records. */
    void setCoordinateOrigin(
        double longitude,
        double latitude,
        double altitude);
    /** Set the world-space error allowed when simplifying plain line paths. */
    void setLineSimplificationTolerance(double toleranceMeters);
    /** Store scene-owned packet slots and sequencing before rendering starts. */
    void configureGpuPacket(
        uint32_t sceneGeneration,
        uint32_t packetSequence,
        uint32_t iconCatalogVersion,
        uint32_t originSlot,
        uint32_t originKeyLow,
        uint32_t originKeyHigh);
    /** Install one immutable browser-atlas entry before packet rendering. */
    void addGpuIconResource(
        std::string const& uri,
        uint32_t atlasPage,
        float u0,
        float v0,
        float u1,
        float v1,
        float pixelWidth,
        float pixelHeight);
    /** Install the single subset with its independently replaceable scene identity. */
    void addTileSubsetContribution(
        TileSubsetLayer const& subset,
        uint32_t contributionKeyLow,
        uint32_t contributionKeyHigh,
        uint32_t contributionRevision,
        uint32_t contributionSlot,
        uint32_t contributionActivationToken);
    /** Evaluate and pack the configured subset exactly once. */
    void run();
    /** Drop all tile-owned state while retaining hot-path storage for reuse. */
    void resetForNextTile();
    /** Return only the browser-owned GLTF bridge data beside the GPU packet. */
    [[nodiscard]] NativeJsValue renderBridgeResult() const;
    /** Build the validated packet bytes for native callers and tests. */
    [[nodiscard]] std::vector<std::byte> renderPacketBytes() const;
    /** Build all bounded packet fragments for native callers and tests. */
    [[nodiscard]] std::vector<std::vector<std::byte>>
    renderPacketFragmentsBytes() const;
    /** Return the complete bounded packet sequence as JavaScript Uint8Arrays. */
    [[nodiscard]] NativeJsValue renderPackets() const;
    /** Return the number of source geometry vertices inspected by this run. */
    [[nodiscard]] uint32_t vertexCount() const;

    /** Temporary styled GLTF node arrays consumed by the browser bridge. */
    struct GltfBuffers {
        std::vector<uint32_t> nodeIndices;
        std::vector<uint8_t> colors;
        std::vector<uint8_t> depthTests;
        std::vector<uint32_t> featureAddresses;
    };

    /** Temporary invisible triangles used to retain exact GLTF drill picking. */
    struct GltfPickProxyBuffers {
        std::vector<float> positions;
        std::vector<uint32_t> startIndices;
        std::vector<uint32_t> nodeIndices;
        std::vector<uint32_t> featureAddresses;
    };

    /** Browser-owned GLTF data which cannot live in the vector packet yet. */
    struct BridgeBuffers {
        GltfBuffers gltfNodes;
        GltfPickProxyBuffers gltfPickProxies;
    };

private:
    /** Projected channel expressions with lazily cached authored-expression bindings. */
    struct ProjectedFields {
        std::vector<std::string> expressions;
        // Rule expression strings have stable addresses for the renderer's
        // lifetime. Binding those objects once avoids hashing long SIMFIL
        // expressions for every emitted feature.
        mutable std::vector<std::pair<std::string const*, uint32_t>> bindings;
    };

    /** Stack-owned state behind allocation-free projected value evaluation. */
    struct ProjectedEvalState {
        TileSubsetLayerRenderer* renderer = nullptr;
        ProjectedFields const* fields = nullptr;
        mapget::model_ptr<mapget::Array> values;
        uint32_t lastIndex = std::numeric_limits<uint32_t>::max();
        simfil::Value lastValue = simfil::Value::undef();
    };

    /** One planned channel's rule and projected scalar-column bindings. */
    struct ChannelBinding {
        std::vector<FeatureStyleRule const*> rules;
        std::vector<uint8_t> fuseWithNext;
        ProjectedFields featureFields;
        ProjectedFields entryFields;
        bool hasBranches = false;
    };

    /** Per-entry projection reused by multiple presentation rules in one channel. */
    struct ProjectedGeometryCacheEntry {
        simfil::ModelNodeAddress address{};
        bool simplified = false;
        std::vector<mapget::Point> points;
    };

    /** Reuses projected-point storage across feature rows without retaining stale entries. */
    struct ProjectedGeometryCache {
        /** Make all entries available for reuse while retaining their point capacities. */
        void reset();
        /** Find an active projection by geometry address. */
        [[nodiscard]] ProjectedGeometryCacheEntry* find(
            simfil::ModelNodeAddress address,
            bool simplified);
        /** Activate one cache entry for a geometry, reusing its point allocation. */
        [[nodiscard]] ProjectedGeometryCacheEntry& append(
            simfil::ModelNodeAddress address,
            bool simplified);

        std::vector<ProjectedGeometryCacheEntry> entries;
        size_t activeCount = 0;
    };

    /** One feature geometry resolved once and reused by all bundled rules. */
    struct ResolvedFeatureGeometry {
        mapget::model_ptr<mapget::Geometry> geometry;
        mapget::GeomType type = mapget::GeomType::Points;
        std::optional<std::string_view> name;
    };

    /** Pre-evaluated path style used when two adjacent strokes share geometry. */
    struct ResolvedGeometryStyle {
        glm::fvec4 color{};
        double zIndex = 0.0;
        float pathWidth = 0.0F;
        FeatureStyleRule::Arrow pathArrow = FeatureStyleRule::NoArrow;
        std::optional<GpuPathOverlay> pathOverlay;
    };

    /** Deduplicated style-evaluation failure transported beside primitive data. */
    struct RuntimeIssue {
        std::string property;
        std::string expression;
        std::string message;
        uint32_t ruleIndex = 0;
        uint64_t occurrenceCount = 1;
    };

    /** Main-thread-assigned ownership fields embedded in every packet record. */
    struct GpuContributionContext {
        uint64_t key = 0U;
        uint32_t revision = 0U;
        uint32_t slot = 0U;
        uint32_t activationToken = 0U;
    };

    /** Stable renderer-local semantic address used to deduplicate pick records. */
    struct PickRef {
        uint32_t channelOrdinal = 0;
        uint32_t entryOrdinal = 0;
        uint32_t endpointRole = 0;

        bool operator==(PickRef const&) const = default;
    };

    /** Hashes one semantic address without depending on native object pointers. */
    struct PickRefHash {
        /** Combine channel, entry, and endpoint ordinals for unordered lookup. */
        size_t operator()(PickRef const& value) const noexcept;
    };

    /** Semantic pick payload resolved into inspection targets by TypeScript. */
    struct PickResult {
        std::string featureId;
        std::optional<uint32_t> attributeIndex;
        std::optional<bool> hasValidity;
        uint32_t validityIndex = 0;
        std::string relationId;
        std::string relationSourceFeatureId;
        std::optional<uint32_t> relationIndex;
        std::vector<std::string> memberFeatureIds;
    };

    /** Paths sharing one adaptive contraction threshold across transition legs. */
    struct TransitionOffsetScaleGroup {
        double scaleThresholdMetersPerPixel = 0.0;
        std::vector<GpuPathRecordHandle> gpuHandles;
    };

    /** Resolve projected feature/entry columns for one server-planned channel. */
    [[nodiscard]] ChannelBinding const& bindingFor(
        mapget::model_ptr<mapget::TileSubsetChannel> const& channel);
    /** Resolve the authored style rules referenced by a planned channel id. */
    [[nodiscard]] std::vector<FeatureStyleRule const*> rulesForChannel(
        std::string const& channelId) const;

    /** Render one feature entry through its planned rule and geometry columns. */
    void renderFeature(
        uint32_t channelOrdinal,
        uint32_t entryOrdinal,
        ChannelBinding const& binding,
        mapget::model_ptr<mapget::FeatureEntry> const& entry);
    /** Emit one concrete feature rule after its branch predicates are resolved. */
    void renderFeatureRule(
        mapget::model_ptr<mapget::FeatureEntry> const& entry,
        mapget::model_ptr<mapget::GeometryCollection> const& geometry,
        std::vector<ResolvedFeatureGeometry> const& geometries,
        FeatureStyleRule const& rule,
        BoundEvalFun const& evalFun,
        mapget::model_ptr<mapget::FeatureId>& featureId,
        std::optional<uint32_t>& selectablePick,
        uint32_t channelOrdinal,
        uint32_t entryOrdinal);
    /** Fuse two compatible feature-line rules into one dual-stroke path record. */
    bool renderFeatureRulePair(
        mapget::model_ptr<mapget::GeometryCollection> const& geometry,
        std::vector<ResolvedFeatureGeometry> const& geometries,
        FeatureStyleRule const& outerRule,
        FeatureStyleRule const& innerRule,
        BoundEvalFun const& evalFun,
        std::optional<uint32_t>& selectablePick,
        uint32_t channelOrdinal,
        uint32_t entryOrdinal);
    /** Test immutable rule properties once before attempting per-feature stroke fusion. */
    [[nodiscard]] static bool canFuseFeatureRulePair(
        FeatureStyleRule const& outerRule,
        FeatureStyleRule const& innerRule);
    /** Render one attribute-validity entry without loading its host feature. */
    void renderAttribute(
        uint32_t channelOrdinal,
        uint32_t entryOrdinal,
        ChannelBinding const& binding,
        mapget::model_ptr<mapget::AttributeValidityEntry> const& entry);
    /** Render one group entry and preserve its member-feature pick semantics. */
    void renderGroup(
        uint32_t channelOrdinal,
        uint32_t entryOrdinal,
        ChannelBinding const& binding,
        mapget::model_ptr<mapget::GroupEntry> const& entry);
    /** Render one relation entry, including independently selectable endpoints. */
    void renderRelation(
        uint32_t channelOrdinal,
        uint32_t entryOrdinal,
        ChannelBinding const& binding,
        mapget::model_ptr<mapget::RelationEntry> const& entry);

    /** Render every geometry in a collection using one evaluated style context. */
    bool renderGeometryCollection(
        mapget::model_ptr<mapget::GeometryCollection> const& geometry,
        FeatureStyleRule const& rule,
        BoundEvalFun const& evalFun,
        uint32_t pickIndex,
        glm::dvec3 const& offset,
        ProjectedGeometryCache* projectionCache = nullptr,
        std::vector<ResolvedFeatureGeometry> const*
            resolvedGeometries = nullptr,
        ResolvedGeometryStyle const* resolvedStyle = nullptr);
    /** Dispatch one geometry by type and optionally emit its label. */
    bool renderGeometry(
        mapget::model_ptr<mapget::Geometry> const& geometry,
        FeatureStyleRule const& rule,
        BoundEvalFun const& evalFun,
        uint32_t pickIndex,
        glm::dvec3 const& offset,
        bool renderLabel = true,
        ProjectedGeometryCache* projectionCache = nullptr,
        std::optional<mapget::GeomType> resolvedType = std::nullopt,
        std::optional<std::string_view> resolvedName = std::nullopt,
        ResolvedGeometryStyle const* resolvedStyle = nullptr);
    /** Render ordinary validity lines with deterministic per-segment stacking. */
    bool renderSegmentStackedLine(
        mapget::model_ptr<mapget::Geometry> const& geometry,
        FeatureStyleRule const& rule,
        BoundEvalFun const& evalFun,
        uint32_t pickIndex,
        std::string const& stackPrefix);
    /** Render transition legs with adaptive offset contraction and continuity. */
    bool renderTransitionLine(
        mapget::model_ptr<mapget::AttributeValidityEntry> const& entry,
        mapget::model_ptr<mapget::Geometry> const& geometry,
        FeatureStyleRule const& rule,
        BoundEvalFun const& evalFun,
        uint32_t pickIndex,
        std::string const& stackPrefix);
    /** Connect relation source and target geometries without host-feature fetches. */
    void renderRelationLine(
        mapget::model_ptr<mapget::GeometryCollection> const& sourceGeometry,
        mapget::model_ptr<mapget::GeometryCollection> const& targetGeometry,
        mapget::model_ptr<mapget::GeometryCollection> const& sourceFeatureGeometry,
        mapget::model_ptr<mapget::GeometryCollection> const& targetFeatureGeometry,
        FeatureStyleRule const& rule,
        BoundEvalFun const& evalFun,
        uint32_t pickIndex);

    /** Bind projected scalar columns to the style evaluator for one entry. */
    [[nodiscard]] BoundEvalFun makeEvalFun(
        ProjectedFields const& fields,
        mapget::model_ptr<mapget::Array> const& values,
        ProjectedEvalState& state);
    /** Skip duplicate server-owned gates for concrete channels while resolving branches locally. */
    bool forEachAdmittedRule(
        FeatureStyleRule const& rule,
        FeatureStyleRule::MatchContext const& context,
        BoundEvalFun const& entryEvalFun,
        std::function<void(FeatureStyleRule const&)> const& callback,
        BoundEvalFun const* featureEvalFun = nullptr) const;
    /** Allocate or reuse one pick index, constructing its payload only when needed. */
    [[nodiscard]] uint32_t pickIndex(
        uint32_t channelOrdinal,
        uint32_t entryOrdinal,
        uint32_t endpointRole,
        bool selectable,
        std::function<PickResult()> const& resultFactory);
    /** Allocate one tuple-addressed pick shared by this feature entry's rules. */
    [[nodiscard]] uint32_t featurePickIndex(
        uint32_t channelOrdinal,
        uint32_t entryOrdinal,
        bool selectable);
    /** Retain one representative physical height independently of render-depth bias. */
    void recordPickNavigationAltitude(
        uint32_t pickIndex,
        std::span<mapget::Point const> points);
    /** Build a semantic attribute/validity pick payload. */
    [[nodiscard]] static PickResult pickResult(
        mapget::model_ptr<mapget::AttributeValidityEntry> const& entry,
        std::string const& featureId);
    /** Build a semantic group pick payload with member feature ids. */
    [[nodiscard]] static PickResult pickResult(
        mapget::model_ptr<mapget::GroupEntry> const& entry,
        mapget::model_ptr<mapget::FeatureId> const& representativeFeatureId);
    /** Build one relation endpoint's semantic pick payload. */
    [[nodiscard]] static PickResult pickResult(
        mapget::model_ptr<mapget::RelationEntry> const& entry,
        mapget::model_ptr<mapget::FeatureId> const& sourceFeatureId,
        mapget::model_ptr<mapget::FeatureId> const& targetFeatureId,
        uint32_t endpointRole);
    /** Deduplicate repeated expression failures while retaining occurrence counts. */
    void recordRuntimeIssue(
        std::string const& property,
        std::string const& expression,
        std::string const& message,
        uint32_t ruleIndex);

    /** Convert WGS84 doubles to local metre coordinates around the packet origin. */
    [[nodiscard]] mapget::Point projectWgsPoint(
        mapget::Point const& wgsPoint) const;
    /** Convert packet-local metre coordinates back to WGS84 doubles for labels/GLTF. */
    [[nodiscard]] mapget::Point unprojectLocalPoint(
        mapget::Point const& localPoint) const;
    /** Map a legacy local pick slot into the compact GPU packet pick table. */
    [[nodiscard]] uint32_t gpuPickIndex(uint32_t legacyPickIndex) const;
    /** Assemble common record metadata from evaluated style and semantic state. */
    [[nodiscard]] GpuRecordStyle gpuRecordStyle(
        FeatureStyleRule const& rule,
        BoundEvalFun const& evalFun,
        glm::fvec4 const& color,
        double zIndex,
        uint32_t legacyPickIndex) const;
    /** Hash one feature identity independently of tile clipping and entry order. */
    [[nodiscard]] uint64_t featureDepthIdentity(
        mapget::model_ptr<mapget::FeatureId> const& featureId) const;
    /** Fold stable tile, semantic, and rule identity into the packet's 32-bit tie key. */
    [[nodiscard]] uint32_t depthTieKey(
        uint64_t semanticIdentity,
        uint32_t ruleRenderIndex) const;
    /** Serialize the exact double-precision coordinate origin for the GLTF bridge. */
    [[nodiscard]] JsValue coordinateOriginToJs() const;
    /** Serialize temporary GLTF-local semantic pick results for TypeScript. */
    [[nodiscard]] JsValue pickResultsToJs() const;

    /** Append one point instance after local-coordinate projection. */
    void appendPoint(
        mapget::Point const& point,
        FeatureStyleRule const& rule,
        BoundEvalFun const& evalFun,
        glm::fvec4 const& color,
        double zIndex,
        uint32_t pickIndex);
    /** Append one hollow screen-facing point glyph with an explicit pixel radius. */
    void appendPointRing(
        mapget::Point const& point,
        float radius,
        FeatureStyleRule const& rule,
        BoundEvalFun const& evalFun,
        glm::fvec4 const& color,
        double zIndex,
        uint32_t pickIndex);
    /** Append or request one style icon without falling back to point geometry. */
    void appendIcon(
        mapget::Point const& point,
        std::string const& uri,
        FeatureStyleRule const& rule,
        BoundEvalFun const& evalFun,
        glm::fvec4 const& color,
        double zIndex,
        uint32_t pickIndex);
    /** Triangulate and append one polygon/surface with explicit ring boundaries. */
    void appendSurface(
        std::vector<mapget::Point> const& points,
        std::vector<uint32_t> const& ringStarts,
        FeatureStyleRule const& rule,
        BoundEvalFun const& evalFun,
        glm::fvec4 const& color,
        double zIndex,
        uint32_t pickIndex);
    /** Preserve GLTF mesh geometry in the temporary browser bridge. */
    void appendMesh(
        std::vector<mapget::Point> const& points,
        FeatureStyleRule const& rule,
        BoundEvalFun const& evalFun,
        glm::fvec4 const& color,
        double zIndex,
        uint32_t pickIndex);
    /** Expand one path into adjacency segments and optional shader arrowheads. */
    GpuPathRecordHandle appendPath(
        std::vector<mapget::Point> const& points,
        FeatureStyleRule const& rule,
        BoundEvalFun const& evalFun,
        glm::fvec4 const& color,
        double zIndex,
        uint32_t pickIndex,
        float width,
        FeatureStyleRule::Arrow arrow,
        std::span<float const> lateralOffsetsPx = {},
        std::span<glm::fvec2 const> lateralOffsetVectorsPx = {},
        float lateralOffsetScaleThreshold = 0.0f,
        bool simplificationApplied = false,
        std::optional<GpuPathOverlay> pathOverlay = std::nullopt,
        GpuScreenLengthAnchor screenLengthAnchor = GpuScreenLengthAnchor::None);
    /** Project WGS84 path points, discarding sub-pixel vertices first when allowed. */
    void projectPathPoints(
        std::span<mapget::Point const> points,
        bool simplify,
        std::vector<mapget::Point>& projected);
    /** Simplify a local or WGS84 path while retaining both endpoints. */
    [[nodiscard]] std::span<mapget::Point const> simplifyPath(
        std::span<mapget::Point const> points,
        bool wgs84Coordinates = false);
    /** Expand one axis-aligned box into persistent surface triangles. */
    void appendAabb(
        mapget::Point const& origin,
        mapget::Point const& size,
        FeatureStyleRule const& rule,
        BoundEvalFun const& evalFun,
        glm::fvec4 const& color,
        double zIndex,
        uint32_t pickIndex);
    /** Append one styled GLTF node reference to the temporary bridge. */
    void appendGltf(
        mapget::model_ptr<mapget::Geometry> const& geometry,
        FeatureStyleRule const& rule,
        BoundEvalFun const& evalFun,
        uint32_t pickIndex);
    /** Append one absolute-WGS84 label for the shared Deck TextLayer host. */
    void appendLabel(
        mapget::Point const& point,
        std::string const& text,
        FeatureStyleRule const& rule,
        double zIndex,
        uint32_t pickIndex);

    /** Convert a normalized color channel to one clamped byte. */
    [[nodiscard]] static uint8_t toColorByte(float value);

    FeatureLayerStyle const& style_;
    FeatureStyleRule::HighlightMode highlightMode_;
    FeatureStyleRule::Fidelity fidelity_;
    mapget::TileSubsetLayer::Ptr subset_;
    GpuContributionContext gpuContributionContext_;
    BridgeBuffers bridgeBuffers_;
    GpuRenderPacketBuilder gpuPacketBuilder_;
    std::vector<mapget::Point> projectedPointsScratch_;
    std::vector<mapget::Point> wgsPathScratch_;
    std::vector<mapget::Point> simplifiedPathScratch_;
    std::vector<uint8_t> pathSimplificationKeepScratch_;
    std::vector<uint32_t> pathSimplificationRangeScratch_;
    std::vector<ResolvedFeatureGeometry> featureGeometriesScratch_;
    std::vector<FeatureStyleRule const*> featureRulesScratch_;
    ProjectedGeometryCache featureProjectionCacheScratch_;
    uint32_t vertexCount_ = 0;

    std::unordered_map<uint32_t, PickResult> bridgePickResults_;
    std::vector<PickRef> pickRefs_;
    std::vector<float> pickNavigationAltitudes_;
    std::unordered_map<PickRef, uint32_t, PickRefHash> pickIndices_;
    std::vector<RuntimeIssue> runtimeIssues_;
    std::unordered_map<std::string, size_t> runtimeIssueIndices_;
    std::unordered_set<std::string> renderedRelationEndpointParts_;
    std::unordered_set<std::string> renderedRelationEndpointLabels_;
    std::optional<std::string> relationEndpointLabelIdentity_;
    std::unordered_map<uint32_t, uint32_t> featureOffsetSlotsByRule_;
    std::unordered_map<std::string, uint32_t>
        attributeOffsetSlotsByFeature_;
    std::unordered_map<std::string, uint32_t>
        attributeOffsetSlotsBySegment_;
    std::unordered_map<std::string, uint32_t>
        attributeOffsetSlotsByTransitionLeg_;
    std::unordered_map<std::string, TransitionOffsetScaleGroup>
        transitionOffsetScaleGroups_;
    std::unordered_map<std::string, ChannelBinding> channelBindings_;
    uint64_t subsetMapDepthSeed_ = 0U;
    uint64_t subsetSemanticGroupSeed_ = 0U;
    uint64_t currentDepthIdentity_ = 0U;
    uint32_t subsetDepthPhase_ = 0U;

    /** Browser-atlas entry installed before rendering starts. */
    struct GpuIconResource {
        uint32_t atlasPage = 0U;
        std::array<float, 4> uv{};
        std::array<float, 2> pixelSize{};
    };
    std::unordered_map<std::string, GpuIconResource> gpuIconResources_;

    mutable bool hasCoordinateOriginWgs_ = false;
    mutable mapget::Point coordinateOriginWgs_{0.0, 0.0, 0.0};
    mutable double coordinateOriginWorldX_ = 0.0;
    mutable double coordinateOriginWorldY_ = 0.0;
    mutable double coordinateOriginCosine_ = 1.0;
    mutable double coordinateOriginTangent_ = 0.0;
    mutable double coordinateUnitsPerMeter_ = 0.0;
    mutable bool coordinateScalesValid_ = false;
    uint32_t gpuSceneGeneration_ = 0U;
    uint32_t gpuPacketSequence_ = 0U;
    uint32_t gpuIconCatalogVersion_ = 0U;
    uint32_t gpuOriginSlot_ = 0U;
    uint64_t gpuOriginKey_ = 0U;
    double lineSimplificationToleranceMeters_ = 0.0;
    bool hasRun_ = false;
};

} // namespace erdblick
