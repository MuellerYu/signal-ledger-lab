from pathlib import Path
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, KeepTogether
)

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf" / "signal-ledger-amd-case-study.pdf"
PUBLIC = ROOT / "public" / "reports" / "signal-ledger-amd-case-study.pdf"
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
PUBLIC.parent.mkdir(parents=True, exist_ok=True)

NAVY = colors.HexColor("#11263A")
BLUE = colors.HexColor("#315FD7")
RED = colors.HexColor("#B9474B")
GREEN = colors.HexColor("#1D7659")
INK = colors.HexColor("#172536")
MUTED = colors.HexColor("#617085")
LINE = colors.HexColor("#D7D4CC")
PAPER = colors.HexColor("#F7F6F1")

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="Kicker", fontName="Helvetica-Bold", fontSize=8, leading=10, textColor=RED, spaceAfter=8, tracking=1.2))
styles.add(ParagraphStyle(name="Title2", fontName="Times-Roman", fontSize=28, leading=30, textColor=NAVY, spaceAfter=9))
styles.add(ParagraphStyle(name="Dek", fontName="Helvetica", fontSize=10.2, leading=15, textColor=MUTED, spaceAfter=14))
styles.add(ParagraphStyle(name="H2x", fontName="Times-Roman", fontSize=19, leading=22, textColor=NAVY, spaceBefore=8, spaceAfter=8))
styles.add(ParagraphStyle(name="H3x", fontName="Helvetica-Bold", fontSize=9, leading=12, textColor=NAVY, spaceBefore=6, spaceAfter=5))
styles.add(ParagraphStyle(name="Bodyx", fontName="Helvetica", fontSize=9, leading=13, textColor=INK, spaceAfter=6))
styles.add(ParagraphStyle(name="Smallx", fontName="Helvetica", fontSize=7.6, leading=10.3, textColor=MUTED))
styles.add(ParagraphStyle(name="Metric", fontName="Helvetica-Bold", fontSize=16, leading=18, textColor=NAVY))
styles.add(ParagraphStyle(name="CellHead", fontName="Helvetica-Bold", fontSize=7.5, leading=9, textColor=MUTED))
styles.add(ParagraphStyle(name="Cell", fontName="Helvetica", fontSize=8.4, leading=11, textColor=INK))

def p(text, style="Bodyx"):
    return Paragraph(text, styles[style])

def rule_table(cells, widths=None, header=False):
    table = Table(cells, colWidths=widths, hAlign="LEFT")
    commands = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.55, LINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 9),
        ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]
    if header:
        commands += [("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#ECEBE5"))]
    table.setStyle(TableStyle(commands))
    return table

def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(LINE)
    canvas.line(0.62 * inch, 0.48 * inch, 7.88 * inch, 0.48 * inch)
    canvas.setFont("Helvetica", 7.2)
    canvas.setFillColor(MUTED)
    canvas.drawString(0.62 * inch, 0.30 * inch, "Signal Ledger - Independent Investment Research & Analytics Project")
    canvas.drawRightString(7.88 * inch, 0.30 * inch, f"{doc.page}")
    canvas.restoreState()

story = []
story += [
    p("FEATURED RESEARCH CASE STUDY / SEPTEMBER 2026", "Kicker"),
    p("AMD Q2 2026: a documented forecast miss", "Title2"),
    p("A recruiter-facing audit of the evidence available before earnings, the company-reported result, the frozen stock-price call, and what the process should change next.", "Dek"),
]

metric_cells = [
    [p("FINANCIAL MODEL", "CellHead"), p("COMPANY RESULT", "CellHead"), p("PRICE CALL", "CellHead"), p("OBSERVED MOVE", "CellHead")],
    [p("Revenue $10.42B<br/>GAAP EPS $0.94", "Metric"), p("Revenue $11.536B<br/>GAAP EPS $1.38", "Metric"), p("+17.0% to $589.50", "Metric"), p("-4.3% to $482.05", "Metric")],
]
story += [rule_table(metric_cells, [1.82 * inch] * 4, header=True), Spacer(1, 12)]

story += [p("The judgment", "H2x")]
story += [p("The financial direction was right, but the stock-reaction direction was wrong. The model underestimated revenue by 9.7% relative to the model estimate and underestimated GAAP EPS by $0.44. Even so, AMD closed 4.3% below the frozen pre-release reference on the defined target session. The +17% price call therefore missed both direction and magnitude, with a target error of 22.3% versus the observed close.")]
story += [p("This is exactly why a strong earnings print cannot be translated mechanically into an up call. The pre-release record lacked usable price-history inputs and options-implied evidence, and its direction was carried primarily by SEC fundamental trend plus positive analyst revisions.")]

