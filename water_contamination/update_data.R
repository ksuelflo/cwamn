# ==============================================================================
# update_data.R — refresh all data for the Minnesota water map
#
# Run this file (from the project folder) to rebuild everything in data/.
# Each step is its own script and can also be run on its own.
#
#   01_boundaries.R      watershed + district outlines        (rarely: setup / redistricting)
#   02_nitrate.R         nitrate: re-pulls recent years, keeps older ones (quarterly)
#   03_nitrate_trend.R   long-term regional trend chart       (quarterly; needs 02)
#   04_pfas.R            PFAS in community water systems      (quarterly)
#   05_impaired_waters.R MPCA impaired waters list            (when MPCA/EPA update the list; needs 01)
#   06_private_wells.R   private wells + special well construction areas (quarterly; needs 01)
#
# Not run from here (run by hand when needed):
#   nitrate_full_rebuild.R   rebuild nitrate files from 2020 on
#   nitrate_trend_history.R  pick the trend sites + download their 2005–2019 results (one time)
# ==============================================================================

# ---- Settings (the only things you should need to change) ----------------------

DATA_DIR <- "data"        # what the website reads

# Nitrate map: how many calendar years to re-download each run (2 = this year + last).
# Older years are kept from the existing data/nitrate_daily.csv.
NITRATE_REFRESH_YEARS <- 2

# Nitrate trend chart: last year shown. Set it to the last COMPLETE year.
# Results reach the Water Quality Portal months late, so move this forward each spring.
TREND_LAST_YEAR <- 2025

# MPCA impaired waters service (change when the final 2026 list, or a new cycle, is published;
# then check the layer numbers printed by 05_impaired_waters.R)
IMPAIRED_URL <- "https://enterprise.gisdata.mn.gov/aghost/rest/services/us_mn_state_pca/env_impaired_water_2026_draft/FeatureServer"

# Which steps to run. Boundaries only need rerunning after redistricting
# (or the first time on a new computer, since 05 uses their files).
RUN <- c(
  boundaries     = FALSE,
  nitrate        = FALSE,
  nitrate_trend  = FALSE,
  pfas           = FALSE,
  impaired       = FALSE,
  wells          = TRUE
)

# ---- Run ---------------------------------------------------------------------------

dir.create(DATA_DIR, showWarnings = FALSE)

steps <- c(
  boundaries    = "R/01_boundaries.R",
  nitrate       = "R/02_nitrate.R",
  nitrate_trend = "R/03_nitrate_trend.R",
  pfas          = "R/04_pfas.R",
  impaired      = "R/05_impaired_waters.R",
  wells         = "R/06_private_wells.R"
)

for (step in names(steps)) {
  if (!RUN[[step]]) {
    message("--- skipping ", step)
    next
  }
  message("\n=== ", step, " (", steps[[step]], ") ===")
  t0 <- Sys.time()
  source(steps[[step]], echo = FALSE)
  message("=== ", step, " done in ", round(difftime(Sys.time(), t0, units = "mins"), 1), " min")
}

# Date the website shows as "Data last updated" (only reached if every step finished)
jsonlite::write_json(list(last_updated = format(Sys.Date(), "%Y-%m-%d")),
                     file.path(DATA_DIR, "meta.json"), auto_unbox = TRUE)

message("\nAll done. Files in ", DATA_DIR, "/:")
print(file.info(list.files(DATA_DIR, full.names = TRUE))[, c("size", "mtime")])