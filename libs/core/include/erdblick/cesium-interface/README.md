## Mapget-to-Cesium Geometry Translation

This directory contains classes, which wrap the construction of CesiumJS
scene primitives. The following classes are currently wrapped:

* `Primitive:` Equals GeometryInstances + Appearance. Can hold ONE OF ...
   * All Corridors (meter-width meshlines) and Meshes with vertex colors
     * Using `PerInstanceColorAppearance`
   * All Corridors (meter-width meshlines) and Meshes with the same texture
     * Using `MaterialAppearance`
   * All Polylines (pixel-width meshlines) with vertex colors
     * Using `PolylineColorAppearance`
   * All Polylines (pixel-width meshlines) with the same special line style (glow OR outline OR dashes OR arrow)
     * Using `PolylineMaterialAppearance`
* `PrimitiveCollection:` Used to bundle all primitives for one tile layer.

For ground-based (sticking to terrain) geometry:

* `GroundPrimitive:` To represent anything (other than polylines) that is glued to the ground.
  * All Corridors (meter-width meshlines) and Meshes with vertex colors
    * Using `PerInstanceColorAppearance`
  * All Corridors (meter-width meshlines) and Meshes with the same texture
    * Using `MaterialAppearance`
* `GroundPolylinePrimitive:` To represent scaling polylines on the ground.
  * All Polylines (pixel-width meshlines) with vertex colors
    * Using `PolylineColorAppearance`
  * All Polylines (pixel-width meshlines) with the same special line style (glow OR outline OR dashes OR arrow)
    * Using `PolylineMaterialAppearance`

In the future, these are also inserted into the `PrimitiveCollection`:

* `BillboardCollection:` To represent pins/points with icons.
* `LabelCollection:` To represent text labels.
* `PointPrimitiveCollection:` To represent untextured points.

## Cesium Support For Erdblick Style Options

The above Cesium Primitive concepts support all planned Feature styling aspects, except...

* Non-scaling dashed lines (unless we texture a corridor).
* Dashed arrows (unless we texture a corridor).
* Lines with arrow-heads on both sides (unless we texture a corridor).

**Note:** Textured corridors would look equivalent to the legacy NDS mapviewer.
