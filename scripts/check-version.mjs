import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const tauriConfig = JSON.parse(
  readFileSync(resolve(root, "src-tauri", "tauri.conf.json"), "utf8"),
);
const cargoToml = readFileSync(resolve(root, "src-tauri", "Cargo.toml"), "utf8");
const cargoVersion = cargoToml.match(
  /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m,
)?.[1];

const versions = {
  "package.json": packageJson.version,
  "src-tauri/Cargo.toml": cargoVersion,
  "src-tauri/tauri.conf.json": tauriConfig.version,
};
const uniqueVersions = new Set(Object.values(versions));

if ([...uniqueVersions].includes(undefined) || uniqueVersions.size !== 1) {
  console.error("Aevum release versions do not match:");
  for (const [file, version] of Object.entries(versions)) {
    console.error(`  ${file}: ${version ?? "missing"}`);
  }
  process.exit(1);
}

console.log(`Aevum version ${packageJson.version} is consistent.`);
