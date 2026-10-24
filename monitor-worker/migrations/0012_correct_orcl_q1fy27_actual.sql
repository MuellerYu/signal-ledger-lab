-- Oracle Q1 FY2027 total revenue was $19.3B. The original parser matched
-- the $1.4B Services segment because "Total quarterly revenues" was not
-- recognized as a consolidated revenue label.
UPDATE earnings_actuals
SET revenue = 19300000000,
    source_name = 'SEC earnings exhibit',
    source_url = 'https://www.sec.gov/Archives/edgar/data/1341439/000119312526387905/orcl-ex99_1.htm',
    source_quality = 'Tier 1 company earnings release filed with the SEC; consolidated total revenue and GAAP diluted EPS.',
    evidence_json = '{"evidence":[{"label":"Total revenue","quote":"Record Q1 Total Revenues up 30% to $19.3 billion.","sourceUrl":"https://www.sec.gov/Archives/edgar/data/1341439/000119312526387905/orcl-ex99_1.htm"},{"label":"GAAP diluted EPS","quote":"Q1 GAAP earnings per share was $1.56.","sourceUrl":"https://www.sec.gov/Archives/edgar/data/1341439/000119312526387905/orcl-ex99_1.htm"}],"extracted":{"revenue":19300000000,"eps":1.56},"correction":"Replaced Services segment revenue with consolidated total revenue."}',
    updated_at = CURRENT_TIMESTAMP
WHERE ticker = 'ORCL'
  AND fiscal_period = '2027-Q1'
  AND accession = '0001193125-26-387905';

-- The resolved forecast row remains immutable. Dashboard comparisons are
-- derived from this corrected actual overlay without rewriting the forecast.
