/**
 * debug-logger.js
 *
 * Formats LLM interaction data into a human-readable Markdown log file.
 * Each log file covers exactly one call to the LLM (one turn).
 *
 * Files are named:
 *   session-{id}__step-{NNN}_turn-{N}_{type}__{YYYY-MM-DD_HH-MM-SS}.md
 *
 * Turn types:
 *   main            — primary LLM call for the step
 *   json-retry      — asked LLM to fix invalid JSON
 *   validation-retry— asked LLM to fix an invalid action
 *   verify          — verification call after "done" is declared
 *
 * Usage (in service worker / background):
 *   import { formatDebugEntry, makeDebugFilename } from '.../debug-logger.js';
 */

/**
 * Build the Markdown content for one LLM interaction.
 *
 * @param {object} p
 * @param {string}   p.sessionId      Short random session identifier (e.g. "a1b2c3")
 * @param {number}   p.stepNum        0-based agent step index
 * @param {number}   p.turnNum        1-based sequential turn number within the session
 * @param {string}   p.turnType       'main' | 'json-retry' | 'validation-retry' | 'verify'
 * @param {string}   p.task           The original user task
 * @param {string}   p.url            Current page URL at the time of the call
 * @param {string}   p.title          Current page title at the time of the call
 * @param {string}   p.system         System prompt sent to the LLM
 * @param {Array}    p.messages        Message array (role/content pairs) sent to the LLM
 * @param {string|null} [p.screenshotFile]  Filename of companion .jpg (relative path within logs/), or null
 * @param {string}   p.response       Raw text response from the LLM
 * @param {number}   p.timestamp      Unix ms timestamp of the call
 * @returns {string} Full Markdown content
 */
export function formatDebugEntry({
  sessionId, stepNum, turnNum, turnType,
  task, url, title,
  system, messages, screenshotFile,
  response, timestamp,
}) {
  const dt = new Date(timestamp).toISOString();
  const stepDisplay = stepNum + 1; // 1-based for humans

  const SEPARATOR = '\n\n---\n\n';

  const meta = [
    `# Browser Agent — Debug Log`,
    ``,
    `| Field | Value |`,
    `|---|---|`,
    `| **Session ID** | \`${sessionId}\` |`,
    `| **Step** | ${stepDisplay} |`,
    `| **Turn** | ${turnNum} (${turnType}) |`,
    `| **Timestamp** | ${dt} |`,
    `| **URL** | ${url || '—'} |`,
    `| **Page Title** | ${title || '—'} |`,
    `| **Screenshot** | ${screenshotFile ? `![annotated screenshot](./${screenshotFile})` : 'No'} |`,
    ``,
    `## Task`,
    ``,
    `> ${task.replace(/\n/g, '\n> ')}`,
  ].join('\n');

  const systemSection = [
    `## System Prompt`,
    ``,
    '```',
    system,
    '```',
  ].join('\n');

  const messagesSection = messages.map((m, i) => {
    const label = `## Message ${i + 1} — role: \`${m.role}\``;
    // The content may be very long (DOM + history); keep it as-is inside a block
    const body = typeof m.content === 'string'
      ? m.content
      : JSON.stringify(m.content, null, 2);
    return [label, '', '```', body, '```'].join('\n');
  }).join(SEPARATOR);

  const responseSection = [
    `## LLM Response`,
    ``,
    '```',
    response,
    '```',
  ].join('\n');

  return [meta, systemSection, messagesSection, responseSection].join(SEPARATOR);
}

/**
 * Generate a filesystem-safe filename for the log entry.
 *
 * @param {object} p
 * @param {string} p.sessionId
 * @param {number} p.stepNum   0-based
 * @param {number} p.turnNum   1-based
 * @param {string} p.turnType
 * @param {number} p.timestamp
 * @returns {string}  e.g. "session-a1b2c3__step-003_turn-1_main__2026-03-31_14-22-05.md"
 */
export function makeDebugFilename({ sessionId, stepNum, turnNum, turnType, timestamp }) {
  const step = String(stepNum + 1).padStart(3, '0');
  // ISO string → "2026-03-31_14-22-05"
  const dt = new Date(timestamp).toISOString()
    .replace('T', '_')
    .replace(/\.\d+Z$/, '')
    .replace(/:/g, '-');
  return `session-${sessionId}__step-${step}_turn-${turnNum}_${turnType}__${dt}.md`;
}
