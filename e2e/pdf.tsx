import { createRoot } from "react-dom/client";
import { PdfDocumentViewer } from "../src/1_PdfDocumentViewer";
import "../src/styles.css";

function receiptPdf(): string {
  const content = "BT /F1 28 Tf 72 720 Td (Instant PDF receipt) Tj 0 -44 Td /F1 16 Tf (Rendered by asynchronously loaded PDF.js) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return `data:application/pdf;base64,${btoa(pdf)}`;
}

createRoot(document.getElementById("root")!).render(
  <div style={{ width: "1100px", height: "760px" }}>
    <PdfDocumentViewer path="/tmp/instant-pdf-receipt.pdf" url={receiptPdf()} />
  </div>,
);
