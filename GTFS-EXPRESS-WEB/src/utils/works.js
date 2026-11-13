import { WORKS_OPEN_EVENT } from "./appEvents";
// Opens the « Mes travaux » window from any page.

export const openWorks = () => window.dispatchEvent(new CustomEvent(WORKS_OPEN_EVENT));
