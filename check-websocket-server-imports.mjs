import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, extname, relative } from "node:path";

const args = process.argv.slice(2);
const pathArgIndex = args.indexOf("--path");
const scanPath =
  pathArgIndex >= 0 && args[pathArgIndex + 1]
    ? resolve(process.cwd(), args[pathArgIndex + 1])
    : null;
const rootDir = process.cwd();
const includeExt = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const skipDirs = new Set([
  ".git",
  ".turbo",
  ".idea",
  ".vscode",
  "node_modules",
  "dist",
  "coverage",
  "worktrees",
  "guardrail-fixtures"
]);

const nodeHintPatterns = [
  /from\s+["']node:/,
  /from\s+["']ws["']/,
  /require\(\s*["']ws["']\s*\)/,
  /from\s+["']http["']/,
  /from\s+["']https["']/,
  /from\s+["']net["']/,
  /from\s+["']tls["']/,
  /createServer\s*\(/,
  /process\.versions\.node/
];

const deprecatedImportPattern = /(?:from\s+["']@scomp\/transport-websocket-server["'])|(?:require\(\s*["']@scomp\/transport-websocket-server["']\s*\))/;

function listFiles(dirPath, results = []) {
  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      listFiles(join(dirPath, entry.name), results);
      continue;
    }

    if (!entry.isFile()) continue;
    const fullPath = join(dirPath, entry.name);
    if (statSync(fullPath).size > 1024 * 1024) continue;
    if (includeExt.has(extname(entry.name))) {
      results.push(fullPath);
    }
  }

  return results;
}

const scanRoots = scanPath
  ? [scanPath]
  : [join(rootDir, "packages"), join(rootDir, "apps")].filter((candidate) => {
      try {
        return statSync(candidate).isDirectory();
      } catch {
        return false;
      }
    });

const offenders = [];
for (const scanRoot of scanRoots) {
  for (const filePath of listFiles(scanRoot)) {
  const source = readFileSync(filePath, "utf8");
  if (!deprecatedImportPattern.test(source)) continue;

  const hasNodeHints = nodeHintPatterns.some((pattern) => pattern.test(source));
  if (!hasNodeHints) continue;

    offenders.push(relative(rootDir, filePath));
  }
}

if (offenders.length > 0) {
  console.error("Deprecated Node websocket server import detected.");
  console.error("Use @scomp/transport-websocket-server-node for Node runtime files.");
  for (const offender of offenders) {
    console.error(` - ${offender}`);
  }
  process.exit(1);
}

console.log("websocket-server import guardrail passed");
