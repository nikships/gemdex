# Release Checklist

Manual steps that drive stars and a clean launch. Run them yourself — they need your GitHub auth and editorial choices.

## One-time repo polish

- [ ] **Set the repo description**
  ```bash
  gh repo edit anand-92/gemdex \
    --description "Semantic code search MCP for AI coding agents — Gemini embeddings + embedded LanceDB hybrid retrieval"
  ```

- [ ] **Add discoverability topics**
  ```bash
  gh repo edit anand-92/gemdex \
    --add-topic mcp \
    --add-topic semantic-search \
    --add-topic gemini \
    --add-topic lancedb \
    --add-topic ast \
    --add-topic code-search \
    --add-topic claude-code \
    --add-topic cursor \
    --add-topic vector-search \
    --add-topic rag \
    --add-topic embeddings \
    --add-topic developer-tools \
    --add-topic ai-coding-assistant \
    --add-topic tree-sitter
  ```

- [ ] **Enable Discussions**
  GitHub → Settings → General → Features → check **Discussions**.

- [ ] **Upload the social preview**
  GitHub → Settings → General → Social preview → upload `assets/social-card.jpg`.

- [ ] **Set the homepage URL** (optional, points to npm)
  ```bash
  gh repo edit anand-92/gemdex --homepage "https://www.npmjs.com/package/gemdex-mcp"
  ```

- [ ] **Pin Gemdex** to your GitHub profile (Profile → Customize your pins).

## Per-release flow

- [ ] Bump versions:
  ```bash
  pnpm --filter gemdex-core version <new>
  pnpm --filter gemdex-mcp version <new>
  ```
- [ ] Update `CHANGELOG.md` with the new section.
- [ ] `pnpm lint && pnpm typecheck && pnpm build && pnpm -r test`
- [ ] Publish:
  ```bash
  pnpm release:core
  pnpm release:mcp
  ```
- [ ] Tag + push:
  ```bash
  git tag v<new> && git push --tags
  ```
- [ ] Create a GitHub Release from the tag, paste the changelog section, attach the hero image.

## Launch (do these once Gemdex is in good shape)

- [ ] **Awesome lists** — open PRs to:
  - `punkpeye/awesome-mcp-servers`
  - `modelcontextprotocol/servers` (community list)
  - `wong2/awesome-mcp-servers`
  - Any Cursor / Claude / Codex community resource lists
- [ ] **Show HN** — `Show HN: Gemdex – Semantic code search MCP for AI coding agents`. Best window: weekday morning Pacific.
- [ ] **r/LocalLLaMA, r/ClaudeAI, r/cursor** — short post with the hero image + 30-second demo block.
- [ ] **Twitter / X + Bluesky thread** — hero image, 3-bullet pitch, gif of the search mockup, link, ask for stars.
- [ ] **Dev.to / Hashnode** — write the "Why we built Gemdex" post; cross-post.
- [ ] **MCP Discord servers** — Anthropic MCP, OpenAI Codex CLI, Cursor.

## Ongoing star drivers

- [ ] Label 3–5 issues `good first issue` and 2–3 `help wanted` at all times.
- [ ] Respond to every issue within 48h, even if the answer is "noted, no ETA."
- [ ] Cut a release every time you ship a user-visible improvement — fresh activity drives GitHub trending eligibility.
- [ ] Embed `assets/social-card.jpg` in every blog post or thread that mentions Gemdex.
