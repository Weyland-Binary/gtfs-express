/**
 * MarkdownText — a small, safe renderer for the assistant's markdown.
 *
 * Supports what the assistant is asked to produce (and nothing that needs
 * raw HTML): paragraphs, headings (# to ###), bullet and numbered lists,
 * fenced code blocks, blockquotes, pipe tables, and inline **bold**,
 * *italic*, `code` and [links](https://…). Everything else is rendered as
 * plain text, so untrusted content can never inject markup.
 *
 * `parseMarkdown` is exported for tests.
 */

import React from "react";
import { Box, alpha, useTheme } from "@mui/material";
import { MONO_FONT } from "../SqlConsole/constants";

// ── Inline parsing ────────────────────────────────────────────────────────
// Token order matters: code spans first (their content is literal), then
// links, bold, italic.
const INLINE_RE = /(`[^`\n]+`)|(\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\))|(\*\*([^*\n]+)\*\*)|(\*([^*\n]+)\*)|(_([^_\n]+)_)/g;

export const parseInline = (text) => {
  const out = [];
  let last = 0;
  let m;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) out.push({ type: "text", value: text.slice(last, m.index) });
    if (m[1]) out.push({ type: "code", value: m[1].slice(1, -1) });
    else if (m[2]) out.push({ type: "link", value: m[3], href: m[4] });
    else if (m[5]) out.push({ type: "bold", value: m[6] });
    else if (m[7]) out.push({ type: "italic", value: m[8] });
    else if (m[9]) out.push({ type: "italic", value: m[10] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out;
};

// ── Block parsing ─────────────────────────────────────────────────────────
const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
const isTableSeparator = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const splitCells = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

export const parseMarkdown = (src) => {
  const lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  let para = [];
  const flushPara = () => {
    if (para.length) {
      blocks.push({ type: "p", text: para.join(" ") });
      para = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      flushPara();
      const lang = fence[1] || "";
      const code = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence (or EOF)
      blocks.push({ type: "code", lang, text: code.join("\n") });
      continue;
    }
    // Heading
    const heading = /^\s*(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushPara();
      blocks.push({ type: "h", level: heading[1].length, text: heading[2] });
      i += 1;
      continue;
    }
    // Table (header + separator)
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushPara();
      const header = splitCells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(splitCells(lines[i]));
        i += 1;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }
    // Lists
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    const numbered = /^\s*(\d+)[.)]\s+(.+)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      const ordered = Boolean(numbered);
      const items = [];
      while (i < lines.length) {
        const b = /^\s*[-*+]\s+(.+)$/.exec(lines[i]);
        const n = /^\s*(\d+)[.)]\s+(.+)$/.exec(lines[i]);
        if (ordered && n) items.push(n[2]);
        else if (!ordered && b) items.push(b[1]);
        else if (/^\s{2,}\S/.test(lines[i]) && items.length) {
          // Continuation line of the previous item.
          items[items.length - 1] += ` ${lines[i].trim()}`;
        } else break;
        i += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    // Blockquote
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flushPara();
      const q = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        q.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push({ type: "quote", text: q.join(" ") });
      continue;
    }
    // Blank line ends a paragraph
    if (!line.trim()) {
      flushPara();
      i += 1;
      continue;
    }
    para.push(line.trim());
    i += 1;
  }
  flushPara();
  return blocks;
};

// ── Rendering ─────────────────────────────────────────────────────────────
const Inline = ({ text, codeSx }) =>
  parseInline(text).map((tok, i) => {
    switch (tok.type) {
      case "code":
        return (
          <Box key={i} component="code" sx={codeSx}>
            {tok.value}
          </Box>
        );
      case "bold":
        return (
          <Box key={i} component="strong" sx={{ fontWeight: 700 }}>
            {tok.value}
          </Box>
        );
      case "italic":
        return (
          <Box key={i} component="em">
            {tok.value}
          </Box>
        );
      case "link":
        return (
          <Box
            key={i}
            component="a"
            href={tok.href}
            target="_blank"
            rel="noreferrer noopener"
            sx={{ color: "primary.main", textDecorationColor: "inherit" }}
          >
            {tok.value}
          </Box>
        );
      default:
        return <React.Fragment key={i}>{tok.value}</React.Fragment>;
    }
  });

export default function MarkdownText({ text, muted = false, children = null }) {
  const theme = useTheme();
  const blocks = React.useMemo(() => parseMarkdown(text), [text]);
  const codeSx = {
    fontFamily: MONO_FONT,
    fontSize: "0.78em",
    px: 0.5,
    py: 0.1,
    borderRadius: 0.75,
    background: alpha(theme.palette.text.primary, 0.07),
    wordBreak: "break-all",
  };
  const border = alpha(theme.palette.text.primary, 0.12);

  return (
    <Box
      className="gtfs-md"
      sx={{
        fontSize: "0.86rem",
        lineHeight: 1.55,
        color: muted ? "text.secondary" : "text.primary",
        wordBreak: "break-word",
        "& > * + *": { mt: 0.9 },
      }}
    >
      {blocks.map((b, i) => {
        switch (b.type) {
          case "h":
            return (
              <Box
                key={i}
                component={`h${b.level + 3}`}
                sx={{
                  m: 0,
                  mt: i === 0 ? 0 : 1.2,
                  fontSize: b.level === 1 ? "1rem" : b.level === 2 ? "0.93rem" : "0.88rem",
                  fontWeight: 700,
                  lineHeight: 1.3,
                }}
              >
                <Inline text={b.text} codeSx={codeSx} />
              </Box>
            );
          case "code":
            return (
              <Box
                key={i}
                component="pre"
                sx={{
                  m: 0,
                  p: 1,
                  borderRadius: 1.25,
                  overflowX: "auto",
                  fontFamily: MONO_FONT,
                  fontSize: "0.74rem",
                  lineHeight: 1.45,
                  background: alpha(theme.palette.text.primary, 0.06),
                  border: `1px solid ${border}`,
                }}
              >
                {b.text}
              </Box>
            );
          case "list":
            return (
              <Box
                key={i}
                component={b.ordered ? "ol" : "ul"}
                sx={{ m: 0, pl: 2.5, "& li + li": { mt: 0.3 } }}
              >
                {b.items.map((it, j) => (
                  <li key={j}>
                    <Inline text={it} codeSx={codeSx} />
                  </li>
                ))}
              </Box>
            );
          case "quote":
            return (
              <Box
                key={i}
                sx={{
                  pl: 1.25,
                  borderLeft: `3px solid ${alpha(theme.palette.primary.main, 0.4)}`,
                  color: "text.secondary",
                }}
              >
                <Inline text={b.text} codeSx={codeSx} />
              </Box>
            );
          case "table":
            return (
              <Box key={i} sx={{ overflowX: "auto" }}>
                <Box
                  component="table"
                  sx={{
                    borderCollapse: "collapse",
                    fontSize: "0.78rem",
                    minWidth: 240,
                    "& th, & td": {
                      border: `1px solid ${border}`,
                      px: 0.9,
                      py: 0.4,
                      textAlign: "left",
                      verticalAlign: "top",
                    },
                    "& th": {
                      fontWeight: 700,
                      background: alpha(theme.palette.text.primary, 0.05),
                    },
                  }}
                >
                  <thead>
                    <tr>
                      {b.header.map((h, j) => (
                        <th key={j}>
                          <Inline text={h} codeSx={codeSx} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {b.header.map((_h, k) => (
                          <td key={k}>
                            <Inline text={r[k] ?? ""} codeSx={codeSx} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </Box>
              </Box>
            );
          default:
            return (
              <Box key={i} component="p" sx={{ m: 0 }}>
                <Inline text={b.text} codeSx={codeSx} />
                {i === blocks.length - 1 ? children : null}
              </Box>
            );
        }
      })}
      {blocks.length === 0 ? children : null}
    </Box>
  );
}
