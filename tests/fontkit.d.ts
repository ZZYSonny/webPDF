/** Minimal typing for the pieces of fontkit the tests inspect. */
declare module 'fontkit' {
  export interface Glyph {
    id: number;
    name: string;
    advanceWidth: number;
    path: { commands: unknown[]; toSVG(): string };
  }
  export interface LayoutRun {
    glyphs: Glyph[];
    positions: Array<{ xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }>;
  }
  export interface Font {
    numGlyphs: number;
    unitsPerEm: number;
    familyName: string;
    postscriptName: string;
    characterSet: number[];
    glyphForCodePoint(code: number): Glyph;
    /** Shape a string, applying the named OpenType features (or the defaults). */
    layout(text: string, features?: string[]): LayoutRun;
  }
  export function create(buffer: Buffer | Uint8Array): Font;
}
