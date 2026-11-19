// Sets the plugin version (and optionally engine ranges) everywhere it lives.
// Usage: node scripts/set-version.mjs <version> [termixRange] [apiRange]
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const [version, termix, api] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  console.error(`Bad version "${version ?? ""}". Use x.y.z, for example 1.0.2`);
  process.exit(1);
}

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, data) =>
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
const changed = [];

const manifest = readJson("manifest.json");
manifest.version = version;
if (termix) manifest.engine.termix = termix;
if (api) manifest.engine.api = api;
writeJson("manifest.json", manifest);
changed.push("manifest.json");

const pkg = readJson("package.json");
pkg.version = version;
writeJson("package.json", pkg);
changed.push("package.json");

if (existsSync("package-lock.json")) {
  const lock = readJson("package-lock.json");
  lock.version = version;
  if (lock.packages?.[""]) lock.packages[""].version = version;
  writeJson("package-lock.json", lock);
  changed.push("package-lock.json");
}

if (existsSync("CHANGELOG.md")) {
  let text = readFileSync("CHANGELOG.md", "utf8");
  if (!new RegExp(`^## ${version.replace(/\./g, "\\.")}\\s*$`, "m").test(text)) {
    text = text.replace(
      /^# Changelog\s*\n/,
      `# Changelog\n\n## ${version}\n\n### Changed\n\n- TODO: describe this release\n\n`,
    );
    writeFileSync("CHANGELOG.md", text);
    changed.push("CHANGELOG.md (new section, edit the TODO line)");
  }
}

if (existsSync("README.md")) {
  const text = readFileSync("README.md", "utf8");
  const next = text.replace(/adb-\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?\.tmxplug/g, `adb-${version}.tmxplug`);
  if (next !== text) {
    writeFileSync("README.md", next);
    changed.push("README.md");
  }
}

console.log(`Version ${version} written to:`);
for (const item of changed) console.log(`  ${item}`);
