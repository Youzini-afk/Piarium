declare module 'yazl' {
  import type { Readable } from 'stream';

  interface ZipFileOptions {
    mtime?: Date | undefined;
    mode?: number | undefined;
    compress?: boolean | undefined;
    forceZip64Format?: boolean | undefined;
  }

  export class ZipFile {
    outputStream: Readable;
    addFile(path: string, metadataPath: string, options?: ZipFileOptions): void;
    addEmptyDirectory(metadataPath: string, options?: ZipFileOptions): void;
    addReadStream(readStream: Readable, metadataPath: string, options?: ZipFileOptions): void;
    end(options?: { forceZip64Format?: boolean | undefined }): void;
  }
}
