---
title: "missing_required_field : champ obligatoire vide dans un GTFS"
description: Un champ que la spécification GTFS rend obligatoire est vide sur une ligne du fichier. Ce que signale missing_required_field et comment le remplir.
updated: 2026-10-21
---

## Ce que signifie cette règle

La colonne existe dans le fichier, mais une ou plusieurs lignes la laissent vide alors que la spécification GTFS Schedule impose une valeur. Exemples : `agency_name` dans `agency.txt`, `stop_id` dans `stops.txt`, `route_id` ou `trip_id` dans `trips.txt`, `stop_sequence` dans `stop_times.txt`. Certains champs ne sont obligatoires que sous condition : `stop_lat` et `stop_lon` le sont pour les arrêts et les stations (`location_type` 0 ou 1, ou vide), pas pour un nœud générique.

Sévérité : **erreur**.

## Pourquoi c'est important

Un champ obligatoire porte une information sans laquelle l'objet n'a pas de sens : une course sans `route_id` n'appartient à aucune ligne, un passage sans `stop_sequence` ne peut pas être ordonné, un arrêt sans coordonnées ne peut pas être placé sur une carte. Les consommateurs du flux écartent souvent la ligne entière.

## Causes fréquentes

- Un export qui écrit l'en-tête de la colonne mais pas les valeurs, par exemple quand la source ne connaît pas l'information.
- Un tableur qui vide une cellule (formule supprimée, collage partiel).
- Une ligne ajoutée à la main en oubliant un champ.
- Un champ conditionnel mal compris, par exemple un `location_type` changé sans compléter les coordonnées.

## Comment la corriger

Renseignez la valeur manquante sur chaque ligne signalée, dans le fichier et le champ indiqués. Si la valeur n'est pas connue, retrouvez-la dans la source de l'exploitant plutôt que d'inventer un contenu qui passerait la validation. Si la ligne entière est un reste sans objet, supprimez-la avec ce qui en dépend.

Dans GTFS Express, chaque occurrence du rapport donne le fichier, la ligne et le champ vide. « Corriger un par un » ouvre la ligne dans l'éditeur avec le champ signalé ; vous saisissez la valeur, ce qui crée une retouche dans le brouillon. « Revalider » vérifie ensuite qu'aucune occurrence ne reste.

## Exemple

La deuxième course n'a pas de `route_id` :

```
route_id,service_id,trip_id,direction_id
L1,SEM,T1001,0
,SEM,T1002,1
```

Corrigée :

```
route_id,service_id,trip_id,direction_id
L1,SEM,T1001,0
L1,SEM,T1002,1
```

Voir aussi le guide [Valider un GTFS](/guides/valider-un-gtfs).
