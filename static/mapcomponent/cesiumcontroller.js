"use strict";

export class CesiumController
{
    constructor(cesiumViewer, mapViewerModel) {
        this.cesiumViewer = cesiumViewer;
        this.mapViewerModel = mapViewerModel;
        mapViewerModel.addEventListener(mapViewerModel.BATCH_ADDED, this.onBatchAdded);
        mapViewerModel.addEventListener(mapViewerModel.BATCH_ABOUT_TO_BE_DISPOSED, this.onBatchAboutToBeRemoved);
    }

    onBatchAdded(event) {
        const batch = event.batch;
        let viewer = this.cesiumViewer.viewer;
        viewer.scene.primitives.add(tileSet);
        // TODO: Remove zoom to as soon as basic functionality has been verified
        viewer.zoomTo(viewer.scene.primitives.get(viewer.scene.primitives.length - 1));
    };

    onBatchAboutToBeRemoved(event) {
        const batch = event.batch;
        let viewer = this.cesiumViewer.viewer;
        viewer.scene.primitives.remove(tileSet);
    };
}
