/** Small, deterministic PDFs for tests; no downloaded corpus or PDF library. */
export function textPdf(pages = 1, font = 'Helvetica', label = 'Recovery works', width = 240, height = 160, lines = 1): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages} >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /${font} >>`,
  ];
  for (let i = 0; i < pages; i++) {
    const escaped = `${label} ${i + 1}`.replace(/[\\()]/g, '\\$&');
    const content = Array.from({ length: lines }, (_, line) => `BT /F1 18 Tf 20 ${height - 60 - line * 24} Td (${escaped}) Tj ET\n`).join('');
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    );
  }
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
