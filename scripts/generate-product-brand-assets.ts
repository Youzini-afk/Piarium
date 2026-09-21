import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  VARIN_MARK_PATHS,
  VARIN_MARK_POLYGONS,
  VARIN_MARK_VIEWBOX,
} from '../packages/ui/src/components/ui/varin-mark';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronIcons = path.join(repoRoot, 'packages', 'electron', 'resources', 'icons');
const electronTray = path.join(electronIcons, 'tray');
const webPublic = path.join(repoRoot, 'packages', 'web', 'public');

const PRODUCT_BACKGROUND = '#efefe8';
const PRODUCT_INK = '#eeeee8';
const PRODUCT_SECONDARY_INK = '#8e9694';
const LIGHT_SURFACE_INK = '#20272a';
const LIGHT_SECONDARY_INK = '#77837f';

const save = async (target: string, bytes: string | Uint8Array): Promise<void> => {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
};

const alpha = (value: number): string => String(Math.round(value * 1_000) / 1_000);

const markBody = (ink: string, compact = false): string => VARIN_MARK_PATHS.map((path, index) => {
  const secondary = ink === PRODUCT_INK ? PRODUCT_SECONDARY_INK : LIGHT_SECONDARY_INK;
  return `<path d="${path}" fill="${index === 0 || compact ? ink : secondary}"/>`;
}).join('');

const transparentMarkSvg = ({
  compact = false,
  ink,
  size = 512,
}: {
  compact?: boolean;
  ink: string;
  size?: number;
}): string => `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${size}" height="${size}" viewBox="${VARIN_MARK_VIEWBOX}" xmlns="http://www.w3.org/2000/svg">
${markBody(ink, compact)}
</svg>
`;

const appIconSvg = (compact = false): string => `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
<rect x="64" y="64" width="896" height="896" rx="216" fill="${PRODUCT_BACKGROUND}"/>
<rect x="68" y="68" width="888" height="888" rx="212" fill="none" stroke="${LIGHT_SURFACE_INK}" stroke-opacity="0.08" stroke-width="8"/>
<svg x="${compact ? 64 : 142}" y="${compact ? 64 : 142}" width="${compact ? 896 : 740}" height="${compact ? 896 : 740}" viewBox="${VARIN_MARK_VIEWBOX}">
${markBody(LIGHT_SURFACE_INK, compact)}
</svg>
</svg>
`;

const iconComposerGlyphSvg = (ink: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
<svg x="152" y="152" width="720" height="720" viewBox="${VARIN_MARK_VIEWBOX}">
${markBody(ink)}
</svg>
</svg>
`;

const themedFaviconSvg = (): string => `<svg width="32" height="32" viewBox="${VARIN_MARK_VIEWBOX}" xmlns="http://www.w3.org/2000/svg">
<style>:root{color:${LIGHT_SURFACE_INK}}@media(prefers-color-scheme:dark){:root{color:${PRODUCT_INK}}}</style>
${markBody('currentColor', true)}
</svg>
`;

/** Native templates use a solid monochrome mark so tinting keeps both ribbons legible. */
const trayGlyphSvg = (): string => `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VARIN_MARK_VIEWBOX}">
${markBody('#000', true)}
</svg>
`;

/** Keep the existing tray breathing state while pulsing the flat mark. */
const trayFrameSvg = (fillLevel: number): string => {
  const clampedLevel = Math.min(1, Math.max(0, fillLevel));
  const markOpacity = alpha(0.7 + clampedLevel * 0.3);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VARIN_MARK_VIEWBOX}">
  <g opacity="${markOpacity}">${markBody('#fff', true)}</g>
</svg>
`;
};

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
const trayGlyph = trayGlyphSvg();
const productPng = await raster(productSvg, 1024);

