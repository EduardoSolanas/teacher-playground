/** Top-left box in canvas space → Konva node anchored at center (for rotation). */
export function boxToKonvaRectProps(el: {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
}) {
  return {
    x: el.x + el.width / 2,
    y: el.y + el.height / 2,
    width: el.width,
    height: el.height,
    offsetX: el.width / 2,
    offsetY: el.height / 2,
    rotation: el.rotation ?? 0,
  };
}

export function boxToKonvaEllipseProps(el: {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
}) {
  return {
    x: el.x + el.width / 2,
    y: el.y + el.height / 2,
    radiusX: el.width / 2,
    radiusY: el.height / 2,
    rotation: el.rotation ?? 0,
  };
}

export function konvaRectNodeToBox(node: {
  x: () => number;
  y: () => number;
  offsetX: () => number;
  offsetY: () => number;
}) {
  return {
    x: node.x() - node.offsetX(),
    y: node.y() - node.offsetY(),
  };
}

export function konvaEllipseNodeToBox(node: {
  x: () => number;
  y: () => number;
  radiusX: () => number;
  radiusY: () => number;
}) {
  return {
    x: node.x() - node.radiusX(),
    y: node.y() - node.radiusY(),
  };
}
