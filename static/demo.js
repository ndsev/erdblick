import { GLTFLoader } from "./deps/GLTFLoader.js";
import * as THREE from "./deps/three.js"

export class Demo {
    async loadGlb(glbArray) {
        console.log(Object.keys(glbArray).length)
        const loader = new GLTFLoader();
        loader.parse(
            glbArray.buffer,
            '',
            function (loadedData) {

                const demo_object = loadedData.scene.children[0].children[0];

                const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 100);
                camera.position.z = 5;

                const scene = new THREE.Scene();

                const dirLight = new THREE.DirectionalLight( 0xffffff, 0.8 );
                dirLight.position.set( - 3, 10, - 10 );
                scene.add( dirLight );
                const dirLight2 = new THREE.DirectionalLight( 0xffffff, 0.8 );
                dirLight2.position.set(  3,  - 10, 10 );
                scene.add( dirLight2 );

                const geometry = new THREE.BoxGeometry(0.2, 0.2, 0.2);
                const material = new THREE.MeshStandardMaterial();
                const mesh = new THREE.Mesh(geometry, material);

                // scene.add(mesh, demo_object);
                scene.add( demo_object );
                // scene.add(mesh);

                const renderer = new THREE.WebGLRenderer({antialias: true});
                renderer.setSize(window.innerWidth - 50, window.innerHeight - 50);
                renderer.setAnimationLoop(animation);

                const container = document.querySelector('#demoScene');
                container.appendChild(renderer.domElement);

                // animation
                function animation(time) {
                    mesh.rotation.x = time / 2000;
                    mesh.rotation.y = time / 1000;

                    demo_object.rotation.x = time / 2000;
                    demo_object.rotation.y = time / 1000;

                    renderer.render(scene, camera);
                }
            },
            function (xhr) {
                // Progress callback
                console.log((xhr.loaded / xhr.total) * 100 + '% loaded');
            },
            function (error) {
                // Error callback
                console.error('Error parsing GLTF', error);
            }
        );
    }
}

console.log("Outside demo class")

const para = document.getElementById("testPara");
const node = document.createTextNode("Test value: ");
para.appendChild(node);

libFeatureLayerRenderer().then(Module => {
    const FMRendererModule = Module;
    let fmr = new FMRendererModule.FeatureLayerRenderer();
    const para = document.getElementById("testPara");

    const node = document.createTextNode(fmr.test_binary_size());
    para.appendChild(node);

    var FMR_constructor = FMRendererModule.cwrap('getFMR', 'FeatureLayerRenderer', []);
    var FMR_test_binary = FMRendererModule.cwrap('fillBuffer', null, ['number', 'number']);
    var FMR_malloc = FMRendererModule.cwrap('emscripten_malloc', 'number', ['number']);

    let testFMR = FMR_constructor();
    let memory = FMRendererModule.asm.memory.buffer;

    // Does not work - buffer is full of zeroes in the end.
    // let buf = new ArrayBuffer(fmr.test_binary_size());
    // FMR_test_binary(testFMR, buf);
    // const dataView = new Uint8Array(buf, 0, fmr.test_binary_size());

    // Fill buffer with content from C++ generated code.
    FMR_test_binary(testFMR, memory);
    // FMR_test_binary(testFMR, memory);
    const dataView = new Uint8Array(memory, 0, fmr.test_binary_size());

    let heapPtr = FMR_malloc(fmr.test_binary_size());
    let dataView2 = new Uint8Array(Module.HEAPU8.buffer, heapPtr, fmr.test_binary_size());
    FMR_test_binary(testFMR, heapPtr);

    for (let i = 0; i < dataView.length; i++) {
        if (dataView[i] !== dataView2[i]) {
            console.log(i)
        }
    }

    const decoder = new TextDecoder('utf-8');
    const glbString = decoder.decode(dataView);
    console.log(glbString);
    console.log(glbString.length);

    let d = new Demo();
    d.loadGlb(dataView2);

});
