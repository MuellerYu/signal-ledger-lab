from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    KeepTogether,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output" / "pdf" / "signal-ledger-orcl-q1-fy2027-preview.pdf"
OUT.parent.mkdir(parents=True, exist_ok=True)

NAVY = colors.HexColor("#102238")
INK = colors.HexColor("#14243A")
MUTED = colors.HexColor("#516074")
PAPER = colors.HexColor("#F7F4EC")
LINE = colors.HexColor("#D8D3C8")
COBALT = colors.HexColor("#4169E1")
SIGNAL = colors.HexColor("#E96F51")
PALE_BLUE = colors.HexColor("#EDF2FF")
PALE_YELLOW = colors.HexColor("#F3E6C8")


styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="KickerSL", parent=styles["Normal"], fontName="Helvetica-Bold", fontSize=8, leading=10, textColor=SIGNAL, spaceAfter=8, tracking=1.4))
styles.add(ParagraphStyle(name="TitleSL", parent=styles["Title"], fontName="Times-Bold", fontSize=31, leading=32, textColor=INK, alignment=0, spaceAfter=10))
styles.add(ParagraphStyle(name="DeckSL", parent=styles["Normal"], fontName="Helvetica", fontSize=11, leading=16, textColor=MUTED, spaceAfter=15))
styles.add(ParagraphStyle(name="SectionSL", parent=styles["Heading2"], fontName="Times-Bold", fontSize=20, leading=23, textColor=INK, spaceBefore=14, spaceAfter=9))
styles.add(ParagraphStyle(name="SubheadSL", parent=styles["Heading3"], fontName="Helvetica-Bold", fontSize=11, leading=14, textColor=INK, spaceBefore=8, spaceAfter=5))
styles.add(ParagraphStyle(name="BodySL", parent=styles["BodyText"], fontName="Helvetica", fontSize=9.4, leading=14, textColor=INK, spaceAfter=8))
styles.add(ParagraphStyle(name="SmallSL", parent=styles["Normal"], fontName="Helvetica", fontSize=7.5, leading=10.5, textColor=MUTED))
styles.add(ParagraphStyle(name="MetricLabel", parent=styles["Normal"], fontName="Helvetica-Bold", fontSize=7, leading=9, textColor=MUTED, tracking=.8))
styles.add(ParagraphStyle(name="MetricValue", parent=styles["Normal"], fontName="Helvetica-Bold", fontSize=16, leading=18, textColor=INK, spaceBefore=5, spaceAfter=5))
styles.add(ParagraphStyle(name="MetricValueCompact", parent=styles["MetricValue"], fontSize=12.5, leading=15))
styles.add(ParagraphStyle(name="RightSmall", parent=styles["SmallSL"], alignment=TA_RIGHT))
styles.add(ParagraphStyle(name="WhiteKicker", parent=styles["KickerSL"], textColor=SIGNAL))
styles.add(ParagraphStyle(name="WhiteSection", parent=styles["SectionSL"], textColor=colors.white, fontSize=18, leading=21))
styles.add(ParagraphStyle(name="WhiteBody", parent=styles["BodySL"], textColor=colors.HexColor("#DCE4EE")))


def page_art(canvas, doc):
    width, height = letter
    canvas.saveState()
    canvas.setFillColor(PAPER)
    canvas.rect(0, 0, width, height, stroke=0, fill=1)
    canvas.setFillColor(NAVY)
    canvas.rect(0, height - 34, width, 34, stroke=0, fill=1)
    canvas.setFillColor(colors.white)
    canvas.setFont("Times-Bold", 10)
    canvas.drawString(42, height - 22, "SIGNAL LEDGER")
    canvas.setFont("Helvetica", 6.8)
    canvas.drawRightString(width - 42, height - 22, "EQUITY RESEARCH  |  ORCL")
    canvas.setStrokeColor(LINE)
    canvas.line(42, 31, width - 42, 31)
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 6.8)
    canvas.drawString(42, 19, "Independent equity research, valuation and forecast accountability")
    canvas.drawRightString(width - 42, 19, f"Page {doc.page}")
    canvas.restoreState()


class ReportDoc(BaseDocTemplate):
    def __init__(self, filename):
        super().__init__(filename, pagesize=letter, leftMargin=42, rightMargin=42, topMargin=52, bottomMargin=42, title="Oracle Q1 FY2027 Pre-Earnings Research", author="Signal Ledger")
        frame = Frame(self.leftMargin, self.bottomMargin, self.width, self.height, id="main")
        self.addPageTemplates(PageTemplate(id="research", frames=[frame], onPage=page_art))


def metric(label, value, note, bg=colors.white, compact=False):
    value_style = styles["MetricValueCompact"] if compact else styles["MetricValue"]
    block = [Paragraph(label.upper(), styles["MetricLabel"]), Paragraph(value, value_style), Paragraph(note, styles["SmallSL"])]
    table = Table([[block]], colWidths=[1.22 * inch])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("BOX", (0, 0), (-1, -1), .6, LINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
    ]))
    return table


