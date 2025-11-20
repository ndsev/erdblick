# SourceData Inspection Guide

The SourceData inspector lets you read raw blobs which are the underlying data of the visible features. Use it to debug encoding issues or verify backend responses.

![SourceData inspector](../../../docs/sourcedata-inspector.svg)

## Ways to Open SourceData

You can reach the SourceData inspector from several different entry points, depending on where you start your investigation:

1. **Context menu** – right-click anywhere on the map and choose **Inspect Source Data**. The UI pre-fills the tile ID under the cursor.
2. **Inspector links** – many feature attributes show a source icon. Clicking it opens SourceData with the correct map, tile, and layer already highlighted.
3. **Search command** – type `<tileId> "<Map Id>" "<Source Layer>"` into the search bar and execute the action. Example:
   ```text
   37443649601549 "Road 4 Test Data" "SourceData-road.layer.RoadLayer-1"
   ```

![Shortcut from inspector to SourceData](../../../docs/goto-sourcedata.svg)

_[Screenshot placeholder: Context menu path that opens the SourceData inspector.]_

## Navigating SourceData

Once the panel is open, the tree view and filter controls make it easier to zero in on the parts of a blob that matter:

- Use the filter box to highlight field names or values (supports case-insensitive search).
- Expand nodes to see value, type, and offsets.

## Tips for Efficient Debugging

A few SourceData habits pay off quickly when you debug tricky encoding or backend problems:

- Enable tile borders and the statistics dialog when chasing missing tiles; copy the tile ID from the statistics view and feed it into SourceData.
- Combine with split view: keep SourceData open on one side while you inspect features on the other.
- Document interesting blobs by copying the current erdblick URL; it encodes the selected map, tile, and layer so colleagues can open the same view.
