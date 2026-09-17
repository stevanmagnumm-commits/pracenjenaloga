"use client";

import { useCallback, useRef, useState } from "react";

/**
 * Checkbox selection for a results table, shared by the Ban Checker, the Views
 * Checker and the Link Finder so the three behave identically.
 *
 * Two things it adds over a plain Set:
 *
 *   - shift-click selects the whole range between the last clicked row and this
 *     one, the way every file manager and spreadsheet does. Picking sixty
 *     accounts out of four hundred one checkbox at a time is the kind of chore
 *     that makes people stop using a screen.
 *   - selection is keyed by username, not row index. The Ban Checker used the
 *     index, which silently re-points at different accounts the moment a filter
 *     is applied — select five rows, click a filter, and the ticks are now on
 *     five other people.
 */
export function useRowSelection(orderedKeys: string[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Index of the last row clicked without shift — the anchor a shift-click
  // extends from. A ref, not state: changing it must not re-render the table.
  const anchor = useRef<number | null>(null);

  const toggle = useCallback(
    (key: string, index: number, shiftKey = false) => {
      setSelected((prev) => {
        const next = new Set(prev);

        if (shiftKey && anchor.current !== null) {
          const [from, to] =
            anchor.current <= index ? [anchor.current, index] : [index, anchor.current];
          // The anchor's own state decides the whole range: extending a
          // selection adds, extending a deselection removes.
          const adding = prev.has(orderedKeys[anchor.current]) || !prev.has(key);
          for (let i = from; i <= to; i++) {
            const k = orderedKeys[i];
            if (!k) continue;
            if (adding) next.add(k);
            else next.delete(k);
          }
          return next;
        }

        if (next.has(key)) next.delete(key);
        else next.add(key);
        anchor.current = index;
        return next;
      });
    },
    [orderedKeys],
  );

  const selectAll = useCallback(() => {
    setSelected(new Set(orderedKeys));
    anchor.current = null;
  }, [orderedKeys]);

  const clear = useCallback(() => {
    setSelected(new Set());
    anchor.current = null;
  }, []);

  const allSelected = orderedKeys.length > 0 && orderedKeys.every((k) => selected.has(k));

  const toggleAll = useCallback(() => {
    if (allSelected) clear();
    else selectAll();
  }, [allSelected, clear, selectAll]);

  return { selected, toggle, selectAll, clear, toggleAll, allSelected };
}

/**
 * Open each account's Instagram profile in its own tab.
 *
 * Browsers only allow this from a real click, and they stop somewhere past a
 * dozen even then — so the caller is told how many actually opened rather than
 * being left to wonder why tab fourteen never appeared.
 */
export function openInstagramTabs(usernames: string[]): { opened: number; blocked: number } {
  let opened = 0;
  let blocked = 0;
  for (const u of usernames) {
    const win = window.open(`https://www.instagram.com/${u}/`, "_blank", "noopener,noreferrer");
    if (win) opened++;
    else blocked++;
  }
  return { opened, blocked };
}
