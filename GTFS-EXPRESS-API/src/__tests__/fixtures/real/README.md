# Real GTFS feeds used as test fixtures

Unmodified open-data feeds, used to test the transformation engine on real
networks (several services per weekday, school periods, variants, blocks).
They are redistributed here under their own licences, with attribution:

| File | Network | Publisher | Source | Licence | SHA-256 |
|---|---|---|---|---|---|
| `albi-libea-urbain.zip` | libéA Urbain — réseau urbain du Grand Albigeois (Albi, France), 10 lines, 1,890 trips, valid 2026-08-31 → 2027-07-03 | Communauté d'agglomération de l'Albigeois | https://transport.data.gouv.fr/datasets/offre-de-transports-du-grand-albigeois-gtfs (resource 79687, file of 2026-09-18) | Open Database License (ODbL) 1.0 — https://opendatacommons.org/licenses/odbl/1-0/ | `d1c4ecfde4700c55a7228e66954faee4e247c4c8c4578073c2061e0e423ba3ee` |
| `vernon-sngo.zip` | SNgo! — Vernon / Les Andelys / Seine Normandie Agglomération (France), 12 lines, 1,605 trips, real vehicle blocks | Syndicat mixte Atoumod | https://transport.data.gouv.fr/datasets/sngo-vernon-les-andelys-seine-normandie-agglo (resource 80655) | Licence Ouverte / Open Licence 2.0 (Etalab) — https://www.etalab.gouv.fr/licence-ouverte-open-licence/ | `4946854f45dabc0b6235e144b355ba4d4f4c8c897a6b89d94c690f283d10aeeb` |

MobilityData canonical validator 8.0.0 (`-c FR`): 0 errors on both
(albi: 4 expired early-September services, missing contact, one stop with
the same name and description; vernon: missing timepoint values, mixed case,
no feed_info).

Any database derived from `albi-libea-urbain.zip` and made public must be
shared under the ODbL, with the attribution above.
