/**
 * direct/modelLoop — one model's conversation with its tools, the agent's and the reviewer's alike: each round
 * streamed (llm/streamRound: a stream cut in the middle is sent again on its own), the tools run in the order the
 * model called them and their answers sent back, until a tool that ends the conversation (finish, ask_person,
 * report), the model's own end of turn, or a bound.
 *
 * What every request is: the tools offered unforced (the model chooses; the provider refuses a forced tool on the
 * models this product runs), no temperature (refused too), the system prompt and the conversation cached as they
 * grow (services/promptCache), through the provider's client — whose every body passes llm/personalData's scrub
 * and is counted by llm/aiMeter. A bound reached (the rounds, the turn's budget, four tool errors in a row) is one
 * closing call without tools (tool_choice none): the model says what it has, and the loop says which bound ended it.
 *
 *   runLoop({ client, model, system, tools, messages, maxRounds, budget, signal, emit, onRound })
 *     → { stop: "tool" | "end_turn" | "rounds" | "budget" | "errors" | "refusal" | "max_tokens" | "aborted",
 *         tool?: { name, id, input, answer }, results: [tool_result blocks of the last round, the ending tool's
 *         excepted], text, rounds }
 *   tools = { definitions: [...], byName: { name: { run(input) → { content, isError?, ends? } } } }
 *
 * `messages` is the conversation, extended in place: a caller that continues it (an answer, a correction) sends the
 * ending tool's tool_result with the round's other results first.
 */

"use strict";

const config = require("../../config");
const { withRollingCache, SYSTEM_CACHE } = require("../promptCache");
const { streamRound } = require("../llm/streamRound");
const { supportsEffort } = require("../llm/provider");

const MAX_TOKENS = 32000;
const MAX_CONSECUTIVE_ERRORS = 4;

const round = ({ client, model, system, tools, messages, signal, emit, toolChoice = null }) => {
  const effort = config.NETWORK_PLANNER_EFFORT;
  return streamRound({
    client,
    signal,
    // Only the retries reach the person's stream: the models' words are not the result, the report is.
    emit: (event, data) => (event === "retry" ? emit("retry", data) : null),
    body: {
      model,
      max_tokens: MAX_TOKENS,
      system: [{ type: "text", text: system, cache_control: SYSTEM_CACHE }],
      tools: tools.definitions,
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
      ...(effort && supportsEffort(model) ? { output_config: { effort } } : {}),
      messages: withRollingCache(messages),
    },
  });
};

const textOf = (content) => (content || []).filter((b) => b.type === "text").map((b) => b.text).join("");

const runLoop = async ({ client, model, system, tools, messages, maxRounds, budget, signal, emit = () => {}, onRound = () => {} }) => {
  let rounds = 0;
  let errors = 0;
  let text = "";
  for (;;) {
    if (signal?.aborted) return { stop: "aborted", results: [], text, rounds };
    const r = await round({ client, model, system, tools, messages, signal, emit });
    rounds += 1;
    onRound(r.usage);
    text += textOf(r.content);
    if (r.stopReason === "refusal" || r.stopReason === "max_tokens") return { stop: r.stopReason, results: [], text, rounds };
    messages.push({ role: "assistant", content: r.content && r.content.length ? r.content : "(No answer.)" });
    if (!r.toolUses.length || r.stopReason !== "tool_use") return { stop: "end_turn", results: [], text, rounds };
    const results = [];
    let ending = null;
    for (const tu of r.toolUses) {
      const tool = tools.byName[tu.name];
      // A tool called after the one that ends the conversation is not run: the conversation stops there.
      if (ending) {
        results.push({ type: "tool_result", tool_use_id: tu.id, content: "Not run: the conversation ended with the call before.", is_error: true });
        continue;
      }
      let res;
      try {
        res = tool ? await tool.run(tu.input || {}) : { content: `Error: unknown tool ${tu.name}.`, isError: true };
      } catch (err) {
        res = { content: `Tool ${tu.name} failed: ${err.message}`, isError: true };
      }
      if (res.ends) {
        ending = { name: tu.name, id: tu.id, input: tu.input || {}, answer: res.content };
        continue;
      }
      errors = res.isError ? errors + 1 : 0;
      results.push({ type: "tool_result", tool_use_id: tu.id, content: res.content, ...(res.isError ? { is_error: true } : {}) });
    }
    if (ending) return { stop: "tool", tool: ending, results, text, rounds };
    const bound = budget?.exceeded() ? "budget" : rounds >= maxRounds ? "rounds" : errors >= MAX_CONSECUTIVE_ERRORS ? "errors" : null;
    if (bound) {
      results[results.length - 1].content += bound === "budget" ? "\n\n[Turn budget spent: say now, in a few lines, what you did and what is missing.]" : bound === "rounds" ? "\n\n[Tool rounds used up: say now, in a few lines, what you did and what is missing.]" : "\n\n[Too many tool errors in a row: say now what you did and what is missing.]";
      messages.push({ role: "user", content: results });
      const closing = await round({ client, model, system, tools, messages, signal, emit, toolChoice: { type: "none" } });
      rounds += 1;
      onRound(closing.usage);
      text += textOf(closing.content);
      // An empty answer is no message the provider takes back: the conversation keeps a placeholder.
      messages.push({ role: "assistant", content: closing.content && closing.content.length ? closing.content : "(No answer.)" });
      return { stop: bound, results: [], text, rounds };
    }
    messages.push({ role: "user", content: results });
  }
};

module.exports = { runLoop, MAX_TOKENS, MAX_CONSECUTIVE_ERRORS };
