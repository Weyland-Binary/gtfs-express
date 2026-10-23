---
title: "route_long_name_contains_short_name : nom long qui répète l'indice"
description: Dans routes.txt, route_long_name reprend route_short_name, par exemple « Ligne 4 Gare - Hôpital » pour la ligne 4. Pourquoi et comment le corriger.
updated: 2026-10-21
---

## Ce que signifie cette règle

Une ligne de `routes.txt` porte deux noms. `route_short_name` est l'indice que les voyageurs lisent sur le bus ou les fiches horaires, court et souvent numérique (`4`, `C2`, `N`). `route_long_name` décrit la ligne, généralement par ses terminus ou sa desserte. La référence GTFS demande que le nom long ne répète pas l'indice. Quand `route_long_name` contient `route_short_name` comme mot à part entière, le validateur lève cet avertissement. Sévérité : **avertissement**.

## Pourquoi c'est important

Un avertissement ne bloque pas la livraison dans GTFS Express. Mais la plupart des applications affichent les deux champs côte à côte : la pastille « 4 » suivie de « Ligne 4 Gare - Hôpital » répète l'information, prend de la place sur les petits écrans, et une synthèse vocale la lit deux fois. Le nom long perd aussi son rôle, qui est de dire où va la ligne.

## Causes fréquentes

- Le nom long a été rempli avec le libellé commercial complet, indice compris.
- Le GTFS est produit depuis un système qui n'a qu'un champ de nom, recopié dans les deux colonnes.
- Le mot « Ligne » ou « Bus » a été ajouté devant l'indice pour rendre le nom long plus lisible.

## Comment la corriger

Retirez l'indice, et le mot qui l'accompagne, de `route_long_name` pour ne garder que la description : les terminus, l'axe ou le quartier desservi. Gardez l'indice dans `route_short_name`. Si une ligne n'a pas d'indice, `route_long_name` seul suffit, et inversement.

Dans GTFS Express, le rapport de validation liste les lignes concernées et « Corriger un par un » ouvre chacune dans l'éditeur, le champ `route_long_name` signalé. Chaque nom corrigé est une retouche du brouillon ; « Revalider » confirme le résultat.

## Exemple

```
route_id,route_short_name,route_long_name,route_type
L4,4,Ligne 4 Gare - Hôpital,3
LC2,C2,C2 Centre - Campus,3
```

Corrigé :

```
route_id,route_short_name,route_long_name,route_type
L4,4,Gare - Hôpital,3
LC2,C2,Centre - Campus,3
```

Voir aussi le guide [Modifier un GTFS](/guides/modifier-un-gtfs) et la [liste des règles](/regles).
