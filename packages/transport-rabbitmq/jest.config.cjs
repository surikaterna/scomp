const path = require('node:path');

module.exports = {
  testEnvironment: path.join(
    __dirname,
    '../../node_modules/.pnpm/jest-environment-node@30.3.0/node_modules/jest-environment-node'
  ),
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.spec.ts'],
  transform: {
    '^.+\\.tsx?$': ['babel-jest', {
      babelrc: false,
      configFile: false,
      presets: [
        ['@babel/preset-env', { targets: { node: 'current' } }],
        '@babel/preset-typescript'
      ]
    }]
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  modulePathIgnorePatterns: ['<rootDir>/dist']
};
