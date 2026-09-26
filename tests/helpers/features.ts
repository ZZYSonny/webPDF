/** Resource/content port of .scratch/make-features.py. The test runs entirely
 * in TypeScript; binary streams are encoded as Latin-1 strings below.
 * Covers gradients, patterns, image masks, CMYK, stroke/clip text and soft masks.
 */
export const featureNames = ['axial extended', 'axial bounded', 'radial cone', 'radial band', 'function shading', 'tiling pattern', 'offset pattern', 'RGB image', 'stencil', 'CMYK image', 'stroked text', 'clipped text', 'luminosity mask', 'mesh shading', 'image soft mask', 'alpha mask'] as const;

export function featurePdf(): Uint8Array {
  const objects: Array<[number, string, string | null]> = [
    [1, "<< /Type /Catalog /Pages 2 0 R >>", null],
    [2, "<< /Type /Pages /Count 16 /Kids [140 0 R 141 0 R 142 0 R 143 0 R 144 0 R 145 0 R 146 0 R 147 0 R 148 0 R 149 0 R 150 0 R 151 0 R 152 0 R 153 0 R 154 0 R 155 0 R] >>", null],
    [3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", null],
    [10, "<< /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1.0 >>", null],
    [11, "<< /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1.0 >>", null],
    [12, "<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [50 50 250 50] /Function 10 0 R /Extend [true true] >>", null],
    [13, "<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [50 50 250 50] /Function 11 0 R /Extend [false false] >>", null],
    [14, "<< /FunctionType 2 /Domain [0 1] /C0 [0.2 0.2 0.2] /C1 [1 1 1] /N 0.7 >>", null],
    [15, "<< /ShadingType 3 /ColorSpace /DeviceRGB /Coords [100 60 0 100 60 60] /Function 14 0 R /Extend [true true] >>", null],
    [16, "<< /ShadingType 3 /ColorSpace /DeviceRGB /Coords [100 60 20 100 60 70] /Function 14 0 R /Extend [true true] >>", null],
    [17, "<< /FunctionType 4 /Domain [0 1 0 1] /Range [0 1] /Length 7 >>", "{ mul }"],
    [18, "<< /ShadingType 1 /ColorSpace /DeviceRGB /Domain [0 1 0 1] /Matrix [200 0 0 200 0 0] /Function 17 0 R /BBox [0 0 200 120] >>", null],
    [19, "<< /ShadingType 4 /ColorSpace /DeviceRGB /BitsPerCoordinate 16 /BitsPerComponent 8 /BitsPerFlag 8 /Decode [0 200 0 200 0 1 0 1 0 1] /BBox [0 0 200 200] /Length 24 >>", "\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u00ff\u00ff\u0000\u0000\u00ff\u0000\u0000\u0000\u0000\u0000\u00ff\u00ff\u0000\u0000\u00ff"],
    [20, "<< /Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 40 40] /XStep 40 /YStep 40 /Matrix [1 0 0 1 0 0] /Resources << >> /Length 50 >>", "1 0 0 rg 0 0 20 20 re f 0 0 1 rg 20 20 20 20 re f\n"],
    [21, "<< /Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [10 10 30 30] /XStep 40 /YStep 40 /Matrix [1 0 0 1 0 0] /Resources << >> /Length 28 >>", "0 0.7 0.2 rg 0 0 50 50 re f\n"],
    [22, "<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length 23 >>", "x\u009c\u00fb\u00cf\u00c0\u00c0\u00b0\u0080\u00e1?\u0098\u00843\u0080\u00e4\u007f\u001c\u00e2\u0000E\u00f3\f\u00f9"],
    [24, "<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceCMYK /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 513 >>", "000000000020000000400000006000000080000000A0000000C0000000E00000000020000020200000402000006020000080200000A0200000C0200000E02000000040000020400000404000006040000080400000A0400000C0400000E04000000060000020600000406000006060000080600000A0600000C0600000E06000000080000020800000408000006080000080800000A0800000C0800000E080000000A0000020A0000040A0000060A0000080A00000A0A00000C0A00000E0A0000000C0000020C0000040C0000060C0000080C00000A0C00000C0C00000E0C0000000E0000020E0000040E0000060E0000080E00000A0E00000C0E00000E0E000>"],
    [25, "<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ImageMask true /BitsPerComponent 1 /Decode [1 0] /Filter /ASCIIHexDecode /Length 17 >>", "C33CC33CC33CC33C>"],
    [26, "<< /Type /XObject /Subtype /Form /FormType 1 /BBox [0 0 120 60] /Group << /S /Transparency /CS /DeviceGray >> /Resources << >> /Length 107 >>", "0 g 0 0 20 60 re f\n0.25 g 20 0 20 60 re f\n0.5 g 40 0 20 60 re f\n0.75 g 60 0 20 60 re f\n1 g 80 0 20 60 re f\n"],
    [27, "<< /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 0.4 >>", null],
    [28, "<< /Type /ExtGState /SMask << /S /Luminosity /G 26 0 R /TR 27 0 R >> >>", null],
    [29, "<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 129 >>", "0000000000000000242424242424242448484848484848486C6C6C6C6C6C6C6C9090909090909090B4B4B4B4B4B4B4B4D8D8D8D8D8D8D8D8FCFCFCFCFCFCFCFC>"],
    [30, "<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /SMask 29 0 R /Length 513 >>", "000000000020000000400000006000000080000000A0000000C0000000E00000000020000020200000402000006020000080200000A0200000C0200000E02000000040000020400000404000006040000080400000A0400000C0400000E04000000060000020600000406000006060000080600000A0600000C0600000E06000000080000020800000408000006080000080800000A0800000C0800000E080000000A0000020A0000040A0000060A0000080A00000A0A00000C0A00000E0A0000000C0000020C0000040C0000060C0000080C00000A0C00000C0C00000E0C0000000E0000020E0000040E0000060E0000080E00000A0E00000C0E00000E0E000>"],
    [31, "<< /Type /XObject /Subtype /Form /FormType 1 /BBox [0 0 200 60] /Group << /S /Transparency /CS /DeviceGray >> /Resources << /ExtGState << /GSa 32 0 R >> >> /Length 39 >>", "/GSa gs 0.1 0.4 0.9 rg 0 0 200 60 re f\n"],
    [32, "<< /Type /ExtGState /ca 0.25 >>", null],
    [33, "<< /Type /ExtGState /SMask << /S /Alpha /G 31 0 R >> >>", null],
    [140, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 3 0 R >> /Shading << /Sh1 12 0 R >> >> /Contents 240 0 R  >>", null],
    [141, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 3 0 R >> /Shading << /Sh1 13 0 R >> >> /Contents 241 0 R  >>", null],
    [142, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 3 0 R >> /Shading << /Sh1 15 0 R >> >> /Contents 242 0 R  >>", null],
    [143, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 3 0 R >> /Shading << /Sh1 16 0 R >> >> /Contents 243 0 R  >>", null],
    [144, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 3 0 R >> /Shading << /Sh1 18 0 R >> >> /Contents 244 0 R  >>", null],
    [145, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 3 0 R >> /Pattern << /P1 20 0 R >> >> /Contents 245 0 R  >>", null],
    [146, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 3 0 R >> /Pattern << /P1 21 0 R >> >> /Contents 246 0 R  >>", null],
    [147, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 22 0 R >> >> /Contents 247 0 R  >>", null],
    [148, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 25 0 R >> >> /Contents 248 0 R  >>", null],
    [149, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 24 0 R >> >> /Contents 249 0 R  >>", null],
    [150, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 3 0 R >>  >> /Contents 250 0 R  >>", null],
    [151, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 3 0 R >>  >> /Contents 251 0 R  >>", null],
    [152, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 3 0 R >> /ExtGState << /GS1 28 0 R >> >> /Contents 252 0 R  >>", null],
    [153, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 3 0 R >> /Shading << /Sh1 19 0 R >> >> /Contents 253 0 R  >>", null],
    [154, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 30 0 R >> >> /Contents 254 0 R  >>", null],
    [155, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 3 0 R >> /ExtGState << /GS1 33 0 R >> >> /Contents 255 0 R  >>", null],
    [240, "<< /Length 12 >>", "q /Sh1 sh Q\n"],
    [241, "<< /Length 12 >>", "q /Sh1 sh Q\n"],
    [242, "<< /Length 12 >>", "q /Sh1 sh Q\n"],
    [243, "<< /Length 12 >>", "q /Sh1 sh Q\n"],
    [244, "<< /Length 12 >>", "q /Sh1 sh Q\n"],
    [245, "<< /Length 41 >>", "q /Pattern cs /P1 scn 0 0 400 300 re f Q\n"],
    [246, "<< /Length 41 >>", "q /Pattern cs /P1 scn 0 0 400 300 re f Q\n"],
    [247, "<< /Length 33 >>", "q 120 0 0 120 20 20 cm /Im1 Do Q\n"],
    [248, "<< /Length 48 >>", "0.1 0.2 0.7 rg q 160 0 0 160 20 20 cm /Im1 Do Q\n"],
    [249, "<< /Length 33 >>", "q 160 0 0 160 20 20 cm /Im1 Do Q\n"],
    [250, "<< /Length 61 >>", "BT /F1 60 Tf 2 Tr 2 w 0.1 0.3 0.8 RG 20 20 Td (STROKE) Tj ET\n"],
    [251, "<< /Length 72 >>", "BT /F1 60 Tf 7 Tr 20 20 Td (CLIP) Tj ET\n0.2 0.6 0.9 rg 0 0 400 120 re f\n"],
    [252, "<< /Length 90 >>", "q /GS1 gs 0.1 0.5 0.9 rg 0 0 400 300 re f Q\nq /GS1 gs 0.9 0.2 0.1 rg 60 60 200 120 re f Q\n"],
    [253, "<< /Length 12 >>", "q /Sh1 sh Q\n"],
    [254, "<< /Length 33 >>", "q 200 0 0 200 40 40 cm /Im1 Do Q\n"],
    [255, "<< /Length 46 >>", "q /GS1 gs 0.9 0.1 0.1 rg 40 40 300 200 re f Q\n"],
  ];
  const chunks: Buffer[] = [Buffer.from('%PDF-1.7\n')];
  const offsets = new Map<number, number>();
  let length = chunks[0].length;
  const append = (value: string, encoding: BufferEncoding = 'utf8') => {
    const bytes = Buffer.from(value, encoding); chunks.push(bytes); length += bytes.length;
  };
  for (const [id, body, stream] of objects) {
    offsets.set(id, length);
    append(`${id} 0 obj\n${body}\n`);
    if (stream !== null) { append('stream\n'); append(stream, 'latin1'); append('\nendstream\n'); }
    append('endobj\n');
  }
  const xref = length, count = Math.max(...offsets.keys()) + 1;
  append(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let id = 1; id < count; id++) {
    const offset = offsets.get(id);
    append(offset === undefined ? '0000000000 65535 f \n' : `${String(offset).padStart(10, '0')} 00000 n \n`);
  }
  append(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(chunks);
}
