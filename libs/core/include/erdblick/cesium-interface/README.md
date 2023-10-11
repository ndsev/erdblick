## Mapget-to-Cesium Geometry Translation

This directory contains classes, which wrap the construction of CesiumJS
scene primitives. The following Cesium classes are useful:

* `Primitive:` Equals GeometryInstances + Appearance. Can hold ONE OF ...
   * All Corridors (meter-width meshlines) and Meshes with solid colors
     * Using `PerInstanceColorAppearance`
   * All Corridors (meter-width meshlines) and Meshes with the same texture
     * Using `MaterialAppearance`
   * All Polylines (pixel-width meshlines) with solid colors
     * Using `PolylineColorAppearance`
   * All Polylines (pixel-width meshlines) with the same special line style (glow OR outline OR dashes OR arrow)
     * Using `PolylineMaterialAppearance`
* `PrimitiveCollection:` Used to bundle all primitives for one tile layer.

Check [this tutorial](https://cesium.com/learn/cesiumjs-learn/cesiumjs-geometry-appearances/) for an introduction into the matter.

For ground-based (sticking to terrain) geometry:

* `GroundPrimitive:` To represent anything (other than polylines) that is glued to the ground.
  * All Corridors (meter-width meshlines) and Meshes with solid colors
    * Using `PerInstanceColorAppearance`
  * All Corridors (meter-width meshlines) and Meshes with the same texture
    * Using `MaterialAppearance`
* `GroundPolylinePrimitive:` To represent scaling polylines on the ground.
  * All Polylines (pixel-width meshlines) with solid colors
    * Using `PolylineColorAppearance`
  * All Polylines (pixel-width meshlines) with the same special line style (glow OR outline OR dashes OR arrow)
    * Using `PolylineMaterialAppearance`

In the future, these are also inserted into the `PrimitiveCollection`:

* `BillboardCollection:` To represent pins/points with icons.
* `LabelCollection:` To represent text labels.
* `PointPrimitiveCollection:` To represent untextured points.

## Cesium Support For Erdblick Style Options

The above Cesium Primitive concepts support all planned Feature styling aspects, except...

* Non-scaling dashed lines (unless we use a texture?).
* Dashed arrows (unless we use a texture?).
* Lines with arrow-heads on both sides (unless we use a texture?).
* **Highlighting:** `(Polyline)-MaterialAppearance`-based geometry instances will require some magic.
  Ad-hoc color changes are only possible for `PerInstanceColorAppearance`/`PolylineColorAppearance`.
  hiding the "real" instance and showing a "highlight instance".

**Note:** Textured polylines/corridors would look equivalent to the legacy NDS mapviewer.
