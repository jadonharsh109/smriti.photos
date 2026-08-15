import { useEffect, useRef } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

/** Landing hero: floating liquid-glass photo slabs rendered with real
 * refraction (MeshPhysicalMaterial transmission), plus a soft particle
 * field. Everything is procedural — no assets, fully offline. */

interface CardSpec {
  x: number;
  y: number;
  z: number;
  ry: number;
  rz: number;
  s: number;
  hueA: number;
  hueB: number;
  phase: number;
}

// hues lean warm — marigold, rani pink, peacock, royal violet
const CARDS: CardSpec[] = [
  { x: -4.6, y: 1.3, z: -1.4, ry: 0.5, rz: 0.1, s: 1.15, hueA: 25, hueB: 350, phase: 0.0 },
  { x: -3.4, y: -1.5, z: -0.4, ry: 0.42, rz: -0.08, s: 0.95, hueA: 30, hueB: 48, phase: 1.3 },
  { x: -2.4, y: 0.4, z: -2.4, ry: 0.3, rz: 0.06, s: 0.8, hueA: 175, hueB: 200, phase: 2.1 },
  { x: -5.4, y: -0.4, z: -2.8, ry: 0.6, rz: -0.05, s: 0.9, hueA: 280, hueB: 320, phase: 3.4 },
  { x: 4.6, y: 1.1, z: -1.2, ry: -0.5, rz: -0.1, s: 1.2, hueA: 335, hueB: 15, phase: 0.8 },
  { x: 3.5, y: -1.4, z: -0.5, ry: -0.42, rz: 0.09, s: 1.0, hueA: 210, hueB: 250, phase: 2.6 },
  { x: 2.5, y: 0.6, z: -2.5, ry: -0.3, rz: -0.06, s: 0.78, hueA: 42, hueB: 62, phase: 4.0 },
  { x: 5.5, y: -0.6, z: -2.9, ry: -0.6, rz: 0.04, s: 0.92, hueA: 300, hueB: 340, phase: 5.1 },
  { x: -1.6, y: 3.1, z: -4.6, ry: 0.18, rz: 0.05, s: 0.8, hueA: 20, hueB: 40, phase: 1.9 },
];

