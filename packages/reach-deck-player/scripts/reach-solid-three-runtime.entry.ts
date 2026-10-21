import * as THREE from 'three';

import {
  color,
  fillTarget,
  frozenController,
  registerScienceKit,
} from './science-kit-runtime.shared';

registerScienceKit('solid-three', (target, spec) => {
  fillTarget(target, spec.ariaLabel);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(800, 480, false);
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  target.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#f8fafc');
  const camera = new THREE.PerspectiveCamera(45, 800 / 480, 0.1, 5000);
  camera.position.set(8, 7, 9);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x64748b, 2.2));
  const light = new THREE.DirectionalLight(0xffffff, 2);
  light.position.set(6, 10, 8);
  scene.add(light);
  const meshes: THREE.Mesh[] = [];
  const interaction = spec.interaction as Record<string, boolean>;
  for (const solid of spec.solids as Array<Record<string, unknown>>) {
    let geometry: THREE.BufferGeometry;
    if (solid.kind === 'sphere') geometry = new THREE.SphereGeometry(Number(solid.radius), 32, 20);
    else if (solid.kind === 'cylinder')
      geometry = new THREE.CylinderGeometry(
        Number(solid.radius),
        Number(solid.radius),
        Number(solid.height),
        32,
      );
    else if (solid.kind === 'cone')
      geometry = new THREE.ConeGeometry(Number(solid.radius), Number(solid.height), 32);
    else if (solid.kind === 'regular-prism')
      geometry = new THREE.CylinderGeometry(
        Number(solid.radius),
        Number(solid.radius),
        Number(solid.height),
        Number(solid.sides),
      );
    else if (solid.kind === 'regular-pyramid')
      geometry = new THREE.ConeGeometry(
        Number(solid.radius),
        Number(solid.height),
        Number(solid.sides),
      );
    else {
      const d = solid.dimensions as [number, number, number];
      geometry = new THREE.BoxGeometry(d[0], d[1], d[2]);
    }
    const material = new THREE.MeshStandardMaterial({
      color: color(solid.colorToken),
      transparent: Number(solid.opacity) < 1,
      opacity: Number(solid.opacity),
    });
    const mesh = new THREE.Mesh(geometry, material);
    const position = solid.position as [number, number, number];
    const rotation = solid.rotation as [number, number, number];
    mesh.position.set(...position);
    mesh.rotation.set(...rotation);
    mesh.userData.id = solid.id;
    scene.add(mesh);
    meshes.push(mesh);
  }
  const initialView = Object.freeze({ azimuth: 0.72, elevation: 0.55, distance: 14 });
  let azimuth = initialView.azimuth;
  let elevation = initialView.elevation;
  let distance = initialView.distance;
  let drag: { x: number; y: number } | undefined;
  const draw = () => {
    camera.position.set(
      Math.cos(azimuth) * Math.cos(elevation) * distance,
      Math.sin(elevation) * distance,
      Math.sin(azimuth) * Math.cos(elevation) * distance,
    );
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
  };
  renderer.domElement.addEventListener('pointerdown', (event) => {
    if (!interaction.orbit) return;
    drag = { x: event.clientX, y: event.clientY };
    renderer.domElement.setPointerCapture(event.pointerId);
  });
  renderer.domElement.addEventListener('pointermove', (event) => {
    if (!drag) return;
    azimuth += (event.clientX - drag.x) * 0.01;
    elevation = Math.max(-1.4, Math.min(1.4, elevation + (event.clientY - drag.y) * 0.01));
    drag = { x: event.clientX, y: event.clientY };
    draw();
  });
  renderer.domElement.addEventListener('pointerup', () => {
    if (drag)
      target.dispatchEvent(
        new CustomEvent('reach-science-kit-change', {
          detail: { kind: 'view', azimuth, elevation, distance },
        }),
      );
    drag = undefined;
  });
  renderer.domElement.addEventListener(
    'wheel',
    (event) => {
      if (!interaction.zoom) return;
      event.preventDefault();
      distance = Math.max(3, Math.min(40, distance + Math.sign(event.deltaY)));
      draw();
      target.dispatchEvent(
        new CustomEvent('reach-science-kit-change', {
          detail: { kind: 'view', azimuth, elevation, distance },
        }),
      );
    },
    { passive: false },
  );
  draw();
  return frozenController(
    () => {
      azimuth = initialView.azimuth;
      elevation = initialView.elevation;
      distance = initialView.distance;
      draw();
    },
    () => {
      for (const mesh of meshes) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
      renderer.dispose();
      target.replaceChildren();
    },
    () => ({ azimuth, elevation, distance }),
    (state) => {
      if (typeof state !== 'object' || state === null) return false;
      const candidate = state as { azimuth?: unknown; elevation?: unknown; distance?: unknown };
      if (
        !Number.isFinite(candidate.azimuth) ||
        !Number.isFinite(candidate.elevation) ||
        !Number.isFinite(candidate.distance)
      )
        return false;
      const nextElevation = Number(candidate.elevation);
      const nextDistance = Number(candidate.distance);
      if (nextElevation < -1.4 || nextElevation > 1.4 || nextDistance < 3 || nextDistance > 40)
        return false;
      azimuth = Number(candidate.azimuth);
      elevation = nextElevation;
      distance = nextDistance;
      draw();
      return true;
    },
  );
});
