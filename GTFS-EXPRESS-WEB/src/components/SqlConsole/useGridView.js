import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { inferColumnType } from "./sqlText";

/** The rows the grid shows of a result: filtered, sorted on one column, in a window widened on scroll. */
export default function useGridView({ allRows, allColumns, debouncedFilter, result }) {
  const filteredRows = useMemo(() => {
    const q = debouncedFilter.trim().toLowerCase();
    if (!q) return allRows;
    return allRows.filter((row) =>
      allColumns.some((col) => {
        const v = row[col];
        return v != null && String(v).toLowerCase().includes(q);
      }),
    );
  }, [allRows, allColumns, debouncedFilter]);

  // GTFS times and dates (HH:MM:SS, YYYYMMDD) are zero-padded: they sort as text.
  const [sortBy, setSortBy] = useState({ column: null, direction: null });

  // A new result resets the sort; a filter does not.
  useEffect(() => {
    setSortBy({ column: null, direction: null });
  }, [result]);

  const handleSortColumn = useCallback((column) => {
    setSortBy((prev) => {
      if (prev.column !== column) return { column, direction: "asc" };
      if (prev.direction === "asc") return { column, direction: "desc" };
      return { column: null, direction: null };
    });
  }, []);

  const sortedRows = useMemo(() => {
    if (!sortBy.column || !sortBy.direction) return filteredRows;
    const col = sortBy.column;
    const dir = sortBy.direction === "desc" ? -1 : 1;
    const colType = inferColumnType(filteredRows, col);
    const isNumeric = colType === "INTEGER" || colType === "REAL";
    const collator = new Intl.Collator(undefined, {
      numeric: true,
      sensitivity: "base",
    });
    const out = filteredRows.slice();
    out.sort((a, b) => {
      const va = a?.[col];
      const vb = b?.[col];
      const aEmpty = va == null || va === "";
      const bEmpty = vb == null || vb === "";
      // Empty values last, whatever the direction.
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1;
      if (bEmpty) return -1;
      let cmp;
      if (isNumeric) {
        const na = Number(va);
        const nb = Number(vb);
        cmp = na - nb;
        // NaN on a mixed-type column: compare as text.
        if (Number.isNaN(cmp)) cmp = collator.compare(String(va), String(vb));
      } else {
        cmp = collator.compare(String(va), String(vb));
      }
      return cmp * dir;
    });
    return out;
  }, [filteredRows, sortBy.column, sortBy.direction]);

  // Widened on scroll: a 1000 × 15 result would otherwise mount 15 000 cells.
  const VIRT_PAGE = 200;
  const [renderedCount, setRenderedCount] = useState(VIRT_PAGE);

  useEffect(() => {
    setRenderedCount(VIRT_PAGE);
  }, [sortedRows]);

  const visibleRows = useMemo(
    () => sortedRows.slice(0, renderedCount),
    [sortedRows, renderedCount],
  );

  const tableScrollRef = useRef(null);

  const handleTableScroll = useCallback(() => {
    const el = tableScrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
      setRenderedCount((prev) => Math.min(prev + VIRT_PAGE, sortedRows.length));
    }
  }, [sortedRows.length]);
  return {
    filteredRows,
    sortBy,
    handleSortColumn,
    sortedRows,
    visibleRows,
    tableScrollRef,
    handleTableScroll,
  };
}
