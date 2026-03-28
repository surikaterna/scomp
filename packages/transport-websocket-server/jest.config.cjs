const fs = require('node:fs');
const path = require('node:path');

function resolveJestNodeEnvironment() {
  const repoRoot = path.resolve(__dirname, '../../../../');
  const pnpmStore = path.join(repoRoot, 'node_modules', '.pnpm');

  if (!fs.existsSync(pnpmStore)) {
    return 'node';
  }

  const candidates = fs.readdirSync(pnpmStore).filter((entry) => entry.startsWith('jest-environment-node@'));
  if (candidates.length === 0) {
    return 'node';
  }

  const preferred = candidates.find((entry) => entry.startsWith('jest-environment-node@30.'))
    ?? candidates.sort().at(-1);

  return path.join(pnpmStore, preferred, 'node_modules', 'jest-environment-node');
}

module.exports = {
  testEnvironment: resolveJestNodeEnvironment(),
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
  moduleNameMapper: {
    '^@scomp/core$': '<rootDir>/../core/src',
    '^@scomp/types$': '<rootDir>/../types/src',
    '^@scomp/transport-websocket-client$': '<rootDir>/../transport-websocket-client/src'
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  modulePathIgnorePatterns: ['<rootDir>/dist']
};
