---
title: Ajouter un arrêt sur une ligne dans un GTFS
description: Créer l'arrêt dans stops.txt, l'insérer dans stop_times avec la bonne séquence et des horaires cohérents, dans les deux sens, puis vérifier tracé et validation.
updated: 2026-10-21
slug: ajouter-un-arret-dans-un-gtfs
---

Ajouter un arrêt sur une ligne, c'est créer l'arrêt dans `stops.txt` s'il n'existe pas, puis insérer un passage dans `stop_times.txt` pour chaque course concernée, avec un `stop_sequence` placé entre ceux des arrêts voisins et des horaires compris entre les leurs. Les deux sens se traitent séparément, et le tracé doit passer près du nouvel arrêt.

## Créer l'arrêt dans stops.txt

Un nouvel arrêt demande au minimum :

- `stop_id` : un identifiant nouveau, dans le style de ceux du réseau.
- `stop_name` : le nom affiché aux voyageurs, écrit comme les autres (casse, abréviations).
- `stop_lat` et `stop_lon` : la position en degrés décimaux WGS84.
- `location_type` : 0 ou vide pour un arrêt ou un quai, le seul type où une course peut s'arrêter.

Reprenez aussi les attributs que portent les arrêts voisins : `zone_id` si le réseau a des zones tarifaires, `wheelchair_boarding`, `stop_code` si les voyageurs voient un code.

La plupart des réseaux urbains ont un quai par sens, de part et d'autre de la chaussée, regroupés sous une station (`location_type` 1) par `parent_station`. Si le réseau procède ainsi, faites de même :

```
stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station,wheelchair_boarding
MAIRIE,Mairie,49.89412,2.29573,1,,
MAIRIE_A,Mairie,49.89418,2.29561,0,MAIRIE,1
MAIRIE_R,Mairie,49.89405,2.29586,0,MAIRIE,1
```

La station n'a pas de `parent_station` et aucune course ne s'y arrête : les passages vont aux quais.

## Placer l'arrêt au bon endroit

Les coordonnées ne s'inventent pas. Elles viennent d'un relevé, du cahier des charges, d'un dossier de travaux ou de la personne qui connaît le terrain. Placez chaque quai du côté de la voie où le véhicule s'arrête dans ce sens.

Un arrêt trop éloigné du tracé de ses courses déclenche l'avertissement [stop_too_far_from_shape](/regles/stop_too_far_from_shape), au-delà d'un seuil qui dépend de la configuration du validateur (100 m par défaut). Si l'arrêt est sur l'itinéraire actuel, le tracé n'a pas à changer. S'il impose un nouvel itinéraire, le tracé doit suivre (voir plus bas).

## Insérer le passage dans stop_times

Pour chaque course de la ligne qui passera par le nouvel arrêt, repérez les deux passages voisins, celui d'avant et celui d'après, puis :

1. Donnez au nouveau passage un `stop_sequence` compris entre les leurs. S'il n'y a pas de place (5 et 6), renumérotez les passages suivants de la course : la séquence doit croître, sans être consécutive.
2. Calculez les horaires entre ceux des voisins, au prorata de la distance. Si le voisin d'avant part à 07:12:00, celui d'après arrive à 07:16:00 et le nouvel arrêt est à 40 % de la distance, le passage tombe à 07:13:36, soit 07:14:00 si le réseau publie à la minute.
3. Gardez `arrival_time` égal à `departure_time` sauf si le réseau prévoit un temps d'arrêt.

Avant :

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence
T101,07:12:00,07:12:00,GARE_A,5
T101,07:16:00,07:16:00,HOPITAL_A,6
```

Après :

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence
T101,07:12:00,07:12:00,GARE_A,5
T101,07:14:00,07:14:00,MAIRIE_A,6
T101,07:16:00,07:16:00,HOPITAL_A,7
```

Si le réseau laisse les arrêts intermédiaires sans horaires (`timepoint` à 0, horaires vides), vous pouvez faire de même pour le nouveau passage. Le premier et le dernier passage d'une course restent toujours horodatés.

Une renumérotation a un coût : un flux temps réel qui cite `stop_sequence` doit suivre la même numérotation. Prévenez qui le produit.

## Les deux sens et toutes les courses concernées

Le sens retour est une autre série de courses (`direction_id`), avec un autre quai, des voisins dans l'ordre inverse et d'autres horaires. Traitez-le comme un second changement.

Une ligne a souvent plusieurs parcours : services partiels, variantes scolaires, courses express. Listez les parcours qui passent entre les deux voisins et décidez pour chacun. Une course qui ne dessert pas l'un des voisins n'a pas les mêmes points d'insertion.

Décidez aussi des jours. Si l'arrêt ouvre à une date donnée, ou seulement pendant des travaux, les courses ne se modifient pas en place : on crée un service pour ces dates et on y copie les courses, comme décrit dans [Modifier un GTFS](/guides/modifier-un-gtfs).

## shape_dist_traveled et le tracé

Si le jeu renseigne `stop_times.shape_dist_traveled`, remplissez-le pour le nouveau passage : la distance le long du tracé, depuis son début jusqu'à la projection de l'arrêt, dans la même unité que `shapes.shape_dist_traveled`. La valeur doit être strictement comprise entre celles des voisins, sinon le validateur signale [decreasing_or_equal_stop_time_distance](/regles/decreasing_or_equal_stop_time_distance).

Si l'arrêt impose un détour, le tracé change. S'il est partagé avec des courses qui ne changent pas, copiez-le sous un nouveau `shape_id`, modifiez la copie et rattachez-y les courses concernées.

## Vérifier

- Chaque course concernée dessert le nouvel arrêt, dans les deux sens et aux bonnes dates. Les autres courses n'ont pas changé.
- Les horaires ne reculent pas : aucune occurrence de [stop_time_with_arrival_before_previous_departure_time](/regles/stop_time_with_arrival_before_previous_departure_time).
- Des temps de parcours trop serrés autour du nouvel arrêt déclenchent [fast_travel_between_consecutive_stops](/regles/fast_travel_between_consecutive_stops).
- Un quai créé mais jamais desservi déclenche [stop_without_stop_time](/regles/stop_without_stop_time).
- Le rapport du validateur ne contient aucune nouvelle erreur par rapport au jeu d'origine.
- Sur une carte, l'arrêt est sur le tracé ; dans la grille d'un jour de semaine, son horaire tombe entre ceux de ses voisins.

Dans GTFS Express, l'ajout se fait dans un brouillon, à la main dans le lecteur ou à partir d'un cahier des charges. Dans ce second cas, si la position du nouvel arrêt n'est pas donnée, l'agent pose la question au lieu de la deviner.

## Pour aller plus loin

- [Modifier un GTFS](/guides/modifier-un-gtfs)
- [Valider un GTFS](/guides/valider-un-gtfs)
- [Du cahier des charges au GTFS](/guides/du-cahier-des-charges-au-gtfs)
