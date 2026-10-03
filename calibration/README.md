# Calibration (optional)

`python -m pipeline.calibrate <spot>` fits a per-spot surf-height formula by comparing
Open-Meteo's past swell with surf heights you've noted down for the same days.

Put your own observations here as `<spot>-YYYY-MM.csv`, one row per day:

```
date,min_ft,max_ft,plus
2026-09-04,3,4,1
```

`plus` = 1 for "3-4ft+". Lines starting with `#` are notes. The script prints the fitted
coefficients for `[spots.<spot>.surf_model]` in `config/settings.toml` and writes a
comparison to `calibration/results/`.

Use heights you observed yourself (or another source whose terms allow it). The
Saunton formula in the example settings came from a year of daily comparisons.
