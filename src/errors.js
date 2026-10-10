// An error whose message is safe and friendly enough to show to the user as-is.
// Anything else that bubbles up is logged and shown as a generic "something went wrong".
export class UserError extends Error {
  constructor(message){
    super(message);
    this.name = 'UserError';
  }
}

export function isUnknownInteraction(err){
  return !!(err && (err.code === 10062 || err.code === 40060 || /Unknown interaction/i.test(String(err.message || ''))));
}

export function isUnknownMessage(err){
  return !!(err && (err.code === 10008 || /Unknown Message/i.test(String(err.message || ''))));
}
