// In-memory session store { endUserId: { cart: [...], lastOrderId, channel } }
const sessions = {};

function getSession(endUserId, channel) {
  if (!sessions[endUserId]) {
    sessions[endUserId] = { cart: [], lastOrderId: null, channel };
  }
  if (channel) sessions[endUserId].channel = channel;
  return sessions[endUserId];
}
