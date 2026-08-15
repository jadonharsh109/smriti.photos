declare module "justified-layout" {
  interface Box {
    aspectRatio: number;
    top: number;
    left: number;
    width: number;
    height: number;
  }
  interface Result {
    containerHeight: number;
    boxes: Box[];
  }
  interface Options {
    containerWidth?: number;
    containerPadding?: number | { top: number; right: number; bottom: number; left: number };
    boxSpacing?: number | { horizontal: number; vertical: number };
    targetRowHeight?: number;
    targetRowHeightTolerance?: number;
    maxNumRows?: number;
    forceAspectRatio?: number | boolean;
    showWidows?: boolean;
    fullWidthBreakoutRowCadence?: number | boolean;
  }
  export default function justifiedLayout(
    input: number[] | { width: number; height: number }[],
    options?: Options
  ): Result;
}
