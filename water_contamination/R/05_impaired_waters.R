# ==============================================================================
# 05_impaired_waters.R — MPCA impaired waters list
#
#   1. Download the impaired lake, stream, wetland, beach and tribal-water layers
#   2. Group each impairment into 8 problem categories; flag waters still needing a plan
#   3. Simplify, then tag each water with its county, watershed and districts
#
# Output: data/impaired_waters.geojson
# Needs:  data/huc8_mn.geojson, data/mn_house.geojson, data/mn_congress.geojson (01_boundaries.R)
# ==============================================================================

library(tidyverse)
library(sf)
library(arcgislayers)
library(tigris)
options(tigris_use_cache = TRUE)

if (!exists("DATA_DIR")) DATA_DIR <- "data"
if (!exists("IMPAIRED_URL")) {
  IMPAIRED_URL <- "https://enterprise.gisdata.mn.gov/aghost/rest/services/us_mn_state_pca/env_impaired_water_2026_draft/FeatureServer"
}

# ---- 1. Download --------------------------------------------------------------------
# Layer IDs in the MPCA service (these start at 0). If MPCA publishes a new list,
# check the printed layer names below and update these numbers if they've moved.

LAYERS <- c(
  lakes          = 13,
  streams        = 7,
  wetlands       = 11,
  beaches        = 8,
  native_lakes   = 12,
  native_streams = 6
)

get_layer <- function(i) {
  lyr <- arc_open(paste0(IMPAIRED_URL, "/", i))
  message("  layer ", i, ": ", lyr$name)
  arc_select(lyr)
}

layers <- map(LAYERS, get_layer)

# Check: every layer should have these columns and the row counts should look right
map(layers, \(x) c(rows = nrow(x), has_imp_param = "imp_param" %in% names(x)))

# ---- 2. Categories + cleaning --------------------------------------------------------

impair_group <- function(code) {
  case_when(
    code %in% c("Hg-F", "Hg-W")                          ~ "Mercury",
    code %in% c("PFOS-F", "PFOS-W")                      ~ "PFAS",
    code %in% c("PCB-F", "PCB-W", "Dioxin", "DDT", "Dieldrin", "Toxaphene",
                "Ace", "Acetochlor", "Clpyr", "Chlorpyrif") ~ "Other toxic chemicals",
    code %in% c("E.coli", "FC")                          ~ "Bacteria",
    code %in% c("Nutrients", "DO", "Nitrates", "Nitrate", "Amm-U") ~ "Nutrients & low oxygen",
    code %in% c("TSS", "T")                              ~ "Sediment",
    code %in% c("Cl-", "SO4", "Al", "As", "Cu")          ~ "Salts & metals",
    code %in% c("FishesBio", "InvertBio", "ColdWater",
                "Temp", "pH", "PlantBio")                ~ "Aquatic life & habitat",
    TRUE                                                 ~ "Other"
  )
}

# Highest priority first: a water with several problems is colored by the first one here
group_priority <- c("PFAS", "Other toxic chemicals", "Mercury", "Nutrients & low oxygen",
                    "Bacteria", "Salts & metals", "Sediment", "Aquatic life & habitat", "Other")

clean_waterbodies <- function(data) {
  data %>%
    st_drop_geometry() %>%
    select(auid, imp_param, needs_pln) %>%
    mutate(any_needs_plan = str_squish(coalesce(needs_pln, "None")) != "None") %>%  # "None" = plan in place
    separate_longer_delim(imp_param, delim = ";") %>%
    mutate(imp_param = str_squish(imp_param)) %>%
    filter(imp_param != "") %>%
    mutate(
      imp_cat  = impair_group(imp_param),
      cat_rank = match(imp_cat, group_priority)
    ) %>%
    distinct(auid, imp_param, .keep_all = TRUE) %>%   # drop any repeated code on the same water
    group_by(auid) %>%
    arrange(cat_rank, .by_group = TRUE) %>%
    summarise(
      primary_group     = first(imp_cat),
      all_groups        = paste(unique(imp_cat), collapse = "; "),
      impairments       = paste(imp_param, collapse = "; "),
      impairment_groups = paste(imp_cat, collapse = "; "),
      needs_pln         = first(needs_pln),
      any_needs_plan    = first(any_needs_plan),
      .groups = "drop"
    )
}

