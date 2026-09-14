/* ============================================================
   StayAI — клієнт Claude API з підтримкою tool-calling
   Мультитенантна версія: runConciergeTurn приймає propertyId і
   propertyName, щоб системний промпт і всі інструменти працювали
   з даними конкретного готелю, а не одного захардкодженого.
   ============================================================ */

const { buildSystemPrompt } = require('./system-prompt');
const { toolDefinitions, createTools } = require('./tools');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-5';
const MAX_TOOL_ROUNDS = 5; // запобіжник від нескінченного циклу викликів інструментів

async function callClaude(messages, propertyName) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY не встановлено в змінних середовища.');
  }

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: buildSystemPrompt({ propertyName }),
      tools: toolDefinitions,
      messages,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API помилка ${response.status}: ${errText}`);
  }

  return response.json();
}

/**
 * Веде повний обмін з гостем, включно з виконанням tool-calls,
 * для конкретного готелю (property).
 * @param {Array} conversationHistory - масив повідомлень у форматі Claude API
 * @param {{ propertyId: string, propertyName: string }} property
 * @returns {Promise<{ replyText: string, updatedHistory: Array }>}
 */
async function runConciergeTurn(conversationHistory, property) {
  const { propertyId, propertyName } = property;
  const toolImplementations = createTools(propertyId);
  let messages = [...conversationHistory];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const data = await callClaude(messages, propertyName);

    const toolUseBlocks = data.content.filter(b => b.type === 'tool_use');
    const textBlocks = data.content.filter(b => b.type === 'text');

    if (toolUseBlocks.length === 0) {
      const replyText = textBlocks.map(b => b.text).join('\n');
      messages.push({ role: 'assistant', content: data.content });
      return { replyText, updatedHistory: messages };
    }

    messages.push({ role: 'assistant', content: data.content });

    const toolResults = [];
    for (const block of toolUseBlocks) {
      const impl = toolImplementations[block.name];
      let resultPayload;
      try {
        resultPayload = impl ? await impl(block.input) : { error: `Невідомий інструмент: ${block.name}` };
      } catch (err) {
        resultPayload = { error: String(err.message || err) };
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(resultPayload),
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  throw new Error('Перевищено ліміт викликів інструментів за один хід розмови.');
}

module.exports = { runConciergeTurn };
