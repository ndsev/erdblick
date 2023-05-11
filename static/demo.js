import { GLTFLoader } from "./deps/GLTFLoader.js";
import * as THREE from "./deps/three.js"

export class Demo
{
    async loadGlb(glbString) {
        const loader = new GLTFLoader();
        const loadedData = await loader.loadAsync(glbString);
        const demo_object = loadedData.scene.children[0];

        const camera = new THREE.PerspectiveCamera( 70, window.innerWidth / window.innerHeight, 0.01, 10 );
        camera.position.z = 1;

        const scene = new THREE.Scene();

        const dirLight = new THREE.DirectionalLight( 0xffffff, 0.8 );
        dirLight.position.set( - 3, 10, - 10 );
        scene.add( dirLight );

        const geometry = new THREE.BoxGeometry( 0.2, 0.2, 0.2 );
        const material = new THREE.MeshNormalMaterial();

        const mesh = new THREE.Mesh( geometry, material );
        // scene.add( mesh, demo_object );
        scene.add( mesh );

        const renderer = new THREE.WebGLRenderer( { antialias: true } );
        renderer.setSize( window.innerWidth - 50, window.innerHeight - 50 );
        renderer.setAnimationLoop( animation );

        const container = document.querySelector('#demoScene');
        container.appendChild( renderer.domElement );

// animation

        function animation( time ) {

            mesh.rotation.x = time / 2000;
            mesh.rotation.y = time / 1000;

            renderer.render( scene, camera );

        }

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
    const node = document.createTextNode(fmr.test());
    para.appendChild(node);

    let d = new Demo();
    d.loadGlb(fmr.test());
});
