---
title: "feed_expiration_date_30_days : GTFS qui expire sous 30 jours"
description: La date feed_end_date de feed_info.txt tombe dans les 30 prochains jours. Ce que cela annonce pour les applications de voyageurs et comment y répondre.
updated: 2026-10-21
---

## Ce que signifie cette règle

`feed_info.txt` peut déclarer la période couverte par le GTFS avec `feed_start_date` et `feed_end_date`. Quand `feed_end_date` arrive dans moins de 30 jours à compter de la date de validation, le validateur lève cet avertissement. Il dispose d'une notice voisine pour une échéance encore plus proche, à 7 jours. Sévérité : **avertissement**.

La règle ne dit pas que les données sont fausses aujourd'hui. Elle annonce qu'elles ne couvriront bientôt plus l'offre.

## Pourquoi c'est important

Un avertissement ne bloque pas la livraison dans GTFS Express. Mais après `feed_end_date`, les applications et les calculateurs d'itinéraire n'ont plus d'horaires à proposer : le réseau disparaît de leurs résultats, ou certains réutilisateurs écartent un fichier jugé périmé. Les bonnes pratiques recommandent de publier un GTFS qui couvre au moins les 30 jours suivants, idéalement toute la période déjà connue.

## Causes fréquentes

- Le GTFS de la saison suivante n'a pas encore été produit ou publié.
- `feed_end_date` a été laissé à une ancienne valeur alors que les calendriers ont été prolongés.
- Les calendriers s'arrêtent à la fin d'une période scolaire en attendant les horaires de la suivante.

## Comment la corriger

La vraie correction est de publier des données qui couvrent la période à venir : prolonger ou ajouter les services dans `calendar.txt` et `calendar_dates.txt`, puis aligner `feed_end_date` sur la dernière date de service. Ne repoussez pas `feed_end_date` seul : la date doit refléter les calendriers, sinon le fichier promet des horaires qu'il ne contient pas.

Dans GTFS Express, le rapport de validation signale la date en cause et « Corriger un par un » ouvre `feed_info.txt` dans l'éditeur. Les nouveaux services se préparent dans un brouillon, chaque modification étant une retouche ; « Revalider » contrôle ensuite le résultat.

## Exemple

Validé le 21 octobre 2026, ce fichier expire le 2 novembre :

```
feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date
Réseau Exemple,https://reseau.example.org,fr,20260901,20261102
```

Après ajout des services de la période suivante :

```
feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date
Réseau Exemple,https://reseau.example.org,fr,20260901,20270704
```

Voir aussi le guide [Modifier un GTFS](/guides/modifier-un-gtfs) et la [liste des règles](/regles).
