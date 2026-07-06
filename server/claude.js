const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-3-5-haiku-latest'; // fast + cheap, plenty for a short text summary
const VISION_MODEL = 'claude-3-5-sonnet-latest'; // stronger model for reading meter digits accurately

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

module.exports = { isConfigured, askClaude, askClaudeWithImage };
