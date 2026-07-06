const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-4-5'; // fast + cheap, plenty for a short text summary
const VISION_MODEL = 'claude-sonnet-5'; // stronger model for reading meter digits accurately

function isConfigured() {
  return !!ANTHROPIC_API_KEY;
}

async function callMessages(model, content, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content }],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Claude API failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  return (data.content || []).map((c) => c.text || '').join('');
}

async function askClaude(prompt, maxTokens = 800) {
  return callMessages(MODEL, prompt, maxTokens);
}

// dataUrl: a "data:image/jpeg;base64,...." string (same format the frontend
// already produces for uploads elsewhere in this app).
async function askClaudeWithImage(prompt, dataUrl, maxTokens = 1024) {
  const match = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) throw new Error('รูปภาพไม่ถูกต้อง');
  const [, mediaType, base64Data] = match;
  const content = [
    { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
    { type: 'text', text: prompt },
  ];
  return callMessages(VISION_MODEL, content, maxTokens);
}

// Tool-use turn for the scoped "command box" assistant — system prompt +
// running message history + a fixed tool whitelist. Returns the raw parsed
// response so the caller can inspect stop_reason / tool_use blocks itself.
async function callWithTools(system, messages, tools, maxTokens = 1024) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: VISION_MODEL, // stronger model — better at staying within tool boundaries
      max_tokens: maxTokens,
      system,
      tools,
      messages,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Claude API failed (${res.status}): ${text}`);
  }
  return res.json();
}

module.exports = { isConfigured, askClaude, askClaudeWithImage, callWithTools };
