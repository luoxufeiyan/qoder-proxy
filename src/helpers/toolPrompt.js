'use strict';

/**
 * toolPrompt.js
 *
 * Converts OpenAI-style tool/function schemas into prompt instructions,
 * and parses model text output back into OpenAI tool_calls format.
 *
 * This enables "fake" tool calling: qodercli receives a text prompt that
 * instructs the model how to signal a tool call, and we parse its response.
 */

// ── Prompt injection ──────────────────────────────────────────────────────────

/**
 * Build a system instruction block describing available tools.
 * Injected at the top of the prompt when tools are present.
 *
 * @param {Array} tools - OpenAI-format tools array from the client request
 * @returns {string} - Plain text system instruction to prepend to the prompt
 */
const buildToolSystemPrompt = (tools) => {
  if (!tools || tools.length === 0) return '';

  const defs = tools
    .filter((t) => t.type === 'function' && t.function)
    .map((t) => {
      const fn = t.function;
      const params = fn.parameters
        ? JSON.stringify(fn.parameters, null, 2)
        : '{}';
      return `Function: ${fn.name}\nDescription: ${fn.description || 'No description'}\nParameters (JSON Schema): ${params}`;
    })
    .join('\n\n');

  return `You have access to the following functions. When you need to call a function, you MUST respond with ONLY a valid JSON object in this exact format and nothing else:

{"tool_call":{"name":"<function_name>","arguments":<arguments_object>}}

Do NOT include any explanation or text before or after the JSON when calling a tool. Only output the raw JSON object.

If you do not need to call a function, respond normally with plain text.

Available functions:
${defs}`;
};

/**
 * Default character budget for the assembled prompt. Older messages are
 * dropped only when this limit is exceeded, and never the current turn.
 * Override with QODER_PROMPT_MAX_CHARS.
 */
const DEFAULT_PROMPT_MAX_CHARS = 300000;

const promptMaxChars = () => {
  const raw = parseInt(process.env.QODER_PROMPT_MAX_CHARS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PROMPT_MAX_CHARS;
};

/** Flatten an OpenAI message content field into plain text. */
const contentToText = (content) => {
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && (typeof p === 'string' || !p.type || p.type === 'text'))
      .map((p) => (typeof p === 'string' ? p : p.text || p.value || ''))
      .join('');
  }
  if (typeof content === 'string') return content;
  return '';
};

/** Render one conversation message with a role label for the CLI prompt. */
const renderMessage = (msg) => {
  const content = contentToText(msg.content).trim();
  if (msg.role === 'user') return content ? `User: ${content}` : '';
  if (msg.role === 'assistant') {
    const lines = [];
    if (content) lines.push(`Assistant: ${content}`);
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const fn = tc && tc.function ? tc.function : {};
        if (fn.name) {
          lines.push(`Assistant called: ${fn.name}(${fn.arguments || '{}'})`);
        }
      }
    }
    return lines.join('\n');
  }
  if (msg.role === 'tool') {
    if (!content) return '';
    const label = msg.name ? `Tool result (${msg.name})` : 'Tool result';
    return `${label}: ${content}`;
  }
  return content ? `${msg.role}: ${content}` : '';
};

/**
 * Inject tool instructions into a messages array by prepending/merging
 * a system message, then convert to prompt string.
 *
 * Context policy: keep every system message and every message from the newest
 * user message onwards, then walk backwards adding older turns until the
 * character budget is exhausted. A fixed "last N messages" window used to
 * drop the user's request in long tool loops, which made the model believe
 * the context was lost and spend tokens re-recallng it.
 *
 * @param {Array}  messages - OpenAI messages array
 * @param {Array}  tools    - OpenAI tools array
 * @param {Function} messagesToPromptFn - The existing messagesToPrompt helper
 * @returns {string} - Final prompt string with tool instructions embedded
 */
