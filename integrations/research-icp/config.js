'use strict';

const AGENT = 'research_icp';
const VERSION = 'research_icp_v1';
const MODE = 'shadow';
function config(env = process.env) {
  return {
    agent: AGENT, version: VERSION, mode: MODE,
    enabled: env.AGENT_RESEARCH_ENABLED === 'true',
    invalidMode: Boolean(env.AGENT_RESEARCH_MODE && env.AGENT_RESEARCH_MODE !== MODE),
    apiKey: String(env.AGENT_RESEARCH_API_KEY || '').trim(),
    model: String(env.AGENT_RESEARCH_MODEL || env.ANTHROPIC_HAIKU_MODEL || 'claude-haiku-4-5').trim(),
  };
}
module.exports = { AGENT, VERSION, MODE, config };
