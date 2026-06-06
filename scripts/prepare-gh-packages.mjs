#!/usr/bin/env node
// Rewrites packages/core, packages/mcp, and packages/server package.json files
// in-place so they publish under the @anand-92 scope to GitHub Packages. This
// is a CI-only transform — the canonical unscoped names (`gemdex-core`,
// `gemdex-mcp`, `gemdex-server`) on npmjs.org are unchanged on disk and on the
// published npm registry. The rewrite is applied transiently inside the
// release workflow's github-packages job right before `pnpm publish`; the
// runner discards the workspace afterwards, so there is no cleanup step.
//
// GitHub Packages' npm registry only accepts scoped names, hence the rename.
//
// Because the rename also changes the *dependency* gemdex-core ->
// @anand-92/gemdex-core, the already-built dist of the dependents (mcp +
// server, which tsc emitted with the unscoped specifier `from "gemdex-core"`)
// would resolve to a package that no longer exists under that name. So we also
// rewrite the import specifiers in their built dist. The workflow runs this
// AFTER `pnpm build` and publishes with `--ignore-scripts`, so the rewritten
// dist is what ships (the prepublishOnly rebuild — which would rimraf +
// recompile with the unscoped specifier and then fail to resolve it — is
// intentionally skipped).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCOPE = "@anand-92";
const REGISTRY = "https://npm.pkg.github.com";
const CORE_OLD = "gemdex-core";
const CORE_NEW = `${SCOPE}/gemdex-core`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function rewrite(relPath, transform) {
    const file = path.join(root, relPath);
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    transform(pkg);
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
}

/**
 * Rewrite the `gemdex-core` module specifier to its scoped name across the
 * compiled output of a package's dist dir (.js + .d.ts). Only the quoted module
 * specifier is matched, so paths/identifiers that merely contain the substring
 * are left alone.
 */
function rewriteDistImports(distRelPath) {
    const distDir = path.join(root, distRelPath);
    if (!fs.existsSync(distDir)) {
        throw new Error(`Expected built dist at ${distRelPath} — run the build before this script.`);
    }
    let rewritten = 0;
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (/\.(js|d\.ts)$/.test(entry.name)) {
                const before = fs.readFileSync(full, "utf8");
                const after = before
                    .split(`"${CORE_OLD}"`).join(`"${CORE_NEW}"`)
                    .split(`'${CORE_OLD}'`).join(`'${CORE_NEW}'`);
                if (after !== before) {
                    fs.writeFileSync(full, after);
                    rewritten += 1;
                }
            }
        }
    };
    walk(distDir);
    console.log(`Rewrote ${CORE_OLD} -> ${CORE_NEW} in ${rewritten} dist file(s) under ${distRelPath}.`);
}

// Retarget the gemdex-core workspace dependency to its scoped name. pnpm
// rewrites `workspace:*` to the concrete version of the referenced workspace
// package at publish time, looking the package up by name; since gemdex-core is
// renamed to @anand-92/gemdex-core in the workspace, every dependent's key has
// to track the rename or `pnpm publish` fails to resolve it.
function retargetCoreDependency(pkg) {
    if (
        pkg.dependencies &&
        Object.prototype.hasOwnProperty.call(pkg.dependencies, CORE_OLD)
    ) {
        const ref = pkg.dependencies[CORE_OLD];
        delete pkg.dependencies[CORE_OLD];
        pkg.dependencies[CORE_NEW] = ref;
    }
}

rewrite("packages/core/package.json", (pkg) => {
    pkg.name = `${SCOPE}/gemdex-core`;
    pkg.publishConfig = { ...(pkg.publishConfig ?? {}), registry: REGISTRY };
});

// gemdex-mcp and gemdex-server are both unscoped npm packages that depend on
// gemdex-core via `workspace:*`; they get the identical scope + dependency +
// dist-import rewrite so the @anand-92/* graph resolves on GitHub Packages.
for (const dependent of ["mcp", "server"]) {
    rewrite(`packages/${dependent}/package.json`, (pkg) => {
        pkg.name = `${SCOPE}/gemdex-${dependent}`;
        pkg.publishConfig = { ...(pkg.publishConfig ?? {}), registry: REGISTRY };
        retargetCoreDependency(pkg);
    });
    // The dependent's dist imports gemdex-core by its unscoped name; retarget it
    // to the scoped dependency the rewritten package.json now declares.
    rewriteDistImports(`packages/${dependent}/dist`);
}

console.log(`Rewrote core + mcp + server to ${SCOPE}/* with registry ${REGISTRY}.`);
