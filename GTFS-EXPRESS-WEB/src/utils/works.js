/**
 * works — « Mes travaux » is a window any page opens (components/home/WorksDialog, mounted by GTFSApp).
 */

export const WORKS_OPEN_EVENT = "gtfs:open-works";
export const openWorks = () => window.dispatchEvent(new CustomEvent(WORKS_OPEN_EVENT));
