import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  LOGO_LEFT_FACE_CELLS,
  LOGO_LEFT_FACE_PATH,
  LOGO_PROJECTED_MARK_PATH,
  LOGO_RIGHT_FACE_CELLS,
  LOGO_RIGHT_FACE_PATH,
  LOGO_STROKE_WIDTH,
  LOGO_TOP_FACE_PATH,
  leftFaceCellOpacity,
  rightFaceCellOpacity,
} from '../packages/ui/src/components/ui/piarium-logo-geometry';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronIcons = path.join(repoRoot, 'packages', 'electron', 'resources', 'icons');
const webPublic = path.join(repoRoot, 'packages', 'web', 'public');
const vscodeAssets = path.join(repoRoot, 'packages', 'vscode', 'assets');

const PRODUCT_BACKGROUND = '#151313';
const PRODUCT_INK = '#f5f5f5';
const LIGHT_SURFACE_INK = '#151313';

const save = async (target: string, bytes: string | Uint8Array): Promise<void> => {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
};

const alpha = (value: number): string => String(Math.round(value * 1_000) / 1_000);

const faceCells = (
  cells: typeof LOGO_LEFT_FACE_CELLS,
  opacityAt: (cell: (typeof cells)[number]) => number,
  ink: string,
  compact: boolean,
): string => compact
  ? ''
  : cells.map((cell) => (
    `<path d="${cell.path}" fill="${ink}" fill-opacity="${alpha(opacityAt(cell) * 0.35)}"/>`
  )).join('');

const markBody = (ink: string, compact = false): string => {
  const strokeWidth = compact ? 3.4 : LOGO_STROKE_WIDTH;
  return [
    `<path d="${LOGO_LEFT_FACE_PATH}" fill="${ink}" fill-opacity="0.15"/>`,
    faceCells(LOGO_LEFT_FACE_CELLS, leftFaceCellOpacity, ink, compact),
    `<path d="${LOGO_RIGHT_FACE_PATH}" fill="${ink}" fill-opacity="0.15"/>`,
    faceCells(LOGO_RIGHT_FACE_CELLS, rightFaceCellOpacity, ink, compact),
    `<path d="${LOGO_TOP_FACE_PATH}" fill="${ink}" fill-opacity="0.1"/>`,
    `<g fill="none" stroke="${ink}" stroke-width="${strokeWidth}" stroke-linejoin="round">`,
    `<path d="${LOGO_LEFT_FACE_PATH}"/><path d="${LOGO_RIGHT_FACE_PATH}"/><path d="${LOGO_TOP_FACE_PATH}"/>`,
    '</g>',
    `<path d="${LOGO_PROJECTED_MARK_PATH}" fill="${ink}"/>`,
  ].join('');
};

const transparentMarkSvg = ({
  compact = false,
  ink,
  size = 512,
}: {
  compact?: boolean;
  ink: string;
  size?: number;
}): string => `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
${markBody(ink, compact)}
</svg>
`;

const appIconSvg = (compact = false): string => `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
<rect x="64" y="64" width="896" height="896" rx="216" fill="${PRODUCT_BACKGROUND}"/>
<rect x="68" y="68" width="888" height="888" rx="212" fill="none" stroke="${PRODUCT_INK}" stroke-opacity="0.08" stroke-width="8"/>
<svg x="142" y="132" width="740" height="740" viewBox="0 0 100 100">
${markBody(PRODUCT_INK, compact)}
</svg>
</svg>
`;

