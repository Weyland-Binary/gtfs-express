---
title: "expired_calendar : service dont la période est terminée"
description: Un service de calendar.txt a une date de fin (end_date) déjà passée. Ce que cela implique pour les courses qui l'utilisent et comment nettoyer le GTFS.
updated: 2026-10-21
---

## Ce que signifie cette règle

Chaque service de `calendar.txt` court de `start_date` à `end_date`. Quand la date de fin d'un service est antérieure à la date de validation, le validateur lève cet avertissement : le service ne roulera plus jamais. Les exceptions de `calendar_dates.txt` comptent aussi, un ajout (`exception_type` = 1) à une date future prolonge la vie du service. Sévérité : **avertissement**.

## Pourquoi c'est important

Un avertissement ne bloque pas la livraison dans GTFS Express. Les courses d'un service expiré ne s'affichent dans aucune application, mais elles alourdissent le fichier et brouillent la lecture du réseau pour ceux qui réutilisent les données : on croit voir une ligne desservie alors qu'elle ne l'est plus. Si tous les services sont expirés, le GTFS ne décrit plus aucune offre.

## Causes fréquentes

- Le GTFS de la nouvelle saison a été construit en ajoutant des services sans retirer ceux de la saison précédente.
- Un service de vacances scolaires passées est resté dans le fichier.
- La date de fin a été mal saisie, `20250630` au lieu de `20260630`.
- Le fichier est simplement ancien et n'a pas été republié.

## Comment la corriger

Si le service roule encore, corrigez `end_date` dans `calendar.txt`. S'il est terminé, supprimez-le ainsi que les courses de `trips.txt` qui le référencent par `service_id`, leurs lignes de `stop_times.txt` et ses lignes de `calendar_dates.txt`. Supprimer le service seul laisserait des courses pointant vers un `service_id` absent, ce qui est une erreur.

Dans GTFS Express, le rapport de validation liste les services concernés. « Corriger un par un » ouvre chaque ligne de `calendar.txt` dans l'éditeur, la date signalée. Chaque modification est une retouche du brouillon ; « Revalider » confirme que l'avertissement a disparu sans nouvelle erreur.

## Exemple

Le service `HIVER_25` s'est arrêté en mars 2026 :

```
service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
HIVER_25,1,1,1,1,1,0,0,20250901,20260315
SEM_26,1,1,1,1,1,0,0,20260316,20270705
```

Ses courses ne circulent plus. On retire `HIVER_25` et ses courses, `SEM_26` reste.

Voir aussi le guide [Vacances scolaires et jours fériés dans un GTFS](/guides/vacances-scolaires-et-jours-feries-dans-un-gtfs) et la [liste des règles](/regles).
