# ==============================================================================
# 01_boundaries.R — outlines the map draws and the other scripts join to
#
# Outputs:
#   data/huc8_mn.geojson      HUC 8 watersheds, clipped to Minnesota
#   data/mn_house.geojson     State House districts (house = "64A", senate = 64)
#   data/mn_senate.geojson    State Senate districts (senate = 64)
#   data/mn_congress.geojson  Congressional districts (district = 1..8)
#
# Rerun only after redistricting (next maps: 2032) or on a fresh setup.
# ==============================================================================

library(tidyverse)
library(sf)
library(httr2)
library(rmapshaper)
library(tigris)
library(arcgislayers)
options(tigris_use_cache = TRUE)

if (!exists("DATA_DIR")) DATA_DIR <- "data"

# ---- 1. HUC 8 watersheds (USGS Watershed Boundary Dataset) ----------------------

huc8 <- request("https://hydro.nationalmap.gov/arcgis/rest/services/wbd/MapServer/4/query") |>
  req_url_query(
    where = "states LIKE '%MN%'",
    outFields = "huc8,name,states",
    outSR = 4326,
    maxAllowableOffset = 0.001,   # light server-side simplification (~100 m) for a faster download
    f = "geojson"
  ) |>
  req_perform() |>
  resp_body_string() |>
  st_read(quiet = TRUE)

mn <- states(cb = TRUE, year = 2023) |>
  filter(STUSPS == "MN") |>
  st_transform(26915)

huc8_mn <- huc8 |>
  st_transform(26915) |>
  st_make_valid() |>
  st_intersection(st_geometry(mn)) |>
  st_collection_extract("POLYGON") |>
  group_by(huc8, name) |>
  summarise(.groups = "drop") |>
  filter(as.numeric(st_area(geometry)) > 1e6) |>   # drop slivers under 1 km² along the border
  ms_simplify(keep = 0.05, keep_shapes = TRUE) |>
  st_transform(4326)

message("Watersheds: ", nrow(huc8_mn), " (expect about 80)")

st_write(huc8_mn, file.path(DATA_DIR, "huc8_mn.geojson"),
         layer_options = "COORDINATE_PRECISION=5", delete_dsn = TRUE, quiet = TRUE)

# ---- 2. District outlines (Census TIGER, 2023 files = the 2022 maps) ------------

house <- state_legislative_districts("MN", house = "lower", cb = TRUE, year = 2023) %>%
  transmute(house  = str_remove(SLDLST, "^0+"),                    # "064A" -> "64A"
            senate = as.integer(str_extract(SLDLST, "^\\d+"))) %>%
  filter(!is.na(senate))                                            # drops any water-only "ZZZ" areas

senate <- state_legislative_districts("MN", house = "upper", cb = TRUE, year = 2023) %>%
  transmute(senate = as.integer(SLDUST)) %>%
  filter(!is.na(senate))

congress <- congressional_districts(state = "MN", cb = TRUE, year = 2023)
congress <- congress %>%
  transmute(district = as.integer(.data[[str_subset(names(congress), "^CD\\d+FP$")]]))

message("Districts: ", nrow(house), " House (expect 134), ", nrow(senate),
        " Senate (expect 67), ", nrow(congress), " congressional (expect 8)")

write_boundary <- function(x, file) {
  x %>%
    st_transform(26915) %>%
    st_simplify(preserveTopology = TRUE, dTolerance = 100) %>%      # 100 m: plenty for a statewide map
    st_transform(4326) %>%
    st_write(file, layer_options = "COORDINATE_PRECISION=5", delete_dsn = TRUE, quiet = TRUE)
}

write_boundary(house,    file.path(DATA_DIR, "mn_house.geojson"))
write_boundary(senate,   file.path(DATA_DIR, "mn_senate.geojson"))
write_boundary(congress, file.path(DATA_DIR, "mn_congress.geojson"))

# ---- 3. City points (MnGeo population centers) ----------------------------------

cities <- arc_select(arc_open(
  "https://enterprise.gisdata.mn.gov/aghost/rest/services/us_mn_state_mngeo/loc_pop_centers/FeatureServer/1"
))

count(st_drop_geometry(cities), ctu_type)    # check the exact type labels first
count(st_drop_geometry(cities), sym_class)

cities %>%
  filter(ctu_type == "City") %>%             # adjust to the label the count shows
  transmute(name, county, population, sym_class) %>%
  arrange(desc(population)) %>%              # biggest first, so they draw and label first
  st_transform(4326) %>%
  st_write("../data/mn_cities.geojson",
           layer_options = "COORDINATE_PRECISION=4", delete_dsn = TRUE, quiet = TRUE)
  # st_write(file.path(DATA_DIR, "mn_cities.geojson"),
  #          layer_options = "COORDINATE_PRECISION=4", delete_dsn = TRUE, quiet = TRUE)
