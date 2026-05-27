#!/usr/bin/env node
// Rewrites packages/core/package.json + packages/mcp/package.json in-place so
// they publish under the @anand-92 scope to GitHub Packages. This is a CI-only
// transform — the canonical unscoped names (`gemdex-core`, `gemdex-mcp`) on
// npmjs.org are unchanged on disk and on the published npm registry. The
// rewrite is applied transiently inside the publish-github-packages workflow
// right before `pnpm publish`; the runner discards the workspace afterwards,
// so there is no cleanup step.
//
// GitHub Packages' npm registry only accepts scoped names, hence the rename.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCOPE = "@anand-92";
const REGISTRY = "https://npm.pkg.github.com";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function rewrite(relPath, transform) {
    const file = path.join(root, relPath);
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    transform(pkg);
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
}

rewrite("packages/core/package.json", (pkg) => {
    pkg.name = `${SCOPE}/gemdex-core`;
    pkg.publishConfig = { ...(pkg.publishConfig ?? {}), registry: REGISTRY };
});

rewrite("packages/mcp/package.json", (pkg) => {
    pkg.name = `${SCOPE}/gemdex-mcp`;
    pkg.publishConfig = { ...(pkg.publishConfig ?? {}), registry: REGISTRY };
    // pnpm rewrites `workspace:*` to the concrete version of the referenced
    // workspace package at publish time, looking the package up by name. Since
    // we just renamed gemdex-core to @anand-92/gemdex-core in the workspace,
    // the dependency key has to track the rename or pnpm publish will fail to
    // resolve it.
    if (
        pkg.dependencies &&
        Object.prototype.hasOwnProperty.call(pkg.dependencies, "gemdex-core")
    ) {
        const ref = pkg.dependencies["gemdex-core"];
        delete pkg.dependencies["gemdex-core"];
        pkg.dependencies[`${SCOPE}/gemdex-core`] = ref;
    }
});

console.log(`Rewrote core + mcp to ${SCOPE}/* with registry ${REGISTRY}.`);
