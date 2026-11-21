// Sets the plugin version (and optionally engine ranges) everywhere it lives.
// Without arguments it asks; an empty answer keeps the current value.
// Usage: node scripts/set-version.mjs [version [termixRange [apiRange]]]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
let [version, termix, api] = process.argv.slice(2);

if (version === undefined) {
  const current = JSON.parse(readFileSync("manifest.json", "utf8"));
  const rl = createInterface({ input: process.stdin });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (label, value) => {
    process.stdout.write(`${label} [${value}]: `);
    const { value: line } = await lines.next();
    return (line ?? "").trim() || value;
  };
  console.log(`Current plugin version: ${current.version}`);
  console.log(`Current engine.termix:  ${current.engine.termix}`);
  console.log(`Current engine.api:     ${current.engine.api}`);
  console.log("(Press Enter to keep the current value)\n");
  version = await ask("New plugin version", current.version);
  termix = await ask("New engine.termix", current.engine.termix);
  api = await ask("New engine.api", current.engine.api);
  rl.close();
}

if (!VERSION.test(version ?? "")) {
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
  if (
    !new RegExp(`^## ${version.replace(/\./g, "\\.")}\\s*$`, "m").test(text)
  ) {
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
  const next = text.replace(
    /adb-\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?\.tmxplug/g,
    `adb-${version}.tmxplug`,
  );
  if (next !== text) {
    writeFileSync("README.md", next);
    changed.push("README.md");
  }
}

console.log(`Version ${version} written to:`);
for (const item of changed) console.log(`  ${item}`);
