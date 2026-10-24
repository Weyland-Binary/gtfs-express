/**
 * Prints a batch of sheets from the page itself (the app's fonts, no pop-up): the pages are laid out in a root of
 * their own off screen, each fitted to its paper, then the browser's print shows them alone, one sheet a page. Saving
 * as PDF from the print dialog gives the vector PDF.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import SheetPage from "./SheetPage";
import { SHEET_CSS, PRINT_CSS } from "./sheetStyles";
import { fitPage } from "./sheetLayout";

const ROOT_ID = "gx-print-root";

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

// A browser that never opens the dialog (a second print() during another, a WebView) sends no afterprint: the print
// media leaving, or this delay once print() returned, ends the print all the same.
const PRINT_FALLBACK_MS = 30_000;

/** Resolves once the print dialog closed, with the keys of the pages still too dense at the smallest text. */
export default async function printSheets({ pages, labels, prefs, paper, watermark, school }) {
  document.getElementById(ROOT_ID)?.remove();
  const host = document.createElement("div");
  host.id = ROOT_ID;
  const style = document.createElement("style");
  style.textContent = `${SHEET_CSS}\n${PRINT_CSS(paper)}`;
  host.appendChild(style);
  const mount = document.createElement("div");
  host.appendChild(mount);
  document.body.appendChild(host);
  const root = createRoot(mount);
  flushSync(() => {
    root.render(
      <>
        {pages.map((page) => (
          <SheetPage key={page.key} page={page} labels={labels} prefs={prefs} paper={paper} watermark={watermark} school={school} />
        ))}
      </>,
    );
  });
  // Logos and the QR codes are laid out before measuring.
  const loaded = (img) =>
    new Promise((resolve) => {
      img.addEventListener("load", resolve, { once: true });
      img.addEventListener("error", resolve, { once: true });
    });
  await Promise.all([...host.querySelectorAll("img")].filter((img) => !img.complete).map(loaded));
  await nextFrame();
  const dense = [];
  host.querySelectorAll(".gx-page").forEach((el, i) => {
    if (fitPage(el).overflow) dense.push(pages[i].key);
  });
  await nextFrame();
  await new Promise((resolve) => {
    const media = typeof window.matchMedia === "function" ? window.matchMedia("print") : null;
    let timer = null;
    const onMedia = (e) => {
      if (!e.matches) done();
    };
    const done = () => {
      window.removeEventListener("afterprint", done);
      media?.removeEventListener?.("change", onMedia);
      clearTimeout(timer);
      resolve();
    };
    window.addEventListener("afterprint", done);
    media?.addEventListener?.("change", onMedia);
    window.print();
    timer = setTimeout(done, PRINT_FALLBACK_MS);
  });
  root.unmount();
  host.remove();
  return dense;
}
