# ==============================================================================
# nitrate_full_rebuild.R — rebuild the nitrate files from scratch
#
# NOT run by update_data.R. Use it if the nitrate files are lost or you change the
# cleaning rules in nitrate_functions.R and want them applied to every year.
# (Once a year is also reasonable, to catch rare late corrections to old results.)
#
# Outputs: data/nitrate_sites.geojson, data/nitrate_daily.csv (overwritten)
# Needs:   data/huc8_mn.geojson
# Run from the project folder.
# ==============================================================================

source("R/nitrate_functions.R")

DATA_DIR      <- "data"
NITRATE_START <- "2020-01-01"

nitrate <- pull_nitrate(NITRATE_START) %>%
  clean_nitrate(file.path(DATA_DIR, "huc8_mn.geojson"))

st_write(nitrate$sites, file.path(DATA_DIR, "nitrate_sites.geojson"),
         layer_options = "COORDINATE_PRECISION=5", delete_dsn = TRUE, quiet = TRUE)

write.csv(nitrate$daily, file.path(DATA_DIR, "nitrate_daily.csv"), row.names = FALSE)

message("Nitrate: ", nrow(nitrate$sites), " sites, ", nrow(nitrate$daily), " site-days")
