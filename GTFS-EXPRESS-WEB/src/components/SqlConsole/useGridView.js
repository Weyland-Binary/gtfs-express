import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { inferColumnType } from "./sqlText";

/**
 * useGridView — what the grid shows of a result: the rows matching the
 * bottom bar's filter (debounced by the caller), sorted on one column in a
 * tri-state cycle (numbers numerically, GTFS times and dates lexically, NULL
 * and empty last whatever the direction; the sort resets on a new result, not
 * on a filter), and the incremental window of VIRT_PAGE rows the scroll
 * handler widens near the bottom, so a 1 000 × 15 result never mounts 15 000
 * cells at once.
 */
export default function useGridView({ allRows, allColumns, debouncedFilter, result }) {
  /* --- derived (filtered rows / virtual slice) ------------------- */
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

  // Column sorting — single-column tri-state (asc → desc → none). Click on
  // another column resets the previous sort. Type detection reuses the same
  // column-type inference as the header chips so numbers sort numerically and
  // GTFS times/dates (HH:MM:SS, YYYYMMDD — both zero-padded) sort
  // lexicographically as expected.
  const [sortBy, setSortBy] = useState({ column: null, direction: null });

  // Reset sort when the underlying result changes (new query, cleared, …).
  // Filter changes alone don't reset — users can sort then filter.
  useEffect(() => {
    setSortBy({ column: null, direction: null });
  }, [result]);

  const handleSortColumn = useCallback((column) => {
    setSortBy((prev) => {
      if (prev.column !== column) return { column, direction: "asc" };
      if (prev.direction === "asc") return { column, direction: "desc" };
      // 3rd click on the same column clears the sort.
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
    // Copy before sort — useMemo result must not mutate filteredRows.
    const out = filteredRows.slice();
    out.sort((a, b) => {
      const va = a?.[col];
      const vb = b?.[col];
      const aEmpty = va == null || va === "";
      const bEmpty = vb == null || vb === "";
      // NULL/empty always sink to the bottom regardless of direction.
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1;
      if (bEmpty) return -1;
      let cmp;
      if (isNumeric) {
        const na = Number(va);
        const nb = Number(vb);
        cmp = na - nb;
        // Fallback to string compare if NaN sneaks in (mixed-type column).
        if (Number.isNaN(cmp)) cmp = collator.compare(String(va), String(vb));
      } else {
        cmp = collator.compare(String(va), String(vb));
      }
      return cmp * dir;
    });
    return out;
  }, [filteredRows, sortBy.column, sortBy.direction]);

  // Incremental render: initially show VIRT_PAGE rows, expand by VIRT_PAGE
  // on each near-bottom scroll event. This avoids mounting 15 000+ DOM nodes
  // for a 1000 row × 15 col result while keeping full scroll semantics.
  const VIRT_PAGE = 200;
  const [renderedCount, setRenderedCount] = useState(VIRT_PAGE);

  // Reset rendered window whenever the underlying data changes (new query,
  // new filter, result cleared, sort applied).
  useEffect(() => {
    setRenderedCount(VIRT_PAGE);
  }, [sortedRows]);

  const visibleRows = useMemo(
    () => sortedRows.slice(0, renderedCount),
    [sortedRows, renderedCount],
  );

  // Ref for the scrollable container so we can attach the scroll handler.
  const tableScrollRef = useRef(null);

  const handleTableScroll = useCallback(() => {
    const el = tableScrollRef.current;
    if (!el) return;
    // Load more when within 120 px of the bottom
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
