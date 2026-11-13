---
title: "mixed_case_recommended_field : nom tout en majuscules"
description: Un nom affiché aux voyageurs (stop_name, route_long_name, trip_headsign) est écrit tout en majuscules ou tout en minuscules. Pourquoi le corriger et comment.
updated: 2026-10-21
---

## Ce que signifie cette règle

Certains champs du GTFS sont lus tels quels par les voyageurs : le nom d'un arrêt (`stop_name`), le nom long d'une ligne (`route_long_name`), la destination affichée d'une course (`trip_headsign`). Les bonnes pratiques demandent de les écrire en casse mixte, avec majuscules et minuscules comme dans un texte ordinaire. Quand un de ces champs est entièrement en majuscules ou entièrement en minuscules, le validateur lève cet avertissement. Sévérité : **avertissement**.

## Pourquoi c'est important

Un avertissement ne bloque pas la livraison dans GTFS Express. Le risque est pour le voyageur : un texte en capitales se lit moins vite sur un écran d'application ou un panneau d'information, et certaines synthèses vocales épellent un mot en majuscules au lieu de le prononcer, ce qui gêne les personnes qui naviguent avec un lecteur d'écran. Les réutilisateurs, eux, ne peuvent pas rétablir la bonne casse automatiquement sans abîmer les sigles.

## Causes fréquentes

- Les noms viennent d'un ancien système d'exploitation qui n'acceptait que les majuscules.
- Les arrêts ont été saisis pour un afficheur embarqué limité en caractères.
- Une conversion de fichier a mis tout le texte en majuscules.

## Comment la corriger

Réécrivez chaque valeur en casse mixte dans le fichier concerné, en gardant les sigles en capitales (`SNCF`, `CHU`, `ZA`) et les règles typographiques de la langue. Une conversion automatique en « Première Lettre Majuscule » est un bon point de départ, mais relisez le résultat : elle transforme `CHU` en `Chu`.

Dans GTFS Express, le rapport de validation liste chaque valeur concernée avec son fichier et sa ligne. « Corriger un par un » ouvre chaque ligne dans l'éditeur, le champ signalé, et chaque nom réécrit devient une retouche du brouillon. « Revalider » vérifie ensuite qu'il ne reste rien.

## Exemple

```
stop_id,stop_name,stop_lat,stop_lon
GARE,GARE SNCF,49.8906,2.3076
CHU,CHU SUD,49.8692,2.2615
```

Corrigé :

```
stop_id,stop_name,stop_lat,stop_lon
GARE,Gare SNCF,49.8906,2.3076
CHU,CHU Sud,49.8692,2.2615
```

Voir aussi le guide [Valider un GTFS](/guides/valider-un-gtfs) et la [liste des règles](/regles).