story = [
    Spacer(1, 4),
    Paragraph("PRE-EARNINGS RESEARCH  |  SEPTEMBER 10, 2026", styles["KickerSL"]),
    Paragraph("Oracle Corporation", styles["TitleSL"]),
    Paragraph("ORCL  |  Q1 FY2027 earnings after market close  |  Preliminary coverage", styles["DeckSL"]),
]

metrics = Table([[
    metric("Reference price", "$159.25", "Frozen Sep 10, 9:04 a.m. ET"),
    metric("Fair value", "WITHHELD", "Capital and cash-return gate", compact=True),
    metric("12M target", "WITHHELD", "Not inferred from event target", compact=True),
    metric("Event target", "$175.97", "+10.5% for Sep 11 close", PALE_BLUE),
]], colWidths=[1.3 * inch] * 4)
metrics.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 6)]))
story.extend([metrics, Spacer(1, 15)])

rating = Table([[
    [Paragraph("RATING", styles["MetricLabel"]), Paragraph("WATCH", styles["MetricValue"]), Paragraph("Research confidence: preliminary / low", styles["SmallSL"])],
    [Paragraph("INVESTMENT CONCLUSION", styles["WhiteKicker"]), Paragraph("Demand is visible; shareholder returns are not yet proven.", styles["WhiteSection"]), Paragraph("Oracle enters Q1 FY2027 with exceptional contracted demand and an aggressive cloud buildout. The investable question is whether capacity converts a $638B backlog into high-quality revenue and free cash flow fast enough to offset debt, equity issuance and dilution.", styles["WhiteBody"])],
]], colWidths=[1.55 * inch, 3.85 * inch])
rating.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (0, 0), PALE_YELLOW),
    ("BACKGROUND", (1, 0), (1, 0), NAVY),
    ("TEXTCOLOR", (1, 0), (1, 0), colors.white),
    ("BOX", (0, 0), (-1, -1), .7, LINE),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 13),
    ("RIGHTPADDING", (0, 0), (-1, -1), 13),
    ("TOPPADDING", (0, 0), (-1, -1), 12),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
]))
story.extend([rating, Paragraph("What matters now", styles["SectionSL"])])

tests = [
    ["Evidence", "Current read", "Decision relevance"],
    ["Revenue growth guide", "27-29%", "Minimum top-line hurdle for the quarter"],
    ["Cloud growth guide", "58-64%", "Capacity delivery and demand conversion test"],
    ["Non-GAAP EPS guide", "$1.72-$1.76", "Not directly comparable with GAAP EPS model"],
    ["Remaining performance obligations", "$638B", "Future contracted obligation, not current revenue or cash"],
    ["Last FY free cash flow", "-$23.7B", "Shows the cost of the current infrastructure ramp"],
    ["Expected FY2027 debt/equity financing", "Approx. $40B", "Financing mix and dilution are part of equity value"],
]
table = Table([[Paragraph(str(c), styles["SmallSL"]) for c in row] for row in tests], colWidths=[1.65 * inch, 1.35 * inch, 2.4 * inch], repeatRows=1)
table.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), NAVY),
    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
    ("GRID", (0, 0), (-1, -1), .45, LINE),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 8),
    ("RIGHTPADDING", (0, 0), (-1, -1), 8),
    ("TOPPADDING", (0, 0), (-1, -1), 7),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
]))
story.append(table)

scenario_data = [[
    [Paragraph("BEAR", styles["KickerSL"]), Paragraph("Growth misses; funding pressure rises", styles["SubheadSL"]), Paragraph("Revenue growth below 27%, EPS below $1.72, slower backlog conversion or a larger financing requirement weakens both earnings quality and future valuation.", styles["BodySL"])],
    [Paragraph("BASE", styles["KickerSL"]), Paragraph("Backlog converts; cash proof lags", styles["SubheadSL"]), Paragraph("Guidance is broadly met and cloud stays strong, while capex and financing keep the shares on WATCH pending free-cash-flow evidence.", styles["BodySL"])],
    [Paragraph("BULL", styles["KickerSL"]), Paragraph("Capacity arrives with disciplined funding", styles["SubheadSL"]), Paragraph("Growth clears the upper guide, deployment remains on schedule and financing does not become more dilutive.", styles["BodySL"])],
]]
scenarios = Table(scenario_data, colWidths=[1.8 * inch] * 3)
scenarios.setStyle(TableStyle([
    ("GRID", (0, 0), (-1, -1), .6, LINE),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("BACKGROUND", (0, 0), (-1, -1), colors.white),
    ("LEFTPADDING", (0, 0), (-1, -1), 11),
    ("RIGHTPADDING", (0, 0), (-1, -1), 11),
    ("TOPPADDING", (0, 0), (-1, -1), 11),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
]))
story.append(KeepTogether([Paragraph("Earnings decision rules", styles["SectionSL"]), scenarios]))
story.extend([Spacer(1, 8), Paragraph("Action: do not chase the backlog headline. Reassess after guidance, financing mix, capex and cash-conversion evidence are published.", styles["BodySL"])])

