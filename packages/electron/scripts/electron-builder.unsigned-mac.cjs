const packageJson = require('../package.json');

module.exports = {
  ...packageJson.build,
  dmg: {
    ...packageJson.build.dmg,
    sign: false,
  },
  mac: {
    ...packageJson.build.mac,
    hardenedRuntime: false,
    identity: null,
    notarize: false,
  },
};
