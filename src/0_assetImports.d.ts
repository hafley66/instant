declare module "*?url" {
  const url: string;
  export default url;
}

declare module "*.css";

declare module "pdfjs-dist/build/pdf.mjs" {
  export * from "pdfjs-dist/types/src/pdf.d.ts";
}