story.extend([
    Paragraph("Valuation framework", styles["SectionSL"]),
    Paragraph("Fair Value answers what the business is worth today. The 12-month target adds the next year of execution, catalysts and risk. The one-session event target answers a separate market-reaction question.", styles["BodySL"]),
])

valuation_rows = [
    ["Method", "Role", "Weight now", "Publication requirement"],
    ["DCF / FCFF", "Primary intrinsic value", "0% - gated", "Post-capex FCF, financing cost and dilution schedule"],
    ["Forward P/E", "Earnings cross-check", "0% - gated", "Comparable GAAP EPS and recurring earnings bridge"],
    ["EV / EBITDA", "Capital structure cross-check", "0% - gated", "Net debt after planned financing and normalized EBITDA"],
    ["EV / Revenue", "Growth cross-check only", "0% - gated", "Cloud mix, margin path and peer-consistent definitions"],
]
valuation = Table([[Paragraph(str(c), styles["SmallSL"]) for c in row] for row in valuation_rows], colWidths=[1.15 * inch, 1.35 * inch, .85 * inch, 2.05 * inch], repeatRows=1)
valuation.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), NAVY),
    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
    ("GRID", (0, 0), (-1, -1), .45, LINE),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 8),
    ("RIGHTPADDING", (0, 0), (-1, -1), 8),
    ("TOPPADDING", (0, 0), (-1, -1), 7),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
]))
story.extend([valuation, Spacer(1, 10)])

gate = Table([[
    [Paragraph("PUBLICATION GATE", styles["KickerSL"]), Paragraph("No false precision", styles["SectionSL"]), Paragraph("A positive target requires a fully sourced share count, net-debt bridge, capex path and cash-return framework. Until then, Fair Value, 12M Target and Buy Zone remain withheld.", styles["BodySL"])],
    [Paragraph("VALUATION BRIDGE", styles["KickerSL"]), Paragraph("No revision published", styles["SectionSL"]), Paragraph("There is no prior published 12-month target to revise. The first bridge will quantify operating-estimate changes, multiple changes, net-debt changes and dilution after the evidence gate clears.", styles["BodySL"])],
]], colWidths=[2.7 * inch, 2.7 * inch])
gate.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (0, 0), PALE_YELLOW),
    ("BACKGROUND", (1, 0), (1, 0), PALE_BLUE),
    ("GRID", (0, 0), (-1, -1), .6, LINE),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 13),
    ("RIGHTPADDING", (0, 0), (-1, -1), 13),
    ("TOPPADDING", (0, 0), (-1, -1), 12),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
]))
story.extend([gate, Paragraph("Forecast accountability", styles["SectionSL"])])

accountability = [
    ["Record", "Frozen input", "Published view", "Status"],
    ["Q1 FY2027 event call", "$159.25 on Sep 10", "$175.97 for Sep 11 close (+10.5%)", "Open"],
    ["Fair Value", "Not complete", "Not published", "Gated"],
    ["12M target", "Not complete", "Not published", "Gated"],
]
account = Table([[Paragraph(str(c), styles["SmallSL"]) for c in row] for row in accountability], colWidths=[1.35 * inch, 1.25 * inch, 1.85 * inch, .95 * inch], repeatRows=1)
account.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), NAVY),
    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
    ("GRID", (0, 0), (-1, -1), .45, LINE),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 8),
    ("RIGHTPADDING", (0, 0), (-1, -1), 8),
    ("TOPPADDING", (0, 0), (-1, -1), 7),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
]))
story.extend([account, Spacer(1, 10), Paragraph("The event amplitude uses Oracle's last three earnings windows: median absolute move 10.2%, 75th percentile 10.4%. This historical sample is not Signal Ledger prediction accuracy. The open forecast is not counted as a win.", styles["BodySL"]), Paragraph("Sources", styles["SectionSL"])])

sources = [
    ("Oracle FY2026 Q4 results and Q1 FY2027 guidance", "https://www.oracle.com/news/announcement/q4fy26-earnings-release-2026-06-10/"),
    ("Oracle Q1 FY2027 earnings date announcement", "https://investor.oracle.com/investor-news/news-details/2026/Oracle-Sets-the-Date-for-its-First-Quarter-Fiscal-Year-2027-Earnings-Announcement/default.aspx"),
    ("SEC Company Facts for Oracle", "https://data.sec.gov/api/xbrl/companyfacts/CIK0001341439.json"),
    ("Nasdaq ORCL quote endpoint", "https://api.nasdaq.com/api/quote/ORCL/info?assetclass=stocks"),
]
for label, url in sources:
    story.append(KeepTogether([Paragraph(f"<b>{label}</b>", styles["BodySL"]), Paragraph(url, styles["SmallSL"]), Spacer(1, 4)]))
story.extend([Spacer(1, 10), Paragraph("Research status", styles["SectionSL"]), Paragraph("This note is a frozen pre-earnings research record. New evidence should create a new dated report rather than overwrite this document. It is not investment advice and does not place trades.", styles["BodySL"])])


ReportDoc(str(OUT)).build(story)
print(OUT)
