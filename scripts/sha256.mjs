// Prints the SHA-256 of the packed plugin, the value the community registry
// asks for. Usage: node scripts/sha256.mjs [file.tmxplug]
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const file =
  process.argv[2] ??
  readdirSync(".").find(
    (name) => name === `${manifest.id}-${manifest.version}.tmxplug`,
  );
if (!file) {
  console.error(
    `No ${manifest.id}-${manifest.version}.tmxplug here. Run npm run pack first.`,
  );
  process.exit(1);
}
const sha = createHash("sha256").update(readFileSync(file)).digest("hex");
writeFileSync(`${file}.sha256`, `${sha}  ${file}\n`);
console.log(`file     ${file}`);
console.log(`version  ${manifest.version}`);
console.log(`sha256   ${sha}`);