story += [p("From revenue to GAAP EPS", "H2x")]
bridge = [
    [p("Step", "CellHead"), p("Q2 2026 reported", "CellHead"), p("Read-through", "CellHead")],
    [p("Revenue", "Cell"), p("$11.536B", "Cell"), p("50% year-over-year growth; Data Center was $6.7B, up 107%.", "Cell")],
    [p("Gross profit", "Cell"), p("$6.203B / 54% margin", "Cell"), p("GAAP margin; do not mix with AMD's 56% non-GAAP margin.", "Cell")],
    [p("Operating expenses", "Cell"), p("$4.213B", "Cell"), p("R&D $2.528B; MG&A $1.401B; acquired-intangible amortization $0.284B.", "Cell")],
    [p("Operating income", "Cell"), p("$1.990B", "Cell"), p("$6.203B gross profit less $4.213B operating expenses.", "Cell")],
    [p("Below the line", "Cell"), p("-$37M interest + $598M other income", "Cell"), p("Other income included a $483M gain on long-term investments; this is not recurring operating profit.", "Cell")],
    [p("Net income", "Cell"), p("$2.297B", "Cell"), p("After $252M tax provision, $6M equity income and an $8M discontinued-operations loss.", "Cell")],
    [p("Diluted EPS", "Cell"), p("$1.38 on 1.659B shares", "Cell"), p("GAAP. AMD separately reported $1.66 non-GAAP EPS after stated adjustments.", "Cell")],
]
story += [rule_table(bridge, [1.22 * inch, 1.65 * inch, 4.42 * inch], header=True), Spacer(1, 5)]
story += [p("Accounting rule: model, company-reported and consensus EPS are compared only when their GAAP/non-GAAP bases match. The Nasdaq $1.35 consensus snapshot is retained as provider-basis and is not scored as a GAAP beat without verified comparability.", "Smallx")]

story += [PageBreak(), p("How the frozen price call was produced", "H2x")]
method = [
    [p("1 / CUT-OFF", "CellHead"), p("2 / DIRECTION", "CellHead"), p("3 / MAGNITUDE", "CellHead")],
    [p("Information frozen Aug 4, 2026 at 12:38 ET. Reference price $503.845 at 12:37 ET.", "Cell"), p("Positive SEC revenue/EPS trend and 3 upward EPS revisions versus 0 downward. Price-vs-SPY, news and options evidence were unavailable or inactive.", "Cell"), p("Four prior earnings reactions had a 13.2% median absolute move and 19.9% 75th percentile. Signal strength mapped to +17.0%.", "Cell")],
]
story += [rule_table(method, [2.43 * inch] * 3, header=True), Spacer(1, 10)]
story += [p("Target formula", "H3x"), p("$503.845 x (1 + 17.0%) = $589.50. Target session: Aug 5, 2026 normal-session close. Actual close: $482.05. The failed call remains in the scorecard; today's price is never used to rewrite the old result.")]

prior = [
    [p("Prior reported session", "CellHead"), p("Recorded reaction", "CellHead")],
    [p("May 5, 2026", "Cell"), p("+23.4%", "Cell")],
    [p("Feb 3, 2026", "Cell"), p("-18.7%", "Cell")],
    [p("Nov 4, 2025", "Cell"), p("-3.7%", "Cell")],
    [p("Aug 5, 2025", "Cell"), p("-7.7%", "Cell")],
]
story += [KeepTogether([p("Historical amplitude sample", "H3x"), rule_table(prior, [3.65 * inch, 3.64 * inch], header=True)])]

story += [p("Post-mortem and process change", "H2x")]
post = [
    [p("What worked", "CellHead"), p("What failed", "CellHead"), p("Required change", "CellHead")],
    [p("Primary-source financial data; frozen cutoff; GAAP actuals; company-specific event history.", "Cell"), p("The direction layer treated positive fundamentals and revisions as sufficient despite missing market-positioning and options evidence.", "Cell"), p("Withhold a price-direction call when market, valuation and options inputs are absent; keep a financial preview only. Add relative-to-SPY and no-change benchmarks.", "Cell")],
]
story += [rule_table(post, [2.43 * inch] * 3, header=True), Spacer(1, 12)]

story += [p("Scope and disclosure", "H2x")]
story += [p("Signal Ledger owns the research questions, definitions, model rules, evidence review, interface decisions and forecast post-mortems. AI assisted with implementation, document extraction, translation and first-pass news triage. This case study demonstrates a research process; it does not claim a proven alpha record or constitute investment advice.")]
story += [p("Sources", "H3x")]
story += [
    p("1. AMD, 'AMD Reports Second Quarter 2026 Financial Results,' Aug. 4, 2026: https://ir.amd.com/news-events/press-releases/detail/1295/amd-reports-second-quarter-2026-financial-results", "Smallx"),
    p("2. Nasdaq quote, earnings-surprise and historical-price endpoints recorded in the frozen Signal Ledger evidence package. Forecast cutoff Aug. 4, 2026; settlement Aug. 5, 2026.", "Smallx"),
    p("3. Signal Ledger methodology: financial estimates and stock-reaction records are stored separately; unresolved or missing-target records are excluded with a stated reason; failed settled calls remain included.", "Smallx"),
]

doc = SimpleDocTemplate(str(OUTPUT), pagesize=letter, rightMargin=0.62*inch, leftMargin=0.62*inch, topMargin=0.58*inch, bottomMargin=0.62*inch, title="Signal Ledger - AMD Q2 2026 Case Study", author="Signal Ledger")
doc.build(story, onFirstPage=footer, onLaterPages=footer)
PUBLIC.write_bytes(OUTPUT.read_bytes())
print(OUTPUT)
