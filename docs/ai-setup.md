# AI setup

The app can run in two modes:

- demo mode: no API key, local prepared answers;
- live AI mode: the server sends questions to OpenAI or Claude.

Do not put real API keys into GitHub, HTML, JavaScript, screenshots, or chat logs.

## OpenAI

Create a local file named `.env` or `.env.local` in the project root:

```env
AI_PROVIDER=openai
OPENAI_API_KEY=sk-your-new-key-here
OPENAI_MODEL=gpt-5.6
PORT=8787
```

Then run:

```powershell
npm.cmd start
```

Open:

```text
http://127.0.0.1:8787/login.html
```

## Claude

```env
AI_PROVIDER=claude
ANTHROPIC_API_KEY=sk-ant-your-key-here
CLAUDE_MODEL=claude-3-5-sonnet-latest
PORT=8787
```

## Safety

`.env` and `.env.local` are ignored by Git. `.env.example` is safe because it contains only placeholders.

If a real key was pasted into a chat, rotate it in the provider dashboard and use a fresh key in `.env.local`.
