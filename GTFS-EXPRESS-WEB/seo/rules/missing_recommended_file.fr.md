---
title: "missing_recommended_file : fichier recommandé absent"
description: Le GTFS ne contient pas feed_info.txt, fichier non obligatoire mais recommandé. Ce qu'il apporte aux réutilisateurs et comment l'écrire en quelques lignes.
updated: 2026-10-21
---

## Ce que signifie cette règle

La référence GTFS distingue les fichiers obligatoires, conditionnels et facultatifs. Certains fichiers facultatifs sont fortement recommandés. Dans le catalogue de GTFS Express, cette règle vise `feed_info.txt` : quand il manque, le validateur lève cet avertissement. Sévérité : **avertissement**.

`feed_info.txt` devient même obligatoire dès que le GTFS contient `translations.txt`.

## Pourquoi c'est important

Un avertissement ne bloque pas la livraison dans GTFS Express. Mais sans `feed_info.txt`, celui qui reçoit le fichier ne sait pas qui l'a publié, dans quelle langue, ni quelle période il couvre. Il ne peut pas distinguer deux versions successives, ni savoir à qui signaler une erreur. Les applications qui surveillent l'échéance des données n'ont pas de `feed_end_date` à lire.

## Causes fréquentes

- L'outil qui produit le GTFS n'écrit que les fichiers obligatoires.
- Le fichier a été retiré lors d'un découpage ou d'une fusion de jeux de données.
- Le GTFS a été assemblé à la main à partir de quelques tableaux.
- Le fichier existe sous un autre nom, `feedinfo.txt` ou `feed_info.csv` par exemple, et n'est donc pas reconnu.

## Comment la corriger

Créez `feed_info.txt` avec ses trois champs obligatoires : `feed_publisher_name`, `feed_publisher_url` et `feed_lang` (code de langue, par exemple `fr`). Ajoutez les champs recommandés : `feed_start_date` et `feed_end_date` alignés sur les calendriers, `feed_version` pour identifier la publication, `feed_contact_email` ou `feed_contact_url` pour les signalements.

Dans GTFS Express, l'éditeur permet de remplir `feed_info.txt` dans le brouillon, comme tout autre fichier du GTFS ; la saisie devient une retouche. « Revalider » confirme ensuite que l'avertissement a disparu et que les dates déclarées tiennent.

## Exemple

Un `feed_info.txt` minimal et complet :

```
feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version,feed_contact_email
Réseau Exemple,https://reseau.example.org,fr,20260901,20270704,2026-09-v3,donnees@reseau.example.org
```

Voir aussi le guide [Valider un GTFS](/guides/valider-un-gtfs) et la [liste des règles](/regles).
