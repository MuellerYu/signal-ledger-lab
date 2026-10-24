"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { filterByRange, formatNav, signedPct } from "@/lib/portfolio-format";

/**
 * One interactive comparison chart for model portfolios.
 *
 * Deliberately portfolio-agnostic: it takes N series, shares a single date
 * domain, a single Y axis and a single crosshair. Pick-NY vs SPY is just the
 * first caller — Pick-Chicago, Pick-LA or any index are added by passing more
 * series, with no change here.
 *
 * The browser only filters dates and rebases the visible window to 100. NAV is
 * never recalculated: the persisted daily series arrives ready to draw.
 */

export type ComparisonPoint = { date: string; value: number };
export type ComparisonSeries = { id: string; label: string; points: ComparisonPoint[] };

export const CHART_RANGES = ["1M", "3M", "6M", "YTD", "SI", "CUSTOM"] as const;
export type ChartRange = (typeof CHART_RANGES)[number];
export type Viewport = { from: number; to: number };

const VIEW_WIDTH = 1200;
const PAD_TOP = 18;
const PAD_BOTTOM = 30;
const PAD_LEFT = 56;
const PAD_RIGHT = 92;
const NAVIGATOR_HEIGHT = 64;
const MIN_VISIBLE_POINTS = 5;

const RANGE_LABEL: Record<ChartRange, string> = {
  "1M": "1M", "3M": "3M", "6M": "6M", YTD: "YTD", SI: "Since inception", CUSTOM: "Custom",
};

/** Union of every series' dates, ascending. */
export function alignDomain(series: ComparisonSeries[]): string[] {
  const dates = new Set<string>();
  for (const entry of series) for (const point of entry.points) dates.add(point.date);
  return [...dates].sort();
}

export function rangeViewport(domain: string[], range: ChartRange, custom?: { from?: string; to?: string }): Viewport {
  const last = domain.length - 1;
  if (last < 0) return { from: 0, to: 0 };
  if (range === "SI") return { from: 0, to: last };
  if (range === "CUSTOM") {
    const fromIndex = custom?.from ? domain.findIndex((date) => date >= custom.from!) : 0;
    let toIndex = last;
    if (custom?.to) {
      toIndex = last;
      for (let index = last; index >= 0; index--) {
        if (domain[index] <= custom.to) { toIndex = index; break; }
      }
    }
    const start = fromIndex === -1 ? 0 : fromIndex;
    return start <= toIndex ? { from: start, to: toIndex } : { from: toIndex, to: start };
  }
  const firstVisible = filterByRange(domain.map((date) => ({ date })), range)[0]?.date;
  return { from: firstVisible ? domain.indexOf(firstVisible) : 0, to: last };
}

/** Re-indexes a visible window to 100 at its first point. Display only. */
export function rebaseWindow(values: (number | null)[], mode: "normalized" | "raw") {
  if (mode === "raw") return values;
  const base = values.find((value) => value !== null && value > 0);
  if (base === undefined || base === null) return values;
  return values.map((value) => (value === null ? null : (value / base) * 100));
}

function niceTicks(min: number, max: number, count = 5) {
  const span = max - min || 1;
  const step = Math.pow(10, Math.floor(Math.log10(span / count)));
  const chosen = [1, 2, 2.5, 5, 10].map((factor) => factor * step).find((value) => span / value <= count) ?? span;
  const ticks: number[] = [];
  for (let value = Math.ceil(min / chosen) * chosen; value <= max + 1e-9; value += chosen) ticks.push(value);
  return ticks.length >= 2 ? ticks : [min, max];
}

