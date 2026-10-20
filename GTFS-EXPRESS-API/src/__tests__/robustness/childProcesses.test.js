/**
 * The child processes the API starts on untrusted input: the canonical validator's JVM gets what it needs to run,
 * never the API's secrets; the PDF readers run a bounded number at a time, the others waiting their turn.
 */

"use strict";

const canonical = require("../../services/canonicalValidatorService");
const pdfText = require("../../services/network/pdfText");

test("the validator's environment carries no secret of the API", () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { ANTHROPIC_API_KEY: "sk-ant-test", STRIPE_SECRET_KEY: "sk_test", MAIL_API_KEY: "mail", PATH: "/usr/bin", JAVA_TOOL_OPTIONS: "-Xss1m" });
    const env = canonical._internals.validatorEnv();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.JAVA_TOOL_OPTIONS).toBe("-Xss1m");
    for (const secret of ["ANTHROPIC_API_KEY", "STRIPE_SECRET_KEY", "MAIL_API_KEY", "IP_HASH_SECRET", "ADMIN_TOKEN", "CLIENT_TOKEN_SECRET"]) expect(env).not.toHaveProperty(secret);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("PDF readers beyond the bound wait their turn", async () => {
  const { PDF_CONCURRENCY, inFlight } = pdfText._internals;
  // Not a PDF: each child starts, fails to parse and ends — what is measured is how many run at once.
  const garbage = Buffer.from("not a pdf");
  const reads = Array.from({ length: PDF_CONCURRENCY + 2 }, () => pdfText.extractPdfText(garbage, { timeoutMs: 15000 }));
  expect(inFlight()).toEqual({ running: PDF_CONCURRENCY, queued: 2 });
  const results = await Promise.all(reads);
  expect(results).toHaveLength(PDF_CONCURRENCY + 2);
  expect(inFlight()).toEqual({ running: 0, queued: 0 });
});
