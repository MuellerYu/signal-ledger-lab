"use client";

import { useMemo, useState } from "react";

export type HistoryPoint = { date: string; nav: number; benchmarkNav: number; drawdown: number };
export type ContributionRow = { ticker: string; contributionPoints: number; currentWeight: number; initialWeight: number };

import { formatNav as nav, signedPct } from "@/lib/portfolio-format";

function scale(values: number[], height: number, pad: number) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return (value: number) => pad + (1 - (value - min) / span) * (height - pad * 2);
}

function linePath(points: HistoryPoint[], pick: (point: HistoryPoint) => number, width: number, y: (v: number) => number) {
  if (points.length === 1) return `M 0 ${y(pick(points[0]))} L ${width} ${y(pick(points[0]))}`;
  return points
    .map((point, index) => {
      const x = (index / (points.length - 1)) * width;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y(pick(point)).toFixed(2)}`;
    })
    .join(" ");
}

const WIDTH = 960;
const HEIGHT = 320;
const PAD = 26;

/** DRAWDOWN — nav / running peak - 1, so every point is at or below zero. */
export function DrawdownChart({ points }: { points: HistoryPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const worst = Math.min(...points.map((point) => point.drawdown), -0.0001);
  const y = (value: number) => PAD + (value / worst) * (HEIGHT - PAD * 2);
  const x = (index: number) => (points.length === 1 ? WIDTH : (index / (points.length - 1)) * WIDTH);

  const area = `${linePath(points, (p) => p.drawdown, WIDTH, y)} L ${WIDTH} ${y(0)} L 0 ${y(0)} Z`;
  const maxIndex = points.reduce((best, point, index) => (point.drawdown < points[best].drawdown ? index : best), 0);
  const active = hover === null ? points.at(-1)! : points[hover];

  return (
    <figure className="picks-chart picks-chart-drawdown">
      <figcaption>
        <span className="picks-chart-title">DRAWDOWN</span>
        <span className="picks-chart-readout">
          <span>Current <b>{signedPct(active.drawdown)}</b></span>
          <span>Maximum <b>{signedPct(worst)}</b> on <b>{points[maxIndex]?.date}</b></span>
        </span>
      </figcaption>
      <div className="picks-chart-plot">
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Pick-NY drawdown from running peak">
          <line x1={0} x2={WIDTH} y1={y(0)} y2={y(0)} className="picks-grid" />
          <path d={area} className="picks-area-drawdown" />
          <path d={linePath(points, (p) => p.drawdown, WIDTH, y)} className="picks-line picks-line-drawdown" />
          {active ? <line x1={x(hover === null ? points.length - 1 : hover)} x2={x(hover === null ? points.length - 1 : hover)} y1={0} y2={HEIGHT} className="picks-cursor" /> : null}
          <rect
            x={0}
            y={0}
            width={WIDTH}
            height={HEIGHT}
            fill="transparent"
            onMouseLeave={() => setHover(null)}
            onMouseMove={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              const ratio = (event.clientX - box.left) / box.width;
              setHover(Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1)))));
            }}
          />
        </svg>
      </div>
    </figure>
  );
}

/** Contribution in percentage points, reconciling with the since-inception return. */
export function ContributionChart({ rows }: { rows: ContributionRow[] }) {
  const sorted = [...rows].sort((left, right) => right.contributionPoints - left.contributionPoints);
  const extent = Math.max(...sorted.map((row) => Math.abs(row.contributionPoints)), 0.1);
  return (
    <ul className="picks-contribution-bars">
      {sorted.map((row) => (
        <li key={row.ticker}>
          <strong>{row.ticker}</strong>
          <span className="picks-bar-track">
            <i
              className={row.contributionPoints >= 0 ? "picks-bar gain-bg" : "picks-bar loss-bg"}
              style={{ width: `${(Math.abs(row.contributionPoints) / extent) * 50}%`, [row.contributionPoints >= 0 ? "left" : "right"]: "50%" }}
            />
          </span>
          <em className={row.contributionPoints > 0 ? "gain" : row.contributionPoints < 0 ? "loss" : ""}>
            {row.contributionPoints > 0 ? "+" : row.contributionPoints < 0 ? "−" : ""}
            {Math.abs(row.contributionPoints).toFixed(1)} pts
          </em>
        </li>
      ))}
    </ul>
  );
}

/** Tiny inline series for the homepage module; no axes, no interaction. */
export function Sparkline({ points }: { points: HistoryPoint[] }) {
  if (points.length < 2) return null;
  const y = scale(points.map((point) => point.nav), 40, 3);
  const d = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${(index / (points.length - 1)) * 160} ${y(point.nav)}`)
    .join(" ");
  const rising = points.at(-1)!.nav >= points[0].nav;
  return (
    <svg className="picks-sparkline" viewBox="0 0 160 40" role="img" aria-label="Pick-NY NAV since inception">
      <path d={d} className={rising ? "picks-line-portfolio" : "picks-line-drawdown"} />
    </svg>
  );
}

