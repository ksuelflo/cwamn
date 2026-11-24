# get_hydro_layers.R
# Downloads Minnesota rivers, lakes, the state outline, and MPCA impaired waters,
# then writes simplified, web-ready GeoJSON for the D3 map.
#
# Sources
#   - MN DNR Hydrography Dataset (24K lakes/open water, perennial streams)
#   - MPCA Impaired Waters 2024 (303(d) list)
#   - US Census cartographic boundary (via tigris) for the state outline
#
# Packages: install.packages(c("sf", "dplyr", "rmapshaper", "tigris"))

library(sf)
library(dplyr)
library(rmapshaper)
library(tigris)

options(timeout = 3600, tigris_use_cache = TRUE)

# ---- Settings --------------------------------------------------------------

raw_dir <- "data/raw"       # downloads (keep out of git)
out_dir <- "data"           # index.html / scrolly.js load GeoJSON from data/

mn_crs <- 26915             # NAD83 / UTM 15N: do all measuring in meters

min_lake_acres <- 50        # drop small lakes/ponds (MN has a *lot*)
min_river_km   <- 25        # keep named rivers at least this long
simplify_keep  <- 0.05      # share of vertices rmapshaper keeps (lower = smaller file)

# Download URLs from the MN Geospatial Commons. If either 404s, open the
# dataset page, copy the GeoPackage link, and paste it here.
hydro_url    <- "https://operations.gis.data.mn.gov/api/publicdownload/download/899/water_dnr_hydrography.zip"
impaired_url <- "https://resources.gisdata.mn.gov/pub/gdrs/data/pub/us_mn_state_pca/env_impaired_water_2024/gpkg_env_impaired_water_2024.zip"

dir.create(raw_dir, recursive = TRUE, showWarnings = FALSE)
dir.create(out_dir, recursive = TRUE, showWarnings = FALSE)

# ---- Helpers ---------------------------------------------------------------

# Download a zipped GeoPackage once, unzip it, return the .gpkg path
get_gpkg <- function(url, dest_dir) {
  zip_path <- file.path(dest_dir, basename(url))
  if (!file.exists(zip_path)) {
    message("Downloading ", basename(url), " ...")
    download.file(url, zip_path, mode = "wb")
  }
  files <- unzip(zip_path, exdir = dest_dir)
  gpkg <- grep("\\.gpkg$", files, value = TRUE)
  if (length(gpkg) == 0) stop("No .gpkg found inside ", zip_path)
  gpkg[1]
}

# Find layer names by regex instead of hard-coding them (names change between releases)
find_layers <- function(gpkg, pattern, exclude = NULL) {
  lyrs <- st_layers(gpkg)$name
  hit <- grep(pattern, lyrs, value = TRUE, ignore.case = TRUE)
  if (!is.null(exclude)) hit <- grep(exclude, hit, value = TRUE, ignore.case = TRUE, invert = TRUE)
  if (length(hit) == 0) {
    stop("No layer matches '", pattern, "'. Layers in file:\n  ", paste(lyrs, collapse = "\n  "))
  }
  hit
}

# First column whose name contains "name" (GNIS name, lake name, etc.)
name_column <- function(x) {
  col <- grep("name", names(x), ignore.case = TRUE, value = TRUE)[1]
  if (is.na(col)) stop("No name-like column. Columns: ", paste(names(x), collapse = ", "))
  message("  using name column: ", col)
  col
}

read_mn <- function(dsn, layer, query = NULL) {
  message("Reading layer: ", layer)
  (if (is.null(query)) st_read(dsn, layer = layer, quiet = TRUE)
   else st_read(dsn, query = query, quiet = TRUE)) |>
    st_zm() |>
    st_transform(mn_crs) |>
    st_make_valid()
}

# Reproject to lon/lat (what d3-geo expects) and write compact GeoJSON
write_web <- function(x, name) {
  path <- file.path(out_dir, paste0(name, ".geojson"))
  write_it <- function(g) st_write(g, path, layer_options = "COORDINATE_PRECISION=5",
                                   delete_dsn = TRUE, quiet = TRUE)
  write_it(st_transform(x, 4326))
  # Rounding to 5 decimals can collapse tiny parts to a single point, and GDAL
  # then writes that feature as a GeometryCollection. Read it back, keep only
  # the layer's main geometry type, and rewrite (already rounded, so stable).
  back  <- st_read(path, quiet = TRUE)
  types <- as.character(st_geometry_type(back))
  if (any(types == "GEOMETRYCOLLECTION")) {
    main <- if (any(grepl("POLYGON", types))) "POLYGON" else "LINESTRING"
    write_it(st_collection_extract(back, main))
  }
  message(sprintf("Wrote %s (%.1f MB, %d features)",
                  path, file.size(path) / 1e6, nrow(x)))
}

