# ==============================================================================
# 02_nitrate.R — quarterly nitrate update
#
# Reads the existing nitrate files, re-downloads the most recent years, and replaces
# those years. Older years are kept from the existing files.
#
# Why re-download recent years instead of only adding days after the last download:
# agencies upload results months after sampling, so recent months keep filling in.
#
# Outputs: data/nitrate_sites.geojson, data/nitrate_daily.csv (both updated in place)
# Needs:   the existing versions of both, and data/huc8_mn.geojson
# To rebuild everything from scratch instead, run R/nitrate_full_rebuild.R
# ==============================================================================

source("R/nitrate_functions.R")

if (!exists("DATA_DIR"))              DATA_DIR              <- "data"
if (!exists("NITRATE_REFRESH_YEARS")) NITRATE_REFRESH_YEARS <- 2

# 2 = this year and last year (run in Oct 2026 -> re-pulls 2025-01-01 to today)
refresh_from <- as.Date(paste0(as.integer(format(Sys.Date(), "%Y")) - NITRATE_REFRESH_YEARS + 1, "-01-01"))
message("  re-downloading from ", refresh_from)

# ---- 1. Existing data -------------------------------------------------------------

old_daily <- read_csv(file.path(DATA_DIR, "nitrate_daily.csv"),
                      col_types = cols(site_id     = col_character(),
                                       date        = col_date(),
                                       nitrate_mgL = col_double(),
                                       non_detect  = col_integer()))

old_sites <- st_read(file.path(DATA_DIR, "nitrate_sites.geojson"), quiet = TRUE)

# ---- 2. Recent data -----------------------------------------------------------------

new <- pull_nitrate(refresh_from) %>%
  clean_nitrate(file.path(DATA_DIR, "huc8_mn.geojson"))

# ---- 3. Combine: old rows before the refresh date + everything new ------------------

daily_out <- old_daily %>%
  filter(date < refresh_from) %>%
  bind_rows(new$daily) %>%
  arrange(site_id, date)

# New site info wins (names/types can be corrected upstream); old-only sites are kept
sites_out <- new$sites %>%
  bind_rows(old_sites %>% filter(!site_id %in% new$sites$site_id)) %>%
  filter(site_id %in% daily_out$site_id)

# Checks: what changed
message("  site-days: ", nrow(old_daily), " -> ", nrow(daily_out),
        "   sites: ", nrow(old_sites), " -> ", nrow(sites_out))
full_join(count(old_daily, year = format(date, "%Y"), name = "before"),
          count(daily_out, year = format(date, "%Y"), name = "after"),
          by = "year") %>%
  as.data.frame() %>%
  print()

# ---- 4. Write -------------------------------------------------------------------------

st_write(sites_out, file.path(DATA_DIR, "nitrate_sites.geojson"),
         layer_options = "COORDINATE_PRECISION=5", delete_dsn = TRUE, quiet = TRUE)

write.csv(daily_out, file.path(DATA_DIR, "nitrate_daily.csv"), row.names = FALSE)
