/**
 * AccountMenu — the account entry in the header, shown only when accounts
 * are enabled on the API: a "Sign in" button for visitors, the avatar
 * initial with a menu (My account, « Mes travaux », « Mes données », Sign
 * out) once signed in. « Mes travaux » is Home, the list of the person's
 * projects — the Project Studio's own list is dissolved in it (WP10).
 * « Mes données » (MyDataDialog) downloads the account's data and deletes
 * the account; the dialog stays mounted once the account is gone, to say so.
 */

import React, { useState } from "react";
import { Avatar, Box, Button, Divider, IconButton, ListItemIcon, Menu, MenuItem, Tooltip, Typography } from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import PersonOutlineIcon from "@mui/icons-material/PersonOutline";
import ManageAccountsOutlinedIcon from "@mui/icons-material/ManageAccountsOutlined";
import LogoutOutlinedIcon from "@mui/icons-material/LogoutOutlined";
import FolderOpenOutlinedIcon from "@mui/icons-material/FolderOpenOutlined";
import PrivacyTipOutlinedIcon from "@mui/icons-material/PrivacyTipOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { useAccount } from "../../contexts/AccountContext";
import { HOME_PATH, useNavigate } from "../../utils/routes";
import MyDataDialog from "./MyDataDialog";

const initialOf = (user) => {
  const source = (user?.display_name || user?.email || "?").trim();
  return source.charAt(0).toUpperCase() || "?";
};

export default function AccountMenu({ compact = false }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const { enabled, me, openAccountDialog, signOut } = useAccount();
  const navigate = useNavigate();
  const [anchor, setAnchor] = useState(null);
  const [dataOpen, setDataOpen] = useState(false);

  if (!enabled) return null;
  // « Mes données » outlives the account it deletes: it says the account is gone, then closes. Keyed, so the
  // sign-out its deletion causes (the other branch below) keeps the same dialog and its state, not a new one.
  const dataDialog = <MyDataDialog key="my-data" open={dataOpen} onClose={() => setDataOpen(false)} />;

  const color = theme.palette.primary.main;
  const base = { borderRadius: 2.5, color, backgroundColor: alpha(color, theme.palette.mode === "dark" ? 0.16 : 0.08), "&:hover": { backgroundColor: alpha(color, theme.palette.mode === "dark" ? 0.26 : 0.16) } };

  if (!me) {
    return (
      <>
      <Tooltip title={t("account.signInHint")} arrow>
        {compact ? (
          <IconButton size="small" onClick={() => openAccountDialog({ tab: "signin" })} aria-label={t("account.signIn")} data-testid="account-signin-button" sx={{ ...base, padding: 1 }}>
            <PersonOutlineIcon sx={{ fontSize: 20 }} />
          </IconButton>
        ) : (
          <Button size="small" onClick={() => openAccountDialog({ tab: "signin" })} startIcon={<PersonOutlineIcon sx={{ fontSize: "18px !important" }} />} data-testid="account-signin-button" sx={{ ...base, textTransform: "none", fontWeight: 700, fontSize: "0.8rem", whiteSpace: "nowrap", px: 1.5, py: 0.6 }}>
            {t("account.signIn")}
          </Button>
        )}
      </Tooltip>
      {dataDialog}
      </>
    );
  }

  const name = me.display_name || me.email;
  return (
    <>
      <Tooltip title={t("account.menu.signedInAs", { name })} arrow>
        <IconButton size="small" onClick={(e) => setAnchor(e.currentTarget)} aria-label={t("account.myAccount")} data-testid="account-menu-button" sx={{ p: 0.4 }}>
          <Avatar sx={{ width: 30, height: 30, fontSize: "0.85rem", fontWeight: 800, bgcolor: color }}>{initialOf(me)}</Avatar>
        </IconButton>
      </Tooltip>
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)} anchorOrigin={{ vertical: "bottom", horizontal: "right" }} transformOrigin={{ vertical: "top", horizontal: "right" }} PaperProps={{ sx: { minWidth: 220, borderRadius: 2 } }}>
        <Box sx={{ px: 2, pt: 1, pb: 0.75 }}>
          <Typography sx={{ fontSize: "0.72rem", color: "text.secondary" }}>{t("account.menu.signedInLabel")}</Typography>
          <Typography sx={{ fontSize: "0.86rem", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} data-testid="account-menu-name">
            {name}
          </Typography>
        </Box>
        <Divider />
        <MenuItem
          onClick={() => {
            setAnchor(null);
            openAccountDialog();
          }}
          data-testid="account-menu-account"
        >
          <ListItemIcon>
            <ManageAccountsOutlinedIcon fontSize="small" />
          </ListItemIcon>
          {t("account.myAccount")}
        </MenuItem>
        <MenuItem
          component="a"
          href={HOME_PATH}
          onClick={(e) => {
            e.preventDefault();
            setAnchor(null);
            navigate(HOME_PATH);
          }}
          data-testid="account-menu-projects"
        >
          <ListItemIcon>
            <FolderOpenOutlinedIcon fontSize="small" />
          </ListItemIcon>
          {t("home.projects")}
        </MenuItem>
        <MenuItem
          onClick={() => {
            setAnchor(null);
            setDataOpen(true);
          }}
          data-testid="account-menu-data"
        >
          <ListItemIcon>
            <PrivacyTipOutlinedIcon fontSize="small" />
          </ListItemIcon>
          {t("account.data.menu")}
        </MenuItem>
        <MenuItem
          onClick={() => {
            setAnchor(null);
            signOut();
          }}
          data-testid="account-menu-signout"
        >
          <ListItemIcon>
            <LogoutOutlinedIcon fontSize="small" />
          </ListItemIcon>
          {t("account.signOut")}
        </MenuItem>
      </Menu>
      {dataDialog}
    </>
  );
}
