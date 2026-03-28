const { createJestConfig } = require('../../jest.base.cjs')

module.exports = createJestConfig({
  rootDir: __dirname,
  transformPattern: '^.+\\.[tj]sx?$',
  transformIgnorePatterns: ['/node_modules/(?!\\.pnpm/uuid@|uuid/)'],
  testTimeout: 15000,
})
