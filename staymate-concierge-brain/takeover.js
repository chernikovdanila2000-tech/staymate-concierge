/*
 * A conversation with an open escalation belongs to a hotel employee until
 * that employee resolves it.  This small module deliberately has no HTTP or
 * channel knowledge, which keeps the rule identical for every channel.
 */

async function isConversationTakenOver({ supabase, propertyId, channel, chatId }) {
  if (!propertyId || !channel || chatId === undefined || chatId === null) {
    return false;
  }

  const { data, error } = await supabase
    .from('escalations')
    .select('id')
    .eq('property_id', String(propertyId))
    .eq('channel', String(channel))
    .eq('chat_id', String(chatId))
    .neq('status', 'resolved')
    .limit(1);

  if (error) {
    throw new Error(`Не вдалося перевірити передачу розмови: ${error.message || error}`);
  }

  return Array.isArray(data) && data.length > 0;
}

// The pause above holds while ANY escalation in the conversation is open, so
// handing the conversation back to the AI must close all of them — closing
// only the one the owner clicked leaves older duplicates still pausing it.
async function resolveConversationEscalations({ supabase, propertyId, channel, chatId, now = new Date() }) {
  if (!propertyId || !channel || chatId === undefined || chatId === null) {
    return [];
  }

  const { data, error } = await supabase
    .from('escalations')
    .update({ status: 'resolved', resolved_at: now.toISOString() })
    .eq('property_id', String(propertyId))
    .eq('channel', String(channel))
    .eq('chat_id', String(chatId))
    .neq('status', 'resolved')
    .select('id');

  if (error) {
    throw new Error(`Не вдалося повернути розмову ШІ: ${error.message || error}`);
  }

  return Array.isArray(data) ? data.map((row) => row.id) : [];
}

module.exports = { isConversationTakenOver, resolveConversationEscalations };
