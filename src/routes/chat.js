const express = require("express");
const {
  getModelMapping,
  messagesToPrompt,
  extractTextContent,
  extractToolCalls,
  newId,
  buildStreamChunk,
  buildDoneChunk,
  buildFullChatResponse,
  buildToolCallStreamChunk,
  buildFullChatResponseWithTools,
} = require("../helpers/format");
const { runQoderRequest } = require("../helpers/spawn");
const { QODER_TIMEOUT_MS, QODER_MAX_OUTPUT_TOKENS } = require("../config");
const {
  buildPromptWithTools,
  parseToolCallFromText,
  toOpenAIToolCalls,
} = require("../helpers/toolPrompt");

const router = express.Router();

const setSSEHeaders = (res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
};

/**
 * Decide whether accumulated model text may still turn out to be a tool call.
 *
 * The tool system prompt requires a call to be a bare JSON object (optionally
 * fenced). Anything that starts with other characters is a normal answer and
 * can be streamed right away instead of being buffered until the CLI exits.
 */
const mayBeToolCall = (text) => {
  const trimmed = text.trimStart();
  if (!trimmed) return false;
  return trimmed.startsWith("{") || trimmed.startsWith("```");
};

// ── GET handler for client compatibility ────────────────────────────────────
router.get("/", (req, res) => {
  // Return helpful error - OpenAI SDK should use POST
  return res.status(400).json({
    error: {
      message: "Use POST method for chat completions",
      type: "invalid_request_error",
      help: 'POST /v1/chat/completions with JSON body: {"messages": [...], "model": "auto"}',
    },
  });
});

