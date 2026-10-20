/**
 * llm/personalData — the safety net under every model request replaces the persons of the request and any e-mail
 * address, and nothing else: the protocol's own fields (a thinking block's signature, the ids pairing a tool call with
 * its result) pass byte for byte, and a feed's proper names that begin with a person's first name stay as written —
 * the agent writes its SQL with them.
 */

"use strict";

const { scrubRequest, scrubText, pseudonymOf } = require("../../services/llm/personalData");

describe("scrubText", () => {
  test("a registered person and any e-mail address are replaced", () => {
    const out = scrubText("Validé par Jean Dupont (jean.dupont@example.fr).", ["Jean Dupont"]);
    expect(out).not.toMatch(/Jean|Dupont|example/);
    expect(out).toContain(pseudonymOf("jean dupont"));
    expect(out).toMatch(/\[email-[0-9a-f]{6}\]/);
  });

  test("a one-word name alone is the person", () => {
    expect(scrubText("Bonjour Jean, la ligne 4 est prête.", ["Jean"])).toBe(`Bonjour ${pseudonymOf("Jean")}, la ligne 4 est prête.`);
  });

  test("a one-word name opening a longer proper name is not the person", () => {
    const text = "SELECT stop_id FROM stops WHERE stop_name = 'Jean Jaurès' -- arrêt Jean  Macé, Avenue Martin Luther King";
    expect(scrubText(text, ["Jean", "Martin"])).toBe(text);
  });

  test("a name inside another word is never touched", () => {
    expect(scrubText("Gare de Saint-Martin, Martinique", ["Martin"])).toBe("Gare de Saint-Martin, Martinique");
  });
});

describe("scrubRequest", () => {
  const names = ["Li"];
  const signature = "EqQBCkgIARABGAIiQLi/Li+Li=" + "x".repeat(40);
  const body = {
    model: "claude-opus-5-5",
    system: [{ type: "text", text: "Contract decided by Li.", cache_control: { type: "ephemeral", ttl: "1h" } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "Li asks for line 4 every 10 minutes." }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "The person (Li) wants a 10 minute headway.", signature },
          { type: "redacted_thinking", data: "Li/Li+Li==" },
          { type: "tool_use", id: "toolu_01Li", name: "run_sql", input: { sql: "SELECT 1", note: "for Li" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01Li", content: "Li: 3 rows" }] },
    ],
  };

  test("the text is scrubbed, the protocol is not", () => {
    const out = scrubRequest(body, names);
    const p = pseudonymOf("Li");
    expect(out.system[0].text).toBe(`Contract decided by ${p}.`);
    expect(out.system[0].cache_control).toEqual(body.system[0].cache_control);
    expect(out.messages[0].content[0].text).toBe(`${p} asks for line 4 every 10 minutes.`);
    // Thinking blocks travel exactly as the model returned them (the API verifies them).
    expect(out.messages[1].content[0]).toEqual(body.messages[1].content[0]);
    expect(out.messages[1].content[1]).toEqual(body.messages[1].content[1]);
    const call = out.messages[1].content[2];
    expect(call.id).toBe("toolu_01Li");
    expect(call.name).toBe("run_sql");
    expect(call.input.note).toBe(`for ${p}`);
    const result = out.messages[2].content[0];
    expect(result.tool_use_id).toBe("toolu_01Li");
    expect(result.content).toBe(`${p}: 3 rows`);
  });

  test("nobody known and no address: the same object", () => {
    const plain = { model: "m", messages: [{ role: "user", content: "line 4" }] };
    expect(scrubRequest(plain, [])).toBe(plain);
  });
});
