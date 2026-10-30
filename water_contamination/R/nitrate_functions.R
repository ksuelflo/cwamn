# ==============================================================================
# nitrate_functions.R — download + cleaning steps shared by
#   02_nitrate.R           (quarterly update: re-pulls recent years, keeps the rest)
#   nitrate_full_rebuild.R (rebuilds everything since 2020; not run by update_data.R)
#
#   pull_nitrate(from)        WQP (WQX 3.0) nitrate results for Minnesota, `from` to today
#   clean_nitrate(nox, huc8)  -> list(sites = sf of sites, daily = one value per site per day)
# ==============================================================================

library(tidyverse)
library(sf)
library(tigris)
library(dataRetrieval)
options(tigris_use_cache = TRUE)

# ---- Download, one calendar year at a time ---------------------------------------
# (big requests can come back incomplete; a year at a time stays well under the limit)

nitrate_names <- c("Nitrate",
                   "Nitrate + Nitrite",
                   "Inorganic nitrogen (nitrate and nitrite) ***retired***use Nitrate + Nitrite")

pull_nitrate <- function(from) {
  from  <- as.Date(from)
  years <- seq(as.integer(format(from, "%Y")), as.integer(format(Sys.Date(), "%Y")))

  nox <- map(years, function(y) {
    lo <- max(from, as.Date(paste0(y, "-01-01")))
    message("  downloading ", y, " ...")
    readWQPdata(statecode          = "US:27",
                characteristicName = nitrate_names,
                startDateLo        = format(lo, "%Y-%m-%d"),
                startDateHi        = paste0(y, "-12-31"),
                service            = "ResultWQX3",
                dataProfile        = "basicPhysChem") %>%
      mutate(across(everything(), as.character))   # years can disagree on column types
  }) %>%
    bind_rows() %>%
    distinct()                                      # drop any exact duplicate rows

  # Checks
  print(count(nox, Result_Characteristic))
  print(as.data.frame(count(nox, year = substr(Activity_StartDate, 1, 4))))

  nox
}

# ---- Clean -> sites + daily values -------------------------------------------------

NO3_TO_N <- 14.007 / 62.004   # ~0.226; nitrate "as NO3" -> "as N"

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
    TRUE                               ~ NA_real_   # mg/kg and anything unknown -> dropped
  )
}

# Minnesota drains to four basins: 04 Great Lakes, 07 Upper Mississippi,
# 09 Souris-Red-Rainy, 10 Missouri (far southwest)
VALID_HUC8 <- "^(04|07|09|10)\\d{6}$"

MAX_SNAP_KM <- 2   # border sites within this distance get the nearest county/watershed

