declare module 'multer' {
  interface MulterLimits {
    fileSize?: number | undefined;
    files?: number | undefined;
    fields?: number | undefined;
    parts?: number | undefined;
    fieldSize?: number | undefined;
    headerPairs?: number | undefined;
  }

  interface MulterOptions {
    storage?: unknown;
    dest?: string | undefined;
    defParamCharset?: string | undefined;
    limits?: MulterLimits | undefined;
    fileFilter?: ((req: unknown, file: unknown, cb: (error: Error | null, accept: boolean) => void) => void) | undefined;
  }

  type RequestHandler = (req: unknown, res: unknown, next: (error?: Error) => void) => void;

  interface Multer {
    single(fieldname: string): RequestHandler;
    array(fieldname: string, maxCount?: number): RequestHandler;
    fields(fields: { name: string; maxCount?: number | undefined }[]): RequestHandler;
    none(): RequestHandler;
    any(): RequestHandler;
  }

  function multer(options?: MulterOptions): Multer;

  namespace multer {
    function memoryStorage(): unknown;
    function diskStorage(options: {
      destination?: ((req: unknown, file: unknown, cb: (error: Error | null, destination: string) => void) => void) | string | undefined;
      filename?: ((req: unknown, file: unknown, cb: (error: Error | null, filename: string) => void) => void) | undefined;
    }): unknown;
  }

  export default multer;
}
