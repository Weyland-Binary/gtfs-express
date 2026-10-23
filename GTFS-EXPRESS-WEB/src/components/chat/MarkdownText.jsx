/**
 * A small renderer for the assistant's markdown that never needs raw HTML: anything unsupported stays plain text, so
 * untrusted content can never inject markup.
 *
 * `spans` ([{ start, end, text }]) strikes through the model's sentences the engine's verdict contradicts
 * (services/verdict.contradictionsOf), each followed by `strikeNote`. Spans are marked before parsing with
 * private-use sentinels so a span split by inline markup still knows which span it is; a span not found by its
 * offsets or its words is not drawn, never a strike on the wrong words.
 */

import React from "react";
import { Box, alpha, useTheme } from "@mui/material";
import { MONO_FONT } from "../SqlConsole/constants";

// Token order matters: code spans first (their content is literal), then links, bold, italic.
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
      i += 1;
      blocks.push({ type: "code", lang, text: code.join("\n") });
      continue;
    }
    const heading = /^\s*(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushPara();
      blocks.push({ type: "h", level: heading[1].length, text: heading[2] });
      i += 1;
      continue;
    }
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
          items[items.length - 1] += ` ${lines[i].trim()}`;
        } else break;
        i += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
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

// Span i opens with U+E000+i and closes with U+E800+i: private use, never in the model's text, markdown or whitespace.
const MAX_SPANS = 0x800;
const OPEN = 0xe000;
const CLOSE = 0xe800;
const SENTINELS = /[\uE000-\uEFFF]/g;
const sentinel = (c) => {
  const code = c.charCodeAt(0);
  if (code >= CLOSE && code < CLOSE + MAX_SPANS) return { close: true, index: code - CLOSE };
  if (code >= OPEN && code < OPEN + MAX_SPANS) return { close: false, index: code - OPEN };
  return null;
};
export const stripSentinels = (s) => String(s || "").replace(SENTINELS, "");

/**
 * → { text, count }: a span is taken at its offsets when the text there is its own, else where its words first
 * appear; overlapping or unfound spans are dropped.
 */
export const markSpans = (text, spans) => {
  const src = stripSentinels(text);
  const placed = [];
  for (const sp of Array.isArray(spans) ? spans.slice(0, MAX_SPANS) : []) {
    if (!sp) continue;
    const words = typeof sp.text === "string" ? sp.text : null;
    let start = Number.isInteger(sp.start) ? sp.start : -1;
    let end = Number.isInteger(sp.end) ? sp.end : -1;
    if (!(start >= 0 && end > start && end <= src.length && (words === null || src.slice(start, end) === words))) {
      start = words ? src.indexOf(words) : -1;
      end = start >= 0 ? start + words.length : -1;
    }
    if (start < 0 || end <= start) continue;
    if (placed.some((p) => start < p.end && end > p.start)) continue;
    placed.push({ start, end });
  }
  placed.sort((a, b) => a.start - b.start);
  let out = "";
  let last = 0;
  placed.forEach((p, i) => {
    out += src.slice(last, p.start) + String.fromCharCode(OPEN + i) + src.slice(p.start, p.end) + String.fromCharCode(CLOSE + i);
    last = p.end;
  });
  return { text: out + src.slice(last), count: placed.length };
};

/** `state` carries the open span from one token of the same block to the next. */
const strikePieces = (value, state, strike, keyBase) => {
  if (!strike) return [value];
  const out = [];
  let buf = "";
  const flush = (k) => {
    if (!buf) return;
    if (state.open === null) out.push(buf);
    else
      out.push(
        <Box key={`${keyBase}-d${k}`} component="del" data-testid="prose-struck" title={strike.title || undefined} aria-describedby={`${strike.idPrefix}-${state.open}`} sx={{ textDecorationThickness: "2px", textDecorationColor: (th) => th.palette.error.main, color: "text.secondary" }}>
          {buf}
        </Box>,
      );
    buf = "";
  };
  let k = 0;
  for (const c of String(value)) {
    const mark = sentinel(c);
    if (!mark) {
      buf += c;
      continue;
    }
    if (!mark.close) {
      flush(k++);
      state.open = mark.index;
    } else {
      // A close with no open in this block: the span began before (a table cell); strike from here.
      if (state.open === null) state.open = mark.index;
      flush(k++);
      state.open = null;
      out.push(
        <Box key={`${keyBase}-n${k++}`} component="span" id={`${strike.idPrefix}-${mark.index}`} data-testid="verdict-contradiction" sx={{ ml: 0.5, fontSize: "0.85em", fontWeight: 700, color: "error.main" }}>
          {`— ${strike.note}`}
        </Box>,
      );
    }
  }
  flush(k++);
  return out;
};

/** A block starts inside a span when its first sentinel closes one. */
const initialState = (text) => {
  for (const c of String(text)) {
    const mark = sentinel(c);
    if (mark) return { open: mark.close ? mark.index : null };
  }
  return { open: null };
};

const Inline = ({ text, codeSx, strike = null }) => {
  const state = initialState(text);
  const pieces = (value, i) => strikePieces(value, state, strike, i);
  return parseInline(text).map((tok, i) => {
    switch (tok.type) {
      case "code":
        return (
          <Box key={i} component="code" sx={codeSx}>
            {pieces(tok.value, i)}
          </Box>
        );
      case "bold":
        return (
          <Box key={i} component="strong" sx={{ fontWeight: 700 }}>
            {pieces(tok.value, i)}
          </Box>
        );
      case "italic":
        return (
          <Box key={i} component="em">
            {pieces(tok.value, i)}
          </Box>
        );
      case "link":
        return (
          <Box
            key={i}
            component="a"
            href={stripSentinels(tok.href)}
            target="_blank"
            rel="noreferrer noopener"
            sx={{ color: "primary.main", textDecorationColor: "inherit" }}
          >
            {pieces(tok.value, i)}
          </Box>
        );
      default:
        return <React.Fragment key={i}>{pieces(tok.value, i)}</React.Fragment>;
    }
  });
};

export default function MarkdownText({ text, muted = false, children = null, spans = null, strikeNote = "", strikeTitle = "" }) {
  const theme = useTheme();
  const uid = React.useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const marked = React.useMemo(() => (Array.isArray(spans) && spans.length ? markSpans(text, spans) : { text: stripSentinels(text), count: 0 }), [text, spans]);
  const blocks = React.useMemo(() => parseMarkdown(marked.text), [marked.text]);
  const strike = marked.count ? { note: strikeNote, title: strikeTitle, idPrefix: `strike-${uid}` } : null;
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
                <Inline text={b.text} codeSx={codeSx} strike={strike} />
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
                {stripSentinels(b.text)}
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
                    <Inline text={it} codeSx={codeSx} strike={strike} />
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
                <Inline text={b.text} codeSx={codeSx} strike={strike} />
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
                          <Inline text={h} codeSx={codeSx} strike={strike} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {b.header.map((_h, k) => (
                          <td key={k}>
                            <Inline text={r[k] ?? ""} codeSx={codeSx} strike={strike} />
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
                <Inline text={b.text} codeSx={codeSx} strike={strike} />
                {i === blocks.length - 1 ? children : null}
              </Box>
            );
        }
      })}
      {blocks.length === 0 ? children : null}
    </Box>
  );
}
