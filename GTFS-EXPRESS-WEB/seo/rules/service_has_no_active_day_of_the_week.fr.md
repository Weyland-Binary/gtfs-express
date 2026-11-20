---
title: "service_has_no_active_day_of_the_week : service sans jour de la semaine"
description: Un service de calendar.txt a ses sept jours de la semaine à 0. Ce que signale le validateur, quand c'est voulu, et comment corriger.
updated: 2026-11-13
---

## Ce que signifie cette règle

Dans `calendar.txt`, chaque `service_id` indique les jours de la semaine où il circule (`monday` à `sunday`, `1` ou `0`) entre `start_date` et `end_date`. La règle se déclenche quand une ligne de `calendar.txt` a ses sept jours à `0` : par ses jours de la semaine, le service ne circule jamais.

Pour cette règle, le validateur lit `calendar.txt` seul. Il la signale même quand `calendar_dates.txt` ajoute des dates au service (`exception_type` = `1`).

Sévérité : **avertissement**.

## Pourquoi c'est important

Un avertissement ne bloque pas la livraison dans GTFS Express. Mais si aucune date n'est ajoutée au service dans `calendar_dates.txt`, toutes les courses de `trips.txt` qui portent ce `service_id` disparaissent des horaires publiés. Et si le service ne vit que par ses dates, sa ligne de `calendar.txt` n'apporte rien et laisse un doute à qui relit le fichier.

## Causes fréquentes

- Un service désactivé en mettant ses jours à `0` au lieu de le supprimer.
- Un service défini par ses dates (jours fériés, vacances) qui a gardé une ligne sans jour dans `calendar.txt`.
- Un service dont les dates de `calendar_dates.txt` ont été perdues ou rattachées à un autre `service_id`.

## Comment la corriger

Décidez si le service doit circuler. S'il circule certains jours de la semaine, mettez ces jours à `1` dans `calendar.txt`. S'il ne circule qu'à des dates données, gardez ses dates dans `calendar_dates.txt` et supprimez sa ligne de `calendar.txt` : un service peut exister par ses seules dates. S'il ne sert plus, supprimez-le avec les courses qui l'utilisent (et leurs `stop_times`), ou rattachez ces courses à un service qui circule.

Dans GTFS Express, le rapport de validation désigne le `service_id` en cause. « Corriger un par un » ouvre la ligne de `calendar.txt` dans l'éditeur ; chaque modification est une retouche du brouillon, puis « Revalider » relance le validateur.

## Exemple

```
service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
FERIE,0,0,0,0,0,0,0,20260901,20270831
```

Le service `FERIE` circule les jours fériés, que donne `calendar_dates.txt` :

```
service_id,date,exception_type
FERIE,20261101,1
FERIE,20261111,1
FERIE,20261225,1
```

Ces dates suffisent à définir le service. Une fois la ligne `FERIE` supprimée de `calendar.txt`, l'avertissement disparaît et le service circule aux mêmes dates.

Voir aussi le guide [Vacances scolaires et jours fériés dans un GTFS](/guides/vacances-scolaires-et-jours-feries-dans-un-gtfs).
