import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const expectedTag = `v${packageJson.version}`;
const releaseTag = process.env.RELEASE_TAG;

if (releaseTag !== expectedTag) {
  console.error(`Release tag ${releaseTag ?? "missing"} does not match ${expectedTag}.`);
  process.exit(1);
}

console.log(`Release tag ${releaseTag} matches Aevum ${packageJson.version}.`);
