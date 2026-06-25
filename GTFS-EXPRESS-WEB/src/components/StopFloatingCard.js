import React from "react";
import ReactDOM from "react-dom";

const StopFloatingCard = ({ stop, isDark, x, y }) => {
  if (!stop) return null;

  const cardWidth = 300;
  const offset = 16;
  const leftPos =
    x + offset + cardWidth > window.innerWidth
      ? x - cardWidth - offset
      : x + offset;
  const topPos = Math.max(8, y - 8);

  const bg = isDark ? "#1a1f2e" : "#ffffff";
  const bannerBg = isDark ? "#1565c0" : "#1976d2";
  const labelColor = isDark ? "#94a3b8" : "#64748b";
  const valueColor = isDark ? "#e2e8f0" : "#1e293b";
  const dividerColor = isDark ? "#2d3748" : "#e2e8f0";
  const codeBg = isDark ? "#2d3748" : "#eff6ff";
  const codeColor = isDark ? "#90caf9" : "#1d4ed8";
  const coordBg = isDark ? "#0f172a" : "#f8fafc";
  const coordColor = isDark ? "#64748b" : "#94a3b8";

  // GTFS location_type: 0/blank = platform/stop, 1 = station (parent),
  // 2 = entrance/exit, 3 = generic node, 4 = boarding area.
  const locType = String(stop.location_type ?? "0");
  const typeLabel =
    locType === "1"
      ? "STATION"
      : locType === "2"
        ? "ENTRANCE/EXIT"
        : locType === "3"
          ? "GENERIC NODE"
          : locType === "4"
            ? "BOARDING AREA"
            : "STOP";

  const rowStyle = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    padding: "5px 0",
    borderBottom: `1px solid ${dividerColor}`,
  };

  const labelStyle = {
    fontSize: 11,
    fontWeight: 600,
    color: labelColor,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    whiteSpace: "nowrap",
  };

  const card = (
    <div
      style={{
        position: "fixed",
        left: leftPos,
        top: topPos,
        zIndex: 9999,
        pointerEvents: "none",
        fontFamily: "'Inter', system-ui, sans-serif",
      }}
    >
      <div
        style={{
          background: bg,
          borderRadius: 12,
          overflow: "hidden",
          minWidth: 280,
          maxWidth: 320,
          boxShadow: isDark
            ? "0 12px 40px rgba(0,0,0,0.55)"
            : "0 8px 32px rgba(0,0,0,0.18)",
        }}
      >
        {/* Banner */}
        <div style={{ background: bannerBg, padding: "14px 16px 12px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 6,
            }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                background: "rgba(255,255,255,0.18)",
                color: "#fff",
                padding: "2px 9px",
                borderRadius: 20,
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.07em",
              }}
            >
              {typeLabel}
            </span>
            {stop.stop_code && (
              <span
                style={{
                  background: "rgba(255,255,255,0.95)",
                  color: "#1565c0",
                  padding: "3px 10px",
                  borderRadius: 20,
                  fontSize: 11,
                  fontWeight: 800,
                  letterSpacing: "0.04em",
                }}
              >
                {stop.stop_code}
              </span>
            )}
          </div>
          <div
            style={{
              fontSize: 16,
              fontWeight: 800,
              color: "#ffffff",
              lineHeight: 1.25,
              letterSpacing: "-0.01em",
              textShadow: "0 1px 3px rgba(0,0,0,0.2)",
            }}
          >
            {stop.stop_name || "Unknown stop"}
          </div>
          {stop.wheelchair_boarding === "1" && (
            <div style={{ marginTop: 8 }}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  background: isDark ? "#14532d" : "#dcfce7",
                  color: isDark ? "#4ade80" : "#15803d",
                  padding: "3px 9px",
                  borderRadius: 20,
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.04em",
                }}
              >
                ♿ ACCESSIBLE
              </span>
            </div>
          )}
          {stop.wheelchair_boarding === "2" && (
            <div style={{ marginTop: 8 }}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  background: isDark ? "#431407" : "#fef3c7",
                  color: isDark ? "#fb923c" : "#92400e",
                  padding: "3px 9px",
                  borderRadius: 20,
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.04em",
                }}
              >
                ♿ NOT ACCESSIBLE
              </span>
            </div>
          )}
        </div>

        {/* Body */}
        <div style={{ padding: "12px 16px 10px" }}>
          {stop.stop_id && (
            <div style={rowStyle}>
              <span style={labelStyle}>Stop ID</span>
              <span
                style={{
                  fontFamily: "monospace",
                  background: codeBg,
                  color: codeColor,
                  padding: "2px 7px",
                  borderRadius: 5,
                  fontSize: 12,
                }}
              >
                {stop.stop_id}
              </span>
            </div>
          )}
          {stop.zone_id && (
            <div style={rowStyle}>
              <span style={labelStyle}>Zone</span>
              <span style={{ fontSize: 12, color: valueColor }}>
                {stop.zone_id}
              </span>
            </div>
          )}
          {stop.parent_station && (
            <div style={rowStyle}>
              <span style={labelStyle}>Station</span>
              <span
                style={{
                  fontSize: 12,
                  color: valueColor,
                  maxWidth: 160,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {stop.parent_station}
              </span>
            </div>
          )}

          {/* Coordinates */}
          <div
            style={{
              marginTop: 10,
              background: coordBg,
              borderRadius: 8,
              padding: "8px 12px",
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: coordColor,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                Latitude
              </span>
              <span
                style={{
                  fontSize: 12,
                  fontFamily: "monospace",
                  color: valueColor,
                }}
              >
                {parseFloat(stop.stop_lat).toFixed(6)}
              </span>
            </div>
            <div style={{ width: 1, background: dividerColor }} />
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 2,
                textAlign: "right",
              }}
            >
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: coordColor,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                Longitude
              </span>
              <span
                style={{
                  fontSize: 12,
                  fontFamily: "monospace",
                  color: valueColor,
                }}
              >
                {parseFloat(stop.stop_lon).toFixed(6)}
              </span>
            </div>
          </div>

          {/* Click hint */}
          <div
            style={{
              marginTop: 8,
              textAlign: "center",
              fontSize: 10,
              fontWeight: 600,
              color: isDark ? "#475569" : "#94a3b8",
              letterSpacing: "0.03em",
            }}
          >
            Click for details
          </div>
        </div>
      </div>
    </div>
  );

  return ReactDOM.createPortal(card, document.body);
};

export default StopFloatingCard;
