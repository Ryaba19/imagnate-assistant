const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const rootDir = __dirname;
const port = Number(process.env.PORT || 8787);
const aiProvider = (process.env.AI_PROVIDER || (process.env.ANTHROPIC_API_KEY ? "claude" : "openai")).toLowerCase();
const openaiModel = process.env.OPENAI_MODEL || "gpt-5.6";
const openaiApiBase = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";
const claudeModel = process.env.CLAUDE_MODEL || "claude-3-5-sonnet-latest";
const claudeApiBase = process.env.CLAUDE_API_BASE || "https://api.anthropic.com/v1";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".csv": "text/csv; charset=utf-8",
  ".sql": "text/plain; charset=utf-8"
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body is too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function extractOpenAiResponseText(payload) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const chunks = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) chunks.push(content.text);
      if (content.type === "text" && content.text) chunks.push(content.text);
    }
  }

  return chunks.join("\n").trim();
}

function extractClaudeResponseText(payload) {
  return (payload.content || [])
    .filter((item) => item.type === "text" && item.text)
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function buildInstructions(mode) {
  const base = [
    "Ты AI-продавец и внутренний помощник магазина iMagnate.",
    "Магазин занимается смартфонами, техникой Apple, аксессуарами, игровыми приставками, trade-in, приемкой, продажей и сервисными задачами.",
    "Отвечай по-русски, спокойно, уверенно и по делу.",
    "Пиши как живой продавец магазина: вежливо, без канцелярита, с пользой для клиента или сотрудника.",
    "Используй только переданный контекст для цен, наличия, остатков, задач, сотрудников и статусов.",
    "Не придумывай скидки, гарантию, возвраты, доставку, наличие или финансовые условия, если их нет в контексте.",
    "Если данных не хватает, честно скажи, что нужно уточнить по базе или у Леонида.",
    "Не раскрывай закупочные цены, маржу и внутренние финансы продавцам или клиентам.",
    "Если вопрос от клиента, помоги подобрать товар, уточни бюджет, модель, память, цвет, состояние и способ покупки.",
    "Если вопрос внутренний, дай понятный порядок действий: что проверить, где открыть, что подготовить."
  ];

  if (mode === "employee_question_reply") {
    base.push(
      "Сейчас нужно подготовить ответ сотруднику на его вопрос.",
      "Ответ должен начинаться с приветствия по имени, если имя есть в запросе.",
      "Не делай длинную инструкцию: 2-4 коротких абзаца достаточно.",
      "Если вопрос связан с доступами, безопасностью или деньгами, не обещай действие автоматически, а предложи проверить и подтвердить."
    );
  }

  return base.join("\n");
}

function buildUserPrompt(prompt, context, question) {
  return [
    "Контекст магазина:",
    JSON.stringify(context || {}, null, 2),
    question ? "\nВопрос сотрудника:" : "",
    question ? JSON.stringify(question, null, 2) : "",
    "\nЗапрос пользователя:",
    prompt
  ].filter(Boolean).join("\n");
}

function buildOpenAiInput(prompt, context, question) {
  return [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: buildUserPrompt(prompt, context, question)
        }
      ]
    }
  ];
}

function getProviderConfig() {
  if (aiProvider === "claude" || aiProvider === "anthropic") {
    return {
      provider: "claude",
      model: claudeModel,
      configured: Boolean(process.env.ANTHROPIC_API_KEY),
      missingKey: "ANTHROPIC_API_KEY is not set"
    };
  }

  return {
    provider: "openai",
    model: openaiModel,
    configured: Boolean(process.env.OPENAI_API_KEY),
    missingKey: "OPENAI_API_KEY is not set"
  };
}

async function callOpenAi(body, prompt) {
  const apiResponse = await fetch(`${openaiApiBase}/responses`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: openaiModel,
      instructions: buildInstructions(body.mode || "store_assistant"),
      input: buildOpenAiInput(prompt, body.context, body.question),
      max_output_tokens: 700,
      store: false
    })
  });

  const payload = await apiResponse.json();
  if (!apiResponse.ok) {
    throw new Error(payload.error?.message || "OpenAI API error");
  }

  return {
    answer: extractOpenAiResponseText(payload),
    model: openaiModel,
    provider: "openai"
  };
}

async function callClaude(body, prompt) {
  const apiResponse = await fetch(`${claudeApiBase}/messages`, {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: claudeModel,
      max_tokens: 700,
      system: buildInstructions(body.mode || "store_assistant"),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: buildUserPrompt(prompt, body.context, body.question)
            }
          ]
        }
      ]
    })
  });

  const payload = await apiResponse.json();
  if (!apiResponse.ok) {
    throw new Error(payload.error?.message || "Claude API error");
  }

  return {
    answer: extractClaudeResponseText(payload),
    model: claudeModel,
    provider: "claude"
  };
}

async function handleAssistant(request, response) {
  const providerConfig = getProviderConfig();
  if (!providerConfig.configured) {
    sendJson(response, 200, {
      ok: false,
      configured: false,
      provider: providerConfig.provider,
      error: providerConfig.missingKey
    });
    return;
  }

  let body;
  try {
    body = JSON.parse(await readBody(request) || "{}");
  } catch {
    sendJson(response, 400, { ok: false, error: "Invalid JSON body" });
    return;
  }

  const prompt = String(body.prompt || "").trim();
  if (!prompt) {
    sendJson(response, 400, { ok: false, error: "Prompt is empty" });
    return;
  }

  try {
    const result = providerConfig.provider === "claude"
      ? await callClaude(body, prompt)
      : await callOpenAi(body, prompt);

    sendJson(response, 200, {
      ok: true,
      configured: true,
      provider: result.provider,
      model: result.model,
      answer: result.answer || "Не получилось сформировать ответ. Попробуй переформулировать вопрос."
    });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: error.message || "Assistant server error"
    });
  }
}

function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const safePath = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  const requestedPath = safePath === "/" ? "/login.html" : safePath;
  const filePath = path.join(rootDir, requestedPath);

  if (!filePath.startsWith(rootDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  const relativePath = path.relative(rootDir, filePath);
  const parts = relativePath.split(path.sep);
  const blockedNames = new Set([".env", ".env.example", "server.js", "package.json", "package-lock.json"]);
  if (parts.some((part) => part.startsWith(".")) || blockedNames.has(path.basename(filePath))) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream"
    });
    response.end(data);
  });
}

const server = http.createServer((request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    response.end();
    return;
  }

  if (request.url?.startsWith("/api/assistant") && request.method === "POST") {
    handleAssistant(request, response);
    return;
  }

  serveStatic(request, response);
});

server.listen(port, "127.0.0.1", () => {
  const providerConfig = getProviderConfig();
  console.log(`iMagnate Assistant: http://127.0.0.1:${port}/login.html`);
  console.log(providerConfig.configured
    ? `AI provider: ${providerConfig.provider}, model: ${providerConfig.model}`
    : `AI: demo fallback, ${providerConfig.missingKey}`);
});