const buildPromptWithTools = (messages, tools, messagesToPromptFn) => {
  if (!tools || tools.length === 0) {
    return messagesToPromptFn(messages);
  }

  const toolSystem = buildToolSystemPrompt(tools);

  // Every system message matters (QwenPaw may send more than one).
  const systemContent = messages
    .filter((m) => m.role === 'system')
    .map((m) => contentToText(m.content).trim())
    .filter(Boolean)
    .join('\n\n');

  const conversation = messages.filter((m) => m.role !== 'system');
  const rendered = conversation.map(renderMessage);

  // The newest user message starts the current turn: it and everything after
  // it are always kept, regardless of the budget.
  let lastUserIdx = -1;
  for (let i = conversation.length - 1; i >= 0; i--) {
    if (conversation[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  const mustKeepFrom = lastUserIdx >= 0 ? lastUserIdx : 0;

  const maxChars = promptMaxChars();
  let used = toolSystem.length + systemContent.length;
  const selected = [];
  for (let i = conversation.length - 1; i >= 0; i--) {
    const text = rendered[i];
    if (!text) continue;
    const size = text.length + 8;
    if (i >= mustKeepFrom) {
      selected.unshift(text);
      used += size;
      continue;
    }
    if (used + size > maxChars) break;
    selected.unshift(text);
    used += size;
  }

  if (selected.length < conversation.length) {
    console.log(
      `[prompt] kept ${selected.length}/${conversation.length} messages (~${used} chars, budget ${maxChars})`,
    );
  }

  const parts = [toolSystem];
  if (systemContent) parts.push(`System context: ${systemContent}`);
  parts.push(...selected);

  return parts.join('\n\n');
};

// ── Response parsing ──────────────────────────────────────────────────────────

/**
 * Patterns to detect a tool call JSON in model output.
 * Handles cases where the model wraps JSON in markdown code fences.
 */
const TOOL_CALL_PATTERNS = [
  // Raw JSON object
  /^\s*(\{"tool_call"\s*:[\s\S]*\})\s*$/m,
  // Markdown fenced
  /```(?:json)?\s*(\{"tool_call"\s*:[\s\S]*?\})\s*```/m,
];

/**
 * Try to extract a tool_call JSON object from model text output.
 *
 * @param {string} text - Raw model response text
 * @returns {{ name: string, arguments: object }|null} - Parsed tool call or null
 */
const parseToolCallFromText = (text) => {
  if (!text || !text.includes('"tool_call"')) return null;

  for (const pattern of TOOL_CALL_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;

    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.tool_call && parsed.tool_call.name) {
        return {
          name: parsed.tool_call.name,
          arguments: parsed.tool_call.arguments ?? {},
        };
      }
    } catch {
      // Try next pattern
    }
  }

  // Fallback: scan for any JSON blob containing tool_call
  const start = text.indexOf('{"tool_call"');
  if (start === -1) return null;

  // Walk forward to find the matching closing brace
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }

  if (end === -1) return null;

  try {
    const parsed = JSON.parse(text.slice(start, end));
    if (parsed.tool_call && parsed.tool_call.name) {
      return {
        name: parsed.tool_call.name,
        arguments: parsed.tool_call.arguments ?? {},
      };
    }
  } catch {
    return null;
  }

  return null;
};

/**
 * Convert a parsed tool call into OpenAI-format tool_calls array.
 *
 * @param {{ name: string, arguments: object }} toolCall
 * @param {string} callId - Unique ID for this tool call
 * @returns {Array} - OpenAI tool_calls array
 */
const toOpenAIToolCalls = (toolCall, callId) => [
  {
    id: callId,
    type: 'function',
    function: {
      name: toolCall.name,
      arguments:
        typeof toolCall.arguments === 'string'
          ? toolCall.arguments
          : JSON.stringify(toolCall.arguments),
    },
  },
];

module.exports = {
  buildPromptWithTools,
  parseToolCallFromText,
  toOpenAIToolCalls,
};
