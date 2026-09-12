/** Minimal typing for the pieces of fontkit the tests inspect. */
declare module 'fontkit' {
  export interface Glyph {
    id: number;
    name: string;
    advanceWidth: number;
    path: { commands: unknown[]; toSVG(): string };
  }
  export interface Font {
    numGlyphs: number;
    unitsPerEm: number;
    familyName: string;
    postscriptName: string;
    characterSet: number[];
    glyphForCodePoint(code: number): Glyph;
  }
  export function create(buffer: Buffer | Uint8Array): Font;
}