await Promise.all([
  save(path.join(electronIcons, 'app-icon.svg'), productSvg),
  save(path.join(electronIcons, 'icon-win.svg'), productSvg),
  save(path.join(electronIcons, 'app-icon.png'), productPng),
  save(path.join(electronIcons, 'icon.png'), productPng),
  save(path.join(electronIcons, 'icon.ico'), await createIco()),
  save(path.join(electronIcons, 'icon.icns'), await createIcns()),
  save(path.join(electronTray, 'tray-glyph.svg'), trayGlyph),
  save(path.join(electronTray, 'trayTemplate-idle.png'), await raster(trayFrameSvg(0), 18)),
  save(path.join(electronTray, 'trayTemplate-idle@2x.png'), await raster(trayFrameSvg(0), 36)),
  save(path.join(electronTray, 'trayTemplate-unseen.png'), await raster(trayFrameSvg(1), 18)),
  save(path.join(electronTray, 'trayTemplate-unseen@2x.png'), await raster(trayFrameSvg(1), 36)),
  ...Array.from({ length: 16 }, async (_, index) => {
    const progress = index <= 8 ? index / 8 : (16 - index) / 8;
    const frame = String(index).padStart(2, '0');
    const [normal, retina] = await Promise.all([
      raster(trayFrameSvg(progress), 18),
      raster(trayFrameSvg(progress), 36),
    ]);
    return Promise.all([
      save(path.join(electronTray, `trayTemplate-breath-${frame}.png`), normal),
      save(path.join(electronTray, `trayTemplate-breath-${frame}@2x.png`), retina),
    ]);
  }),
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
  save(path.join(webPublic, 'pwa-192.png'), await raster(productSvg, 192)),
  save(path.join(webPublic, 'pwa-512.png'), await raster(productSvg, 512)),
  save(path.join(webPublic, 'pwa-maskable-192.png'), await raster(productSvg, 192)),
  save(path.join(webPublic, 'pwa-maskable-512.png'), await raster(productSvg, 512)),
  save(path.join(webPublic, 'apple-touch-icon.svg'), productSvg),
  save(path.join(webPublic, 'apple-touch-icon.png'), await raster(productSvg, 180)),
  ...[120, 152, 167, 180].map(async (size) => save(
    path.join(webPublic, `apple-touch-icon-${size}x${size}.png`),
    await raster(productSvg, size),
  )),

]);

// Keep the existing SF Symbols template metadata; regenerate its glyphs from the shared polygons.
const symbolPath = path.join(repoRoot, 'packages/mobile/ios/App/VarinWidget/Assets.xcassets/VarinLogoSymbol.symbolset/varin-logo-symbol.svg');
const symbolTemplate = await readFile(symbolPath, 'utf8');
const markPoints = VARIN_MARK_POLYGONS.flat();
const minX = Math.min(...markPoints.map(([x]) => x));
const maxX = Math.max(...markPoints.map(([x]) => x));
const minY = Math.min(...markPoints.map(([, y]) => y));
const maxY = Math.max(...markPoints.map(([, y]) => y));
const symbolScale = 70 / (maxY - minY);
const coordinate = (value: number): number => Math.round(value * 1_000) / 1_000;
const symbolGroups = ['Ultralight', 'Regular', 'Black'].map((weight, index) => {
  const centerX = 265 + index * 200;
  const paths = VARIN_MARK_POLYGONS.map((points) => `<path d="M${points.map(([x, y]) => `${coordinate(centerX + x * symbolScale)},${coordinate(111 + y * symbolScale)}`).join(' L')} Z"/>`).join('');
  return `<g id="${weight}-S">${paths}</g>`;
}).join('\n');
const symbolHeader = symbolTemplate.slice(0, symbolTemplate.indexOf('    <g id="Symbols">'))
  .replace(/(<path id="(left|right)-margin-(Ultralight|Regular|Black)-S" d="M)[\d.]+/g, (_match, prefix, side, weight) => {
    const centerX = 265 + ['Ultralight', 'Regular', 'Black'].indexOf(weight) * 200;
    return `${prefix}${coordinate(centerX + (side === 'left' ? minX : maxX) * symbolScale)}`;
  });
await save(symbolPath, `${symbolHeader}    <g id="Symbols">\n${symbolGroups}\n    </g>\n</svg>\n`);

console.log('[branding] Generated Varin desktop, Web, and Widget assets from the approved fold mark.');