/** Paint a tiny abstract landscape "photo" for a card face. */
function photoTexture(hueA: number, hueB: number): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 192;
  const g = c.getContext("2d")!;
  // sky
  const sky = g.createLinearGradient(0, 0, 0, 192);
  sky.addColorStop(0, `hsl(${hueA} 80% 72%)`);
  sky.addColorStop(1, `hsl(${hueB} 70% 48%)`);
  g.fillStyle = sky;
  g.fillRect(0, 0, 256, 192);
  // sun
  g.fillStyle = "rgba(255,240,210,0.95)";
  g.beginPath();
  g.arc(70 + Math.random() * 110, 46 + Math.random() * 30, 17 + Math.random() * 8, 0, Math.PI * 2);
  g.fill();
  // far hills
  g.fillStyle = `hsl(${hueB} 45% 34% / 0.85)`;
  g.beginPath();
  g.moveTo(0, 132);
  for (let x = 0; x <= 256; x += 32) g.lineTo(x, 118 + Math.sin(x * 0.05 + hueA) * 14);
  g.lineTo(256, 192);
  g.lineTo(0, 192);
  g.fill();
  // near hills
  g.fillStyle = `hsl(${hueB} 40% 22%)`;
  g.beginPath();
  g.moveTo(0, 160);
  for (let x = 0; x <= 256; x += 24) g.lineTo(x, 148 + Math.cos(x * 0.045 + hueB) * 12);
  g.lineTo(256, 192);
  g.lineTo(0, 192);
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export default function Hero3D() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    host.appendChild(renderer.domElement);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 60);
    camera.position.set(0, 0, 8.5);

    // studio environment so the glass has something to refract & reflect
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;

    scene.add(new THREE.AmbientLight(0xffb088, 0.3));
    const keyLight = new THREE.PointLight(0xffb25e, 90, 40); // marigold key
    keyLight.position.set(-6, 5, 6);
    scene.add(keyLight);
    const rimLight = new THREE.PointLight(0xb96bff, 70, 40); // violet rim
    rimLight.position.set(7, -4, 5);
    scene.add(rimLight);

    const disposables: { dispose(): void }[] = [envTex, pmrem];

    // ---- glass photo cards ----
    const group = new THREE.Group();
    scene.add(group);

    const slabGeo = new THREE.BoxGeometry(1.7, 1.3, 0.09);
    const photoGeo = new THREE.PlaneGeometry(1.46, 1.06);
    disposables.push(slabGeo, photoGeo);

    const cards: { pivot: THREE.Group; spec: CardSpec }[] = [];
    for (const spec of CARDS) {
      const pivot = new THREE.Group();
      pivot.position.set(spec.x, spec.y, spec.z);
      pivot.rotation.set(0, spec.ry, spec.rz);
      pivot.scale.setScalar(spec.s);

      const glass = new THREE.MeshPhysicalMaterial({
        transmission: 1,
        thickness: 0.6,
        roughness: 0.12,
        ior: 1.45,
        color: 0xdfe9ff,
        attenuationColor: new THREE.Color(0x9db4ff),
        attenuationDistance: 2.5,
        clearcoat: 1,
        clearcoatRoughness: 0.18,
        envMapIntensity: 0.55, // keep the studio env from washing the slabs white
      });
      const slab = new THREE.Mesh(slabGeo, glass);

      const tex = photoTexture(spec.hueA, spec.hueB);
      const photoMat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
      const photo = new THREE.Mesh(photoGeo, photoMat);
      photo.position.z = -0.06; // sits behind the glass, seen through it

      pivot.add(photo);
      pivot.add(slab);
      group.add(pivot);
      cards.push({ pivot, spec });
      disposables.push(glass, tex, photoMat);
    }

    // ---- drifting dust ----
    const N = 320;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 18;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 10;
      pos[i * 3 + 2] = -1 - Math.random() * 6;
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const dustMat = new THREE.PointsMaterial({
      color: 0x9db4ff,
      size: 0.035,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const dust = new THREE.Points(dustGeo, dustMat);
    scene.add(dust);
    disposables.push(dustGeo, dustMat);

    // ---- interaction & loop ----
    const mouse = { x: 0, y: 0 };
    const onMove = (e: PointerEvent) => {
      mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      mouse.y = (e.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener("pointermove", onMove);

    const resize = () => {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    let raf = 0;
    let running = true;
    const clock = new THREE.Clock();

    const frame = () => {
      const t = clock.getElapsedTime();
      for (const { pivot, spec } of cards) {
        pivot.position.y = spec.y + Math.sin(t * 0.5 + spec.phase) * 0.22;
        pivot.rotation.y = spec.ry + Math.sin(t * 0.34 + spec.phase) * 0.1;
        pivot.rotation.z = spec.rz + Math.cos(t * 0.4 + spec.phase) * 0.04;
      }
      group.rotation.y = Math.sin(t * 0.08) * 0.05;
      dust.rotation.y = t * 0.008;
      camera.position.x += (mouse.x * 0.55 - camera.position.x) * 0.04;
      camera.position.y += (-mouse.y * 0.35 - camera.position.y) * 0.04;
      camera.lookAt(0, 0, -1);
      renderer.render(scene, camera);
    };

    const loop = () => {
      if (!running) return;
      frame();
      raf = requestAnimationFrame(loop);
    };

    if (reduced) {
      frame(); // a single still frame
    } else {
      loop();
    }

    const onVis = () => {
      const shouldRun = !document.hidden && !reduced;
      if (shouldRun && !running) {
        running = true;
        loop();
      } else if (!shouldRun) {
        running = false;
        cancelAnimationFrame(raf);
      }
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pointermove", onMove);
      ro.disconnect();
      for (const d of disposables) d.dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={hostRef} className="lp-hero-canvas" />;
}
