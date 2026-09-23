declare module "pdfjs-dist/legacy/build/pdf.mjs" {
  export interface PdfPage {
    getTextContent(): Promise<{
      items: Array<{
        str?: string;
        transform?: number[];
        hasEOL?: boolean;
      }>;
    }>;
  }
  export interface PdfDocument {
    numPages: number;
    getPage(n: number): Promise<PdfPage>;
  }
  export function getDocument(params: { data: ArrayBuffer; disableWorker?: boolean }): { promise: Promise<PdfDocument> };
}
