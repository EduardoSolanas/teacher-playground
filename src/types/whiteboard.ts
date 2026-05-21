export type ElementType =
  | "pen"
  | "text"
  | "rectangle"
  | "circle"
  | "line"
  | "arrow"
  | "stickyNote";

export type CanvasElement =
  | PenStroke
  | TextElement
  | RectangleElement
  | CircleElement
  | LineElement
  | ArrowElement
  | StickyNoteElement;

export type PenStroke = {
  id: string;
  type: "pen";
  points: { x: number; y: number }[];
  color: string;
  strokeWidth: number;
};

export type TextElement = {
  id: string;
  type: "text";
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  color: string;
  fontSize: number;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  rotation?: number;
};

export type RectangleElement = {
  id: string;
  type: "rectangle";
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  rotation?: number;
};

export type CircleElement = {
  id: string;
  type: "circle";
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  rotation?: number;
};

export type LineElement = {
  id: string;
  type: "line";
  points: { x: number; y: number }[];
  stroke: string;
  strokeWidth: number;
};

export type ArrowElement = {
  id: string;
  type: "arrow";
  points: { x: number; y: number }[];
  stroke: string;
  strokeWidth: number;
};

export type StickyNoteElement = {
  id: string;
  type: "stickyNote";
  x: number;
  y: number;
  width: number;
  height: number;
  content: string;
  backgroundColor: string;
  borderColor: string;
  borderRadius: number;
  rotation?: number;
};

export type RemoteCursor = {
  peerId: string;
  userName: string;
  color: string;
  x: number;
  y: number;
};

export type ToolType =
  | "select"
  | "pen"
  | "text"
  | "rectangle"
  | "circle"
  | "line"
  | "arrow"
  | "stickyNote"
  | "eraser";

export type PaletteSettings = {
  tool: ToolType;
  color: string;
  strokeWidth: number;
  fill: string;
};

export type Viewport = {
  x: number;
  y: number;
  zoom: number;
};

export type HistoryEntry = {
  elements: CanvasElement[];
};

export type WhiteboardRoom = {
  roomId: string;
  elements: CanvasElement[];
  viewport: Viewport;
  cursors: RemoteCursor[];
  users: WhiteboardUser[];
};

export type WhiteboardUser = {
  peerId: string;
  userName: string;
  color: string;
  isHost: boolean;
  isWaiting?: boolean;
};
