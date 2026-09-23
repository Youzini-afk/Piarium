declare module "pdfjs-dist/legacy/build/pdf.mjs" {
  export interface PdfPage {
    getTextContent(): Promise<{
      items: Array<{
        str?: string;
        transform?: number[];
        width?: number;
        height?: number;
        fontName?: string;
        hasEOL?: boolean;
      }>;
    }>;
    getViewport(params: { scale: number }): { width: number; height: number };
    getOperatorList(): Promise<{ fnArray: number[] }>;
  }
  export interface PdfDocument {
    numPages: number;
    getPage(n: number): Promise<PdfPage>;
  }
  export function getDocument(params: { data: ArrayBuffer; disableWorker?: boolean }): { promise: Promise<PdfDocument> };
  export const OPS: Record<string, number>;
}
