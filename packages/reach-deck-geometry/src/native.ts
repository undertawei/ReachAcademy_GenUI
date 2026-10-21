import JSXGraph from 'jsxgraph';

export interface NativeElement {
  id: string;
  elType: string;
  X(): number;
  Y(): number;
  Z(): number;
  Radius(): number;
  coords: number[];
  matrix: number[][];
  vec1: number[];
  vec: number[];
  vec2: number[];
  normal: number[];
  point: NativeElement;
  point1: NativeElement;
  point2: NativeElement;
  center: NativeElement;
  objects: Record<string, NativeElement>;
  create(kind: string, parents: unknown[], attributes: Record<string, unknown>): NativeElement;
  addParents?(parents: NativeElement[]): void;
  addChild?(child: NativeElement): void;
  prepareUpdate?(): NativeElement;
  update(): NativeElement;
  updateNormal?(): NativeElement;
  removeObject(element: NativeElement): void;
  setAttribute(attributes: Record<string, unknown>): NativeElement;
  updateVisibility(visible?: boolean): NativeElement;
  updateRenderer(): NativeElement;
  hasPoint(x: number, y: number): boolean;
  rendNode?: SVGElement;
}
export interface NativeBoard {
  id: string;
  renderer?: unknown;
  animationIntervalCode?: ReturnType<typeof setInterval>;
  animationObjects: Record<string, unknown>;
  objects: Record<string, NativeElement>;
  objectsList: NativeElement[];
  jc: { creator: { clearCache(): void } };
  create(kind: string, parents: unknown[], attributes: Record<string, unknown>): NativeElement;
  removeObject(element: NativeElement): void;
  suspendUpdate(): void;
  removeEventHandlers(): void;
  containerObj?: HTMLElement;
  origin: { scrCoords: number[] };
  unitX: number;
  unitY: number;
  options: { precision: { hasPoint: number } };
  resizeContainer(
    width: number,
    height: number,
    dontSet?: boolean,
    dontSetBoundingBox?: boolean,
  ): void;
  setBoundingBox(bounds: number[], keepAspectRatio?: boolean): void;
}
interface TrustedLibrary {
  Options: Record<string, unknown>;
  boards: Record<string, NativeBoard>;
  Board: new (...args: unknown[]) => NativeBoard;
  NoRenderer: new () => unknown;
  JSXGraph: {
    initBoard(container: HTMLElement, attributes: Record<string, unknown>): NativeBoard;
    _setAttributes(
      value: Record<string, unknown>,
      options: Record<string, unknown>,
    ): Record<string, unknown>;
    _fillBoard(
      board: NativeBoard,
      attributes: Record<string, unknown>,
      size: { width: number; height: number },
    ): void;
  };
  Math: {
    axpy(factor: number, vector: number[], origin: number[]): number[];
    innerProduct(a: number[], b: number[], dimension: number): number;
    crossProduct(a: number[], b: number[]): number[];
    matVecMult(matrix: number[][], vector: number[]): number[];
    Geometry: {
      project3DTo3DPlane(point: number[], normal: number[], origin: number[]): number[];
      meet3Planes(
        n1: number[],
        d1: number,
        n2: number[],
        d2: number,
        n3: number[],
        d3: number,
      ): number[];
      meetLineCircle(
        line: number[],
        circle: number[],
        branch: number,
        board: NativeBoard,
      ): { usrCoords: number[] };
      meetLineLine(
        first: number[],
        second: number[],
        index: number,
        board: NativeBoard,
      ): { usrCoords: number[] };
    };
  };
}
const library = JSXGraph as unknown as TrustedLibrary;
export const math = library.Math;
export const geometry = math.Geometry;

export function createBoard(planar?: {
  container: HTMLElement;
  bounds: readonly [number, number, number, number];
  ariaLabel: string;
}): NativeBoard {
  if (planar) {
    const { container, bounds, ariaLabel } = planar;
    if (!container || container.nodeType !== 1 || !container.ownerDocument)
      throw new Error('invalid_planar_container');
    if (!container.id) container.id = `reach-geometry-${globalThis.crypto.randomUUID()}`;
    const board = library.JSXGraph.initBoard(container, {
      renderer: 'svg',
      registerEvents: false,
      showNavigation: false,
      showCopyright: false,
      title: ariaLabel,
      axis: false,
      grid: false,
      showInfobox: false,
      boundingbox: [bounds[0], bounds[3], bounds[2], bounds[1]],
      keepaspectratio: true,
      pan: { enabled: false },
      zoom: { enabled: false },
      keyboard: { enabled: false },
      selection: { enabled: false },
      resize: { enabled: false },
    });
    board.suspendUpdate();
    return board;
  }
  const attributes = library.JSXGraph._setAttributes(
    {
      renderer: 'no',
      registerEvents: false,
      showNavigation: false,
      showCopyright: false,
      resize: { enabled: false },
    },
    library.Options,
  );
  const board = new library.Board(
    '',
    new library.NoRenderer(),
    '',
    [400, 300],
    1,
    1,
    50,
    50,
    800,
    600,
    attributes,
  );
  try {
    library.JSXGraph._fillBoard(board, attributes, { width: 800, height: 600 });
    board.suspendUpdate();
    return board;
  } catch (error) {
    disposeBoard(board);
    throw error;
  }
}

export function createView(board: NativeBoard): NativeElement {
  const attributes: Record<string, unknown> = {
    axesPosition: 'none',
    projection: 'parallel',
    az: { slider: { visible: false } },
    el: { slider: { visible: false } },
    bank: { slider: { visible: false } },
  };
  // The six default surface planes enter an upstream DOM-dependent tiling path.
  for (const axis of ['x', 'y', 'z'])
    for (const side of ['Rear', 'Front'])
      attributes[`${axis}Plane${side}`] = { visible: false, type: 'wireframe' };
  return board.create(
    'view3d',
    [
      [-6, -5],
      [10, 9],
      [
        [-1, 5],
        [-1, 4],
        [-1, 8],
      ],
    ],
    attributes,
  );
}

export function disposeBoard(board: NativeBoard): void {
  if (!board.renderer) return;
  if (board.animationIntervalCode) clearInterval(board.animationIntervalCode);
  board.animationObjects = {};
  board.removeEventHandlers();
  board.suspendUpdate();
  // freeBoard assumes a DOM container, including when its renderer is NoRenderer.
  try {
    for (const element of [...board.objectsList])
      if (element.elType === 'view3d') {
        for (const child of Object.values(element.objects))
          if (board.objects[child.id]) element.removeObject(child);
      }
    for (const element of [...board.objectsList].reverse())
      if (board.objects[element.id]) board.removeObject(element);
  } finally {
    board.objects = {};
    board.objectsList = [];
    board.jc.creator.clearCache();
    delete library.boards[board.id];
    delete board.renderer;
    if (board.containerObj) board.containerObj.replaceChildren();
  }
}

export function nativeBoardCount(): number {
  return Object.keys(library.boards).length;
}
