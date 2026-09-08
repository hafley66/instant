// A real PDF on disk, ⌘-clicked open from terminal output, rendered by the
// app's pdf.js viewer. Receipts are the viewer's own DOM: one page, a painted
// canvas, selectable text, and the page count in the toolbar.
import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { boot, clickToken, killAllSessions, mkRepo, openSessionTab, shot } from "./0_real";

// A one-page PDF holding one line of extractable text, assembled with a correct
// xref so pdf.js needs no recovery pass.
function writePdf(file: string): void {
  const stream = "BT /F1 24 Tf 72 720 Td (Instant PDF receipt) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  writeFileSync(file, out, "latin1");
}

test.afterAll(() => {
  if (process.env.INSTANT_E2E_KEEP) return;
  killAllSessions();
});

test("PDF.js renders a canvas and selectable text", async ({ page }) => {
  await boot(page);
  const dir = mkRepo({ "keep.txt": "x" });
  writePdf(path.join(dir, "receipt.pdf"));
  const session = await openSessionTab(page, dir);
  await clickToken(page, session, "  see receipt.pdf for the numbers", "receipt.pdf");

  await expect(page.locator(".pdfViewer .page")).toHaveCount(1);
  await expect(page.locator(".pdfViewer canvas")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".pdfViewer .textLayer")).toContainText("Instant PDF receipt");
  await expect(page.getByText("1 pages", { exact: true })).toBeVisible();
  await shot(page, "pdf-01-rendered");
});
