# ==============================================================================
# 06_private_wells.R — private wells + Special Well and Boring Construction Areas
#
#   1. Print the well use / status codes (the settings below were checked against them)
#   2. Download active domestic wells from the Minnesota Well Index (MDH)
#   3. Tag each well with its county, watershed, House district and congressional district
#   4. Write one small file per county (the website only loads the counties it needs)
#   5. Download the Special Well and Boring Construction Areas (SWBCA)
#
# Outputs:
#   data/wells/<county FIPS>.csv   lon, lat, huc8, house, cong   (e.g. data/wells/27053.csv)
#   data/swbca.geojson             name, zone, effective
# Needs: data/huc8_mn.geojson, data/mn_house.geojson, data/mn_congress.geojson (01_boundaries.R)
# ==============================================================================

library(tidyverse)
library(sf)
library(arcgislayers)
library(httr2)
library(tigris)
options(tigris_use_cache = TRUE)

if (!exists("DATA_DIR")) DATA_DIR <- "data"

MWI_URL <- "https://arcgis.web.health.state.mn.us/arcgis/rest/services/3GADX/MWIMap/MapServer"

# Well use and status codes (checked Oct 2026 against the counts printed in step 1)
DOMESTIC_USE <- c("DO", "MD")   # USE_C: Domestic, Multiple dwelling (private drinking-water wells)
KEEP_STATUS  <- "A"            # STATUS_C: A = active (drops sealed, unused, inactive)

# MDH's server says it supports the compact "PBF" format, but sends PBF that arcgislayers
# can't decode. Telling arcgislayers the layer only does JSON makes it download JSON instead.
open_mdh <- function(url) {
  lyr <- arc_open(url)
  lyr$supportedQueryFormats <- "JSON"
  lyr
}

in_list   <- function(x) paste0("(", paste0("'", x, "'", collapse = ","), ")")
use_where <- paste0("USE_C IN ", in_list(DOMESTIC_USE))                              # USE_C IN ('DO','MD')
dl_where  <- paste0(use_where, " AND STATUS_C IN ", in_list(KEEP_STATUS))            # ... AND STATUS_C IN ('A')

# ---- 1. Check the codes (quick: the server does the counting) ------------------------

# Number of wells per value of `field`, counted on MDH's server
count_by <- function(field, where = "1=1") {
  stat <- sprintf('[{"statisticType":"count","onStatisticField":"%s","outStatisticFieldName":"n"}]', field)
  request(paste0(MWI_URL, "/0/query")) |>
    req_url_query(where = where, groupByFieldsForStatistics = field,
                  outStatistics = stat, f = "json") |>
    req_perform() |>
    resp_body_json() |>
    pluck("features") |>
    map_dfr("attributes") |>
    rename_with(tolower) |>        # the server returns some names in capitals ("N")
    arrange(desc(n))
}

# What each use code means (layer 10: Use Code Descriptions)
use_codes <- request(paste0(MWI_URL, "/10/query")) |>
  req_url_query(where = "1=1", outFields = "*", f = "json") |>
  req_perform() |>
  resp_body_json() |>
  pluck("features") |>
  map_dfr("attributes")

print(use_codes)
print(count_by("USE_C"))                                                    # check DOMESTIC_USE
print(count_by("STATUS_C", where = use_where))                              # check KEEP_STATUS

# ---- 2. Download active domestic wells, 2,000 at a time ---------------------------------------
# The Wells layer has no ID column, so the pages are ordered by the well number (RELATEID).

mdh_wells_page <- function(offset) {
  request(paste0(MWI_URL, "/0/query")) |>
    req_url_query(where             = dl_where,
                  outFields         = "RELATEID,STATUS_C",
                  orderByFields     = "RELATEID",
                  resultOffset      = offset,
                  resultRecordCount = 2000,
                  outSR             = 4326,
                  f                 = "geojson") |>
    req_perform() |>
    resp_body_string() |>
    st_read(quiet = TRUE)
}

pages  <- list()
offset <- 0
repeat {
  page <- mdh_wells_page(offset)
  pages[[length(pages) + 1]] <- page
  if (offset %% 50000 == 0) message("  ", offset, " wells downloaded ...")
  if (nrow(page) < 2000) break                 # last page
  offset <- offset + 2000
}

wells <- bind_rows(pages) %>%
  distinct(RELATEID, .keep_all = TRUE) %>%
  st_transform(26915)

message("Active domestic wells: ", nrow(wells), " (expect about 423,000)")

# ---- 3. County, watershed and districts for each well ----------------------------

# Index of the polygon each point falls in; points in no polygon get the nearest one
which_poly <- function(pts, polys, nearest = TRUE) {
  hits  <- st_intersects(pts, polys)
  first <- vapply(hits, function(i) if (length(i)) i[1] else NA_integer_, integer(1))
  miss  <- is.na(first)
  if (nearest && any(miss)) first[miss] <- st_nearest_feature(pts[miss, ], polys)
  first
}

mn_counties <- counties(state = "MN", cb = TRUE, year = 2023) %>% st_transform(26915)
huc8        <- st_read(file.path(DATA_DIR, "huc8_mn.geojson"),     quiet = TRUE) %>% st_transform(26915)
house       <- st_read(file.path(DATA_DIR, "mn_house.geojson"),    quiet = TRUE) %>% st_transform(26915)
congress    <- st_read(file.path(DATA_DIR, "mn_congress.geojson"), quiet = TRUE) %>% st_transform(26915)

# Wells outside every county are mislocated or out of state: drop them
county_i <- which_poly(wells, mn_counties, nearest = FALSE)
wells    <- wells[!is.na(county_i), ]
county_i <- county_i[!is.na(county_i)]

coords <- wells %>% st_transform(4326) %>% st_coordinates()

wells_out <- tibble(
  county = mn_counties$GEOID[county_i],
  lon    = round(coords[, 1], 4),        # ~10 m: plenty for dots, half the file size
  lat    = round(coords[, 2], 4),
  huc8   = huc8$huc8[which_poly(wells, huc8)],
  house  = house$house[which_poly(wells, house)],
  cong   = congress$district[which_poly(wells, congress)]
)

message("Private wells: ", nrow(wells_out))

# ---- 4. One file per county ------------------------------------------------------

wells_dir <- file.path(DATA_DIR, "wells")
dir.create(wells_dir, showWarnings = FALSE)
unlink(file.path(wells_dir, "*.csv"))      # clear last run's files

wells_out %>%
  group_by(county) %>%
  group_walk(\(d, key) write_csv(d, file.path(wells_dir, paste0(key$county, ".csv"))))

# ---- 5. Special Well and Boring Construction Areas --------------------------------
# (this layer has an ID column, so arc_select can page it; it just needs the JSON fix)

arc_select(open_mdh(paste0(MWI_URL, "/5"))) %>%
  st_make_valid() %>%
  transmute(name      = swc_name,
            zone,
            effective = as.character(as.Date(swca_d))) %>%
  st_transform(4326) %>%
  st_write(file.path(DATA_DIR, "swbca.geojson"),
           layer_options = "COORDINATE_PRECISION=5", delete_dsn = TRUE, quiet = TRUE)