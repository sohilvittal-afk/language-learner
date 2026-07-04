const Anthropic = require('@anthropic-ai/sdk');

let client = null;

// Powers Side Quest generation (see generateSideQuestStory in server.js).
// Created lazily so a server without an Anthropic key can still boot and
// serve everything else (word bank, flashcard review).
function getAnthropicClient() {
  if (client) return client;

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('Side Quests are not configured: set ANTHROPIC_API_KEY.');
  }

  client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

module.exports = { getAnthropicClient };