export default function PortfolioComparisonChart({
  series,
  mode = "normalized",
  initialRange = "SI",
  height = 430,
  navigator = true,
}: {
  series: ComparisonSeries[];
  mode?: "normalized" | "raw";
  /** Future PRO mode compares across portfolios and indices. */
  initialRange?: ChartRange;
  height?: number;
  navigator?: boolean;
}) {
  const domain = useMemo(() => alignDomain(series), [series]);
  const [range, setRange] = useState<ChartRange>(initialRange);
  const [custom, setCustom] = useState<{ from?: string; to?: string }>({});
  const [viewport, setViewport] = useState<Viewport>(() => rangeViewport(domain, initialRange));
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const plotRef = useRef<SVGSVGElement | null>(null);

  const setWindow = useCallback((next: Viewport) => {
    const last = domain.length - 1;
    if (last < 0) return;
    const width = Math.max(Math.min(MIN_VISIBLE_POINTS, last), Math.min(next.to - next.from, last));
    let from = Math.max(0, Math.min(next.from, last - width));
    let to = from + width;
    if (to > last) {
      to = last;
      from = Math.max(0, to - width);
    }
    setViewport({ from, to });
  }, [domain.length]);

  const applyRange = useCallback((next: ChartRange, nextCustom?: { from?: string; to?: string }) => {
    const merged = nextCustom ? { ...custom, ...nextCustom } : custom;
    setRange(next);
    if (nextCustom) setCustom(merged);
    setViewport(rangeViewport(domain, next, merged));
    setHoverIndex(null);
  }, [custom, domain]);

  const visibleDates = useMemo(() => domain.slice(viewport.from, viewport.to + 1), [domain, viewport]);

  const drawn = useMemo(() => {
    return series.map((entry) => {
      const map = new Map(entry.points.map((point) => [point.date, point.value]));
      let carried: number | null = null;
      const raw = visibleDates.map((date) => {
        const found = map.get(date);
        if (found !== undefined) carried = found;
        return carried;
      });
      const base = raw.find((value) => value !== null && value > 0) ?? null;
      const values = rebaseWindow(raw, mode);
      const latestRaw = raw.at(-1) ?? null;
      return {
        id: entry.id,
        label: entry.label,
        values,
        latest: values.at(-1) ?? null,
        returnPct: base && latestRaw !== null && base > 0 ? latestRaw / base - 1 : null,
      };
    });
  }, [series, visibleDates, mode]);

  const scale = useMemo(() => {
    const values = drawn.flatMap((entry) => entry.values).filter((value): value is number => value !== null);
    const min = values.length ? Math.min(...values) : 0;
    const max = values.length ? Math.max(...values) : 1;
    const pad = (max - min || 1) * 0.08;
    return { min: min - pad, max: max + pad };
  }, [drawn]);

  const plotWidth = VIEW_WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotHeight = height - PAD_TOP - PAD_BOTTOM;
  const x = (index: number) =>
    PAD_LEFT + (visibleDates.length <= 1 ? plotWidth : (index / (visibleDates.length - 1)) * plotWidth);
  const y = (value: number) => PAD_TOP + (1 - (value - scale.min) / (scale.max - scale.min || 1)) * plotHeight;

  const drag = useRef<{ x: number; from: number; to: number } | null>(null);

  // Wheel is registered natively so it can be non-passive: the chart consumes it
  // and the page never scrolls sideways.
  useEffect(() => {
    const node = plotRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      const width = viewport.to - viewport.from;
      event.preventDefault();
      if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        const step = Math.sign(event.deltaX || event.deltaY) * Math.max(1, Math.round(width * 0.08));
        setWindow({ from: viewport.from + step, to: viewport.to + step });
        return;
      }
      const box = node.getBoundingClientRect();
      const scaleX = box.width / VIEW_WIDTH;
      const ratio = Math.min(1, Math.max(0, (event.clientX - box.left - PAD_LEFT * scaleX) / (plotWidth * scaleX)));
      const focus = viewport.from + ratio * width;
      const nextWidth = Math.max(Math.min(MIN_VISIBLE_POINTS, domain.length - 1), Math.round(width * (event.deltaY > 0 ? 1.15 : 0.87)));
      const start = Math.round(focus - ((focus - viewport.from) / (width || 1)) * nextWidth);
      setWindow({ from: start, to: start + nextWidth });
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [domain.length, plotWidth, setWindow, viewport]);

  const indexFromClientX = (clientX: number, box: DOMRect) => {
    const scaleX = box.width / VIEW_WIDTH;
    const ratio = (clientX - box.left - PAD_LEFT * scaleX) / (plotWidth * scaleX);
    return Math.max(0, Math.min(visibleDates.length - 1, Math.round(ratio * (visibleDates.length - 1))));
  };

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { x: event.clientX, from: viewport.from, to: viewport.to };
  };
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    setHoverIndex(indexFromClientX(event.clientX, box));
    if (!drag.current) return;
    const scaleX = box.width / VIEW_WIDTH;
    const step = Math.round(((drag.current.x - event.clientX) / (plotWidth * scaleX)) * (drag.current.to - drag.current.from));
    setWindow({ from: drag.current.from + step, to: drag.current.to + step });
  };
  const endDrag = () => {
    drag.current = null;
    navDrag.current = null;
  };

  const navDrag = useRef<{ mode: "move" | "from" | "to"; index: number; from: number; to: number } | null>(null);
  const startNavigatorDrag = (mode: "move" | "from" | "to") => (event: ReactPointerEvent<SVGRectElement>) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const box = event.currentTarget.ownerSVGElement!.getBoundingClientRect();
    navDrag.current = {
      mode,
      index: Math.round(((event.clientX - box.left) / box.width) * domain.length),
      from: viewport.from,
      to: viewport.to,
    };
  };

  const activeIndex = Math.min(hoverIndex ?? visibleDates.length - 1, Math.max(0, visibleDates.length - 1));
  const activeDate = visibleDates[activeIndex];
  const primary = drawn[0];
  const benchmark = drawn[1];
  const activeExcess =
    primary && benchmark && primary.returnPct !== null && benchmark.returnPct !== null
      ? primary.returnPct - benchmark.returnPct
      : null;

  const yTicks = useMemo(() => niceTicks(scale.min, scale.max), [scale]);
  const xTicks = useMemo(() => {
    if (visibleDates.length <= 7) return visibleDates.map((date, index) => ({ date, index }));
    return Array.from({ length: 7 }, (_, step) => {
      const index = Math.round((step / 6) * (visibleDates.length - 1));
      return { date: visibleDates[index], index };
    });
  }, [visibleDates]);

  const navigatorPath = useMemo(() => {
    const points = series[0]?.points ?? [];
    if (points.length < 2) return "";
    const values = points.map((point) => point.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    return points
      .map((point, index) => {
        const px = (index / (points.length - 1)) * VIEW_WIDTH;
        const py = NAVIGATOR_HEIGHT - 8 - ((point.value - min) / (max - min || 1)) * (NAVIGATOR_HEIGHT - 16);
        return `${index === 0 ? "M" : "L"} ${px.toFixed(2)} ${py.toFixed(2)}`;
      })
      .join(" ");
  }, [series]);

  if (!domain.length || !series.length) return <p className="picks-unavailable">No daily series is published yet.</p>;

  const windowX = (index: number) => (index / Math.max(1, domain.length)) * VIEW_WIDTH;

  return (
    <div className="cmp-chart">
      <div className="cmp-chart-toolbar">
        <div className="picks-range" role="group" aria-label="Chart range">
          {CHART_RANGES.map((option) => (
            <button key={option} type="button" className={option === range ? "active" : ""} onClick={() => applyRange(option)}>
              {RANGE_LABEL[option]}
            </button>
          ))}
        </div>
        <div className="cmp-chart-legend">
          {drawn.map((entry, index) => (
            <span key={entry.id} className="cmp-legend-item">
              <i className={`cmp-swatch cmp-swatch-${index}`} />
              {entry.label}
              <b>{entry.latest === null ? "—" : formatNav(entry.latest)}</b>
              <em className={(entry.returnPct ?? 0) >= 0 ? "gain" : "loss"}>
                {entry.returnPct === null ? "—" : signedPct(entry.returnPct)}
              </em>
            </span>
          ))}
        </div>
      </div>

      {range === "CUSTOM" ? (
        <div className="cmp-custom-range">
          <label>
            From
            <input type="date" value={custom.from ?? domain[viewport.from] ?? ""} min={domain[0]} max={domain.at(-1)}
              onChange={(event) => applyRange("CUSTOM", { from: event.target.value })} />
          </label>
          <label>
            To
            <input type="date" value={custom.to ?? domain[viewport.to] ?? ""} min={domain[0]} max={domain.at(-1)}
              onChange={(event) => applyRange("CUSTOM", { to: event.target.value })} />
          </label>
        </div>
      ) : null}

      <div className="cmp-chart-plot">
        <svg
          ref={plotRef}
          viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
          role="img"
          aria-label={`Comparison of ${series.map((entry) => entry.label).join(" and ")}, ${mode === "normalized" ? "indexed to 100 at the first visible session" : "shown at stored NAV"}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={() => { endDrag(); setHoverIndex(null); }}
        >
          {yTicks.map((tick) => (
            <g key={tick}>
              <line x1={PAD_LEFT} x2={PAD_LEFT + plotWidth} y1={y(tick)} y2={y(tick)} className="cmp-grid" />
              <text x={PAD_LEFT - 8} y={y(tick) + 4} className="cmp-axis" textAnchor="end">{tick.toFixed(0)}</text>
            </g>
          ))}
          {xTicks.map((tick) => (
            <text key={tick.date} x={x(tick.index)} y={height - 8} className="cmp-axis" textAnchor="middle">{tick.date.slice(0, 7)}</text>
          ))}

          {drawn.map((entry, index) => {
            let open = false;
            const path = entry.values
              .map((value, pointIndex) => {
                if (value === null) { open = false; return null; }
                const command = open ? "L" : "M";
                open = true;
                return `${command} ${x(pointIndex).toFixed(2)} ${y(value).toFixed(2)}`;
              })
              .filter(Boolean)
              .join(" ");
            return <path key={entry.id} className={`cmp-line cmp-line-${index}`} d={path} />;
          })}

          {activeDate ? <line x1={x(activeIndex)} x2={x(activeIndex)} y1={PAD_TOP} y2={PAD_TOP + plotHeight} className="cmp-crosshair" /> : null}

          {drawn.map((entry, index) => {
            const value = entry.values[activeIndex];
            if (value === null || value === undefined) return null;
            return (
              <g key={entry.id}>
                <circle cx={x(activeIndex)} cy={y(value)} r={5} className={`cmp-dot cmp-dot-${index}`} />
                <text x={x(activeIndex) + 10} y={y(value) - 8} className={`cmp-dot-label cmp-dot-label-${index}`}>
                  {formatNav(value)}
                </text>
              </g>
            );
          })}
        </svg>

        {activeDate ? (
          <div className="cmp-tooltip" role="status">
            <b>{activeDate}</b>
            {drawn.map((entry, index) => (
              <div key={entry.id} className="cmp-tooltip-row">
                <i className={`cmp-swatch cmp-swatch-${index}`} />
                <span>{entry.label}</span>
                <span>NAV <b>{entry.values[activeIndex] === null ? "—" : formatNav(entry.values[activeIndex]!)}</b></span>
                <span className={(entry.returnPct ?? 0) >= 0 ? "gain" : "loss"}>{entry.returnPct === null ? "—" : signedPct(entry.returnPct)}</span>
              </div>
            ))}
            <div className="cmp-tooltip-row cmp-tooltip-excess">
              <span>Excess</span>
              <b className={(activeExcess ?? 0) >= 0 ? "gain" : "loss"}>{activeExcess === null ? "—" : signedPct(activeExcess)}</b>
            </div>
          </div>
        ) : null}
      </div>

      {navigator && domain.length > MIN_VISIBLE_POINTS ? (
        <div className="cmp-navigator">
          <svg
            viewBox={`0 0 ${VIEW_WIDTH} ${NAVIGATOR_HEIGHT}`}
            role="group"
            aria-label="Time navigator: drag the highlighted window to pan, drag its edges to change the range"
            onPointerMove={(event) => {
              const nav = navDrag.current;
              if (!nav) return;
              const box = event.currentTarget.getBoundingClientRect();
              const index = Math.round(((event.clientX - box.left) / box.width) * domain.length);
              if (nav.mode === "move") {
                const delta = index - nav.index;
                setWindow({ from: nav.from + delta, to: nav.to + delta });
              } else if (nav.mode === "from") {
                setWindow({ from: Math.min(index, nav.to - MIN_VISIBLE_POINTS), to: nav.to });
              } else {
                setWindow({ from: nav.from, to: Math.max(index, nav.from + MIN_VISIBLE_POINTS) });
              }
            }}
            onPointerUp={endDrag}
            onPointerLeave={endDrag}
          >
            <path className="cmp-navigator-spark" d={navigatorPath} />
            <rect x={0} y={0} width={windowX(viewport.from)} height={NAVIGATOR_HEIGHT} className="cmp-navigator-mask" />
            <rect x={windowX(viewport.to + 1)} y={0} width={Math.max(0, VIEW_WIDTH - windowX(viewport.to + 1))} height={NAVIGATOR_HEIGHT} className="cmp-navigator-mask" />
            <rect
              x={windowX(viewport.from)}
              y={0}
              width={Math.max(12, windowX(viewport.to + 1) - windowX(viewport.from))}
              height={NAVIGATOR_HEIGHT}
              className="cmp-navigator-window"
              onPointerDown={startNavigatorDrag("move")}
            />
            <rect x={windowX(viewport.from)} y={0} width={10} height={NAVIGATOR_HEIGHT} className="cmp-navigator-handle" onPointerDown={startNavigatorDrag("from")} />
            <rect x={Math.max(0, windowX(viewport.to + 1) - 10)} y={0} width={10} height={NAVIGATOR_HEIGHT} className="cmp-navigator-handle" onPointerDown={startNavigatorDrag("to")} />
          </svg>
          <div className="cmp-navigator-labels">
            <span>{domain[0]}</span>
            <span>{domain.at(-1)}</span>
          </div>
        </div>
      ) : null}

      <p className="cmp-chart-hint">
        Drag the chart or scroll to move through time.
        {mode === "normalized" ? " Both series are indexed to 100 at the first visible session." : " Stored NAV is shown unscaled."}
      </p>
    </div>
  );
}