waterbodies_out <- function(data, type, native = FALSE) {
  keep <- if (native) c("auid", "name", "indian_reservation") else c("auid", "name")
  data %>%
    select(all_of(keep)) %>%
    inner_join(clean_waterbodies(data), by = "auid") %>%
    mutate(water_type = type)
}

impaired_out <- list(
  waterbodies_out(layers$lakes,          "Lake"),
  waterbodies_out(layers$streams,        "Stream"),
  waterbodies_out(layers$wetlands,       "Wetland"),
  waterbodies_out(layers$beaches,        "Beach"),
  waterbodies_out(layers$native_lakes,   "Lake",   native = TRUE),
  waterbodies_out(layers$native_streams, "Stream", native = TRUE)
) %>%
  keep(\(x) nrow(x) > 0) %>%                                              # skip empty layers
  lapply(st_transform, 26915) %>%                                         # meters, so the tolerance is in meters
  lapply(st_simplify, preserveTopology = TRUE, dTolerance = 25) %>%       # drop detail finer than ~25 m
  bind_rows()

# Check: codes that didn't match a category (add them to impair_group if any show up)
impaired_out %>%
  st_drop_geometry() %>%
  separate_longer_delim(impairments, delim = "; ") %>%
  filter(impair_group(impairments) == "Other") %>%
  count(impairments) %>%
  print()

# ---- 3. County, watershed and districts for each water ------------------------------
# One point inside each water, so a long river lands in exactly one place; waters that
# fall just outside the outlines (border lakes and rivers) get the nearest one.

water_points <- impaired_out %>%
  select(auid) %>%
  st_point_on_surface()

assign_area <- function(pts, polys, cols) {
  polys <- st_transform(polys, 26915) %>% select(all_of(cols))
  hit <- st_join(pts, polys, join = st_intersects) %>%
    distinct(auid, .keep_all = TRUE)
  miss <- is.na(hit[[cols[1]]])
  if (any(miss)) {
    nearest <- st_nearest_feature(hit[miss, ], polys)
    for (col in cols) hit[[col]][miss] <- polys[[col]][nearest]
  }
  st_drop_geometry(hit)
}

mn_counties <- counties(state = "MN", cb = TRUE, year = 2023) %>%
  transmute(county_fips = GEOID, county = NAME)

huc8_areas <- st_read(file.path(DATA_DIR, "huc8_mn.geojson"), quiet = TRUE) %>%
  transmute(huc8, huc8_name = name)

house <- st_read(file.path(DATA_DIR, "mn_house.geojson"), quiet = TRUE) %>%
  transmute(house_dist = house)

congress <- st_read(file.path(DATA_DIR, "mn_congress.geojson"), quiet = TRUE) %>%
  transmute(cong_dist = district)

impaired <- impaired_out %>%
  left_join(assign_area(water_points, mn_counties, c("county_fips", "county")), by = "auid") %>%
  left_join(assign_area(water_points, huc8_areas,  c("huc8", "huc8_name")),     by = "auid") %>%
  left_join(assign_area(water_points, house,       "house_dist"),               by = "auid") %>%
  left_join(assign_area(water_points, congress,    "cong_dist"),                by = "auid") %>%
  mutate(senate_dist = as.integer(str_extract(house_dist, "^\\d+"))) %>%        # House districts nest in Senate ones
  st_transform(4326)

# Checks: no missing areas; counts by category
impaired %>%
  st_drop_geometry() %>%
  summarise(across(c(county_fips, huc8, house_dist, cong_dist), ~ sum(is.na(.x)))) %>%
  print()
print(count(st_drop_geometry(impaired), primary_group, any_needs_plan))

st_write(impaired, file.path(DATA_DIR, "impaired_waters.geojson"),
         layer_options = "COORDINATE_PRECISION=5", delete_dsn = TRUE, quiet = TRUE)

message("Impaired waters: ", nrow(impaired), " waters")