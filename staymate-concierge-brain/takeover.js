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

module.exports = { isConversationTakenOver };
