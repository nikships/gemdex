# Remote Memory Gap Execution Plan

Source: `remote_memory_gaps.html`

Linear project: [Remote Memory Desktop Gap Remediation](https://linear.app/gemdex/project/remote-memory-desktop-gap-remediation-2adc443769e5)

## Ticket Map

| Gap | Linear | Priority | Estimate | Primary area | Blocked by |
| --- | --- | --- | --- | --- | --- |
| GAP-01 | [GEM-23](https://linear.app/gemdex/issue/GEM-23/gap-01-add-recovery-ui-when-the-active-remote-is-unreachable-at-boot) | Urgent | 3 | Frontend boot/recovery | GEM-27 |
| GAP-02 | [GEM-24](https://linear.app/gemdex/issue/GEM-24/gap-02-load-memory-list-thumbnails-through-authenticated-attachment) | Urgent | 2 | Frontend attachments | None |
| GAP-03 | [GEM-25](https://linear.app/gemdex/issue/GEM-25/gap-03-make-first-run-setup-present-local-and-remote-paths-equally) | High | 2 | Frontend onboarding | GEM-27 |
| GAP-04 | [GEM-26](https://linear.app/gemdex/issue/GEM-26/gap-04-show-the-active-local-or-remote-backend-in-the-main-topbar) | High | 2 | Frontend topbar/state | GEM-27 |
| GAP-05 | [GEM-27](https://linear.app/gemdex/issue/GEM-27/gap-05-retain-get-config-backend-metadata-in-frontend-state) | High | 1 | Frontend config state | GEM-30 |
| GAP-06 | [GEM-28](https://linear.app/gemdex/issue/GEM-28/gap-06-confirm-backend-switches-with-the-active-remote-name) | Medium | 1 | Frontend mode switch | GEM-26 |
| GAP-07 | [GEM-29](https://linear.app/gemdex/issue/GEM-29/gap-07-render-actionable-remote-recall-errors-in-the-find-similar) | Medium | 1 | Frontend recall errors | None |
| GAP-08 | [GEM-30](https://linear.app/gemdex/issue/GEM-30/gap-08-include-non-secret-active-remote-identity-in-get-config) | Medium | 1 | MCP sidecar config API | None |
| GAP-09 | [GEM-31](https://linear.app/gemdex/issue/GEM-31/gap-09-document-the-localhost-proxy-csp-invariant-for-remote-mode) | Low | 1 | App CSP documentation | None |

## Dependency Sequence

The critical path is:

```text
GEM-30 (config response)
  -> GEM-27 (frontend config state)
       -> GEM-23 (boot recovery)
       -> GEM-25 (onboarding)
       -> GEM-26 (backend badge)
            -> GEM-28 (switch confirmation)
```

`GEM-24`, `GEM-29`, and `GEM-31` are independent of that chain.

## Worktree Waves

### Wave 1: Start in parallel

- `GEM-30`: add `remoteName` to the sidecar config response and tests.
- `GEM-24`: fix authenticated thumbnail loading.
- `GEM-29`: add the Find Similar panel error state.
- `GEM-31`: document the CSP/localhost-proxy invariant.

These tickets are logically independent. `GEM-24` and `GEM-29` both edit
`packages/app/frontend/src/main.js`, but their target functions are far apart.
They can be developed in parallel worktrees; merge `GEM-24` before `GEM-29`
and resolve any import/helper or formatting overlap during the second merge.

### Wave 2: After GEM-30

- `GEM-27`: establish the single frontend source of truth for active backend
  metadata.

Do not start dependent frontend state work from `main`. Base its worktree on
the merged `GEM-30` result so the response contract is stable.

### Wave 3: After GEM-27, develop in parallel

- `GEM-23`: remote boot failure and recovery UI.
- `GEM-25`: equal Local/Remote onboarding choices.
- `GEM-26`: persistent active-backend badge.

These tickets are logically parallel but all touch `main.js`; `GEM-25` and
`GEM-26` also touch `index.html`. Separate worktrees are useful for ownership
and review, but the branches should be integrated in this order:

1. `GEM-26`, because it establishes the persistent backend presentation.
2. `GEM-23`, rebased onto the badge/state behavior for unreachable status.
3. `GEM-25`, rebased last because onboarding edits overlap both config-gate
   logic and page markup.

### Wave 4: After GEM-26

- `GEM-28`: add mode-switch confirmation using the established badge/state
  path.

This should be a small follow-up to `GEM-26`, not a competing status system.

## Suggested Worktree Layout

Use one sibling directory per ticket and create each branch from the required
base:

```powershell
git worktree add ..\gemdex-gem-30 -b gem-30-config-remote-name main
git worktree add ..\gemdex-gem-24 -b gem-24-auth-thumbnails main
git worktree add ..\gemdex-gem-29 -b gem-29-recall-errors main
git worktree add ..\gemdex-gem-31 -b gem-31-csp-docs main
```

After each dependency is merged, update local `main` before creating the next
dependent worktree. Avoid stacking dependent branches on an unmerged sibling
unless the PR is explicitly marked as stacked.

## Integration Rules

- Keep one Linear ticket per PR so blocker state and review ownership remain
  clear.
- Rebase each frontend branch on the latest integration base before final
  review; most remaining work converges on `main.js`.
- Do not broaden the CSP or allow direct frontend-to-server traffic.
- Do not expose remote bearer tokens through `/config` or frontend state.
- Preserve localhost-only sidecar binding and the existing three MCP tools.
- Run the repository-required checks before every merge:

```powershell
pnpm build
pnpm typecheck
pnpm lint
pnpm -r --if-present test
npm --prefix packages/app/frontend run build
```
