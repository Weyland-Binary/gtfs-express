import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { parseMarkdown, parseInline } from "../components/chat/MarkdownText";
import MarkdownText from "../components/chat/MarkdownText";
import { turnsToWireMessages } from "../components/chat/useChatHistory";

describe("MarkdownText parser", () => {
  it("parses headings, lists, code fences, quotes and tables", () => {
    const blocks = parseMarkdown(
      [
        "## Résumé",
        "Texte **gras** et `code`.",
        "",
        "- un",
        "- deux",
        "  suite",
        "1. premier",
        "2) second",
        "> citation",
        "```sql",
        "SELECT 1;",
        "```",
        "| a | b |",
        "|---|---|",
        "| 1 | 2 |",
      ].join("\n"),
    );
    expect(blocks.map((b) => b.type)).toEqual(["h", "p", "list", "list", "quote", "code", "table"]);
    expect(blocks[0]).toMatchObject({ level: 2, text: "Résumé" });
    expect(blocks[2]).toMatchObject({ ordered: false, items: ["un", "deux suite"] });
    expect(blocks[3]).toMatchObject({ ordered: true, items: ["premier", "second"] });
    expect(blocks[5]).toMatchObject({ lang: "sql", text: "SELECT 1;" });
    expect(blocks[6]).toMatchObject({ header: ["a", "b"], rows: [["1", "2"]] });
  });

  it("parses inline tokens and only http(s) links", () => {
    const tokens = parseInline("a **b** *c* `d` [e](https://x.y) [f](javascript:alert(1))");
    expect(tokens.map((tk) => tk.type)).toEqual(["text", "bold", "text", "italic", "text", "code", "text", "link", "text"]);
    expect(tokens[7].href).toBe("https://x.y");
    expect(tokens[8].value).toContain("[f](javascript:alert(1))");
  });

  it("renders text, never HTML", () => {
    render(<MarkdownText text={"Hello <img src=x onerror=alert(1)> **world**"} />);
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("world").tagName).toBe("STRONG");
  });
});

describe("turnsToWireMessages", () => {
  it("flattens assistant turns into an answer plus a tool trace", () => {
    const wire = turnsToWireMessages([
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: "answer",
        steps: [
          { stepId: "s1", kind: "sql", sql: "SELECT 1", rowCount: 1 },
          { stepId: "s2", kind: "sql", sql: "SELECT nope", error: "boom" },
        ],
        proposals: [{ proposalId: "p1", title: "Fix", sql: "UPDATE x SET y=1 WHERE 0", outcome: "applied" }],
        uiActions: [{ actionId: "a1", label: "route S1", target: "route", id: "S1" }],
        charts: [{ chartId: "c1", rows: [{}] }],
      },
    ]);
    expect(wire).toEqual([
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: "answer",
        steps: [
          { kind: "sql", sql: "SELECT 1", rowCount: 1, error: null },
          { kind: "sql", sql: "SELECT nope", rowCount: null, error: "boom" },
        ],
        proposals: [{ title: "Fix", sql: "UPDATE x SET y=1 WHERE 0", outcome: "applied" }],
        uiActions: [{ label: "route S1" }],
      },
    ]);
  });
});
