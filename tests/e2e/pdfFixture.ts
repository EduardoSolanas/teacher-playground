/**
 * A real, parseable PDF built rather than committed (spec/PDF_IMPORT_SPEC.md).
 *
 * Each page is US Letter and shows its own number in large Helvetica, so a test
 * can tell the pages apart and PDF.js exercises its standard-font path, not an
 * empty page. The cross-reference table carries exact byte offsets, so the
 * file opens without PDF.js having to repair it: a fixture that only loads
 * through the recovery path would prove less than a teacher's real worksheet.
 */
export function makePdf(pageCount: number): Buffer {
  const objects: string[] = [];
  // 1: catalog, 2: page tree, 3: font, then a page and its content per page.
  const pageIds = Array.from({ length: pageCount }, (_, index) => 4 + index * 2);
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let index = 0; index < pageCount; index += 1) {
    const pageId = pageIds[index];
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`,
    );
    const stream = `BT /F1 200 Tf 220 330 Td (${index + 1}) Tj ET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** Bytes that claim to be a PDF by name and are not one. */
export function makeNotAPdf(): Buffer {
  return Buffer.from('this is a lesson plan, not a PDF\n', 'utf8');
}
