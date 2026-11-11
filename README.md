# Little-Known Texas Markers

A personal tracker for Texas historical markers and county courthouses: map, "near me", search, visits, photos, notes, and story leads for the *Little-Known Texas* novellas.

- **Hosting:** GitHub Pages (static files, nothing to build).
- **Sync:** Supabase project `roped-in-ranch` — table `lkt_logs` and private storage bucket `lkt-photos`, each row/photo locked to the signed-in user.
- **Sign-in:** the same family Roper Supabase account used by the other family apps.

## Data
Marker and courthouse data courtesy of the **Texas Historical Commission**, Texas Historic Sites Atlas (atlas.thc.texas.gov), downloaded Nov 10, 2026.

- `data/markers.json` — slim index of all 17,373 markers (name, GPS, county, town, year, flags)
- `data/text/<county>.json` — full inscriptions and details, loaded one county at a time
- `data/courthouses.json` — all 820 courthouses in THC's records (278 with map pins)

To refresh the data later, download new copies of the Historical Markers GIS file + Raw Data CSV (and the Courthouse ones) and rerun the processing script.
