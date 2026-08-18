import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const mobileRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (...segments) => readFileSync(join(mobileRoot, ...segments), 'utf8');

const collectTextFiles = (directory, result = []) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['build', 'dist', 'Pods'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectTextFiles(path, result);
    } else if (/\.(?:gradle|java|json|mjs|plist|pbxproj|swift|ts|xcprivacy|xcscheme|xml)$/i.test(entry.name)) {
      result.push(path);
    }
  }
  return result;
};

test('native shells use the Piarium application identity', () => {
  assert.match(read('capacitor.config.ts'), /appId: 'dev\.piarium\.mobile'/);
  assert.match(read('capacitor.config.ts'), /appName: 'Piarium'/);
  assert.match(read('android', 'app', 'build.gradle'), /applicationId "dev\.piarium\.mobile"/);
  assert.match(read('android', 'app', 'src', 'main', 'res', 'values', 'strings.xml'), /<string name="custom_url_scheme">piarium<\/string>/);
  assert.match(read('android', 'app', 'src', 'main', 'AndroidManifest.xml'), /android\.intent\.category\.BROWSABLE/);
  assert.ok(existsSync(join(mobileRoot, 'android', 'app', 'src', 'main', 'java', 'dev', 'piarium', 'mobile', 'MainActivity.java')));

  const project = read('ios', 'App', 'App.xcodeproj', 'project.pbxproj');
  assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER = dev\.piarium\.mobile;/);
  assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER = dev\.piarium\.mobile\.widget;/);
  assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER = dev\.piarium\.mobile\.notification-service;/);
  assert.match(project, /path = PiariumWidget;/);
  assert.match(project, /path = PiariumNotificationService;/);
  assert.match(project, /path = PiariumWidgets\.swift;/);
  assert.match(project, /path = PiariumControl\.swift;/);
  assert.match(read('ios', 'App', 'App', 'Info.plist'), /<string>piarium<\/string>/);
  for (const relative of [
    ['ios', 'App', 'App', 'App.entitlements'],
    ['ios', 'App', 'PiariumWidget', 'PiariumWidget.entitlements'],
    ['ios', 'App', 'PiariumNotificationService', 'PiariumNotificationService.entitlements'],
  ]) {
    assert.match(read(...relative), /group\.dev\.piarium\.mobile/);
  }
  assert.ok(existsSync(join(mobileRoot, 'ios', 'App', 'App.xcodeproj', 'xcshareddata', 'xcschemes', 'PiariumWidget.xcscheme')));
  assert.ok(existsSync(join(mobileRoot, 'ios', 'App', 'PiariumWidget', 'PiariumWidgets.swift')));
  assert.ok(existsSync(join(mobileRoot, 'ios', 'App', 'PiariumWidget', 'PiariumControl.swift')));
  assert.ok(existsSync(join(mobileRoot, 'ios', 'App', 'PiariumNotificationService', 'NotificationService.swift')));

  const definitions = new Set(
    [...project.matchAll(/^\s*([A-F0-9]{24}) \/\*.*\*\/ = \{/gm)].map((match) => match[1]),
  );
  const brokenReferences = [];
  for (const match of project.matchAll(/\b(buildConfigurationList|fileRef|productReference|target|targetProxy|remoteGlobalIDString) = ([A-F0-9]+);/g)) {
    const [, field, identifier] = match;
    if (identifier.length !== 24 || !definitions.has(identifier)) {
      brokenReferences.push(`${field}:${identifier}`);
    }
  }
  assert.deepEqual(brokenReferences, []);
});

test('source tree contains no inherited mobile product identity', () => {
  const inheritedProductName = ['Open', 'Chamber'].join('');
  const inheritedBundleId = ['com', 'openchamber', 'app'].join('.');
  const inheritedFirebaseProject = ['openchamber', '8bf7e'].join('-');
  const offenders = [];

  for (const path of collectTextFiles(mobileRoot)) {
    const content = readFileSync(path, 'utf8');
    if (
      content.includes(inheritedProductName)
      || content.includes(inheritedBundleId)
      || content.includes(inheritedFirebaseProject)
    ) {
      offenders.push(path.slice(mobileRoot.length + 1));
    }
  }

  assert.deepEqual(offenders, []);
  assert.equal(existsSync(join(mobileRoot, 'android', 'app', 'google-services.json')), false);
});

test('committed primary mobile icons use one generated Piarium source', () => {
  const mobileIcon = readFileSync(join(mobileRoot, 'assets', 'icon-only.png'));
  const iosIcon = readFileSync(join(mobileRoot, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset', 'AppIcon-512@2x.png'));
  assert.deepEqual(iosIcon, mobileIcon);
});