clean_nitrate <- function(nox, huc8_file) {

  nox_slim <- nox %>%
    select(
      Location_Identifier, Location_Name, Location_Type,
      Location_LatitudeStandardized, Location_LongitudeStandardized,
      Location_CountyName, Location_HUCEightDigitCode,
      Activity_StartDate, Activity_TypeCode, Activity_Media,
      Result_Characteristic, Result_Measure, Result_MeasureUnit,
      Result_MethodSpeciation, Result_SampleFraction,
      Result_ResultDetectionCondition, Result_MeasureStatusIdentifier,
      DetectionLimit_MeasureA, DetectionLimit_MeasureUnitA,
      Org_FormalName, ProviderName
    )

  # Values
  nox_clean <- nox_slim |>
    mutate(censored = Result_ResultDetectionCondition %in% censored_conditions) |>
    filter(
      !str_detect(coalesce(Activity_TypeCode, ""), "Quality Control"),          # drop QC samples
      !Result_ResultDetectionCondition %in% c("Detected Not Quantified", "Not Reported"),
      !is.na(Result_Measure) | censored,                                        # no value and no flag
      !Result_MethodSpeciation %in% "as NO2+NO3"                                # ambiguous basis
    ) |>
    mutate(
      species_mult = if_else(Result_MethodSpeciation %in% "as NO3", NO3_TO_N, 1),
      new_result = if_else(
        censored,
        as.numeric(DetectionLimit_MeasureA) * to_mgL(DetectionLimit_MeasureUnitA),  # non-detects: use the limit
        as.numeric(Result_Measure)          * to_mgL(Result_MeasureUnit)
      ) * species_mult
    ) |>
    filter(
      !is.na(new_result),                     # unknown units
      !(censored & new_result >= 10)          # detection limits too high to say anything about the standard
    )

  # Fill missing county / HUC 8 from the site's location (UTM 15N so distances are planar)
  mn_counties <- counties(state = "MN", cb = TRUE, year = 2023) |>
    st_transform(26915) |>
    select(county_fill = NAME)

  huc8_poly <- st_read(huc8_file, quiet = TRUE) |>
    st_transform(26915) |>
    select(huc8_fill = huc8)

  site_pts <- nox_clean |>
    distinct(Location_Identifier, .keep_all = TRUE) |>
    select(Location_Identifier, Location_LongitudeStandardized, Location_LatitudeStandardized) |>
    mutate(across(c(Location_LongitudeStandardized, Location_LatitudeStandardized), as.numeric)) |>
    filter(!is.na(Location_LongitudeStandardized), !is.na(Location_LatitudeStandardized)) |>
    st_as_sf(coords = c("Location_LongitudeStandardized", "Location_LatitudeStandardized"), crs = 4326) |>
    st_transform(26915)

  nearest_within <- function(pts, polys, value_col, max_km) {
    idx  <- st_nearest_feature(pts, polys)
    dist <- as.numeric(st_distance(pts, polys[idx, ], by_element = TRUE)) / 1000
    if_else(dist <= max_km, polys[[value_col]][idx], NA_character_)
  }

  site_fill <- site_pts |>
    st_join(mn_counties, join = st_within) |>
    st_join(huc8_poly,   join = st_within) |>
    distinct(Location_Identifier, .keep_all = TRUE)

  no_county <- is.na(site_fill$county_fill)
  no_huc    <- is.na(site_fill$huc8_fill)

  if (any(no_county)) {
    site_fill$county_fill[no_county] <-
      nearest_within(site_fill[no_county, ], mn_counties, "county_fill", MAX_SNAP_KM)
  }
  if (any(no_huc)) {
    site_fill$huc8_fill[no_huc] <-
      nearest_within(site_fill[no_huc, ], huc8_poly, "huc8_fill", MAX_SNAP_KM)
  }

  site_fill <- st_drop_geometry(site_fill)

  # Keep agency values when valid, otherwise the spatial fill; then drop out-of-state sites
  nox_clean <- nox_clean |>
    left_join(site_fill, by = "Location_Identifier") |>
    mutate(
      huc_raw = str_trim(as.character(Location_HUCEightDigitCode)),
      huc_raw = if_else(is.na(huc_raw) | str_detect(huc_raw, "^0*$"),
                        NA_character_,
                        str_pad(huc_raw, 8, pad = "0")),
      huc_raw = if_else(str_detect(coalesce(huc_raw, ""), VALID_HUC8),
                        huc_raw, NA_character_),
      Location_HUCEightDigitCode = coalesce(huc_raw, huc8_fill),
      Location_CountyName        = coalesce(na_if(str_trim(Location_CountyName), ""), county_fill)
    ) |>
    select(-huc_raw, -county_fill, -huc8_fill) |>
    filter(!is.na(Location_HUCEightDigitCode),
           !is.na(Location_CountyName)) |>
    mutate(Location_CountyName = str_remove(Location_CountyName, " County"),
           Location_CountyName = case_when(Location_CountyName == "Lac qui Parle"     ~ "Lac Qui Parle",
                                           Location_CountyName == "Lake Of The Woods" ~ "Lake of the Woods",
                                           Location_CountyName == "Mcleod"            ~ "McLeod",
                                           Location_CountyName == "St Louis"          ~ "St. Louis",
                                           .default = Location_CountyName))

  # Sites
  sites <- nox_clean |>
    distinct(Location_Identifier, .keep_all = TRUE) |>
    mutate(lon = as.numeric(Location_LongitudeStandardized),
           lat = as.numeric(Location_LatitudeStandardized)) |>
    filter(!is.na(lon), !is.na(lat)) |>
    select(site_id = Location_Identifier, name = Location_Name, county = Location_CountyName,
           huc8 = Location_HUCEightDigitCode, org = Org_FormalName, lon, lat,
           type = Location_Type) |>
    st_as_sf(coords = c("lon", "lat"), crs = 4326) |>
    mutate(water_type = case_when(
      str_detect(type, "^River|^Stream|Channelized|Riverine")         ~ "Rivers & streams",
      str_detect(type, "Lake")                                        ~ "Lakes",
      str_detect(type, "^Wetland")                                    ~ "Wetlands",
      str_detect(type, "Well|Spring|Gallery|Ground Water")            ~ "Groundwater",
      str_detect(type, "Storm")                                       ~ "Stormwater",
      type == "Land" & str_detect(name, regex("piezometer", ignore_case = TRUE)) ~ "Groundwater",
      type == "Land" & str_detect(name, regex("tile", ignore_case = TRUE))       ~ "Farm drainage (tile)",
      TRUE                                                            ~ NA_character_
    )) |>
    filter(!is.na(water_type))

  # One value per site per day
  daily <- nox_clean |>
    filter(Location_Identifier %in% sites$site_id) |>
    mutate(date = as.Date(Activity_StartDate)) |>
    group_by(site_id = Location_Identifier, date) |>
    summarise(nitrate_mgL = round(mean(new_result), 3),
              non_detect  = as.integer(all(censored)),
              .groups = "drop")

  list(sites = sites, daily = daily)
}
