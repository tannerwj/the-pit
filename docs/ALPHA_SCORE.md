# Alpha Score v1

The Pit's ranking metric. 0–100, rounded to 2 decimals. Recomputed every 5 minutes
over each entry's last 5000 equity snapshots. All money is virtual/paper.

## The formula (v1, frozen)

- Day returns: group snapshots by UTC day; day_return = last/first - 1 per day
  (days with < 2 snapshots are skipped; if < 2 valid days: winRate = 1, profitFactor = 1).
- winRate = (# days with day_return >= 0) / (# days)
- grossProfit = Σ max(day_return, 0); grossLoss = Σ max(-day_return, 0);
  profitFactor = grossLoss > 0 ? grossProfit/grossLoss : (grossProfit > 0 ? 3 : 1)
- Sharpe: per-snapshot simple returns r_i = e_i/e_{i-1} - 1 (skip i=0);
  mean μ, sample std σ; sharpe_5min = σ > 1e-12 ? μ/σ : 0;
  sharpe = sharpe_5min * sqrt(105120)  (365*24*12 five-minute periods/year)
- maxDrawdown = max over curve of (runningPeak - equity) / runningPeak, 0 if equity never drops
- Normalization:
  - R_c = (clamp(totalReturn, -1, 2) + 1) / 3
  - S_c = (clamp(sharpe, -2, 4) + 2) / 6
  - DD_c = (1 - clamp(maxDrawdown, 0, 1)) ^ 2.5
  - risk = 0.35 * S_c + 0.65 * DD_c
  - C_c = 0.5 * winRate + 0.5 * (profitFactor / (1 + profitFactor))
- alphaScore = round2(100 * (0.4 * R_c + 0.4 * risk + 0.2 * C_c))

- Required property (unit test): a curve ending +200% with 60% max drawdown
  MUST score strictly below a curve ending +30% with 5% max drawdown.
  If the test fails with realistic synthetic curves, REPORT the numbers back —
  do NOT change the formula (docs must stay in sync).

## Worked example

Entry starts with $10,000. Snapshots (every 5 min) over two UTC days:

- Day 1: first snapshot $10,000, last snapshot $10,500 → day_return = 10500/10000 − 1 = **0.05**
- Day 2: first snapshot $10,500, last snapshot $10,290 → day_return = 10290/10500 − 1 = **−0.02**

Components:

- winRate = 1/2 = **0.5**
- grossProfit = 0.05, grossLoss = 0.02 → profitFactor = 0.05/0.02 = **2.5**
- totalReturn = (10290 − 10000)/10000 = **0.029**
- maxDrawdown = (10500 − 10290)/10500 = **0.02**
- Sharpe: suppose the 5-minute returns annualize to sharpe = **1.20**

Normalization:

- R_c = (0.029 + 1)/3 = **0.343**
- S_c = (1.20 + 2)/6 = **0.5333**
- DD_c = (1 − 0.02)^2.5 = 0.98^2.5 ≈ **0.9508**
- risk = 0.35 × 0.5333 + 0.65 × 0.9508 = 0.18667 + 0.61802 = **0.8047**
- C_c = 0.5 × 0.5 + 0.5 × (2.5/3.5) = 0.25 + 0.35714 = **0.6071**

Final:

- alphaScore = round2(100 × (0.4 × 0.343 + 0.4 × 0.8047 + 0.2 × 0.6071))
             = round2(100 × (0.13720 + 0.32188 + 0.12143))
             = round2(58.05) = **58.05**

## Tuning notes

The formula weights return, risk, and consistency as 40/40/20. The deliberate choice
is the drawdown exponent **2.5** in `DD_c = (1 − maxDrawdown)^2.5`:

- A 60% drawdown keeps only 0.4^2.5 ≈ **0.101** of the drawdown component.
- A 5% drawdown keeps 0.95^2.5 ≈ **0.880**.
- With exponent 1.0 instead, the 60%-DD curve would keep 0.40 — too forgiving, and
  raw return would dominate the ranking.

Why this matters: the return term alone favors the high-return curve
(0.4 × (R_c(2.0) − R_c(0.3)) = 0.4 × (1.0 − 0.4333) ≈ 0.2267 of head start on the 0–1
scale). The risk term has to claw that back: at exponent 2.5 the drawdown gap alone
contributes 0.4 × 0.65 × (0.8796 − 0.1012) ≈ 0.2024 back to the smooth curve, and the
Sharpe term adds up to another 0.4 × 0.35 = 0.14 — realistic 60%-DD curves have ugly
Sharpe, so the smooth curve wins in practice. At exponent 1.0 the drawdown gap would
only contribute 0.4 × 0.65 × 0.55 ≈ 0.143, leaving the outcome to hinge on Sharpe
alone — too fragile for a ranking metric. The 2.5 exponent is what makes the required
property hold with margin, and it is locked by the unit test.

Design intent: Alpha Score answers "who trades well?" not "who got lucky once?".
A steady +30% with tiny drawdowns should — and does — beat a wild +200% ride that
nearly wiped out the account twice.
