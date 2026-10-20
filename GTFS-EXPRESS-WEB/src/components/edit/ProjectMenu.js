import React, { useState } from "react";
import {
  Box,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  IconButton,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import ArticleOutlinedIcon from "@mui/icons-material/ArticleOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { useDetailPanel } from "../../contexts/DetailPanelContext";

/**
 * ProjectMenu — Discreet "Metadata" menu displayed in the header next to
 * the edit button. Exposes the feed's metadata editor (feed_info.txt).
 */
function ProjectMenu() {
  const { t } = useLanguage();
  const { openPanel } = useDetailPanel();
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";

  const [anchorEl, setAnchorEl] = useState(null);

  const open = Boolean(anchorEl);

  const handleOpenMenu = (e) => setAnchorEl(e.currentTarget);
  const handleCloseMenu = () => setAnchorEl(null);

  return (
    <>
      <Tooltip title={t("project.metadataSection")} arrow>
        <IconButton
          size="small"
          onClick={handleOpenMenu}
          sx={{
            padding: 1,
            borderRadius: 2.5,
            color: theme.palette.text.secondary,
            backgroundColor: alpha(
              theme.palette.primary.main,
              isDark ? 0.08 : 0.05,
            ),
            "&:hover": {
              backgroundColor: alpha(
                theme.palette.primary.main,
                isDark ? 0.18 : 0.12,
              ),
            },
          }}
        >
          <ArticleOutlinedIcon sx={{ fontSize: 20 }} />
        </IconButton>
      </Tooltip>

      <Menu
        anchorEl={anchorEl}
        open={open}
        onClose={handleCloseMenu}
        slotProps={{ paper: { sx: { minWidth: 280 } } }}
      >
        <Box sx={{ px: 2, pt: 0.75, pb: 0.25 }}>
          <Typography variant="caption" color="text.secondary" sx={{ textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 10, fontWeight: 700 }}>
            {t("project.metadataSection") || "Metadata"}
          </Typography>
        </Box>
        <MenuItem
          onClick={() => {
            handleCloseMenu();
            openPanel("feed_info", "feed_info.txt");
          }}
        >
          <ListItemIcon>
            <ArticleOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary={t("feedInfo.menuItem") || "Feed info…"}
            secondary="feed_info.txt"
          />
        </MenuItem>
        {/* levels / pathways / translations / attributions intentionally
            omitted here — they're accessible via CommandPalette (Ctrl+K)
            and the SQL Console Browse-files strip. Feed info stays because
            it's a singleton with cross-field validation (URL, date range,
            contact) that benefits from a dedicated form. */}
      </Menu>
    </>
  );
}

/** The feed's metadata as a row of the reader's « ⋯ » menu (Header, barFold): `onPick` closes that menu. */
export function FeedInfoMenuItem({ onPick = null }) {
  const { t } = useLanguage();
  const { openPanel } = useDetailPanel();
  return (
    <MenuItem
      onClick={() => {
        onPick?.();
        openPanel("feed_info", "feed_info.txt");
      }}
      data-testid="feed-info-open"
    >
      <ListItemIcon>
        <ArticleOutlinedIcon fontSize="small" />
      </ListItemIcon>
      <ListItemText primary={t("feedInfo.menuItem")} secondary="feed_info.txt" />
    </MenuItem>
  );
}

export default ProjectMenu;
