import { GLTFLoader } from "./deps/GLTFLoader.js";
import * as THREE from "./deps/three.js"

export class Demo {
    async loadGlb(glbArray) {

        const loader = new GLTFLoader();
        loader.parse(
            glbArray,
            '',
            function (loadedData) {

                // Reference: https://github.com/mrdoob/three.js/blob/dev/README.md
                const demo_object = loadedData.scene.children[0].children[0];
                const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 2000);
                camera.position.z = 700;

                const scene = new THREE.Scene();

                const dirLight = new THREE.DirectionalLight( 0xffffff, 0.8 );
                dirLight.position.set( - 300, 1000, - 1000 );
                scene.add( dirLight );
                const dirLight2 = new THREE.DirectionalLight( 0xffffff, 0.8 );
                dirLight2.position.set(  300,  - 1000, 1000 );
                scene.add( dirLight2 );

                scene.add( demo_object );

                const renderer = new THREE.WebGLRenderer({antialias: true});
                renderer.setSize(window.innerWidth - 50, window.innerHeight - 50);
                renderer.setAnimationLoop(animation);

                const container = document.querySelector('#demoScene');
                container.appendChild(renderer.domElement);

                function animation(time) {
                    demo_object.rotation.x = time / 2500;
                    demo_object.rotation.x = time / 2500;
                    demo_object.rotation.y = time / 1000;
                    renderer.render(scene, camera);
                }
            },
            function (xhr) {
                console.log((xhr.loaded / xhr.total) * 100 + '% loaded');
            },
            function (error) {
                console.error('Error parsing GLTF', error);
            }
        );
    }

    async loadStyleYaml(url) {
        const yamlFetchJob = fetch(url);
        yamlFetchJob.then((response) => {
            if (!response.ok) {
                // Throw an error if the request did not succeed.
                throw new Error(`HTTP error: ${response.status}`);
            }
            // Fetch the response as text and immediately return the promise.
            let t = response.text();
            console.log("Inside fetch callback...")
            console.log(t);
            return t;
            })
            // Catch any errors and display a message.
            .catch((error) => {
                console.log(`Could not fetch style: ${error}`);
            });
    }
}

libFeatureLayerRenderer().then(Module => {
    const FMRendererModule = Module;
    let fmr = new FMRendererModule.FeatureLayerRenderer();
    let renderObj = fmr.render();
    let objSize = renderObj.getGlbSize();

    let bufferPtr = Number(renderObj.getGlbPtr());
    // Module.HEAPU8.buffer is the same as Module.asm.memory.buffer.
    let arrBuf = FMRendererModule.HEAPU8.buffer.slice(bufferPtr, bufferPtr + objSize);

    let d = new Demo();
    d.loadGlb(arrBuf);

    const styleUrl = "/styles/demo-style.yaml";

    fetch(styleUrl).then((response) => {
        if (!response.ok) {
            throw new Error(`HTTP error: ${response.status}`);
        }
        return response.text();
    })
    .then((styleYaml) => {
        console.log(styleYaml);
        let styleLength = styleYaml.length * 2;
        let arrBuf = FMRendererModule.HEAPU16.buffer.slice(bufferPtr, bufferPtr + styleLength);
        let bufView = new Uint16Array(arrBuf);
        for (let i = 0; i < styleLength; i++) {
            bufView[i] = styleYaml.charCodeAt(i);
        }
        // TODO pass the buffer pointer and length to C++ YAML parser.
        console.log(bufView);
    })
    .catch((error) => {
        console.log(`Could not fetch style: ${error}`);
    });

    renderObj.delete();
    fmr.delete();
});
