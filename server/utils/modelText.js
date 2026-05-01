function stripLeadingModelControlTags(text) {
  return String(text || "")
    .replace(/^\s*(?:\[(?:RESPONDING|RESPONSE|ANSWER|ASSISTANT|FACILITATOR|PLATO)\]\s*:?\s*)+/i, "")
    .trim();
}

module.exports = {
  stripLeadingModelControlTags
};
