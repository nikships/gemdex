export const SETUP_GUIDANCE = `Gemdex needs a one-time setup before this tool can run: its on-device embedding model is not installed yet.

Requirements: an Apple Silicon Mac, macOS 14+, and native arm64 Node (not Rosetta). No API key is needed.

Ask the user for approval, then help them run this on their own machine (not an unrelated agent sandbox):

  npx gemdex-mcp install

That downloads the managed Python/MLX runtime and the pinned BGE-M3 model (about 600 MB). Users upgrading from a Gemini-based Gemdex release can then run npx gemdex-mcp migrate to re-embed their existing memories locally. Run npx gemdex-mcp status to inspect the setup.

Do not download the model or migrate memories without the user's approval. Then retry this tool; if the client still shows old settings, reconnect Gemdex with /mcp. No memory has been saved or changed by this setup response.`;
