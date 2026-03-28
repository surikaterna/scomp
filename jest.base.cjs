const fs = require("node:fs");
const path = require("node:path");

function parseMajor(version) {
  const major = Number(String(version || "").split(".")[0]);
  return Number.isNaN(major) ? undefined : major;
}

function parsePackageVersionFromEntry(entry) {
  const match = /^jest-environment-node@(\d+\.\d+\.\d+)/.exec(entry);
  return match ? match[1] : undefined;
}

function compareVersionsDesc(left, right) {
  const a = String(left || "")
    .split(".")
    .map((part) => Number(part));
  const b = String(right || "")
    .split(".")
    .map((part) => Number(part));
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (b[index] || 0) - (a[index] || 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function resolveJestNodeEnvironment() {
  const repoRoot = __dirname;

  const pnpmStore = path.join(repoRoot, "node_modules", ".pnpm");
  if (fs.existsSync(pnpmStore)) {
    let preferredMajor;
    try {
      const jestPackageJsonPath = require.resolve("jest/package.json", {
        paths: [repoRoot],
      });
      const jestPackage = require(jestPackageJsonPath);
      preferredMajor = parseMajor(jestPackage.version);
    } catch {
      preferredMajor = undefined;
    }

    const candidates = fs
      .readdirSync(pnpmStore)
      .filter((entry) => entry.startsWith("jest-environment-node@"))
      .map((entry) => {
        const version = parsePackageVersionFromEntry(entry);
        return {
          entry,
          version,
          major: parseMajor(version),
        };
      })
      .filter((candidate) => Boolean(candidate.version))
      .sort((left, right) => compareVersionsDesc(left.version, right.version));

    const preferred =
      (preferredMajor === undefined
        ? candidates[0]
        : candidates.find((candidate) => candidate.major === preferredMajor)) ||
      candidates[0];

    if (preferred) {
      return path.join(
        pnpmStore,
        preferred.entry,
        "node_modules",
        "jest-environment-node",
      );
    }
  }

  const directPackageJson = path.join(
    repoRoot,
    "node_modules",
    "jest-environment-node",
    "package.json",
  );
  try {
    const directPackage = require(directPackageJson);
    const major = parseMajor(directPackage.version);
    if (major !== undefined && major >= 27) {
      return path.dirname(directPackageJson);
    }
  } catch {
    // Fall through to require.resolve lookup.
  }

  try {
    const packageJsonPath = require.resolve(
      "jest-environment-node/package.json",
      {
        paths: [repoRoot],
      },
    );
    return path.dirname(packageJsonPath);
  } catch {
    return "node";
  }
}

function createJestConfig(options = {}) {
  const {
    rootDir,
    moduleNameMapper,
    transformIgnorePatterns,
    testTimeout,
    transformPattern = "^.+\\.tsx?$",
    roots = ["<rootDir>/test"],
    testMatch = ["**/*.spec.ts"],
  } = options;

  const config = {
    rootDir,
    testEnvironment: resolveJestNodeEnvironment(),
    roots,
    testMatch,
    transform: {
      [transformPattern]: [
        "babel-jest",
        {
          babelrc: false,
          configFile: false,
          presets: [
            ["@babel/preset-env", { targets: { node: "current" } }],
            "@babel/preset-typescript",
          ],
        },
      ],
    },
    moduleFileExtensions: ["ts", "js", "json"],
    modulePathIgnorePatterns: ["<rootDir>/dist"],
  };

  if (moduleNameMapper) {
    config.moduleNameMapper = moduleNameMapper;
  }
  if (transformIgnorePatterns) {
    config.transformIgnorePatterns = transformIgnorePatterns;
  }
  if (testTimeout) {
    config.testTimeout = testTimeout;
  }

  return config;
}

module.exports = {
  createJestConfig,
  resolveJestNodeEnvironment,
};
