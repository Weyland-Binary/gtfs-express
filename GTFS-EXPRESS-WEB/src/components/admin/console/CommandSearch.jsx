import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Dialog, InputBase, Stack, Typography, alpha } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import SearchIcon from "@mui/icons-material/Search";
import PersonOutlineIcon from "@mui/icons-material/PersonOutline";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import StorageOutlinedIcon from "@mui/icons-material/StorageOutlined";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import { fetchProjects, fetchSessions, fetchUsers } from "../adminApi";
import { agencyNamesOf } from "./format";

const MAX_PER_GROUP = 6;

export default function CommandSearch({ open, onClose, onGo, sections }) {
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState({ users: [], projects: [], sessions: [] });
  const [active, setActive] = useState(0);
  const listRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    let alive = true;
    Promise.allSettled([fetchUsers(), fetchProjects(), fetchSessions()]).then(([u, p, s]) => {
      if (!alive) return;
      setIndex({
        users: u.status === "fulfilled" ? u.value.users : [],
        projects: p.status === "fulfilled" ? p.value.projects : [],
        sessions: s.status === "fulfilled" ? s.value.sessions : [],
      });
    });
    return () => {
      alive = false;
    };
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const has = (...parts) => parts.some((p) => p && String(p).toLowerCase().includes(q));
    const out = [];
    const screens = sections.filter((s) => !q || has(s.label, s.id)).map((s) => ({ key: `s-${s.id}`, group: "Screens", icon: s.icon, title: s.label, sub: null, go: () => onGo(s.id) }));
    if (!q) return screens;
    const users = index.users
      .filter((u) => has(u.email, u.display_name, u.profile && u.profile.organisation, u.id))
      .slice(0, MAX_PER_GROUP)
      .map((u) => ({ key: `u-${u.id}`, group: "Accounts", icon: PersonOutlineIcon, title: u.display_name || u.email, sub: [u.display_name ? u.email : null, u.profile && u.profile.organisation].filter(Boolean).join(" · "), go: () => onGo("accounts", u.id) }));
    const projects = index.projects
      .filter((p) => has(p.name, p.network, p.id, p.owner && p.owner.email))
      .slice(0, MAX_PER_GROUP)
      .map((p) => ({ key: `p-${p.id}`, group: "Projects", icon: FolderOutlinedIcon, title: p.name || "Untitled project", sub: [p.network, p.owner && p.owner.email].filter(Boolean).join(" · "), go: () => onGo("activity", null, { tab: "projects", q: p.name || p.id }) }));
    const sessions = index.sessions
      .filter((s) => has(s.session_id, agencyNamesOf(s.meta).join(" ")))
      .slice(0, MAX_PER_GROUP)
      .map((s) => ({ key: `w-${s.session_id}`, group: "Working copies", icon: StorageOutlinedIcon, title: agencyNamesOf(s.meta)[0] || "Working copy", sub: s.session_id, go: () => onGo("operations", null, { tab: "sessions", q: s.session_id }) }));
    out.push(...users, ...projects, ...sessions, ...screens);
    return out;
  }, [query, index, sections, onGo]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    const el = listRef.current && listRef.current.querySelector(`[data-index="${active}"]`);
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (r) => {
    onClose();
    r.go();
  };
  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && results[active]) {
      e.preventDefault();
      pick(results[active]);
    }
  };

  let lastGroup = null;
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: "12px", position: "absolute", top: { xs: 16, sm: "12vh" }, m: 0, width: { xs: "calc(100% - 24px)", sm: "100%" } } }}>
      <Stack direction="row" alignItems="center" spacing={1.25} sx={{ px: 2, height: 56, borderBottom: `1px solid ${theme.palette.divider}` }}>
        <SearchIcon sx={{ color: "text.secondary" }} />
        <InputBase
          autoFocus
          fullWidth
          placeholder="Search accounts, projects, working copies, screens"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          inputProps={{ "aria-label": "Search the console", "data-testid": "admin-search-input" }}
          sx={{ fontSize: 15 }}
        />
      </Stack>
      <Box ref={listRef} sx={{ maxHeight: "52vh", overflowY: "auto", py: 1 }} role="listbox">
        {results.length ? (
          results.map((r, i) => {
            const header = r.group !== lastGroup ? r.group : null;
            lastGroup = r.group;
            const Icon = r.icon;
            const on = i === active;
            return (
              <React.Fragment key={r.key}>
                {header ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: "block", px: 2.25, pt: i ? 1.25 : 0.5, pb: 0.5, fontWeight: 600 }}>
                    {header}
                  </Typography>
                ) : null}
                <Stack
                  direction="row"
                  alignItems="center"
                  spacing={1.5}
                  role="option"
                  aria-selected={on}
                  data-index={i}
                  data-testid="admin-search-result"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(r)}
                  sx={{ mx: 1, px: 1.25, py: 0.9, borderRadius: "8px", cursor: "pointer", bgcolor: on ? alpha(theme.palette.primary.main, 0.1) : "transparent" }}
                >
                  <Icon sx={{ fontSize: 18, color: on ? "primary.main" : "text.secondary" }} />
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
                      {r.title}
                    </Typography>
                    {r.sub ? (
                      <Typography variant="caption" color="text.secondary" noWrap component="div">
                        {r.sub}
                      </Typography>
                    ) : null}
                  </Box>
                  {on ? <ArrowForwardIcon sx={{ fontSize: 16, color: "primary.main" }} /> : null}
                </Stack>
              </React.Fragment>
            );
          })
        ) : (
          <Typography variant="body2" color="text.secondary" sx={{ px: 2.5, py: 3, textAlign: "center" }}>
            Nothing matches « {query} ».
          </Typography>
        )}
      </Box>
    </Dialog>
  );
}
