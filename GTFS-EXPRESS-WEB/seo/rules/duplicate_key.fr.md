---
title: "duplicate_key : clé primaire en double dans un fichier GTFS"
description: Deux lignes d'un même fichier GTFS portent la même clé primaire. Ce que signifie duplicate_key, ses causes habituelles et la façon de le corriger.
updated: 2026-10-21
---

## Ce que signifie cette règle

Chaque fichier GTFS a une clé primaire qui doit être unique : `stop_id` dans `stops.txt`, `route_id` dans `routes.txt`, `trip_id` dans `trips.txt`, `service_id` dans `calendar.txt`. Certains fichiers ont une clé composée de plusieurs champs : `trip_id` et `stop_sequence` dans `stop_times.txt`, `service_id` et `date` dans `calendar_dates.txt`, `shape_id` et `shape_pt_sequence` dans `shapes.txt`. La règle se déclenche quand deux lignes partagent la même clé.

Sévérité : **erreur**.

## Pourquoi c'est important

Une référence vers une clé en double est ambiguë : une course qui cite `route_id` `L3` ne dit pas laquelle des deux lignes `L3` elle suit. Les outils qui consomment le flux gardent en général la première ou la dernière ligne et ignorent l'autre, sans prévenir. Dans `stop_times.txt`, deux passages avec le même `stop_sequence` rendent l'ordre des arrêts indéterminé.

## Causes fréquentes

- Deux exports concaténés (deux périodes, deux exploitants) sans renumérotation.
- Une ligne copiée pour en créer une variante, dont l'identifiant n'a pas été changé.
- Un `stop_sequence` resaisi à la main après l'insertion d'un arrêt.
- Une exception de `calendar_dates.txt` saisie deux fois pour la même date, parfois avec deux `exception_type` contradictoires.

## Comment la corriger

Comparez les lignes en double. Si elles sont identiques, supprimez-en une. Si elles décrivent deux objets différents, donnez un nouvel identifiant à l'une et mettez à jour toutes les références qui doivent la viser (`trips.txt`, `stop_times.txt`...). Pour `stop_times.txt`, renumérotez `stop_sequence` dans l'ordre réel de passage. Pour `calendar_dates.txt`, gardez l'exception qui correspond au service voulu ce jour-là.

Dans GTFS Express, le rapport de validation liste chaque occurrence avec son fichier et sa ligne. « Corriger un par un » ouvre les lignes concernées dans l'éditeur ; chaque modification devient une retouche du brouillon, puis « Revalider » confirme que le doublon a disparu.

## Exemple

Deux arrêts différents portent le même `stop_id` :

```
stop_id,stop_name,stop_lat,stop_lon
S100,Gare,49.8920,2.3070
S100,Hôtel de Ville,49.8945,2.2990
```

Après correction, le second reçoit un identifiant libre, et les `stop_times` qui le desservent sont mis à jour :

```
stop_id,stop_name,stop_lat,stop_lon
S100,Gare,49.8920,2.3070
S101,Hôtel de Ville,49.8945,2.2990
```

Voir aussi la [liste des règles de validation](/regles).
