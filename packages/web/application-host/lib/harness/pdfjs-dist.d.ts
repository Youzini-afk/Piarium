declare module "pdfjs-dist/legacy/build/pdf.mjs" {
  export interface PdfPage {
    getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
  }
  export interface PdfDocument {
    numPages: number;
    getPage(n: number): Promise<PdfPage>;
  }
  export function getDocument(params: { data: ArrayBuffer }): { promise: Promise<PdfDocument> };
}
