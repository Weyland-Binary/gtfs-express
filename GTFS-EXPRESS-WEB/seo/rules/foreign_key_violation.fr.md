---
title: "foreign_key_violation : référence introuvable dans un autre fichier"
description: Un identifiant cité dans un fichier GTFS n'existe pas dans le fichier qu'il désigne. Causes, conséquences et correction de foreign_key_violation.
updated: 2026-10-21
---

## Ce que signifie cette règle

Un champ qui renvoie à la clé primaire d'un autre fichier contient une valeur introuvable dans ce fichier. Par exemple, `trips.txt` cite un `route_id` absent de `routes.txt`, `stop_times.txt` cite un `stop_id` absent de `stops.txt`, ou un `service_id` de `trips.txt` n'apparaît ni dans `calendar.txt` ni dans `calendar_dates.txt`. Le même contrôle porte sur `agency_id`, `shape_id`, `parent_station`, `fare_id` et les autres références de la spécification.

Sévérité : **erreur**. Le validateur de MobilityData la signale avec le même code.

## Pourquoi c'est important

Une référence cassée rend la donnée inexploitable à cet endroit. Un calculateur d'itinéraire ne sait pas à quelle ligne rattacher une course dont le `route_id` est inconnu, ni où placer un passage dont l'arrêt n'existe pas. Selon l'outil, l'enregistrement fautif est ignoré en silence ou le flux entier est refusé.

## Causes fréquentes

- Un arrêt, une ligne ou un service supprimé dans un fichier sans nettoyer les fichiers qui le citent.
- Un identifiant renommé d'un côté seulement.
- Des fichiers exportés à des dates différentes, puis assemblés dans une même archive.
- Une différence invisible : espace en fin de valeur, casse différente (`L1` et `l1`), zéro initial perdu par un tableur (`0042` devenu `42`).

## Comment la corriger

Pour chaque occurrence, décidez de quel côté se trouve l'erreur. Si la cible a disparu par erreur, recréez la ligne manquante dans le fichier cible (`routes.txt`, `stops.txt`, `calendar.txt`...). Si la référence est fausse, remplacez la valeur par un identifiant existant. Si la ligne qui cite n'a plus de raison d'être, supprimez-la, avec ses dépendances (une course supprimée emporte ses `stop_times`).

Dans GTFS Express, ouvrez le rapport de validation : chaque occurrence indique le fichier, la ligne, le champ et la valeur. « Corriger un par un » ouvre chaque ligne fautive dans l'éditeur, le champ signalé. Chaque correction est une retouche du brouillon ; « Revalider » relance ensuite le validateur.

## Exemple

`trips.txt` cite la ligne `L7`, qui n'existe pas dans `routes.txt` :

```
route_id,service_id,trip_id
L1,SEM,T1001
L7,SEM,T7001
```

```
route_id,route_short_name,route_type
L1,1,3
L2,2,3
```

Si la course appartient en réalité à la ligne 2, la correction porte sur `trips.txt` :

```
route_id,service_id,trip_id
L1,SEM,T1001
L2,SEM,T7001
```

Voir aussi le guide [Valider un GTFS](/guides/valider-un-gtfs).
