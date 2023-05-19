import { GLTFLoader } from "./deps/GLTFLoader.js";
import * as THREE from "./deps/three.js"

export class Demo {
    async loadGlb(glbArray) {
        console.log(Object.keys(glbArray).length)
        const loader = new GLTFLoader();

        console.log(glbArray);
        const decoder = new TextDecoder('utf-8');
        const s1 = decoder.decode(glbArray);
        console.log(s1);

        loader.parse(
            glbArray,
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

                scene.add( demo_object );

                const renderer = new THREE.WebGLRenderer({antialias: true});
                renderer.setSize(window.innerWidth - 50, window.innerHeight - 50);
                renderer.setAnimationLoop(animation);

                const container = document.querySelector('#demoScene');
                container.appendChild(renderer.domElement);

                // animation
                function animation(time) {
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

    var FMR_constructor = FMRendererModule.cwrap('getFMR', 'FeatureLayerRenderer', []);
    var FMR_test_binary = FMRendererModule.cwrap('fillBuffer', null, ['number', 'number']);
    var FMR_malloc = FMRendererModule.cwrap('emscripten_malloc', 'number', ['number']);
    let testFMR = FMR_constructor();

    let buffer_ptr = Number(fmr.test_binary_two());
    // var FMR_test_binary_two = FMRendererModule.cwrap('testBinaryTwo', 'number', []);
    // let buffer_ptr = FMR_test_binary_two(testFMR);
    let a = Module.HEAPU8.buffer.slice(buffer_ptr, buffer_ptr + fmr.test_binary_size());
    console.log(a)

    let d = new Demo();
    d.loadGlb(a);

    const node = document.createTextNode(fmr.test_binary_size());
    para.appendChild(node);

    // Fails because of unbound parameter or sth.
    // let m = FMRendererModule.asm.memory.buffer;
    // fmr.test_binary(m);

    // let memory = FMRendererModule.asm.memory.buffer;

    // Not a function.
    // fmr.fillBuffer(testFMR, memory);

    // Does not work - buffer is full of zeroes in the end.
    // let buf = new ArrayBuffer(fmr.test_binary_size());
    // FMR_test_binary(testFMR, buf);
    // const dataView = new Uint8Array(buf, 0, fmr.test_binary_size());
    // const decoder = new TextDecoder('utf-8');

    // // Fill buffer with content from C++ generated code.
    // FMR_test_binary(testFMR, memory);
    // // FMR_test_binary(testFMR, memory);
    // const unusedDataView = new Uint8Array(memory, 0, fmr.test_binary_size());
    // const s0 = decoder.decode(unusedDataView);
    // console.log(s0);
    // console.log(unusedDataView);
    //
    // let heapPtr = FMR_malloc(fmr.test_binary_size());
    // let otherHeapPtr = FMR_malloc(fmr.test_binary_size());
    // FMR_test_binary(testFMR, heapPtr);
    // let dataView = new Uint8Array(Module.HEAPU8.buffer, heapPtr, fmr.test_binary_size());
    // let otherDataView = new Uint8Array(Module.HEAPU8.buffer, otherHeapPtr, fmr.test_binary_size());
    //
    // console.log(heapPtr);
    // const s1 = decoder.decode(dataView);
    // console.log(s1);
    // console.log(dataView);
    //
    // console.log(otherHeapPtr);
    // const s2 = decoder.decode(otherDataView);
    // console.log(s2);
    // console.log(otherDataView);

    // let d = new Demo();
    // d.loadGlb(dataView);

});
