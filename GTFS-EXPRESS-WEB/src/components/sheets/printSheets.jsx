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
    const done = () => {
      window.removeEventListener("afterprint", done);
      resolve();
    };
    window.addEventListener("afterprint", done);
    window.print();
  });
  root.unmount();
  host.remove();
  return dense;
}
