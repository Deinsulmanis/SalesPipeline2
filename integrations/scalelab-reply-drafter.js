'use strict';
// Pluggable reply drafter for the ScaleLab reply screen (v0 placeholder).
// The wording rules live in docs/skills/scalelab-reply-drafting/RULES.md and
// are read at call time, so they change without a code change. The draft is a
// suggestion only: the owner edits it and nothing is sent without the button.
// Uses the existing Claude setup and its budgets (wrapCreateMessage).
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { STAFFING_PRODUCT_FACTS } = require('../product-facts');
const { ALERT_INTENTS } = require('./scalelab-fast-reply');

const RULES_PATH = join(__dirname, '..', 'docs', 'skills', 'scalelab-reply-drafting', 'RULES.md');
const BOOKING_LINK = 'https://calendar.app.google/oFNAniV6HKqhSUR29';
const MEETING_INTENTS = new Set(['meeting_request', 'reschedule_request']);
const MODEL = 'claude-haiku-4-5-20251001';
const DRAFTABLE = new Set(ALERT_INTENTS);

const loadRules = () => readFileSync(RULES_PATH, 'utf8');
const noDashes = text => String(text).replace(/[‒-―−]/g, '-');

/** Post-checks every engine's output: shape, booking link, placeholders kept. */
function finishDraft(text, { intent, firstName }) {
  let out = noDashes(String(text || '').trim()).replace(/\r/g, '');
  if (!out) return null;
  const greeting = `Hi ${String(firstName || '').trim() || 'there'},`;
  if (!/^hi\b/i.test(out)) out = `${greeting}\n\n${out}`;
  if (MEETING_INTENTS.has(intent) && !out.includes(BOOKING_LINK)) {
    out = out.replace(/\n+Deins\s*$/i, '');
    out = `${out}\n\nYou can pick a time that suits you here: ${BOOKING_LINK}\n\nDeins`;
  }
  if (!/\n\s*Deins\s*$/.test(out)) out = `${out}\n\nDeins`;
  // Any other link the model added is replaced by a placeholder for the owner.
  out = out.replace(/https?:\/\/\S+/g, url => (url.startsWith(BOOKING_LINK) ? url : '[FILL: link]'));
  return out;
}

/** Deterministic fallback engine: no model call, always placeholders. */
function templateEngine({ intent, firstName }) {
  const hi = `Hi ${String(firstName || '').trim() || 'there'},`;
  const bodies = {
    interest: `Thanks for getting back to me. Happy to walk you through how we'd approach your market on a short call: ${BOOKING_LINK}`,
    information_request: 'Thanks for asking. We handle the prospecting, outreach and qualification, and interested employers are booked straight onto your calendar. [FILL: anything specific they asked]',
    pricing_request: "Thanks for asking. It's performance based around qualified employer meetings. [FILL: pricing answer]",
    meeting_request: `Glad to. You can pick any time that suits you here: ${BOOKING_LINK}`,
    reschedule_request: `No problem. You can pick a new time that suits you here: ${BOOKING_LINK}`,
  };
  return { text: `${hi}\n\n${bodies[intent]}\n\nDeins`, source: 'template_v0' };
}

/**
 * Claude engine. createMessage: an Anthropic messages.create, already wrapped
 * with the budget tracker by the caller (wrapCreateMessage, feature
 * reply_question_answer). Any failure falls back to the template engine.
 */
function claudeEngine({ createMessage, model = MODEL }) {
  return async ({ intent, inboundText, firstName, company }) => {
    const result = await createMessage({
      model, max_tokens: 400, temperature: 0,
      system: `${loadRules()}\n\n# Product facts (the only facts you may use)\n${STAFFING_PRODUCT_FACTS}`,
      messages: [{ role: 'user', content: JSON.stringify({ intent, first_name: firstName || '', company: company || '',
        prospect_message: String(inboundText || '').slice(0, 2000) }) }],
    });
    const text = (result?.content || []).filter(block => block?.type === 'text').map(block => block.text).join('\n').trim();
    if (!text || result?.stop_reason === 'max_tokens') throw new Error('draft_incomplete');
    return { text, source: `claude_v0:${model}` };
  };
}

/**
 * The drafter the queue calls. Mixed, negative, unsubscribe and unclear
 * replies never get a draft (only the alert intents do).
 */
function createReplyDrafter({ engine = templateEngine, fallback = templateEngine, log = () => {} } = {}) {
  return async input => {
    if (!DRAFTABLE.has(input.intent)) return null;
    let draft;
    try { draft = await engine(input); } catch (error) {
      log(`drafter engine failed (${error.message}); using template`);
      draft = await fallback(input);
    }
    const text = finishDraft(draft?.text, input);
    return text ? { text, source: draft.source } : null;
  };
}

module.exports = { RULES_PATH, BOOKING_LINK, loadRules, finishDraft, templateEngine, claudeEngine, createReplyDrafter };
