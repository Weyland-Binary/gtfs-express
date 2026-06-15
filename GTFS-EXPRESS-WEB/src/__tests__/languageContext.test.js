import React from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { LanguageProvider, useLanguage } from "../contexts/LanguageContext";

// Minimal consumer exposing the bits under test.
let api;
const Probe = ({ tKey, tParams }) => {
  api = useLanguage();
  return <span data-testid="out">{api.t(tKey, tParams)}</span>;
};

const renderWithLanguage = (props) =>
  render(
    <LanguageProvider>
      <Probe {...props} />
    </LanguageProvider>,
  );

beforeEach(() => {
  localStorage.clear();
  document.documentElement.dir = "ltr";
});

describe("t()", () => {
  it("resolves a known key in the active language", () => {
    localStorage.setItem("appLanguage", "fr");
    renderWithLanguage({ tKey: "nav.stops" });
    expect(screen.getByTestId("out")).toHaveTextContent("Arrêts");
  });

  it("falls back to English when the key is missing in the active language, and to the key itself when unknown everywhere", () => {
    localStorage.setItem("appLanguage", "fr");
    renderWithLanguage({ tKey: "totally.unknown.key" });
    expect(screen.getByTestId("out")).toHaveTextContent("totally.unknown.key");
  });

  it("interpolates {param} placeholders, including repeated ones", () => {
    localStorage.setItem("appLanguage", "en");
    renderWithLanguage({
      tKey: "header.reportTooltip",
      tParams: { errors: 3, warnings: 5, infos: 1 },
    });
    expect(screen.getByTestId("out").textContent).toContain("3");
    expect(screen.getByTestId("out").textContent).toContain("5");
  });
});

describe("language switching", () => {
  it("flips document direction to rtl for Arabic and back to ltr", () => {
    renderWithLanguage({ tKey: "nav.stops" });

    act(() => api.setLanguage("ar"));
    expect(document.documentElement.dir).toBe("rtl");
    expect(document.documentElement.lang).toBe("ar");
    expect(localStorage.getItem("appLanguage")).toBe("ar");

    act(() => api.setLanguage("en"));
    expect(document.documentElement.dir).toBe("ltr");
  });

  it("ignores unsupported language codes", () => {
    renderWithLanguage({ tKey: "nav.stops" });
    const before = api.language;
    act(() => api.setLanguage("xx"));
    expect(api.language).toBe(before);
  });

  it("exposes the 8 supported languages", () => {
    renderWithLanguage({ tKey: "nav.stops" });
    expect(api.languages.map((l) => l.code)).toEqual([
      "en",
      "fr",
      "es",
      "de",
      "pt",
      "zh",
      "ar",
      "hi",
    ]);
  });
});
