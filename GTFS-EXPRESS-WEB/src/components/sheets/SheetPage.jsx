/**
 * One printed stop sheet. A line's sheet (`page.block`): on the left the line's path from end to end, the stop
 * marked (a long path folds the stops already passed); on the right the line and its direction, the days and hours
 * it runs, its weekday headway, the stop's name, then one band per day type with the hours across and the minutes
 * under each hour. A stop's poster (`page.blocks`): the stop's name, then every line calling there, one block each,
 * no path. At the foot the school holidays, the notes, the QR code and the network's message. The same markup is the
 * preview and the print; its words are the sheet's (`labels`, from the server, in the sheet's language), not the
 * screen's.
 */
import React, { useMemo } from "react";
import qrcode from "qrcode-generator";
import { baseSizeOf, foldPath, gridOf, hoursOf, qrAddressOf, routeColorsOf, timeOf } from "./sheetLayout";
import { DAY_TYPE_COLORS } from "./sheetStyles";

const fill = (template, values) => String(template || "").replace(/\{(\w+)\}/g, (_, k) => (values[k] === undefined ? "" : String(values[k])));
const upperFirst = (s) => (s ? s.charAt(0).toLocaleUpperCase() + s.slice(1) : s);

function QrCode({ text }) {
  const shape = useMemo(() => {
    try {
      const qr = qrcode(0, "M");
      qr.addData(text);
      qr.make();
      const n = qr.getModuleCount();
      let d = "";
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
      return { d, n };
    } catch {
      return null;
    }
  }, [text]);
  if (!shape) return null;
  return (
    <svg viewBox={`-1 -1 ${shape.n + 2} ${shape.n + 2}`} shapeRendering="crispEdges" role="img" aria-label={text}>
      <rect x="-1" y="-1" width={shape.n + 2} height={shape.n + 2} fill="#ffffff" />
      <path d={shape.d} fill="#111111" />
    </svg>
  );
}

function Path({ path, links, labels }) {
  const last = path.stops.length - 1;
  const rows = useMemo(() => foldPath(path), [path]);
  return (
    <div className="gx-path" data-fit="">
      {rows.map((row) => {
        if (row.fold) {
          return (
            <div key="fold" className="gx-stop gx-past gx-fold" data-testid="sheet-path-fold">
              <div className="gx-stop-name">{fill(labels.moreStops || "{n}", { n: row.fold })}</div>
              <div className="gx-rail" />
              <div className="gx-stop-min" />
            </div>
          );
        }
        const { stop: s, i } = row;
        const cls = ["gx-stop", i < path.here ? "gx-past" : "", i === path.here ? "gx-here" : "", i === last ? "gx-end" : ""].filter(Boolean).join(" ");
        return (
          <div key={`${s.name}-${i}`} className={cls}>
            <div className="gx-stop-name">
              {links && i > path.here && s.links.length > 0 && (
                <span className="gx-links">
                  {s.links.slice(0, 3).map((l) => (
                    <span key={l.id} className="gx-link" style={{ background: `#${l.color}`, color: `#${l.text}` }}>
                      {l.short}
                    </span>
                  ))}
                </span>
              )}
              <span>{s.name}</span>
            </div>
            <div className="gx-rail">
              <span className="gx-dot" />
            </div>
            <div className="gx-stop-min">{i > path.here && s.min != null ? `${s.min}′` : ""}</div>
          </div>
        );
      })}
    </div>
  );
}

