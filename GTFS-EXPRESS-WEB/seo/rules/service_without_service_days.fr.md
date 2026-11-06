---
title: "service_without_service_days : service qui ne circule aucun jour"
description: Un service de calendar.txt a tous ses jours à 0 et aucune date ajoutée dans calendar_dates.txt, ses courses ne circulent donc jamais. Causes et correction.
updated: 2026-10-21
---

## Ce que signifie cette règle

Dans `calendar.txt`, chaque `service_id` indique les jours de la semaine où il circule (`monday` à `sunday`, `1` ou `0`) entre `start_date` et `end_date`. Les exceptions de `calendar_dates.txt` ajoutent une date (`exception_type` = `1`) ou en retirent une (`exception_type` = `2`). La règle se déclenche quand un service a ses sept jours à `0` et qu'aucune exception ne lui ajoute de date : il ne circule aucun jour.

Sévérité : **erreur**.

## Pourquoi c'est important

Toutes les courses de `trips.txt` qui portent ce `service_id` disparaissent des horaires publiés. Si ces courses ont un sens (un service de jours fériés, un service de vacances), l'offre réelle est incomplète ; sinon, le flux contient des données mortes qui gênent la lecture et la maintenance.

## Causes fréquentes

- Un service défini seulement par ses dates, dont les exceptions de `calendar_dates.txt` ont été perdues ou rattachées à un autre `service_id`.
- Un service désactivé en mettant ses jours à `0` au lieu de le supprimer.
- Un service de jours fériés ou de vacances dont les dates n'ont pas été reportées d'une année sur l'autre.
- Une erreur de casse ou d'espace entre le `service_id` de `calendar.txt` et celui de `calendar_dates.txt`.

## Comment la corriger

Décidez si le service doit circuler. S'il le doit, cochez les bons jours dans `calendar.txt` ou ajoutez ses dates dans `calendar_dates.txt` avec `exception_type` = `1`. S'il ne sert plus, supprimez-le de `calendar.txt` avec les courses qui l'utilisent (et leurs `stop_times`), ou rattachez ces courses à un service qui circule. Un service défini uniquement par des dates peut aussi vivre sans ligne dans `calendar.txt`, seulement dans `calendar_dates.txt`.

Dans GTFS Express, le rapport de validation désigne le `service_id` en cause. « Corriger un par un » ouvre la ligne de `calendar.txt` dans l'éditeur ; chaque modification est une retouche du brouillon, puis « Revalider » confirme que le service circule.

## Exemple

```
service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
FERIE,0,0,0,0,0,0,0,20260901,20270831
```

Aucune ligne `FERIE` dans `calendar_dates.txt`. Ajouter les jours fériés de la période corrige l'erreur :

```
service_id,date,exception_type
FERIE,20261101,1
FERIE,20261111,1
FERIE,20261225,1
```

Voir aussi le guide [Vacances scolaires et jours fériés dans un GTFS](/guides/vacances-scolaires-et-jours-feries-dans-un-gtfs).
