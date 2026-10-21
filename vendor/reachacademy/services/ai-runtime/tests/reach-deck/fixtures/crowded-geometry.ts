/**
 * Two similar triangles (ratio k, `gap` apart) with six side labels and four angle values.
 * The default spacing is too dense to label cleanly in a 560x420 slot even at the 18px floor.
 */
export function crowdedSimilarTriangles(gap = 1, k = 0.5) {
  const pt = (id: string, x: number, y: number) => ({
    id,
    kind: 'point',
    x,
    y,
    label: id,
    color: 'ink',
    hidden: false,
  });
  const side = (id: string, a: string, b: string, label: string) => ({
    id,
    kind: 'segment',
    a,
    b,
    label,
    color: 'ink',
    lineStyle: 'solid',
    hidden: false,
  });
  const triangle = (id: string, vertices: string[]) => ({
    id,
    kind: 'polygon',
    vertices,
    label: null,
    color: 'ink',
    lineStyle: 'solid',
    hidden: false,
  });
  const angle = (id: string, a: string, vertex: string, b: string) => ({
    id,
    kind: 'threePointAngle',
    a,
    vertex,
    b,
    label: null,
    show: 'value',
    decimals: 0,
  });
  return {
    ariaLabel: '相似三角形 ABC 与 DEF',
    units: 'unit',
    objects: [
      pt('A', 0, 0),
      pt('B', 4, 0),
      pt('C', 1, 3),
      pt('D', 4 + gap, 0),
      pt('E', 4 + gap + 4 * k, 0),
      pt('F', 4 + gap + k, 3 * k),
      triangle('ABC', ['A', 'B', 'C']),
      triangle('DEF', ['D', 'E', 'F']),
      side('AB', 'A', 'B', 'AB=4'),
      side('BC', 'B', 'C', 'BC=4.24'),
      side('CA', 'C', 'A', 'CA=3.16'),
      side('DE', 'D', 'E', 'DE=2'),
      side('EF', 'E', 'F', 'EF=2.12'),
      side('FD', 'F', 'D', 'FD=1.58'),
    ],
    measurements: [
      angle('a1', 'B', 'A', 'C'),
      angle('d1', 'E', 'D', 'F'),
      angle('b1', 'C', 'B', 'A'),
      angle('e1', 'F', 'E', 'D'),
    ],
    assertions: [],
    rightAngles: [],
  };
}
