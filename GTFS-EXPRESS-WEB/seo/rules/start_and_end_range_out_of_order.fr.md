---
title: "start_and_end_range_out_of_order : début après la fin d'une plage"
description: Dans frequencies.txt, le start_time d'une plage de fréquence est égal ou postérieur à son end_time. Ce que signale cette erreur GTFS et comment la corriger.
updated: 2026-10-21
---

## Ce que signifie cette règle

`frequencies.txt` décrit des courses à fréquence plutôt qu'à horaires fixes : pour un `trip_id`, une plage de `start_time` à `end_time` et un intervalle `headway_secs` entre deux départs. Une plage doit commencer avant de finir. Le catalogue de GTFS Express décrit le cas de `frequencies.txt` : la règle se déclenche quand `start_time` est supérieur ou égal à `end_time`. Le validateur de MobilityData emploie le même code pour les plages de dates dont le début suit la fin, dans `calendar.txt` et `feed_info.txt`.

Sévérité : **erreur**.

## Pourquoi c'est important

Une plage inversée ou vide ne produit aucun départ. Les courses que la fréquence devait générer manquent dans les horaires, ou l'outil qui lit le flux rejette la ligne. Sur une ligne à haute fréquence, c'est souvent toute une partie de la journée qui disparaît.

## Causes fréquentes

- Une plage qui passe minuit écrite `22:00:00` à `01:00:00` au lieu de `22:00:00` à `25:00:00`.
- Les deux colonnes inversées lors d'une saisie ou d'une conversion.
- Une heure de fin égale à l'heure de début, quand une plage a été raccourcie jusqu'à disparaître sans être supprimée.
- Une heure mal convertie par un tableur (voir [invalid_time](/regles/invalid_time)).

## Comment la corriger

Dans `frequencies.txt`, corrigez `start_time` ou `end_time` pour que la plage commence avant de finir. Une plage qui se prolonge après minuit garde des heures au-delà de 24 sur le même jour de service. Une plage vide qui n'a plus d'objet se supprime. Vérifiez au passage que les plages d'un même `trip_id` ne se chevauchent pas.

Dans GTFS Express, chaque occurrence du rapport désigne la ligne de `frequencies.txt` en cause. « Corriger un par un » l'ouvre dans l'éditeur, le champ signalé ; la correction devient une retouche du brouillon, puis « Revalider » relance le validateur.

## Exemple

```
trip_id,start_time,end_time,headway_secs
T_SOIR,20:00:00,22:00:00,900
T_NUIT,22:00:00,01:00:00,1800
```

Corrigé :

```
trip_id,start_time,end_time,headway_secs
T_SOIR,20:00:00,22:00:00,900
T_NUIT,22:00:00,25:00:00,1800
```

Voir aussi la [liste des règles de validation](/regles).