# ---- State outline ---------------------------------------------------------

mn_outline <- states(cb = TRUE, resolution = "500k", year = 2024) |>
  filter(STUSPS == "MN") |>
  st_transform(mn_crs) |>
  select(name = NAME)

write_web(mn_outline, "mn_outline")

# ---- DNR hydrography -------------------------------------------------------

# The DNR zip ships an Esri File Geodatabase, not a GeoPackage. It holds two
# copies: water_dnr_hydrography.gdb is compressed and GDAL's OpenFileGDB
# driver can't read it, so use the _uncompressed one.
hydro_gdb <- file.path(raw_dir, "water_dnr_hydrography", "fgdb",
                       "water_dnr_hydrography_uncompressed.gdb")
if (!dir.exists(hydro_gdb)) {
  zip_path <- file.path(raw_dir, basename(hydro_url))
  if (!file.exists(zip_path)) {
    message("Downloading ", basename(hydro_url), " ...")
    download.file(hydro_url, zip_path, mode = "wb")
  }
  unzip(zip_path, exdir = file.path(raw_dir, "water_dnr_hydrography"))
}
print(st_layers(hydro_gdb))
# Two layers: dnr_hydro_features_all (polygons) and dnr_rivers_and_streams (lines)

# Lakes and open water. Same classes as DNR's own "Lakes and Open Water"
# layer file, minus islands (they would draw as filled water in D3).
# "Riverine polygon" holds the wide 2-D rivers, like the Mississippi.
#   ow_use = 'Y'      -> DNR's non-overlapping open-water set: it picks either
#                        a parent lake or its sub-basins, never both (e.g. Red
#                        Lake comes through as Upper Red + Lower Red)
#   outside_mn = 'Y'  -> wholly outside MN (all of Superior, Canadian waters)
# The layer already has an `acres` field, so filter in the query rather than
# reading all ~131k polygons.
lakes_raw <- read_mn(hydro_gdb, "dnr_hydro_features_all", query = sprintf(
  "SELECT * FROM dnr_hydro_features_all
   WHERE wb_class IN ('Lake or Pond', 'Riverine polygon', 'Reservoir')
     AND ow_use = 'Y'
     AND (outside_mn IS NULL OR outside_mn <> 'Y')
     AND acres >= %d", min_lake_acres))

# st_make_valid() can turn slivers into GEOMETRYCOLLECTIONs; keep only polygons
lakes <- lakes_raw |>
  st_collection_extract("POLYGON") |>
  transmute(name  = coalesce(map_label, pw_basin_name),
            type  = wb_class,
            acres = round(acres))

# Lake labels: one point inside each named lake (labeling the polygons in
# MapLibre repeats the name in every tile a big lake crosses).
# DNR names drop the word "Lake" ("Swan", "Leech") and carry basin notes, so:
#   "Unnamed (Mud)"                      -> "Mud Lake" (local name)
#   "St. Louis River - Thomson Reservoir" -> "Thomson Reservoir"
#   "Gleason (Main Lake)", "Red (Upper Red)" -> "Gleason Lake", "Red Lake"
#   plain "Unnamed" / missing             -> no label
# Riverine polygons are skipped; the river lines already carry those names.
clean_lake_name <- function(x) {
  x <- trimws(x)
  x <- sub("^.* - ", "", x)                                # "<river> - <name>"
  x <- ifelse(grepl("^Unnamed \\(.*\\)$", x), sub("^Unnamed \\((.*)\\)$", "\\1", x), x)
  for (i in 1:3) x <- gsub("\\s*\\([^()]*\\)", "", x)       # nested parentheticals
  x <- trimws(x)
  x[x %in% c("", "Unnamed")] <- NA
  water_word <- grepl("\\b(lake|lakes|lac|lacs|reservoir|pond|pool|flowage|slough|marsh)\\b|^Bde ",
                      x, ignore.case = TRUE)
  ifelse(is.na(x) | water_word, x,
         ifelse(x %in% lake_first, paste("Lake", x), paste(x, "Lake")))
}

# Lakes conventionally named "Lake X" rather than "X Lake". Add to this as
# needed; names that are also ordinary "X Lake" elsewhere (Riley, Benton,
# Calhoun...) are left out on purpose.
lake_first <- c("Superior", "Minnetonka", "Vermilion", "Winnibigoshish", "Kabetogama",
                "Minnewaska", "Pepin", "Harriet", "Nokomis", "Phalen", "Como",
                "Hiawatha", "Waconia", "Elmo", "Owasso", "Johanna", "Shetek",
                "Traverse", "Bemidji", "Carlos", "Mazaska", "Koronis", "Andrusia",
                "Itasca", "Miltona", "Byllesby", "Elysian")

lake_labels <- lakes |>
  filter(type != "Riverine polygon") |>
  mutate(name = clean_lake_name(name)) |>
  filter(!is.na(name)) |>
  st_point_on_surface()

# Streams. Strm_type codes in this release:
#   20 Stream (Perennial), 21 Intermittent, 4x drainage ditches,
#   60 Connector (Lake), 62 Centerline (River), 63 Connector (River)
# Big rivers (the Mississippi included) are stored ONLY as 60/62/63, so keep
# those along with perennial streams or the main rivers disappear.
streams_raw <- read_mn(hydro_gdb, "dnr_rivers_and_streams", query =
  "SELECT * FROM dnr_rivers_and_streams WHERE Strm_type IN (20, 60, 62, 63)")

# Merge segments into one feature per name, then keep the long ones.
# Note: repeated names ("Mud Creek") merge across the state; the length
# filter mostly takes care of that, but check the output.
# Blank names are stored as " " (a space), so trim before filtering.
# st_make_valid() turns zero-length segments into points; extract drops them.
rivers <- streams_raw |>
  st_collection_extract("LINESTRING") |>
  mutate(KITTLE_NAME = trimws(KITTLE_NAME)) |>
  filter(!is.na(KITTLE_NAME), KITTLE_NAME != "",
         !KITTLE_NAME %in% c("Unnamed Stream", "Unnamed Creek")) |>
  group_by(name = KITTLE_NAME) |>
  summarise(.groups = "drop") |>
  st_cast("MULTILINESTRING") |>   # single-segment names come back as LINESTRING
  st_line_merge()

rivers$length_km <- round(as.numeric(st_length(rivers)) / 1000)
rivers <- filter(rivers, length_km >= min_river_km)

# Simplify. If node + mapshaper are installed, add sys = TRUE (much faster).
lakes_web  <- ms_simplify(lakes,  keep = simplify_keep, keep_shapes = TRUE)
rivers_web <- ms_simplify(rivers, keep = simplify_keep, keep_shapes = TRUE)

write_web(lakes_web,  "mn_lakes")
write_web(rivers_web, "mn_rivers")
write_web(select(lake_labels, name, acres), "mn_lake_labels")

# ---- MPCA impaired waters (2024 list) --------------------------------------

imp_gpkg <- get_gpkg(impaired_url, raw_dir)
print(st_layers(imp_gpkg))

# Polygon/line layers only (skip the point and delisted versions)
imp_layers <- find_layers(imp_gpkg, "impaired.*(stream|lake|wetland)",
                          exclude = "point|delist")

# MPCA publishes waters partly or wholly inside reservations as separate
# layers and asks that they be symbolized differently, so keep a flag.
read_impaired <- function(layer) {
  read_mn(imp_gpkg, layer) |>
    mutate(
      src_layer   = layer,
      reservation = case_when(
        grepl("wholly",    layer, ignore.case = TRUE) ~ "wholly",
        grepl("partially", layer, ignore.case = TRUE) ~ "partially",
        TRUE                                          ~ "none"
      ),
      geom_type = if_else(grepl("stream", layer, ignore.case = TRUE), "stream", "lake")
    )
}

impaired <- lapply(imp_layers, read_impaired)

# Flag PFAS impairments by searching every text column (attribute names
# vary by year; PFOS is the parameter MN usually lists)
flag_pfas <- function(x) {
  txt <- st_drop_geometry(x) |> select(where(is.character))
  x$pfas <- apply(txt, 1, function(r) any(grepl("PFOS|PFOA|PFAS|perfluoro", r, ignore.case = TRUE)))
  x
}
impaired <- lapply(impaired, flag_pfas)

imp_streams <- bind_rows(Filter(\(x) x$geom_type[1] == "stream", impaired))
imp_lakes   <- bind_rows(Filter(\(x) x$geom_type[1] == "lake",   impaired))

# Inspect the columns once, then trim to what the map needs
message("Impaired stream columns: ", paste(names(imp_streams), collapse = ", "))

slim <- function(x) {
  nm <- name_column(x)
  x |> transmute(name = .data[[nm]], pfas, reservation)
}

write_web(ms_simplify(slim(imp_streams), keep = simplify_keep, keep_shapes = TRUE),
          "mn_impaired_streams")
write_web(ms_simplify(slim(imp_lakes),   keep = simplify_keep, keep_shapes = TRUE),
          "mn_impaired_lakes")

message("PFAS-impaired: ", sum(imp_streams$pfas), " stream reaches, ",
        sum(imp_lakes$pfas), " lakes/wetlands")