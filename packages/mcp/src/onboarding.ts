export const SETUP_GUIDANCE = `Gemdex needs setup before this tool can run. Ask the user directly which option they prefer, then help them set it up with their approval:

1. Gemini: local storage with cloud text/media embeddings. Run npx gemdex-mcp setup gemini and enter a Gemini API key at the hidden prompt (get one at https://aistudio.google.com/apikey).
2. Local MLX text: Apple Silicon Mac, macOS 14+, native arm64 Node (not Rosetta). Run npx gemdex-mcp install. Gemdex downloads its own Python/MLX runtime and pinned BGE-M3 model; no Homebrew, Python, uv or Hugging Face CLI needed. Text stays local/offline after installation. Gemini is still needed for media and unmigrated Gemini memories. Existing users can separately run npx gemdex-mcp migrate-text.
3. Remote: connect to an existing Gemdex Server using npx gemdex-mcp init-remote <name> <https://server-url> and enter its bearer token at the hidden prompt. No local Gemini key or model required.

Do not choose for the user, download a model, migrate memories, or request secrets in chat without their approval. Help run the chosen command on the user's machine (not an unrelated agent sandbox). Then retry this tool; if the client still shows old settings, reconnect Gemdex in Claude Code with /mcp. Run npx gemdex-mcp status to inspect configuration. No memory has been saved or changed by this setup response.`;