// ── POST handler (standard OpenAI-compatible endpoint) ──────────────────────
router.post("/", (req, res) => {
  const {
    messages,
    model: requestedModel,
    stream = false,
    temperature,
    max_tokens,
    tools,
    tool_choice,
  } = req.body || {};

  const userAgent = req.headers["user-agent"] || "unknown";
  const hasTools = Array.isArray(tools) && tools.length > 0;

  if (
    userAgent.includes("Continue") ||
    userAgent.includes("Zed") ||
    userAgent.includes("Cursor") ||
    userAgent.includes("opencode")
  ) {
    console.log(
      "[IDE Request]",
      userAgent,
      "stream:",
      stream,
      "model:",
      requestedModel,
      "tools:",
      hasTools ? tools.length : 0,
    );
  }

  // Validate messages
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: {
        message: "messages is required and must be a non-empty array",
        type: "invalid_request_error",
      },
    });
  }

  const model = getModelMapping(requestedModel);

  // Log model resolution so dashboard system logs show what happened
  if (requestedModel && model !== requestedModel) {
    const { addSystem } = require("../store/logStore");
    addSystem(
      `Model "${requestedModel}" resolved to "${model}"`,
      "info",
      "model-map",
    );
  }

  // Use tool-aware prompt builder when tools are present
  const prompt = hasTools
    ? buildPromptWithTools(messages, tools, messagesToPrompt)
    : messagesToPrompt(messages);
  const id = newId("chatcmpl");

  const flags = [];
  if (max_tokens != null) {
    if (max_tokens >= 32000) flags.push("--max-output-tokens", "32k");
    else if (max_tokens >= 16000) flags.push("--max-output-tokens", "16k");
  } else if (QODER_MAX_OUTPUT_TOKENS) {
    flags.push("--max-output-tokens", QODER_MAX_OUTPUT_TOKENS);
  }

  if (stream) {
    setSSEHeaders(res);

    const streamStartTime = Date.now();
    req.socket.setTimeout(0);
    req.socket.setKeepAlive(true);

    // Send role chunk immediately for IDE compatibility
    const firstChunk = {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          // When tools are present, omit content from the role chunk entirely.
          // IDEs use the presence/absence of content to decide how to handle the stream.
          delta: hasTools ? { role: "assistant" } : { role: "assistant", content: "" },
          finish_reason: null,
        },
      ],
    };
    res.write(`data: ${JSON.stringify(firstChunk)}\n\n`);
    if (typeof res.flush === "function") res.flush();

    let lastFinishReason = "stop";
    let hasReceivedData = false;
    // Accumulate full text so we can detect tool calls at the end
    let fullStreamText = "";
    // Whether any content delta has already been sent to the client
    let streamedContent = false;
    // Whether a native tool_use block was forwarded as OpenAI tool_calls
    let emittedToolCalls = false;

    // Only tool names declared by the client may be forwarded; anything else
    // is the CLI's own agent machinery and must not leak into the response.
    const declaredToolNames = new Set(
      hasTools
        ? tools
            .filter((t) => t && t.type === "function" && t.function?.name)
            .map((t) => t.function.name)
        : [],
    );

    let clientAborted = false;
    const child = runQoderRequest({
      prompt,
      model,
      flags,
      timeoutMs: QODER_TIMEOUT_MS,
      onChunk: (data) => {
        // Native tool_use blocks (present when QODER_NATIVE_TOOLS=on, or if a
        // future CLI ignores --tools "") map straight onto tool_calls.
        if (hasTools && !emittedToolCalls) {
          const nativeCalls = extractToolCalls(data.message?.content) || [];
          const declared = nativeCalls.filter((tc) =>
            declaredToolNames.has(tc.function.name),
          );
          if (declared.length > 0) {
            const tcChunk = {
              id,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [
                {
                  index: 0,
                  delta: { tool_calls: declared },
                  finish_reason: null,
                },
              ],
            };
            res.write(`data: ${JSON.stringify(tcChunk)}\n\n`);
            emittedToolCalls = true;
            lastFinishReason = "tool_calls";
            // The client now owns the call: close the stream instead of
            // waiting for the CLI to run (and fail) its own tool loop.
            if (!res.writableEnded) {
              res.write(
                `data: ${JSON.stringify(buildDoneChunk(model, id, "tool_calls"))}\n\n`,
              );
              res.write("data: [DONE]\n\n");
              res.end();
            }
            try {
              child.kill();
            } catch {
              // already exited
            }
            return;
          }
        }
        if (emittedToolCalls) return;

        const content = extractTextContent(data.message);
        const finishReason = data.message?.stop_reason || null;
        if (!hasReceivedData) {
          console.log(
            "[Stream Timing] First chunk at",
            Date.now() - streamStartTime,
            "ms",
          );
          hasReceivedData = true;
        }
        if (finishReason) lastFinishReason = finishReason;
        if (content) {
          fullStreamText += content;
          // With tools present we must not leak a raw tool-call JSON as text.
          // Buffer only while the text could still be a tool call; once it is
          // clearly a normal answer (or already started streaming), send it.
          const shouldStream =
            !hasTools || streamedContent || !mayBeToolCall(fullStreamText);
          if (shouldStream) {
            const chunk = {
              id,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { content }, finish_reason: null }],
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            streamedContent = true;
          }
        }
      },
      onDone: (code, stderr) => {
        if (clientAborted || res.writableEnded) return;
        if (code !== 0) {
          console.error(
            "[chat/completions] qodercli exit code:",
            code,
            stderr?.substring(0, 200),
          );
        }

        // Text buffered in case it was a tool call: emit it as a normal answer
        // when parsing says otherwise. Without this the client receives an
        // empty response for every text answer sent with tools declared.
        if (hasTools && !streamedContent) {
          const toolCall = parseToolCallFromText(fullStreamText);
          if (toolCall) {
            const callId = `call_${newId("tc").replace("tc-", "")}`;
            const toolCalls = toOpenAIToolCalls(toolCall, callId);
            // Emit a tool_calls delta chunk
            const tcChunk = {
              id,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [
                {
                  index: 0,
                  delta: { tool_calls: toolCalls },
                  finish_reason: null,
                },
              ],
            };
            res.write(`data: ${JSON.stringify(tcChunk)}\n\n`);
            lastFinishReason = "tool_calls";
          } else if (fullStreamText.trim()) {
            console.log(
              "[Stream] emitting buffered text as content (no tool call detected)",
            );
            const chunk = {
              id,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [
                { index: 0, delta: { content: fullStreamText }, finish_reason: null },
              ],
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
        }

        res.write(
          `data: ${JSON.stringify(buildDoneChunk(model, id, lastFinishReason))}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      },
      onError: (err) => {
        if (clientAborted || res.writableEnded) return;
        console.error("[chat/completions] error:", err.message);
        res.write(
          `data: ${JSON.stringify({ error: { message: err.message, type: err.code === "TIMEOUT" ? "timeout_error" : "api_error" } })}\n\n`,
        );
        res.end();
      },
    });

    req.on("aborted", () => {
      clientAborted = true;
      console.log(
        "[Stream] Client disconnected at",
        Date.now() - streamStartTime,
        "ms",
      );
      if (!res.writableEnded) child.kill();
    });
  } else {
    // Non-streaming path
    let fullContent = "";
    let finishReason = "stop";
    let allToolCalls = [];
    let clientAborted = false;

    const child = runQoderRequest({
      prompt,
      model,
      flags,
      timeoutMs: QODER_TIMEOUT_MS,
      onChunk: (data) => {
        const content = extractTextContent(data.message);
        const toolCalls = extractToolCalls(data.message?.content);
        if (content) fullContent += content;
        if (toolCalls && toolCalls.length > 0) {
          allToolCalls.push(...toolCalls);
          finishReason = "tool_calls";
        }
        if (data.message?.stop_reason) finishReason = data.message.stop_reason;
      },
      onDone: (code, stderr) => {
        if (clientAborted || res.writableEnded) return;
        if (code !== 0) {
          return res.status(500).json({
            error: {
              message: `qodercli exited with code ${code}`,
              type: "api_error",
              details: stderr,
            },
          });
        }

        // Check text output for fake tool calls when tools were provided
        if (hasTools && allToolCalls.length === 0) {
          const toolCall = parseToolCallFromText(fullContent);
          if (toolCall) {
            const callId = `call_${newId("tc").replace("tc-", "")}`;
            allToolCalls = toOpenAIToolCalls(toolCall, callId);
            finishReason = "tool_calls";
            fullContent = ""; // tool call responses have null content
          }
        }

        if (allToolCalls.length > 0) {
          res.json(
            buildFullChatResponseWithTools(
              allToolCalls,
              fullContent || null,
              model,
              finishReason,
              id,
            ),
          );
        } else {
          res.json(buildFullChatResponse(fullContent, model, finishReason, id));
        }
      },
      onError: (err) => {
        if (clientAborted || res.writableEnded) return;
        res.status(err.code === "TIMEOUT" ? 504 : 500).json({
          error: {
            message: err.message,
            type: err.code === "TIMEOUT" ? "timeout_error" : "api_error",
          },
        });
      },
    });

    // Clean up only on real client aborts during non-streaming response.
    // req "close" can fire after normal request completion and would kill too early.
    req.on("aborted", () => {
      clientAborted = true;
      if (!res.writableEnded) child.kill();
    });
  }
});

module.exports = router;
