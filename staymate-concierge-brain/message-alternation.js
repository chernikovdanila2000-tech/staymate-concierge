/* ============================================================
   Anthropic API вимагає, щоб ролі user/assistant строго чергувались —
   два підряд повідомлення з однаковою роллю відхиляються помилкою.
   Розмови, збережені до появи appendGuestMessage() у server.js (кілька
   повідомлень гостя поспіль під час очікування відповіді власника),
   досі можуть мати таку "биту" структуру в базі. Замість падіння на
   кожному ході вже існуючої розмови — об'єднуємо такі сусідні текстові
   повідомлення перед викликом API, а не лише на запис нових.
   ============================================================ */

function normalizeAlternation(messages) {
  const result = [];
  for (const msg of messages) {
    const prev = result[result.length - 1];
    if (
      prev &&
      prev.role === msg.role &&
      typeof prev.content === 'string' &&
      typeof msg.content === 'string'
    ) {
      prev.content += '\n' + msg.content;
    } else {
      result.push({ ...msg });
    }
  }
  return result;
}

module.exports = { normalizeAlternation };
