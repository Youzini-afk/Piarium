import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const productIconPath = resolve(mobileRoot, '..', 'electron', 'resources', 'icons', 'app-icon.png');
const darkSurfaceMarkPath = resolve(mobileRoot, '..', 'web', 'public', 'logo-dark-512x512.svg');
const lightSurfaceMarkPath = resolve(mobileRoot, '..', 'web', 'public', 'logo-light-512x512.svg');
const androidRes = join(mobileRoot, 'android', 'app', 'src', 'main', 'res');
const iosAssets = join(mobileRoot, 'ios', 'App', 'App', 'Assets.xcassets');
const brandAssets = join(mobileRoot, 'assets');
const background = '#151313';
const splashBackground = '#f7f4eb';

const ensureParent = async (path) => mkdir(dirname(path), { recursive: true });
const save = async (path, bytes) => {
  await ensureParent(path);
  await writeFile(path, bytes);
};

const productIcon = await sharp(productIconPath).resize(1024, 1024).png().toBuffer();
const glyph = await sharp(darkSurfaceMarkPath).resize(1024, 1024).png().toBuffer();
const lightSurfaceMark = await sharp(lightSurfaceMarkPath).resize(1024, 1024).png().toBuffer();
const solidBackground = await sharp({
  create: { width: 1024, height: 1024, channels: 4, background },
}).png().toBuffer();

await save(join(brandAssets, 'icon-only.png'), productIcon);
await save(join(brandAssets, 'icon-foreground.png'), glyph);
await save(join(brandAssets, 'icon-background.png'), solidBackground);
await save(join(iosAssets, 'AppIcon.appiconset', 'AppIcon-512@2x.png'), productIcon);

const densitySizes = new Map([
  ['ldpi', 36],
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192],
]);

for (const [density, size] of densitySizes) {
  const directory = join(androidRes, `mipmap-${density}`);
  const icon = await sharp(productIcon).resize(size, size).png().toBuffer();
  const foregroundSize = Math.max(1, Math.round(size * 0.72));
  const inset = Math.floor((size - foregroundSize) / 2);
  const foreground = await sharp(glyph)
    .resize(foregroundSize, foregroundSize, { fit: 'contain' })
    .extend({
      top: inset,
      bottom: size - foregroundSize - inset,
      left: inset,
      right: size - foregroundSize - inset,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
  const adaptiveBackground = await sharp({
    create: { width: size, height: size, channels: 4, background },
  }).png().toBuffer();

  await save(join(directory, 'ic_launcher.png'), icon);
  await save(join(directory, 'ic_launcher_round.png'), icon);
  await save(join(directory, 'ic_launcher_foreground.png'), foreground);
  await save(join(directory, 'ic_launcher_background.png'), adaptiveBackground);
}

const renderSplash = async (width, height) => {
  const markSize = Math.max(72, Math.round(Math.min(width, height) * 0.28));
  const mark = await sharp(lightSurfaceMark).resize(markSize, markSize).png().toBuffer();
  return sharp({
    create: { width, height, channels: 4, background: splashBackground },
  })
    .composite([{ input: mark, gravity: 'centre' }])
    .png()
    .toBuffer();
};

const androidSplashes = [
  ['drawable/splash.png', 480, 320],
  ['drawable-land-mdpi/splash.png', 480, 320],
  ['drawable-land-hdpi/splash.png', 800, 480],
  ['drawable-land-xhdpi/splash.png', 1280, 720],
  ['drawable-land-xxhdpi/splash.png', 1600, 960],
  ['drawable-land-xxxhdpi/splash.png', 1920, 1280],
  ['drawable-port-mdpi/splash.png', 320, 480],
  ['drawable-port-hdpi/splash.png', 480, 800],
  ['drawable-port-xhdpi/splash.png', 720, 1280],
  ['drawable-port-xxhdpi/splash.png', 960, 1600],
  ['drawable-port-xxxhdpi/splash.png', 1280, 1920],
];

for (const [relativePath, width, height] of androidSplashes) {
  await save(join(androidRes, relativePath), await renderSplash(width, height));
}

const iosSplash = await renderSplash(2732, 2732);
for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
  await save(join(iosAssets, 'Splash.imageset', name), iosSplash);
}

console.log('[mobile] Generated Piarium launcher, adaptive, and splash assets.');
