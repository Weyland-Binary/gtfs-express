---
title: "stop_time_with_arrival_before_previous_departure_time : temps négatif"
description: Dans une course, l'heure d'arrivée à un arrêt précède l'heure de départ de l'arrêt précédent. Causes de cette erreur GTFS et correction des horaires.
updated: 2026-10-21
---

## Ce que signifie cette règle

Dans `stop_times.txt`, les passages d'une même course sont ordonnés par `stop_sequence`. Un véhicule ne peut pas arriver à un arrêt avant d'être parti du précédent : l'`arrival_time` d'un passage doit être supérieure ou égale au `departure_time` du passage qui le précède. La règle se déclenche quand elle est strictement inférieure. Les passages sans horaire (arrêts intermédiaires non horodatés) sont sautés : la comparaison se fait avec le dernier passage qui porte une heure.

Sévérité : **erreur**.

## Pourquoi c'est important

Un temps de parcours négatif rend la course incohérente. Les calculateurs d'itinéraire peuvent proposer des correspondances impossibles, afficher des horaires dans le désordre ou écarter la course. Dans le rapport, cette erreur va souvent avec d'autres signalements sur la même course.

## Causes fréquentes

- Des heures après minuit écrites `00:10:00` au lieu de `24:10:00` sur une course commencée la veille.
- Une valeur de `stop_sequence` qui ne suit pas l'ordre réel de passage, par exemple après l'insertion d'un arrêt.
- Une faute de frappe sur une heure (`08:15` saisi `07:15`).
- Une course décalée à la main sur une partie de ses arrêts seulement.

## Comment la corriger

Ouvrez la course entière dans `stop_times.txt`, triée par `stop_sequence`, et cherchez où les heures reculent. Corrigez l'heure fausse, ou remettez `stop_sequence` dans l'ordre réel si ce sont les arrêts qui sont mal rangés. Pour une course qui passe minuit, toutes les heures après minuit dépassent 24.

Dans GTFS Express, chaque occurrence du rapport désigne la course et le passage. « Corriger un par un » ouvre le passage dans l'éditeur, le champ signalé. Chaque correction est une retouche du brouillon, puis « Revalider » confirme le résultat.

## Exemple

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence
T2240,23:52:00,23:52:00,S100,1
T2240,23:58:00,23:58:00,S110,2
T2240,00:04:00,00:04:00,S120,3
```

Corrigé :

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence
T2240,23:52:00,23:52:00,S100,1
T2240,23:58:00,23:58:00,S110,2
T2240,24:04:00,24:04:00,S120,3
```

Voir aussi la [liste des règles de validation](/regles).
