/**
 * What a screen knows of the edit journal (GET /edit/history): its latest standing entry, which an undo names so that
 * it never undoes an edit made elsewhere since, and the entry each edit recorded here wrote. That entry is told by
 * what stands above the head known before the edit: as many entries as edits recorded here are theirs, in their
 * order; fewer or more, and no edit is named rather than another's.
 *
 * `read({ after, limit })` answers the journal's `{ history, head_id }`, or throws.
 */
export function createJournalWatch(read) {
  // null: not read yet; 0: nothing stands.
  let head = null;
  // Moves when this screen learns the head outside a read: what a read in flight then answers is stale.
  let moved = 0;
  let waiting = [];
  let reading = null;

  const readOnce = async () => {
    const asked = waiting;
    waiting = [];
    const known = head;
    const at = moved;
    let top = null;
    try {
      // One entry more than the edits recorded here: enough to see that another stands beside them.
      top = await read(known == null ? { limit: asked.length ? 1 : 0 } : { after: known, limit: asked.length + 1 });
    } catch {
      top = null;
    }
    const usable = Boolean(top) && Number.isInteger(top.head_id) && at === moved;
    const standing = usable ? (Array.isArray(top.history) ? top.history : []).filter((e) => e && !e.undone).map((e) => Number(e.id)).sort((a, b) => a - b) : [];
    let named = asked.map(() => null);
    if (usable && known != null && standing.length === asked.length) named = standing;
    // With no head known before it, the last edit is given the latest standing entry.
    else if (usable && known == null && asked.length && standing.length) named[asked.length - 1] = standing[standing.length - 1];
    if (usable) head = top.head_id;
    asked.forEach((tell, i) => tell(named[i]));
  };

  const sync = () => {
    if (!reading) {
      reading = (async () => {
        try {
          do await readOnce();
          while (waiting.length);
        } finally {
          reading = null;
        }
      })();
    }
    return reading;
  };

  return {
    /** The entry the edit just recorded here wrote, or null when it cannot be told apart. */
    entryOfEdit: () => {
      const told = new Promise((tell) => waiting.push(tell));
      sync();
      return told;
    },
    /** The latest standing entry this screen knows, read first when it knows none; null when it cannot be read. */
    latest: async () => {
      if (reading) await reading;
      if (head == null) await sync();
      return head;
    },
    /** The head an undo, a redo or a jump answered. */
    set: (id) => {
      head = Number.isInteger(id) ? id : null;
      moved += 1;
    },
    /** The screen reads another journal, or its journal moved without it. */
    forget: () => {
      head = null;
      moved += 1;
    },
  };
}