function DayGrid({ block, column, hours, labels, fold }) {
  const { cells, bands } = useMemo(() => gridOf(block, column, hours, fold), [block, column, hours, fold]);
  const color = DAY_TYPE_COLORS[column.types[0]] || DAY_TYPE_COLORS.weekday;
  const covered = new Set(bands.flatMap((b) => Array.from({ length: b.span }, (_, k) => b.from + k)));
  return (
    <section className="gx-day">
      <div className="gx-day-title" style={{ background: color.bg, color: color.fg }}>
        <span>{column.label}</span>
        {(column.note || column.closed) && <em>{[column.note, column.closed].filter(Boolean).join(" · ")}</em>}
      </div>
      <div className="gx-grid" style={{ "--gx-hours": hours.length }}>
        {hours.map((h) => (
          <div key={`h${h}`} className="gx-hour">
            {h % 24}
            <small>h</small>
          </div>
        ))}
        {hours.map((h, k) => {
          const band = bands.find((b) => b.from === k);
          if (band)
            return (
              <div key={`c${h}`} className="gx-cell gx-cell-band" style={{ gridColumn: `span ${band.span}` }}>
                <div className="gx-band">{upperFirst(band.lo === band.hi ? fill(labels.every, { n: band.lo }) : fill(labels.everyRange, { a: band.lo, b: band.hi }))}</div>
              </div>
            );
          if (covered.has(k)) return null;
          return (
            <div key={`c${h}`} className={k % 2 ? "gx-cell gx-alt" : "gx-cell"}>
              {cells[k].map((c, n) => (
                <span key={`${c.sec}-${n}`}>
                  {c.m}
                  {c.mark && <sup>{c.mark}</sup>}
                </span>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}

const amplitudeOf = (labels, s) => (s.first && s.last ? fill(labels.amplitude, { first: timeOf(labels, s.first), last: timeOf(labels, s.last) }) : null);

function Header({ block, stop, labels, prefs }) {
  const s = block.summary;
  const amplitude = amplitudeOf(labels, s);
  return (
    <>
      <div className="gx-code">{stop.code || ""}</div>
      <div className="gx-card">
        <div className="gx-card-top">
          <div className="gx-badge">{block.route.short}</div>
          <div className="gx-direction">
            <small>{labels.direction} :</small>
            <strong>{block.headsign}</strong>
          </div>
        </div>
        <div className="gx-card-facts">
          <div className="gx-fact">{s.days}</div>
          {amplitude && <div className="gx-fact">{amplitude}</div>}
          {s.headway != null && (
            <div className="gx-fact">
              <span>{labels.headway}</span>
              <b>
                {s.headway} {labels.min}
              </b>
            </div>
          )}
          {prefs.logo && (
            <div className="gx-fact gx-logo">
              <img src={prefs.logo} alt={prefs.network || ""} />
            </div>
          )}
        </div>
      </div>
      <div className="gx-valid">{labels.validText}</div>
      <div className="gx-stopname">
        {labels.stop} : <b>{stop.name}</b>
      </div>
    </>
  );
}

function Grids({ block, labels, prefs }) {
  const hours = useMemo(() => hoursOf(block), [block]);
  return (
    <>
      {block.columns.map((c) => (
        <DayGrid key={c.types.join("+")} block={block} column={c} hours={hours} labels={labels} fold={prefs.freq} />
      ))}
      {block.absent && <div className="gx-absent">{block.absent}</div>}
    </>
  );
}

function Boxes({ notes, stop, labels, prefs, school }) {
  const qr = prefs.qr && prefs.qrUrl ? qrAddressOf(prefs.qrUrl, stop) : null;
  const holidays = prefs.school ? school : [];
  if (!holidays.length && !notes.length && !qr) return null;
  return (
    <div className="gx-boxes">
      {holidays.length > 0 && (
        <div className="gx-box gx-school">
          <div className="gx-box-head">{labels.school}</div>
          <div className="gx-box-body">
            {holidays.map((h) => (
              <div key={`${h.name}-${h.from}`}>
                <b>{h.name}</b> : {h.from} → {h.to}
              </div>
            ))}
          </div>
        </div>
      )}
      {notes.length > 0 && (
        <div className="gx-box gx-notes">
          <div className="gx-box-head">{labels.notes}</div>
          <div className="gx-box-body">
            {notes.map((n) => (
              <div key={n.mark} className="gx-note">
                <b>{n.mark}</b>
                <span>{n.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {qr && (
        <div className="gx-box gx-qr">
          <div className="gx-box-head">{prefs.qrCaption || labels.nextDepartures}</div>
          <div className="gx-box-body">
            <QrCode text={qr} />
          </div>
        </div>
      )}
    </div>
  );
}

/** A stop's poster: every line and direction calling there, one block each; each block's notes under its grids. */
function Poster({ stop, blocks, labels, prefs, school }) {
  return (
    <div className="gx-sheet gx-poster">
      <div className="gx-main" data-fit="">
        <div className="gx-poster-head">
          <div className="gx-stopname">
            {labels.stop} : <b>{stop.name}</b>
            {stop.code && <span className="gx-code"> {stop.code}</span>}
          </div>
          <div className="gx-valid">{labels.validText}</div>
        </div>
        {blocks.map((block) => {
          const colors = routeColorsOf(block.route);
          const facts = [block.summary.days, amplitudeOf(labels, block.summary), block.summary.headway != null ? `${labels.headway} ${block.summary.headway} ${labels.min}` : null].filter(Boolean).join(" · ");
          return (
            <div key={block.key} className="gx-poster-block" data-testid="poster-block" style={colors}>
              <div className="gx-poster-line">
                <div className="gx-badge">{block.route.short}</div>
                <div className="gx-direction">
                  <small>{labels.direction} :</small>
                  <strong>{block.headsign}</strong>
                </div>
                <div className="gx-poster-facts">{facts}</div>
              </div>
              <Grids block={block} labels={labels} prefs={prefs} />
              {block.notes.length > 0 && (
                <div className="gx-poster-notes">
                  {block.notes.map((n) => (
                    <span key={n.mark}>
                      <b>{n.mark}</b>
                      {n.text}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <div className="gx-spacer" />
        <Boxes notes={[]} stop={stop} labels={labels} prefs={prefs} school={school} />
        {prefs.footer && <div className="gx-footer">{prefs.footer}</div>}
        <div className="gx-edition">{[prefs.network, labels.editedText].filter(Boolean).join(" · ")}</div>
      </div>
    </div>
  );
}

const SheetPage = React.forwardRef(function SheetPage({ page, labels, prefs, paper, watermark, school = [] }, ref) {
  const { stop, block, blocks } = page;
  const lead = block || blocks?.[0] || null;
  const colors = lead ? routeColorsOf(lead.route) : {};
  return (
    <div
      ref={ref}
      className="gx-page"
      data-testid="sheet-page"
      data-kind={block ? "line" : "stop"}
      style={{ width: `${paper.w}mm`, height: `${paper.h}mm`, "--gx-base": `${baseSizeOf(paper, prefs.large)}pt`, "--gx-scale": 1, "--gx-accent": prefs.accent || colors["--gx-route-ink"] || "#1a1a1a", ...colors }}
    >
      {block ? (
        <div className="gx-sheet">
          <Path path={block.path} links={prefs.links} labels={labels} />
          <div className="gx-main" data-fit="">
            <Header block={block} stop={stop} labels={labels} prefs={prefs} />
            <Grids block={block} labels={labels} prefs={prefs} />
            <div className="gx-spacer" />
            <Boxes notes={block.notes} stop={stop} labels={labels} prefs={prefs} school={school} />
            {prefs.footer && <div className="gx-footer">{prefs.footer}</div>}
            <div className="gx-edition">{[prefs.network, labels.editedText].filter(Boolean).join(" · ")}</div>
          </div>
        </div>
      ) : (
        <Poster stop={stop} blocks={blocks || []} labels={labels} prefs={prefs} school={school} />
      )}
      {/* A fine pattern over the whole page, blended into it: it marks every part of the sheet and hides none of it. */}
      {watermark && (
        <div className={`gx-watermark gx-watermark-${watermark}`} aria-hidden="true">
          <div className="gx-watermark-tiles">
            {Array.from({ length: 60 }, (_, i) => (
              <span key={i}>{watermark === "trial" ? labels.trial : labels.preview}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

export default SheetPage;
