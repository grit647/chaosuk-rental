const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-3-5-haiku-latest'; // fast + cheap, plenty for a short summary

function isConfigured() {
  return !!ANTHROPIC_API_KEY;
}

async function askClaude(prompt, maxTokens = 800) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Claude API failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  return (data.content || []).map((c) => c.text || '').join('');
}

module.exports = { isConfigured, askClaude };
