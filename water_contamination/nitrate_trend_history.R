# ==============================================================================
# nitrate_trend_history.R — one-time setup for the long-term trend chart
#
# NOT run by update_data.R. Run once (or again only if you change the site rules).
#
#   1. Pick the trend sites (6+ years of data, 2020–2025) and give each a region
#   2. Download their 2005–2019 results (older WQP service)
#   3. Clean them the same way as nitrate_daily
#
# Outputs (not read by the website; read by 03_nitrate_trend.R):
#   data-raw/trend_sites.csv           site_id, region
#   data-raw/nitrate_pre2020_daily.csv one value per site per day, 2005–2019
# Needs: data/nitrate_daily.csv, data/nitrate_sites.geojson
# Run from the project folder.
# ==============================================================================

library(tidyverse)
library(lubridate)
library(sf)
library(dataRetrieval)

DATA_DIR <- "data"
RAW_DIR  <- "data-raw"
dir.create(RAW_DIR, showWarnings = FALSE)

first_year     <- 2005
site_last_year <- 2025   # site selection window: 2020 to this year
min_years      <- 6      # years with data in that window to count as long-term

dat   <- read_csv(file.path(DATA_DIR, "nitrate_daily.csv"), show_col_types = FALSE)
sites <- st_read(file.path(DATA_DIR, "nitrate_sites.geojson"), quiet = TRUE)

# ---- 1. Trend sites + regions -------------------------------------------------

huc_region <- function(huc8) {
  huc4 <- str_sub(huc8, 1, 4)
  case_when(
    huc4 %in% c("0702", "1017", "1023", "0710") ~ "Minnesota River & Southwest",
    huc4 %in% c("0704", "0708")                 ~ "Southeast",
    huc4 %in% c("0701", "0703")                 ~ "Upper Mississippi & St. Croix",
    huc4 == "0902"                              ~ "Red River",
    huc4 %in% c("0401", "0903")                 ~ "North (Superior & Rainy)",
    TRUE                                        ~ "Other"
  )
}

long_sites <- dat %>%
  mutate(year = year(date)) %>%
  filter(year >= 2020, year <= site_last_year) %>%
  distinct(site_id, year) %>%
  count(site_id, name = "n_years") %>%
  filter(n_years >= min_years)

site_regions <- sites %>%
  st_drop_geometry() %>%
  filter(site_id %in% long_sites$site_id) %>%
  distinct(site_id, region = huc_region(huc8))

trend_sites <- site_regions$site_id

print(count(site_regions, region))

# ---- 2. Download 2005–2019 ---------------------------------------------------------

nitrate_names <- c("Nitrate",
                   "Nitrate + Nitrite",
                   "Inorganic nitrogen (nitrate and nitrite) ***retired***use Nitrate + Nitrite")

pull_chunk <- function(ids) {
  readWQPdata(siteid             = ids,
              characteristicName = nitrate_names,
              startDateLo        = paste0(first_year, "-01-01"),
              startDateHi        = "2019-12-31") %>%
    mutate(across(everything(), as.character))   # chunks can disagree on column types
}

chunks  <- split(trend_sites, ceiling(seq_along(trend_sites) / 25))   # small chunks so WQP doesn't time out
raw_old <- map(chunks, pull_chunk) %>% bind_rows()

# ---- 3. Clean (same rules as nitrate_functions.R; older column names) --------------
# The older service has no speciation column, so speciation comes from the unit text

NO3_TO_N <- 14.007 / 62.004

censored_conditions <- c(
  "Below Detection Limit", "Below Method Detection Limit", "Below Reporting Limit",
  "Not Detected", "Not Detected at Reporting Limit",
  "Present Below Quantification Limit", "Between Inst Detect and Quant Limit"
)

to_mgL <- function(unit) {
  u <- str_to_lower(str_squish(coalesce(unit, "")))
  case_when(
    str_starts(u, "mg/l") | u == "ppm" ~ 1,
    str_starts(u, "ug/l") | u == "ppb" ~ 0.001,
    TRUE                               ~ NA_real_
  )
}

old_daily <- raw_old %>%
  transmute(
    site_id    = MonitoringLocationIdentifier,
    date       = as.Date(ActivityStartDate),
    type_code  = ActivityTypeCode,
    value      = ResultMeasureValue,
    unit       = ResultMeasure.MeasureUnitCode,
    condition  = ResultDetectionConditionText,
    dl_value   = DetectionQuantitationLimitMeasure.MeasureValue,
    dl_unit    = DetectionQuantitationLimitMeasure.MeasureUnitCode
  ) %>%
  mutate(censored = condition %in% censored_conditions) %>%
  filter(
    !str_detect(coalesce(type_code, ""), "Quality Control"),
    !condition %in% c("Detected Not Quantified", "Not Reported"),
    !is.na(value) | censored
  ) %>%
  mutate(
    unit_used    = if_else(censored, dl_unit, unit),
    species_mult = if_else(str_detect(coalesce(unit_used, ""),
                                      regex("as ?no3", ignore_case = TRUE)), NO3_TO_N, 1),
    result = if_else(censored,
                     as.numeric(dl_value) * to_mgL(dl_unit),
                     as.numeric(value)    * to_mgL(unit)) * species_mult
  ) %>%
  filter(!is.na(result),
         !(censored & result >= 10)) %>%
  group_by(site_id, date) %>%
  summarise(nitrate_mgL = round(mean(result), 3),
            non_detect  = as.integer(all(censored)),
            .groups = "drop")

write_csv(site_regions, file.path(RAW_DIR, "trend_sites.csv"))
write_csv(old_daily,    file.path(RAW_DIR, "nitrate_pre2020_daily.csv"))

message("Trend history: ", length(trend_sites), " sites, ", nrow(old_daily), " site-days before 2020")
