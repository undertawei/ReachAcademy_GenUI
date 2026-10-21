import * as ThreeDmol from '3dmol';

import { MOLECULE_3D_BALL_AND_STICK_STYLE } from './reach-molecule-3dmol-style';
import { fillTarget, frozenController, registerScienceKit } from './science-kit-runtime.shared';

registerScienceKit('molecule-3dmol', (target, spec) => {
  fillTarget(target, spec.ariaLabel);
  const api = ThreeDmol as unknown as {
    createViewer: (element: HTMLElement, options: object) => any;
  };
  const viewer = api.createViewer(target, { backgroundColor: '#f8fafc', antialias: true });
  const models = new Map<string, any>();
  for (const structure of spec.structures as Array<Record<string, unknown>>) {
    models.set(
      String(structure.id),
      viewer.addModel(String(structure.data), String(structure.format), { keepH: true }),
    );
  }
  const stylesByStructure = new Map<string, Record<string, object>>();
  for (const representation of spec.representations as Array<Record<string, unknown>>) {
    const model = models.get(String(representation.structureId));
    if (!model) continue;
    const structureId = String(representation.structureId);
    const combined = stylesByStructure.get(structureId) ?? {};
    const style = String(representation.style);
    if (style === 'line') combined.line = {};
    else if (style === 'stick') {
      combined.stick = { radius: MOLECULE_3D_BALL_AND_STICK_STYLE.stickRadius };
    } else if (style === 'sphere') {
      combined.sphere = { scale: MOLECULE_3D_BALL_AND_STICK_STYLE.sphereScale };
    } else combined.cartoon = { color: 'spectrum' };
    stylesByStructure.set(structureId, combined);
  }
  for (const [structureId, style] of stylesByStructure) {
    const model = models.get(structureId);
    model?.setStyle({}, style);
    const hydrogenColorStyle: Record<string, object> = {};
    if (style.line !== undefined) {
      hydrogenColorStyle.line = { color: '#94a3b8' };
    }
    if (style.stick !== undefined) {
      hydrogenColorStyle.stick = { color: '#94a3b8' };
    }
    if (style.sphere !== undefined) {
      hydrogenColorStyle.sphere = { color: '#cbd5e1' };
    }
    if (Object.keys(hydrogenColorStyle).length > 0) {
      model?.setStyle({ elem: 'H' }, hydrogenColorStyle, true);
    }
  }
  const atoms = [...models.values()].flatMap((model) => model.selectedAtoms({}));
  const bonds = new Set<string>();
  for (const atom of atoms) {
    for (const bondedIndex of Array.isArray(atom.bonds) ? atom.bonds : []) {
      bonds.add(
        [Number(atom.index), Number(bondedIndex)].sort((left, right) => left - right).join(':'),
      );
    }
  }
  target.dataset.reachScienceKitAtomCount = String(atoms.length);
  target.dataset.reachScienceKitBondCount = String(bonds.size);
  viewer.resize();
  viewer.zoomTo();
  viewer.zoom(2);
  viewer.render();
  const initialView = (viewer.getView() as unknown[]).map(Number);
  const reportViewChange = () => {
    requestAnimationFrame(() => {
      target.dispatchEvent(
        new CustomEvent('reach-science-kit-change', {
          detail: { kind: 'view', view: (viewer.getView() as unknown[]).map(Number) },
        }),
      );
    });
  };
  target.addEventListener('pointerup', reportViewChange);
  target.addEventListener('wheel', reportViewChange);
  return frozenController(
    () => {
      viewer.setView([...initialView]);
      viewer.render();
    },
    () => {
      viewer.clear();
      target.replaceChildren();
    },
    () => ({ view: (viewer.getView() as unknown[]).map(Number) }),
    (state) => {
      if (typeof state !== 'object' || state === null) return false;
      const view = (state as { view?: unknown }).view;
      if (
        !Array.isArray(view) ||
        view.length !== initialView.length ||
        !view.every((value) => Number.isFinite(value))
      )
        return false;
      viewer.setView(view.map(Number));
      viewer.render();
      return true;
    },
  );
});
