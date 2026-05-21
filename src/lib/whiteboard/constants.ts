export const COLOR_PRESETS = [
  '#000000',
  '#e74c3c',
  '#e67e22',
  '#f1c40f',
  '#2ecc71',
  '#3498db',
  '#9b59b6',
  '#1abc9c',
  '#e91e63',
  '#607d8b',
] as const;

export const STROKE_WIDTHS = [1, 2, 3, 5, 8, 12] as const;

export const STICKY_NOTE_COLORS = [
  '#fff9c4',
  '#f8bbd0',
  '#bbdefb',
  '#c8e6c9',
  '#ffe0b2',
] as const;

export const TOOL_SHORTCUTS: Record<string, string> = {
  select: 'V',
  pen: 'P',
  text: 'T',
  rectangle: 'R',
  circle: 'C',
  line: 'L',
  arrow: 'A',
  stickyNote: 'S',
  eraser: 'E',
};

export const ZOOM_RANGE = {
  min: 0.1,
  max: 5.0,
};
