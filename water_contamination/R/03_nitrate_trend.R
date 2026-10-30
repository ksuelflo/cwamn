# ==============================================================================
# 03_nitrate_trend.R — data for the "Long-term trend" chart
#
# The trend uses a fixed set of sites. Their 2005–2019 results are saved in
# data-raw/ (made once by nitrate_trend_history.R); their 2020+ results come
# from the freshly updated data/nitrate_daily.csv.
#
#   site-year value = median of monthly medians (March–October)
#   plotted value   = median across sites, per region and year
#
# Output: data/region_year.csv
# Needs:  data-raw/trend_sites.csv, data-raw/nitrate_pre2020_daily.csv,
#         data/nitrate_daily.csv (from 02_nitrate.R)
# ==============================================================================

library(tidyverse)
library(lubridate)

if (!exists("DATA_DIR"))        DATA_DIR        <- "data"
if (!exists("TREND_LAST_YEAR")) TREND_LAST_YEAR <- 2025

RAW_DIR <- "data-raw"

# Quality rules for the yearly medians (1 = no rule)
min_months <- 1       # months sampled (Mar–Oct) for a site-year to count
min_sites  <- 1       # sites a region-year needs to be kept

site_regions <- read_csv(file.path(RAW_DIR, "trend_sites.csv"), show_col_types = FALSE)
old_daily    <- read_csv(file.path(RAW_DIR, "nitrate_pre2020_daily.csv"), show_col_types = FALSE)

new_daily <- read_csv(file.path(DATA_DIR, "nitrate_daily.csv"), show_col_types = FALSE) %>%
  filter(site_id %in% site_regions$site_id)

nitrate_trend_daily <- new_daily %>%
  bind_rows(old_daily %>% anti_join(new_daily, by = c("site_id", "date"))) %>%   # no doubled days
  filter(year(date) <= TREND_LAST_YEAR)

site_year <- nitrate_trend_daily %>%
  mutate(year = year(date), month = month(date)) %>%
  filter(month %in% 3:10) %>%
  group_by(site_id, year, month) %>%
  summarise(month_median = median(nitrate_mgL), .groups = "drop") %>%
  group_by(site_id, year) %>%
  summarise(n_months = n(),
            median_B = median(month_median),
            .groups  = "drop") %>%
  filter(n_months >= min_months) %>%
  left_join(site_regions, by = "site_id")

region_year <- site_year %>%
  group_by(region, year) %>%
  summarise(year_med = median(median_B),
            n_sites  = n(),
            .groups  = "drop") %>%
  filter(n_sites >= min_sites,
         region != "Other")

write_csv(region_year, file.path(DATA_DIR, "region_year.csv"))

message("Trend: ", nrow(site_regions), " sites, ", min(region_year$year), "–", max(region_year$year))
