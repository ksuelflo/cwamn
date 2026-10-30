# ==============================================================================
# 04_pfas.R — MDH PFAS results for ALL tested community water systems
#   - purchased-water systems inherit results from the system they buy from
#   - long format: one row per system per compound
#   - per-system summary + color category for the map
#
# Outputs: data/pfas_all.geojson, data/pfas_long.json
# ==============================================================================

library(tidyverse)
library(sf)
library(httr2)
library(jsonlite)

if (!exists("DATA_DIR")) DATA_DIR <- "data"

# EPA MCLs (ng/L). Hazard Index limit is 1 and comes from the `hi` column.
MCL <- c(PFOA = 4, PFOS = 4, PFHXS = 10, PFNA = 10, `HFPO-DA` = 10)

result_cols <- c("any_detections", "hi", "min_hi", "hi_text",
                 "mcl_detect_text", "mcl_status_text", "mcl_update_date")

# ---- 1. Fetch every tested system --------------------------------------------

pfas_url <- "https://services1.arcgis.com/RQG3sksSXcoDoIfj/arcgis/rest/services/PFAS_Unified_Feature_Layer/FeatureServer/0/query"

resp <- request(pfas_url) |>
  req_url_query(
    where = "pfas_tested = 'Tested'",
    outFields = paste(
      "pwsid", "name", "loc_city", "county", "pop_serv", "primary_source_type",
      "buys_from_pwsid", "any_detections",
      "hi", "min_hi", "hi_text", "mcl_detect_text", "mcl_status_text", "mcl_update_date",
      sep = ","
    ),
    outSR = 4326,
    f = "geojson"
  ) |>
  req_perform()

pfas_raw <- st_read(resp_body_string(resp), quiet = TRUE) |>
  mutate(mcl_update_date = as.Date(as.POSIXct(mcl_update_date / 1000, origin = "1970-01-01", tz = "UTC")))

# ---- 2. Purchased-water systems inherit their seller's results ---------------

# Seller results, prefixed with s_ so they don't collide with the buyer's columns
sellers <- pfas_raw |>
  st_drop_geometry() |>
  select(pwsid, seller_name = name, all_of(result_cols)) |>
  rename_with(\(x) paste0("s_", x), all_of(result_cols))

# Fallback for rows with no seller ID: match the name from the "See X for results" text
name_to_id <- sellers |>
  distinct(seller_name, .keep_all = TRUE) |>
  select(seller_name, name_pwsid = pwsid)

pfas_all <- pfas_raw |>
  mutate(
    purchases_from_text = str_match(mcl_detect_text, "See<br/>(.*?)<br/>for results")[, 2] |>
      str_replace_all("<br/>", " ") |>
      str_squish(),
    purchased = !is.na(purchases_from_text) | coalesce(str_detect(buys_from_pwsid, "\\d"), FALSE)
  ) |>
  left_join(name_to_id, by = c("purchases_from_text" = "seller_name")) |>
  mutate(seller_pwsid = if_else(purchased,
                                coalesce(str_extract(buys_from_pwsid, "\\d{7}"), name_pwsid),
                                NA_character_)) |>
  left_join(sellers, by = c("seller_pwsid" = "pwsid"))

# Copy the seller's results into the buyer's columns (only for purchasers with a matched seller)
for (col in result_cols) {
  seller_val <- pfas_all[[paste0("s_", col)]]
  pfas_all[[col]] <- if_else(pfas_all$purchased & !is.na(seller_val), seller_val, pfas_all[[col]])
}

pfas_all <- pfas_all |>
  select(-starts_with("s_"), -name_pwsid, -purchases_from_text) |>
  rename(purchases_from = seller_name)

# Check: purchasers whose seller couldn't be matched (or whose seller is itself a purchaser)
pfas_all |>
  st_drop_geometry() |>
  filter(purchased, is.na(mcl_detect_text) | str_detect(coalesce(mcl_detect_text, ""), "for results")) |>
  select(pwsid, name, buys_from_pwsid, purchases_from) |>
  print()

# ---- 3. Long format: one row per system per compound -------------------------

pfas_long <- pfas_all |>
  st_drop_geometry() |>
  select(pwsid, name, mcl_detect_text) |>
  separate_longer_delim(mcl_detect_text, delim = "<br/>") |>
  filter(str_starts(mcl_detect_text, "<b>")) |>              # drop footnotes and text-only lines
  mutate(
    analyte      = str_match(mcl_detect_text, "<b>(.*?)</b>")[, 2],
    min_ngl      = as.numeric(str_match(mcl_detect_text, "&nbsp;([0-9.]+)")[, 2]),
    max_ngl      = as.numeric(str_match(mcl_detect_text, "([0-9.]+) ng/L")[, 2]),
    min_below_rl = str_detect(mcl_detect_text, fixed("<sup>(1)</sup>")),
    exceeds_mcl  = str_detect(mcl_detect_text, fixed("(**)")),
    mcl_ngl      = unname(MCL[str_to_upper(analyte)]),
    mcl_ratio    = round(max_ngl / mcl_ngl, 2)              # NA for compounds without an MCL
  ) |>
  select(-mcl_detect_text)

# ---- 4. Per-system summary + color category ----------------------------------

system_summary <- pfas_long |>
  group_by(pwsid) |>
  summarise(
    n_compounds_detected = n_distinct(analyte),
    worst_ratio = if (all(is.na(mcl_ratio))) NA_real_ else max(mcl_ratio, na.rm = TRUE),
    worst_compound = if (all(is.na(mcl_ratio))) NA_character_ else analyte[which.max(mcl_ratio)],
    compounds_over_mcl = paste(analyte[exceeds_mcl], collapse = " + "),
    .groups = "drop"
  )

pfas_all <- pfas_all |>
  left_join(system_summary, by = "pwsid") |>
  mutate(
    n_compounds_detected = coalesce(n_compounds_detected, 0L),
    # Overall ratio to the limit: worst single compound, or the Hazard Index (limit = 1)
    overall_ratio = pmax(worst_ratio, hi, na.rm = TRUE),
    above_mcl = mcl_status_text %in% "PFAS levels above MCL",
    pfas_category = case_when(
      n_compounds_detected == 0 & !above_mcl ~ "Not detected",
      above_mcl & overall_ratio >= 2         ~ "Above limit (2x or more)",
      above_mcl                              ~ "Above limit",
      overall_ratio >= 0.5                   ~ "Approaching limit",
      TRUE                                   ~ "Detected, below half the limit"
    ),
    pfas_category = factor(pfas_category, levels = c(
      "Not detected", "Detected, below half the limit", "Approaching limit",
      "Above limit", "Above limit (2x or more)"
    ))
  )

print(count(st_drop_geometry(pfas_all), pfas_category, purchased))

# ---- 5. Write ----------------------------------------------------------------

pfas_all |>
  select(-mcl_detect_text) |>                       # the parsed long table replaces this HTML
  mutate(pfas_category = as.character(pfas_category),
         mcl_update_date = as.character(mcl_update_date)) |>
  st_write(file.path(DATA_DIR, "pfas_all.geojson"),
           layer_options = "COORDINATE_PRECISION=5", delete_dsn = TRUE, quiet = TRUE)

write_json(pfas_long, file.path(DATA_DIR, "pfas_long.json"), dataframe = "rows", na = "null", digits = NA)

message("PFAS: ", nrow(pfas_all), " systems")