const iconComposerGlyphSvg = (ink: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
<svg x="152" y="142" width="720" height="720" viewBox="0 0 100 100">
${markBody(ink)}
</svg>
</svg>
`;

const themedFaviconSvg = (): string => `<svg width="32" height="32" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
<style>:root{color:${LIGHT_SURFACE_INK}}@media(prefers-color-scheme:dark){:root{color:${PRODUCT_INK}}}</style>
${markBody('currentColor', true)}
</svg>
`;

const raster = async (svg: string, size: number): Promise<Buffer> => sharp(Buffer.from(svg))
  .resize(size, size, { fit: 'fill' })
  .png()
  .toBuffer();

const createIco = async (): Promise<Buffer> => {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = await Promise.all(sizes.map((size) => raster(appIconSvg(size <= 32), size)));
  const headerSize = 6 + images.length * 16;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = headerSize;
  images.forEach((image, index) => {
    const size = sizes[index] as number;
    const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header[entry + 2] = 0;
    header[entry + 3] = 0;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  });
  return Buffer.concat([header, ...images]);
};

const createIcns = async (): Promise<Buffer> => {
  const entries: ReadonlyArray<readonly [string, number]> = [
    ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128],
    ['ic08', 256], ['ic09', 512], ['ic10', 1024],
  ];
  const chunks = await Promise.all(entries.map(async ([type, size]) => {
    const image = await raster(appIconSvg(size <= 32), size);
    const chunk = Buffer.alloc(8 + image.length);
    chunk.write(type, 0, 4, 'ascii');
    chunk.writeUInt32BE(chunk.length, 4);
    image.copy(chunk, 8);
    return chunk;
  }));
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
};

const productSvg = appIconSvg();
const darkMarkSvg = transparentMarkSvg({ ink: PRODUCT_INK });
const lightMarkSvg = transparentMarkSvg({ ink: LIGHT_SURFACE_INK });
const compactCurrentColor = transparentMarkSvg({ compact: true, ink: 'currentColor', size: 24 });
const compactDarkSurface = transparentMarkSvg({ compact: true, ink: PRODUCT_INK, size: 24 });
const productPng = await raster(productSvg, 1024);

await Promise.all([
  save(path.join(electronIcons, 'app-icon.svg'), productSvg),
  save(path.join(electronIcons, 'icon-win.svg'), productSvg),
  save(path.join(electronIcons, 'app-icon.png'), productPng),
  save(path.join(electronIcons, 'icon.png'), productPng),
  save(path.join(electronIcons, 'icon.ico'), await createIco()),
  save(path.join(electronIcons, 'icon.icns'), await createIcns()),
  save(path.join(electronIcons, 'AppIcon.icon', 'Assets', 'app-icon-glyph-dark 4.png'), await raster(iconComposerGlyphSvg(PRODUCT_INK), 1024)),
  save(path.join(electronIcons, 'AppIcon.icon', 'Assets', 'app-icon-glyph-light 2.png'), await raster(iconComposerGlyphSvg(LIGHT_SURFACE_INK), 1024)),

  save(path.join(webPublic, 'logo-dark-512x512.svg'), darkMarkSvg),
  save(path.join(webPublic, 'logo-light-512x512.svg'), lightMarkSvg),
  save(path.join(webPublic, 'logo-dark-192x192.png'), await raster(darkMarkSvg, 192)),
  save(path.join(webPublic, 'logo-light-192x192.png'), await raster(lightMarkSvg, 192)),
  save(path.join(webPublic, 'favicon.svg'), themedFaviconSvg()),
  save(path.join(webPublic, 'favicon-16.png'), await raster(appIconSvg(true), 16)),
  save(path.join(webPublic, 'favicon-32.png'), await raster(appIconSvg(true), 32)),
  save(path.join(webPublic, 'favicon.png'), await raster(productSvg, 64)),
  save(path.join(webPublic, 'apple-touch-icon.svg'), productSvg),
  save(path.join(webPublic, 'apple-touch-icon.png'), await raster(productSvg, 180)),
  ...[120, 152, 167, 180].map(async (size) => save(
    path.join(webPublic, `apple-touch-icon-${size}x${size}.png`),
    await raster(productSvg, size),
  )),

  save(path.join(vscodeAssets, 'app-icon.png'), await raster(productSvg, 512)),
  save(path.join(vscodeAssets, 'icon.svg'), compactCurrentColor),
  save(path.join(vscodeAssets, 'icon-titlebar.svg'), compactDarkSurface),
]);

console.log('[branding] Generated Piarium desktop, Web, README, and VS Code assets from the splash mark.');
